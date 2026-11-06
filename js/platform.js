'use strict';
// File access for the desktop app (through the preload bridge) with browser fallbacks
// (file pickers and downloads), so the rest of the app doesn't care where it runs.

const Platform = (() => {
  const native = window.wbNative || null;
  const ACCEPT = {
    any: '.md,.markdown,.txt,.wbdoc,.wboard,.json,text/markdown',
    md: '.md,.markdown,.txt,text/markdown',
    wbdoc: '.wbdoc,.wboard,.json',
  };
  const BINARY = [];

  async function fileResult(f, path = null) {
    return BINARY.some(ext => f.name.toLowerCase().endsWith(ext))
      ? { name: f.name, path, bytes: new Uint8Array(await f.arrayBuffer()) }
      : { name: f.name, path, text: (await f.text()).replace(/^\uFEFF/, '') };
  }

  function pickFile(accept) {
    return new Promise(resolve => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = accept;
      input.addEventListener('change', async () => {
        const f = input.files[0];
        resolve(f ? await fileResult(f) : null);
      }, { once: true });
      input.click();
    });
  }

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // A backslash separates folders only on Windows; elsewhere it's a legal filename character.
  const WINDOWS = !!native && native.platform === 'win32';
  const lastSep = p => (WINDOWS ? Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')) : p.lastIndexOf('/'));
  const dirOf = p => p.slice(0, lastSep(p) + 1);
  const baseName = p => p.slice(lastSep(p) + 1);

  // Desktop: writes to `path`, or asks where (starting from `name`). Browser: downloads.
  // `data` is a string or bytes. Returns the saved path (desktop), 'downloaded' (browser)
  // or null if cancelled.
  async function saveFile({ path, name, data, kind, type = 'application/octet-stream' }) {
    if (!native) {
      download(new Blob([data], { type }), name);
      return 'downloaded';
    }
    const write = p => (typeof data === 'string' ? native.writeText(p, data) : native.writeBytes(p, data));
    let target = path || await native.saveDialog(name, kind);
    if (!target) return null;
    try {
      await write(target);
    } catch (err) {
      // The desktop app only writes where the user chose to; for any other path, ask.
      if (!/NOT_CHOSEN/.test(err && err.message)) throw err;
      target = await native.saveDialog(target, kind);
      if (!target) return null;
      await write(target);
    }
    return target;
  }

  // Browser PDF: print a hidden frame; the user picks "Save as PDF".
  function printHtml(html) {
    return new Promise(resolve => {
      const frame = document.createElement('iframe');
      frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
      frame.srcdoc = html;
      frame.addEventListener('load', () => {
        setTimeout(() => {
          frame.contentWindow.print();
          setTimeout(() => { frame.remove(); resolve('printed'); }, 1000);
        }, 200);
      }, { once: true });
      document.body.append(frame);
    });
  }

  return {
    desktop: !!native,
    download,
    dirOf,
    baseName,
    saveFile,

    // Returns { name, path, text } (or { name, path, bytes } for binary files) or null.
    open(kind = 'any') {
      return native ? native.openDialog(kind) : pickFile(ACCEPT[kind] || ACCEPT.any);
    },

    async readDropped(file) {
      return (native && await native.readDropped(file)) || fileResult(file);
    },

    readPath(p) { return native.readFile(p); },

    saveText({ path, name, text, kind, type = 'text/plain' }) { return saveFile({ path, name, data: text, kind, type }); },

    saveDialog(defaultPath, kind) { return native ? native.saveDialog(defaultPath, kind) : Promise.resolve(null); },
    writeText(p, text) { return native.writeText(p, text); },
    writeBase64(p, base64) { return native.writeBase64(p, base64); },
    userName() { return native ? native.userName() : Promise.resolve(null); },
    showInFolder(p) { if (native) native.showInFolder(p); },

    // Desktop: PDF bytes. Browser: opens the print dialog and returns null.
    async pdf(html) {
      if (native) return native.printToPDF(html);
      await printHtml(html);
      return null;
    },

    // Handwriting recognition (desktop on Windows). Resolves { lines, words, drawings }.
    inkAvailable() { return native ? native.inkAvailable() : Promise.resolve(false); },
    recognizeInk(strokes, mode = 'text') {
      if (!native) return Promise.reject(new Error('Handwriting recognition needs the desktop app on Windows'));
      return native.recognizeInk(strokes, mode);
    },

    openExternal(url) {
      if (!/^https?:\/\//i.test(url)) return;
      if (native) native.openExternal(url);
      else window.open(url, '_blank', 'noopener');
    },

    // Only a document that lives in a file on disk can be "unsaved" when the window closes.
    setDirty(dirty) { if (native) native.setDirty(dirty); },

    // Each folder name is percent-encoded on its own, so a "#" or "?" in it (C# notes)
    // stays part of the path instead of starting a fragment or query. A drive letter stays as is.
    fileUrl(dir, rel) {
      const d = (WINDOWS ? dir.replace(/\\/g, '/') : dir).replace(/\/?$/, '/');
      const encoded = d.split('/').map((seg, i) => (i === 0 && /^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg))).join('/');
      return (d.startsWith('/') ? 'file://' : 'file:///') + encoded + encodeURI(rel);
    },

    onOpenPath(cb) { if (native) native.onOpenPath(cb); },
    onCloseRequest(cb) { if (native) native.onCloseRequest(cb); },
    closeNow() { if (native) native.closeNow(); },
    ready() { if (native) native.ready(); },
  };
})();
