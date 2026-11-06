'use strict';
// Electron main process: window, file dialogs and file I/O for the renderer, PDF rendering
// and the handwriting recognition sidecar.

const { app, BrowserWindow, Menu, dialog, ipcMain, shell, session } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { fileURLToPath } = require('url');

// Up to 2.1 the app was called "Whiteboard": keep using that data folder, so boards and
// settings carry over. Only for the real app: a copy under another product name keeps its own.
if (app.getName() === 'ZP Whiteboard') app.setPath('userData', path.join(app.getPath('appData'), 'Whiteboard'));

// The renderer may only read and write these kinds of files.
const TEXT_READABLE = new Set(['.md', '.markdown', '.txt', '.wbdoc', '.wboard', '.json']);
const BINARY_READABLE = new Set();
const WRITABLE = new Set(['.md', '.markdown', '.wbdoc', '.wboard', '.png', '.docx', '.pdf', '.html']);
const OPENABLE_ARGS = new Set(['.md', '.markdown', '.wbdoc', '.wboard']);
const MAX_READ = 512 * 1024 * 1024;

let win = null;
let docDirty = false;
let closeConfirmed = false;
let pendingPath = null;

// The app never talks to the network or other machines. Blocking it here backs up the
// HTML sanitizer: a document can't load a remote image (a read receipt) or a
// \\server\share path (which would make Windows send the user's NTLM hash).
function blockedUrl(url) {
  if (/^(https?|wss?|ftp):/i.test(url)) return true;
  // Local files only: file:///C:/… or file:///home/…, never file://host/… or file:////host/….
  if (/^file:/i.test(url)) return !/^file:\/\/\/[^/\\]/i.test(url);
  return false;
}

function lockDown(ses) {
  ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (d, cb) => cb({ cancel: blockedUrl(d.url) }));
  // Only writing to the clipboard (the prompt after Export for AI) is ever needed.
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'clipboard-sanitized-write'));
  ses.setPermissionCheckHandler((_wc, permission) => permission === 'clipboard-sanitized-write');
}

// IPC is only accepted from the app's own page in the main window.
function guard(fn) {
  return (e, ...args) => {
    if (!win || e.sender !== win.webContents || !e.senderFrame || e.senderFrame !== win.webContents.mainFrame || !/^file:/i.test(e.senderFrame.url)) {
      throw new Error('Not allowed');
    }
    return fn(e, ...args);
  };
}

// Linux desktops start the app with file:///… URIs (the .desktop entry's %U), not paths.
function fileArg(argv) {
  for (const a of argv.slice(1)) {
    if (a.startsWith('-')) continue;
    let p = a;
    if (/^file:/i.test(a)) {
      // file://host/… names a network share (on Windows fileURLToPath would make it \\host\…): refused.
      try { if (new URL(a).host) continue; p = fileURLToPath(a); } catch { continue; }
    }
    if (OPENABLE_ARGS.has(path.extname(p).toLowerCase())) return p;
  }
  return null;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 720,
    minHeight: 480,
    title: 'ZP Whiteboard',
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'icons', 'icon-512.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'index.html'));

  // Links never navigate the app window; web links open in the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', e => e.preventDefault());

  // Closing asks the page to flush its autosave first (and optionally save the .md file).
  win.on('close', e => {
    if (closeConfirmed) return;
    e.preventDefault();
    let action = 'flush';
    if (docDirty) {
      const choice = dialog.showMessageBoxSync(win, {
        type: 'question',
        buttons: ['Save', "Don't save", 'Cancel'],
        defaultId: 0,
        cancelId: 2,
        title: 'Unsaved document',
        message: 'Save changes to the document file before closing?',
        detail: 'Your board, comments and edits are kept in the app either way. This only concerns the file on disk.',
      });
      if (choice === 2) return;
      action = choice === 0 ? 'save' : 'flush';
    }
    win.webContents.send('app:close-request', action);
    // Don't let a stuck page keep the window open forever.
    if (action === 'flush') setTimeout(() => { closeConfirmed = true; if (win) win.close(); }, 4000);
  });
  win.on('closed', () => { win = null; });
}

function sendOpenPath(p) {
  if (!p) return;
  choose(p).catch(() => {});
  if (win && !win.webContents.isLoading()) win.webContents.send('app:open-path', p);
  else pendingPath = p;
}

async function readAllowed(p) {
  const ext = path.extname(p).toLowerCase();
  if (!TEXT_READABLE.has(ext) && !BINARY_READABLE.has(ext)) throw new Error(`Cannot open ${ext || 'this'} files`);
  const st = await fs.stat(p);
  if (st.size > MAX_READ) throw new Error('That file is too large');
  const name = path.basename(p);
  if (BINARY_READABLE.has(ext)) return { path: p, name, bytes: new Uint8Array(await fs.readFile(p)) };
  // A byte-order mark would show up as a stray character before the first heading.
  return { path: p, name, text: (await fs.readFile(p, 'utf8')).replace(/^\uFEFF/, '') };
}

// Write to a temporary file next to the target, then rename: a crash never leaves half a file.
// The counter keeps two saves of the same file at once from sharing a temporary file.
// Saving over a symlink writes to the file it points at, and an existing file keeps its
// permissions (on Linux the temporary file would otherwise get the umask's, often 0644).
// `owner: true` creates a new file readable by its owner only (the app's own private data).
let tmpSeq = 0;
async function writeAtomic(p, data, { owner = false } = {}) {
  let mode = null;
  try {
    p = await fs.realpath(p);
    if (process.platform !== 'win32') mode = (await fs.stat(p)).mode & 0o777;
  } catch {
    if (owner && process.platform !== 'win32') mode = 0o600; // a new file
  }
  const tmp = path.join(path.dirname(p), `.${path.basename(p)}.${process.pid}.${++tmpSeq}.tmp`);
  // Created owner-only, then given the final mode, so the data is never readable by others in
  // between. 'wx' never reuses a leftover temporary file.
  await fs.writeFile(tmp, data, mode === null ? { flag: 'wx' } : { flag: 'wx', mode: 0o600 });
  try {
    if (mode !== null) await fs.chmod(tmp, mode);
    await fs.rename(tmp, p);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}

// ---------- Paths the user chose ----------
// The page may only read by path, write to, or show in Explorer a file the user pointed at:
// a path from a save or open dialog, a file the app was opened with (recorded here, in the
// main process), or a file dropped on the window (its path comes from the preload, from the
// File object). A path that only appears inside a document never qualifies, so a shared
// file can't choose where Save writes. The list is kept across restarts, so Ctrl+S
// still goes straight to the file for a workspace restored from autosave.
const chosenFile = () => path.join(app.getPath('userData'), 'chosen-paths.json');
const pathKey = p => (process.platform === 'win32' ? path.resolve(String(p)).toLowerCase() : path.resolve(String(p)));
let chosen = null; // Promise<Set>: loaded once, so concurrent callers share one set

function chosenPaths() {
  if (!chosen) {
    chosen = fs.readFile(chosenFile(), 'utf8').then(t => new Set(JSON.parse(t))).catch(() => new Set());
  }
  return chosen;
}

async function choose(p) {
  const set = await chosenPaths(), key = pathKey(p);
  set.delete(key); // most recent last
  set.add(key);
  while (set.size > 1000) set.delete(set.values().next().value);
  try { await writeAtomic(chosenFile(), JSON.stringify([...set]), { owner: true }); } catch { /* still allowed this session */ }
}

const wasChosen = async p => (await chosenPaths()).has(pathKey(p));

const FILTERS = {
  any: [
    { name: 'Documents and workspaces', extensions: ['md', 'markdown', 'wbdoc', 'wboard'] },
    { name: 'Markdown', extensions: ['md', 'markdown'] },
    { name: 'Whiteboard workspace', extensions: ['wbdoc', 'wboard'] },
  ],
  md: [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
  wbdoc: [{ name: 'Whiteboard workspace', extensions: ['wbdoc'] }],
  review: [{ name: 'Markdown', extensions: ['md'] }],
  png: [{ name: 'PNG image', extensions: ['png'] }],
  docx: [{ name: 'Word document', extensions: ['docx'] }],
  pdf: [{ name: 'PDF', extensions: ['pdf'] }],
  html: [{ name: 'Web page', extensions: ['html'] }],
};

ipcMain.handle('app:user', guard(() => {
  try { return os.userInfo().username; } catch { return null; }
}));

ipcMain.handle('file:open-dialog', guard(async (_e, kind) => {
  const res = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: FILTERS[kind] || FILTERS.any });
  if (res.canceled || !res.filePaths[0]) return null;
  const file = await readAllowed(res.filePaths[0]);
  await choose(res.filePaths[0]);
  return file;
}));

// Files the app was opened with (sendOpenPath already chose them).
ipcMain.handle('file:read', guard(async (_e, p) => {
  if (!(await wasChosen(p))) throw new Error('Open that file with Open… or by dropping it on the window');
  return readAllowed(String(p));
}));

ipcMain.handle('file:read-dropped', guard(async (_e, p) => {
  const file = await readAllowed(String(p));
  await choose(p);
  return file;
}));

ipcMain.handle('file:save-dialog', guard(async (_e, { defaultPath, kind }) => {
  const res = await dialog.showSaveDialog(win, { defaultPath, filters: FILTERS[kind] || [] });
  if (res.canceled || !res.filePath) return null;
  await choose(res.filePath);
  // Export for AI writes the board sketch next to the bundle: name.review.md + name.board.png.
  if (kind === 'review') await choose(path.join(path.dirname(res.filePath), path.basename(res.filePath).replace(/(\.review)?\.md$/i, '') + '.board.png'));
  return res.filePath;
}));

ipcMain.handle('file:write', guard(async (_e, { path: p, text, base64, bytes }) => {
  const ext = path.extname(String(p)).toLowerCase();
  if (!WRITABLE.has(ext)) throw new Error(`Cannot write ${ext || 'this'} files`);
  if (!(await wasChosen(p))) throw new Error('NOT_CHOSEN: choose where to save this file');
  const data = bytes != null ? Buffer.from(bytes) : base64 != null ? Buffer.from(base64, 'base64') : Buffer.from(String(text), 'utf8');
  await writeAtomic(String(p), data);
  return true;
}));

ipcMain.handle('shell:open-external', guard((_e, url) => {
  if (/^https?:\/\//i.test(url)) shell.openExternal(url);
}));

ipcMain.handle('shell:show-item', guard(async (_e, p) => { if (await wasChosen(p)) shell.showItemInFolder(String(p)); }));


// ---------- PDF ----------

// One in-memory session for all PDF exports (sessions are never freed, so not one per
// export). Each export's page is served from `pdfPages` at its own path while it prints.
let pdfSeq = 0, pdfSes = null;
const pdfPages = new Map();
function pdfSession() {
  if (pdfSes) return pdfSes;
  pdfSes = session.fromPartition('whiteboard-pdf', { cache: false });
  pdfSes.protocol.handle('wbexport', req => {
    const html = pdfPages.get(new URL(req.url).pathname);
    return html == null ? new Response('', { status: 404 }) : new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  });
  pdfSes.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (d, cb) => cb({ cancel: !/^(wbexport|data):/i.test(d.url) }));
  pdfSes.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
  return pdfSes;
}

ipcMain.handle('export:pdf', guard(async (_e, html) => {
  if (typeof html !== 'string' || html.length > 200 * 1024 * 1024) throw new Error('Nothing to print');
  const ses = pdfSession();
  const page = `/${++pdfSeq}`;
  pdfPages.set(page, html);
  const pdfWin = new BrowserWindow({
    show: false,
    webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: true },
  });
  pdfWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  pdfWin.webContents.on('will-navigate', e => e.preventDefault());
  try {
    await pdfWin.loadURL(`wbexport://document${page}`);
    await pdfWin.webContents.executeJavaScript(`(async () => {
      await document.fonts.ready;
      await Promise.all([...document.images].map(i => i.complete ? i.decode().catch(() => {}) : new Promise(r => { i.onload = i.onerror = r; })));
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    })()`);
    const pdf = await pdfWin.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      generateTaggedPDF: true,
      generateDocumentOutline: true,
    });
    return new Uint8Array(pdf);
  } finally {
    pdfWin.destroy();
    pdfPages.delete(page);
    ses.clearStorageData().catch(() => {});
  }
}));

// ---------- Handwriting recognition (bin/swbd-ink.exe, Windows Ink, offline) ----------

const inkExe = () => (app.isPackaged
  ? path.join(process.resourcesPath, 'bin', 'swbd-ink.exe')
  : path.join(__dirname, '..', 'bin', 'swbd-ink.exe'));

let ink = null; // { proc, pending: Map<id, {resolve, reject, timer}>, buf }
let inkSeq = 0;

function inkProcess() {
  if (ink) return ink;
  const proc = spawn(inkExe(), [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  ink = { proc, pending: new Map(), buf: '' };
  const fail = err => {
    for (const p of ink.pending.values()) { clearTimeout(p.timer); p.reject(err); }
    ink = null;
  };
  proc.on('error', () => fail(new Error('Handwriting recognition is not available on this computer')));
  proc.on('exit', () => { if (ink && ink.proc === proc) fail(new Error('Handwriting recognition stopped')); });
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', chunk => {
    const state = ink;
    if (!state) return;
    state.buf += chunk;
    let nl;
    while ((nl = state.buf.indexOf('\n')) >= 0) {
      const line = state.buf.slice(0, nl);
      state.buf = state.buf.slice(nl + 1);
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const p = state.pending.get(msg.id);
      if (!p) continue;
      state.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg);
      else p.reject(new Error(msg.error || 'Recognition failed'));
    }
  });
  return ink;
}

ipcMain.handle('ink:recognize', guard((_e, { strokes, mode }) => {
  if (process.platform !== 'win32') throw new Error('Handwriting recognition needs Windows');
  if (!Array.isArray(strokes)) throw new Error('No strokes');
  const req = { id: ++inkSeq, mode: mode === 'auto' ? 'auto' : 'text', strokes };
  const state = inkProcess();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { state.pending.delete(req.id); reject(new Error('Recognition timed out')); }, 20000);
    state.pending.set(req.id, { resolve, reject, timer });
    state.proc.stdin.write(JSON.stringify(req) + '\n');
  });
}));

ipcMain.handle('ink:available', guard(async () => {
  if (process.platform !== 'win32') return false;
  try { await fs.access(inkExe()); return true; } catch { return false; }
}));

// ---------- Window lifecycle ----------

const fromApp = e => win && e.sender === win.webContents;
ipcMain.on('app:set-dirty', (e, dirty) => { if (fromApp(e)) docDirty = !!dirty; });
ipcMain.on('app:close-now', e => { if (!fromApp(e)) return; closeConfirmed = true; if (win) win.close(); });
ipcMain.on('app:ready', e => {
  if (!fromApp(e)) return;
  if (pendingPath) { win.webContents.send('app:open-path', pendingPath); pendingPath = null; }
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
    sendOpenPath(fileArg(argv));
  });

  app.whenReady().then(() => {
    lockDown(session.defaultSession);
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: 'editMenu' },
      {
        label: 'View',
        submenu: [
          ...(app.isPackaged ? [] : [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }]),
          { role: 'togglefullscreen' },
        ],
      },
    ]));
    pendingPath = fileArg(process.argv);
    if (pendingPath) choose(pendingPath).catch(() => {});
    createWindow();
  });

  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => { if (ink) ink.proc.kill(); });
}
