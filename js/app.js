'use strict';
// ZP Whiteboard: state, input handling, history, persistence, layout and UI wiring.

const stage = $('stage');
const canvas = $('board');
const ctx = canvas.getContext('2d', { alpha: false });
// The live layer sits on top of the board and holds the stroke being drawn plus
// overlays (selection, lasso, eraser), so pen input never redraws the whole scene.
const live = $('live');
// Not `desynchronized`: that presents outside the compositor's frames, and the tearing
// made drawing look choppy. Repainting only what changed keeps the latency low anyway.
const liveCtx = live.getContext('2d');
const liveInk = createLiveInk(live, liveCtx);
const editor = $('editor');
const toolbarEl = $('toolbar');

const ACCENT = '#4f6bed';
const INK_COLORS = ['#1f1f1f', '#ffffff', '#8a8886', '#e81224', '#f7630c', '#ffb900', '#16c60c', '#0078d4', '#886ce4', '#e3008c'];
const HIGHLIGHT_COLORS = ['#fff100', '#a4f45c', '#3ee8ff', '#ff8cd9', '#ffaa44', '#b4a0ff'];
const NOTE_COLORS = ['#fff59d', '#ffd59e', '#ffc1d9', '#c8eba5', '#b8e3ff', '#dccfff', '#ececec'];
const SHAPE_KINDS = ['rect', 'ellipse', 'triangle', 'line', 'arrow'];
const TOOLS_WITH_OPTIONS = ['pen', 'highlighter', 'eraser', 'shape', 'text', 'note'];
const DARK_INK = '#1f1f1f', LIGHT_INK = '#ffffff';
const MIN_SCALE = 0.1, MAX_SCALE = 10;
const HISTORY_LIMIT = 200;
const MD_EXT = /\.(md|markdown|txt)$/i;
const WORKSPACE_EXT = /\.(wbdoc|wboard|json)$/i;
const SECURE_EXT = /\.swbdx$/i;
const KEY_EXT = /\.swbdkey$/i;
// Encrypted documents (js/secure.js and its WebAssembly core) are an optional module: the
// public edition is built without it (tools/export-public.js). Every way into it checks this.
const SECURE = typeof Secure !== 'undefined';
const FULL_EDITION_ONLY = 'Encrypted .swbdx documents need the full edition of ZP Whiteboard.';

const ICONS = {
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  select: '<path d="M7 22a5 5 0 0 1-2-4"/><path d="M3.3 14A6.8 6.8 0 0 1 2 10c0-4.4 4.5-8 10-8s10 3.6 10 8-4.5 8-10 8a12 12 0 0 1-5-1"/><circle cx="5" cy="16" r="2"/>',
  hand: '<path d="M18 11V6a2 2 0 0 0-4 0v5"/><path d="M14 10V4a2 2 0 0 0-4 0v6"/><path d="M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-6-2.3l-3.6-3.6a2 2 0 0 1 2.8-2.8L7 15"/>',
  pen: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  highlighter: '<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>',
  eraser: '<path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/>',
  shapes: '<rect x="3" y="3" width="8" height="8" rx="1"/><circle cx="17" cy="17" r="4"/><path d="M17 3l4 7h-8z"/><path d="M3 21l8-8"/>',
  text: '<path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/>',
  note: '<path d="M15.5 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8.5Z"/><path d="M15 3v6h6"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  fit: '<path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/>',
  background: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>',
  trash: '<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6"/>',
  copy: '<rect x="8" y="8" width="14" height="14" rx="2"/><path d="M4 16a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2"/>',
  front: '<path d="M5 3h14M18 13l-6-6-6 6M12 7v14"/>',
  back: '<path d="M19 21H5M6 11l6 6 6-6M12 17V3"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  filePlus: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M12 12v6M9 15h6"/>',
  boards: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
  install: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4M12 7v6M9 10l3 3 3-3"/>',
  rect: '<rect x="3.5" y="6" width="17" height="12" rx="1"/>',
  ellipse: '<ellipse cx="12" cy="12" rx="9" ry="7"/>',
  triangle: '<path d="M12 4.5 21 19.5H3z"/>',
  line: '<path d="M5 19 19 5"/>',
  arrow: '<path d="M5 19 19 5M9 5h10v10"/>',
  modeBoard: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 14c2-3 3 1 5-2s3 0 5-2"/>',
  modeSplit: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16M6 8.5h3M6 11.5h3M6 14.5h3"/>',
  modeDoc: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>',
  comment: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M12 7v6M9 10h6"/>',
  comments: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M8 9h8M8 13h5"/>',
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/>',
  share: '<path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7M16 6l-4-4-4 4M12 2v13"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  smile: '<circle cx="12" cy="12" r="9"/><path d="M8.5 14a4 4 0 0 0 7 0M9 9.5h.01M15 9.5h.01"/>',
  up: '<path d="m6 15 6-6 6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  suggest: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/><path d="M3 3l4 4"/>',
  write: '<path d="M3 17c3-4 4 2 7-2s3 1 5-1"/><path d="M15 6l3-3 3 3-9 9H9v-3z"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>',
  fileText: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h8M8 9h2"/>',
  merge: '<path d="M6 3v6a6 6 0 0 0 6 6h6"/><path d="m15 12 3 3-3 3"/><circle cx="6" cy="3" r="0.5"/><path d="M18 3v4"/>',
  toText: '<path d="M4 7V5h10v2M9 5v12M7 17h4"/><path d="M14 14c1.5-2 2.5 1 4-1s2 .5 2 .5"/>',
  toShape: '<rect x="3" y="12" width="8" height="8" rx="1"/><circle cx="17" cy="7" r="4"/><path d="M4 6c2-3 4 1 6-2"/>',
};

function icon(name) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...children.flat().filter(present));
  return el;
}

// append / replaceChildren that skip null and false, like h().
const present = c => c != null && c !== false;
function fill(el, ...children) { el.replaceChildren(...children.flat().filter(present)); return el; }
function addTo(el, ...children) { el.append(...children.flat().filter(present)); return el; }

// Modal dialog built on the fly. Each action's onClick may return false (or a promise of
// false) to keep the dialog open. Returns a function that closes it.
function dialog({ title, body = [], actions = [], small = false, focus = null, onDismiss = null, onClose = null }) {
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    modal.remove();
    document.removeEventListener('keydown', onKey, true);
    if (onClose) onClose();
  };
  const dismiss = () => { if (closed) return; close(); if (onDismiss) onDismiss(); };
  const buttons = actions.map(act => {
    const b = h('button', { type: 'button', class: 'btn' + (act.primary ? ' primary' : '') + (act.danger ? ' danger' : '') }, act.label);
    b.addEventListener('click', async () => {
      if (b.disabled) return;
      b.disabled = true;
      try {
        const keep = act.onClick ? await act.onClick() : true;
        if (keep !== false) close();
      } finally { b.disabled = false; }
    });
    return b;
  });
  const box = h('div', { class: 'dialog panel' + (small ? ' small' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('header', {}, h('h2', {}, title), h('button', { class: 'icon-btn', type: 'button', title: 'Close', html: icon('close'), onclick: dismiss })),
    h('div', { class: 'dialog-body' }, ...body),
    buttons.length ? h('footer', {}, ...buttons) : null);
  const modal = h('div', { class: 'modal dyn' }, box);
  modal.addEventListener('pointerdown', e => { if (e.target === modal) dismiss(); });
  function onKey(e) {
    if (!document.body.contains(modal) || (EmojiPicker.isOpen() && e.key === 'Escape')) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); dismiss(); return; }
    if (e.key === 'Enter' && e.target.matches('input:not([type=checkbox])') && modal.contains(e.target)) {
      const primary = buttons[actions.findIndex(x => x.primary)];
      if (primary) { e.preventDefault(); primary.click(); }
    }
  }
  document.addEventListener('keydown', onKey, true);
  document.body.append(modal);
  setTimeout(() => (focus || box.querySelector('input, button.primary') || box).focus());
  return close;
}

function loadJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function saveJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}

const stripExt = name => name.replace(/\.[^.]+$/, '');

// ---------- State ----------

const settings = {
  tool: 'pen',
  userName: '',
  pen: { color: DARK_INK, size: 4 },
  highlighter: { color: '#fff100', size: 22 },
  eraser: { size: 24 },
  shape: { kind: 'rect', color: '#0078d4', size: 4, fill: false },
  text: { color: DARK_INK, size: 28 },
  note: { color: NOTE_COLORS[0] },
};
{
  const saved = loadJSON('wb.settings', {});
  for (const k of Object.keys(settings)) {
    if (!(k in saved)) continue;
    settings[k] = typeof settings[k] === 'object' ? { ...settings[k], ...saved[k] } : saved[k];
  }
}
function saveSettings() { saveJSON('wb.settings', settings); }

let board = null;         // { id, name, bg, layout: { mode, split }, saved, thumb, filePath, secure }
let inkReady = false;     // handwriting recognition available (desktop app on Windows)
let elements = [];        // bottom to top; committed element objects are never mutated
let view = { x: 0, y: 0, scale: 1 };
let selection = new Set();
let undoStack = [[]];
let undoIndex = 0;
let gesture = null;
let editing = null;       // { id, isNew }
const pointers = new Map();
let sawPen = false;
let spaceDown = false;
let hover = null;         // last mouse/pen position over the canvas, stage coords
let deferredInstall = null;
let saveTimer = null;
let dirty = false;
let saveFailed = false;
let boardVersion = 0;     // bumps on every board change; the thumbnail is redrawn only when it moved
let thumbVersion = -1;
let stageRect = { left: 0, top: 0, width: innerWidth, height: innerHeight };

const findEl = id => elements.find(el => el.id === id);
const theme = () => THEMES[board.bg.theme] || THEMES.white;
const me = () => settings.userName || 'Me';
// Coordinates: "stage" = CSS pixels relative to the board area; "world" = board space.
const toWorld = (sx, sy) => [(sx - view.x) / view.scale, (sy - view.y) / view.scale];
const toScreen = (wx, wy) => [wx * view.scale + view.x, wy * view.scale + view.y];
const local = e => [e.clientX - stageRect.left, e.clientY - stageRect.top];
const viewCenter = () => toWorld(stageRect.width / 2, stageRect.height / 2);
const withAuthor = el => (settings.userName ? { ...el, author: settings.userName } : el);

// ---------- History ----------

// `appended` is an element just added on top: it's painted onto the scene as is
// instead of redrawing everything.
function commit(appended) {
  undoStack.length = undoIndex + 1;
  undoStack.push(elements.slice());
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  undoIndex = undoStack.length - 1;
  afterChange(appended);
}

function undo() {
  if (editing) commitEditor();
  if (gesture || undoIndex === 0) return;
  undoIndex--;
  elements = undoStack[undoIndex].slice();
  afterChange();
}

function redo() {
  if (editing) commitEditor();
  if (gesture || undoIndex >= undoStack.length - 1) return;
  undoIndex++;
  elements = undoStack[undoIndex].slice();
  afterChange();
}

function afterChange(appended) {
  if (selection.size) {
    const ids = new Set(elements.map(el => el.id));
    for (const id of selection) if (!ids.has(id)) selection.delete(id);
  }
  $('undoBtn').disabled = undoIndex === 0;
  $('redoBtn').disabled = undoIndex >= undoStack.length - 1;
  boardVersion++;
  scheduleReviewPanel();
  if (appended) appendToScene(appended);
  else requestRender();
  scheduleSave();
}

// Throws away uncommitted changes from an interrupted gesture.
function cancelGesture() {
  const g = gesture;
  gesture = null;
  live.style.opacity = '';
  if (g && g.kind !== 'pan' && g.kind !== 'pinch') {
    elements = undoStack[undoIndex].slice();
    afterChange();
  }
}

// ---------- Rendering ----------

// Two layers, two dirty flags: the scene (background + committed elements) and the
// live layer. Drawing, lasso and hover only touch the live layer.
//
// The committed elements are also kept as a bitmap (`elementLayer`, drawn at
// `layerView`). While the view pans or zooms, frames just move and scale that bitmap over
// a fresh background (drawing cost is mostly GPU time, which timing on the page can't
// see), and the full-quality redraw happens once the view stops moving.
let sceneDirty = false, overlayDirty = false, viewDirty = false, frameQueued = false;
function requestRender() { sceneDirty = overlayDirty = true; queueFrame(); }
function requestOverlay() { overlayDirty = true; queueFrame(); }
function requestViewRender() { viewDirty = overlayDirty = true; queueFrame(); }

const elementLayer = document.createElement('canvas');
const layerCtx = elementLayer.getContext('2d');
let layerView = null;      // the view elementLayer was drawn at (null: not usable)
let settleTimer = null;
function queueFrame() {
  if (frameQueued) return;
  frameQueued = true;
  requestAnimationFrame(frame);
}
onImageLoad = requestRender;

function frame() {
  frameQueued = false;
  if (!board || !stageRect.width) return; // loading, or the board is hidden
  if (sceneDirty) renderScene();
  else if (viewDirty) {
    if (layerView) moveScene();
    else renderScene();
  }
  viewDirty = false;
  if (overlayDirty) renderOverlay();
  if (cursorDirty) { cursorDirty = false; updateCursor(); }
}

function resizeCanvas() {
  const r = stage.getBoundingClientRect();
  stageRect = { left: r.left, top: r.top, width: r.width, height: r.height };
  const dpr = window.devicePixelRatio || 1;
  elementLayer.width = live.width = canvas.width = Math.max(1, Math.round(r.width * dpr));
  elementLayer.height = live.height = canvas.height = Math.max(1, Math.round(r.height * dpr));
  layerView = null;
  liveInk.reset(); // setting the size cleared the live layer, even when it didn't change
  requestRender();
}

const worldTransform = (c, dpr) => c.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * view.x, dpr * view.y);

// The element a draw or shape gesture is shaping lives on the live layer until committed.
const draftEl = () => (gesture && (gesture.kind === 'draw' || gesture.kind === 'shape') ? gesture.el : null);

function renderScene() {
  sceneDirty = false;
  clearTimeout(settleTimer);
  const dpr = window.devicePixelRatio || 1;
  const w = stageRect.width, hgt = stageRect.height;
  layerCtx.setTransform(1, 0, 0, 1, 0, 0);
  layerCtx.clearRect(0, 0, elementLayer.width, elementLayer.height);
  worldTransform(layerCtx, dpr);
  const [vx0, vy0] = toWorld(0, 0), [vx1, vy1] = toWorld(w, hgt);
  const skip = draftEl(), editId = editing && editing.id;
  for (const el of elements) {
    if (el === skip || el.id === editId) continue;
    const b = getBounds(el);
    if (b.x > vx1 || b.y > vy1 || b.x + b.w < vx0 || b.y + b.h < vy0) continue;
    drawElement(layerCtx, el, dpr * view.scale);
  }
  layerView = { ...view, dpr };
  drawBackground(ctx, view, w, hgt, theme(), board.bg.pattern, dpr);
  ctx.drawImage(elementLayer, 0, 0);
}

// Fast frame while panning or zooming: the last full render, moved and scaled.
function moveScene() {
  const dpr = window.devicePixelRatio || 1;
  if (layerView.dpr !== dpr) { renderScene(); return; }
  drawBackground(ctx, view, stageRect.width, stageRect.height, theme(), board.bg.pattern, dpr);
  const k = view.scale / layerView.scale;
  ctx.setTransform(k, 0, 0, k, dpr * (view.x - layerView.x * k), dpr * (view.y - layerView.y * k));
  ctx.imageSmoothingQuality = 'low';
  ctx.drawImage(elementLayer, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  clearTimeout(settleTimer);
  settleTimer = setTimeout(requestRender, 140);
}

// Paints a just-committed top element onto the current scene.
function appendToScene(el) {
  if (sceneDirty || !board || !stageRect.width || elements[elements.length - 1] !== el) { requestRender(); return; }
  const dpr = window.devicePixelRatio || 1;
  if (!layerView || layerView.x !== view.x || layerView.y !== view.y || layerView.scale !== view.scale) { requestRender(); return; }
  worldTransform(ctx, dpr);
  drawElement(ctx, el, dpr * view.scale);
  worldTransform(layerCtx, dpr);
  drawElement(layerCtx, el, dpr * view.scale);
  requestOverlay();
}

function renderOverlay() {
  overlayDirty = false;
  const dpr = window.devicePixelRatio || 1;
  const g = gesture;
  if (g && g.kind === 'draw') {
    // While drawing, the stroke is all the live layer holds (pointerdown cleared the
    // selection), and only the part that changed is repainted.
    liveInk.draw(g.builder, g.predicted, dpr * view.scale, dpr * view.x, dpr * view.y);
    return;
  }
  liveInk.reset();
  live.style.opacity = '';
  liveCtx.setTransform(1, 0, 0, 1, 0, 0);
  liveCtx.clearRect(0, 0, live.width, live.height);
  if (g && g.kind === 'shape') {
    worldTransform(liveCtx, dpr);
    drawElement(liveCtx, g.el, dpr * view.scale);
  }
  liveCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawOverlays(liveCtx);
  if (editing) positionEditor();
  updateSelBar();
}

function selectedElements() { return elements.filter(el => selection.has(el.id)); }

function selectionBounds() {
  const sel = selectedElements();
  return sel.length ? unionBounds(sel) : null;
}

// Selection box in stage coords, padded, plus its four corner handles (tl, tr, br, bl).
function selectionFrame() {
  const b = selectionBounds();
  if (!b) return null;
  const [x0, y0] = toScreen(b.x, b.y);
  const pad = 6;
  const r = { x: x0 - pad, y: y0 - pad, w: b.w * view.scale + pad * 2, h: b.h * view.scale + pad * 2 };
  const handles = [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]];
  return { b, r, handles };
}

function drawOverlays(ctx) {
  if (gesture && gesture.kind === 'lasso' && gesture.pts.length > 1) {
    ctx.beginPath();
    gesture.pts.forEach(([x, y], i) => {
      const [sx, sy] = toScreen(x, y);
      if (i) ctx.lineTo(sx, sy); else ctx.moveTo(sx, sy);
    });
    ctx.fillStyle = 'rgba(79,107,237,0.08)';
    ctx.fill();
    ctx.setLineDash([6, 5]);
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  if (settings.tool === 'select' && !editing) {
    const f = selectionFrame();
    if (f) {
      if (selection.size > 1) {
        ctx.strokeStyle = 'rgba(79,107,237,0.45)';
        ctx.lineWidth = 1;
        for (const el of selectedElements()) {
          const b = getBounds(el);
          const [x, y] = toScreen(b.x, b.y);
          ctx.strokeRect(x, y, b.w * view.scale, b.h * view.scale);
        }
      }
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.strokeRect(f.r.x, f.r.y, f.r.w, f.r.h);
      ctx.setLineDash([]);
      for (const [x, y] of f.handles) {
        ctx.beginPath();
        ctx.arc(x, y, 5.5, 0, Math.PI * 2);
        ctx.fillStyle = '#fff';
        ctx.fill();
        ctx.stroke();
      }
    }
  }

  if (settings.tool === 'eraser' && hover && !spaceDown) {
    ctx.beginPath();
    ctx.arc(hover.x, hover.y, settings.eraser.size / 2, 0, Math.PI * 2);
    ctx.fillStyle = theme().dark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.06)';
    ctx.fill();
    ctx.strokeStyle = theme().dark ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.55)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

function handleAt(sx, sy) {
  if (settings.tool !== 'select') return -1;
  const f = selectionFrame();
  if (!f) return -1;
  return f.handles.findIndex(([x, y]) => Math.hypot(sx - x, sy - y) <= 10);
}

function topHit(wx, wy, tol, filter) {
  for (let i = elements.length - 1; i >= 0; i--) {
    const el = elements[i];
    if ((!filter || filter(el)) && hitTest(el, wx, wy, tol)) return el;
  }
  return null;
}

let cursorDirty = false;
function scheduleCursor() { cursorDirty = true; queueFrame(); }

function updateCursor() {
  let c = 'default';
  if (gesture && (gesture.kind === 'pan' || gesture.kind === 'pinch')) c = 'grabbing';
  else if (spaceDown || settings.tool === 'hand') c = 'grab';
  else if (settings.tool === 'eraser') c = 'none';
  else if (settings.tool === 'text') c = 'text';
  else if (settings.tool === 'select') {
    if (gesture && gesture.kind === 'move') c = 'move';
    else if (hover) {
      const hi = handleAt(hover.x, hover.y);
      if (hi >= 0) c = hi % 2 === 0 ? 'nwse-resize' : 'nesw-resize';
      else {
        const [wx, wy] = toWorld(hover.x, hover.y);
        const b = selectionBounds();
        if ((b && inBox(wx, wy, b, 6 / view.scale)) || topHit(wx, wy, 6 / view.scale)) c = 'move';
      }
    }
  } else c = 'crosshair';
  canvas.style.cursor = c;
}

// ---------- View ----------

function viewChanged() {
  $('zoomLabel').textContent = Math.round(view.scale * 100) + '%';
  requestViewRender();
  scheduleSave();
}

function zoomAt(sx, sy, factor) {
  const s = clamp(view.scale * factor, MIN_SCALE, MAX_SCALE);
  const [wx, wy] = toWorld(sx, sy);
  view = { scale: s, x: sx - wx * s, y: sy - wy * s };
  viewChanged();
}

function zoomBy(factor) { zoomAt(stageRect.width / 2, stageRect.height / 2, factor); }
function resetZoom() { zoomAt(stageRect.width / 2, stageRect.height / 2, 1 / view.scale); }

function fitToContent() {
  if (!elements.length) { view = { x: 0, y: 0, scale: 1 }; viewChanged(); return; }
  const b = unionBounds(elements);
  const W = stageRect.width, H = stageRect.height;
  const s = clamp(Math.min((W - 120) / b.w, (H - 200) / b.h, 2), MIN_SCALE, MAX_SCALE);
  view = { scale: s, x: W / 2 - (b.x + b.w / 2) * s, y: H / 2 - (b.y + b.h / 2) * s };
  viewChanged();
}

// ---------- Layout: board / split / document ----------

function applyLayoutSize() {
  const mode = board.layout.mode;
  const docW = mode === 'split' ? Math.round(innerWidth * board.layout.split) : mode === 'doc' ? innerWidth : 0;
  document.documentElement.style.setProperty('--doc-w', docW + 'px');
  resizeCanvas();
  DocPane.refresh();
}

function setLayout(mode, split) {
  if (mode !== 'board' && !DocPane.hasDoc()) DocPane.load(blankDoc());
  board.layout = { mode, split: clamp(split ?? board.layout?.split ?? 0.5, 0.2, 0.8) };
  document.body.classList.remove('mode-board', 'mode-split', 'mode-doc');
  document.body.classList.add('mode-' + mode);
  const topbar = $('topbar');
  if (mode === 'board') document.body.append(topbar);
  else $('docHeader').prepend(topbar);
  for (const b of $('modeSeg').querySelectorAll('button')) b.classList.toggle('active', b.dataset.mode === mode);
  for (const b of document.querySelectorAll('[data-doc-only]')) b.hidden = !DocPane.hasDoc();
  if (mode === 'board' && DocPane.drawTool()) DocPane.setDrawTool(null); // its keys would still be live
  closePopovers();
  applyLayoutSize();
  scheduleReviewPanel();
  scheduleSave();
}

function blankDoc() {
  return { name: (board && board.name !== 'Untitled board' ? board.name : 'Untitled') + '.md', markdown: '', baseline: '', savedText: null, comments: [], lineAuthors: [] };
}

// ---------- Pointer input ----------

function pressureOf(e) {
  return e.pointerType === 'pen' && e.pressure > 0 ? e.pressure : 0.5;
}

function touchPoints() {
  return [...pointers.values()].filter(p => p.type === 'touch').slice(0, 2);
}

function startPinch() {
  const [a, b] = touchPoints();
  gesture = {
    kind: 'pinch',
    d0: Math.hypot(a.x - b.x, a.y - b.y) || 1,
    mx: (a.x + b.x) / 2,
    my: (a.y + b.y) / 2,
    v0: { ...view },
  };
}

function updatePinch() {
  const [a, b] = touchPoints();
  if (!b) return;
  const g = gesture;
  const s = clamp(g.v0.scale * Math.hypot(a.x - b.x, a.y - b.y) / g.d0, MIN_SCALE, MAX_SCALE);
  const wx = (g.mx - g.v0.x) / g.v0.scale, wy = (g.my - g.v0.y) / g.v0.scale;
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  view = { scale: s, x: mx - wx * s, y: my - wy * s };
  viewChanged();
}

function onPointerDown(e) {
  closePopovers();
  // The canvas cancels the mousedown that would normally end a text selection elsewhere;
  // end it here, or copy and cut would keep acting on that text.
  if (textSelected()) getSelection().removeAllRanges();
  const active = document.activeElement;
  if (active && active !== document.body && active !== editor) active.blur();
  if (editing) { commitEditor(); return; }
  if (e.pointerType === 'pen') sawPen = true;
  if (e.pointerType === 'touch' && gesture && gesture.pointerType === 'pen') return; // palm while writing

  const [sx, sy] = local(e);
  pointers.set(e.pointerId, { x: sx, y: sy, type: e.pointerType });
  try { canvas.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }

  if (e.pointerType === 'touch' && touchPoints().length >= 2) {
    cancelGesture();
    startPinch();
    return;
  }
  // A pen beats a touch that got there first (a resting palm panning the board).
  if (gesture && e.pointerType === 'pen' && (gesture.kind === 'pinch' || gesture.pointerType === 'touch')) cancelGesture();
  if (gesture) return;

  const [wx, wy] = toWorld(sx, sy);
  const penEraser = e.pointerType === 'pen' && (e.buttons & 32);
  const base = { pointerId: e.pointerId, pointerType: e.pointerType };

  if (e.button === 1 || e.button === 2 || spaceDown || settings.tool === 'hand' || (e.pointerType === 'touch' && sawPen)) {
    gesture = { ...base, kind: 'pan', sx, sy, vx: view.x, vy: view.y };
    updateCursor();
    return;
  }
  if (e.button !== 0 && !penEraser) return;

  switch (penEraser ? 'eraser' : settings.tool) {
    case 'pen':
    case 'highlighter': {
      const tool = settings.tool, s = settings[tool];
      const el = withAuthor({ id: uid(), type: 'stroke', color: s.color, size: s.size / view.scale, points: [[wx, wy, pressureOf(e)]] });
      if (tool === 'highlighter') el.highlighter = true;
      else if (e.pointerType === 'pen') el.pressure = true;
      elements.push(el);
      selection.clear();
      live.style.opacity = el.highlighter ? '0.4' : '';
      gesture = { ...base, kind: 'draw', el, builder: strokeBuilder(el, true), predicted: [] };
      break;
    }
    case 'eraser':
      gesture = { ...base, kind: 'erase', removed: false, last: [wx, wy] };
      eraseAt(wx, wy);
      break;
    case 'shape': {
      const s = settings.shape;
      const el = withAuthor({ id: uid(), type: 'shape', shape: s.kind, x1: wx, y1: wy, x2: wx, y2: wy, color: s.color, size: s.size / view.scale });
      if (s.fill && s.kind !== 'line' && s.kind !== 'arrow') el.fill = true;
      elements.push(el);
      selection.clear();
      gesture = { ...base, kind: 'shape', el };
      break;
    }
    case 'text': {
      const hit = topHit(wx, wy, 4 / view.scale, el => el.type === 'text');
      if (hit) openEditor(hit, false);
      else addText(wx, wy, '');
      break;
    }
    case 'note': {
      const hit = topHit(wx, wy, 0, el => el.type === 'note');
      if (hit) { openEditor(hit, false); break; }
      const size = 220 / view.scale;
      const el = withAuthor({ id: uid(), type: 'note', x: wx - size / 2, y: wy - size / 2, w: size, h: size, text: '', color: settings.note.color });
      elements.push(el);
      openEditor(el, true);
      break;
    }
    case 'select':
      startSelectGesture(e, base, sx, sy, wx, wy);
      break;
  }
  updateCursor();
  if (draftEl()) requestOverlay();
  else requestRender();
}

function startSelectGesture(e, base, sx, sy, wx, wy) {
  const handle = handleAt(sx, sy);
  if (handle >= 0) {
    const { b } = selectionFrame();
    const corners = [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]];
    gesture = { ...base, kind: 'resize', anchor: corners[(handle + 2) % 4], corner: corners[handle], orig: selectedMap(), changed: false };
    return;
  }
  const hit = topHit(wx, wy, 6 / view.scale);
  const b = selectionBounds();
  if (hit) {
    if (e.shiftKey) {
      if (selection.has(hit.id)) { selection.delete(hit.id); return; }
      selection.add(hit.id);
    } else if (!selection.has(hit.id)) {
      selection = new Set([hit.id]);
    }
  } else if (!(b && !e.shiftKey && inBox(wx, wy, b, 6 / view.scale))) {
    if (!e.shiftKey) selection.clear();
    gesture = { ...base, kind: 'lasso', pts: [[wx, wy]] };
    return;
  }
  gesture = { ...base, kind: 'move', wx, wy, sx, sy, orig: selectedMap(), changed: false };
}

function selectedMap() {
  const m = new Map();
  for (const el of elements) if (selection.has(el.id)) m.set(el.id, el);
  return m;
}

function onPointerMove(e) {
  const [sx, sy] = local(e);
  const p = pointers.get(e.pointerId);
  if (p) { p.x = sx; p.y = sy; }
  if (e.pointerType !== 'touch') hover = { x: sx, y: sy };
  const g = gesture;
  if (!g) {
    if (settings.tool === 'select') scheduleCursor();
    if (settings.tool === 'eraser') requestOverlay();
    return;
  }
  if (g.kind === 'pinch') { updatePinch(); return; }
  if (e.pointerId !== g.pointerId) return;

  const [wx, wy] = toWorld(sx, sy);
  switch (g.kind) {
    case 'pan':
      view.x = g.vx + sx - g.sx;
      view.y = g.vy + sy - g.sy;
      viewChanged();
      return;
    case 'draw': {
      const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
      for (const ce of events.length ? events : [e]) addPoint(g.el, ce);
      extendStroke(g.builder);
      g.predicted = predictedTail(g.el, e);
      requestOverlay();
      return;
    }
    case 'erase': {
      // Sample along the movement so fast swipes don't skip strokes.
      const [lx, ly] = g.last;
      const r = settings.eraser.size / 2 / view.scale;
      const steps = Math.max(1, Math.ceil(Math.hypot(wx - lx, wy - ly) / r));
      const before = elements;
      for (let i = 1; i <= steps; i++) eraseAt(lx + (wx - lx) * i / steps, ly + (wy - ly) * i / steps);
      g.last = [wx, wy];
      // Only a move that erased something changes the scene; otherwise just the cursor moves.
      if (elements !== before) requestRender();
      else requestOverlay();
      return;
    }
    case 'shape':
      updateShapeDraft(g.el, wx, wy, e.shiftKey);
      requestOverlay();
      return;
    case 'lasso': {
      const last = g.pts[g.pts.length - 1];
      if (Math.hypot(wx - last[0], wy - last[1]) * view.scale > 3) g.pts.push([wx, wy]);
      requestOverlay();
      return;
    }
    case 'move': {
      if (!g.changed && Math.hypot(sx - g.sx, sy - g.sy) < 3) return;
      g.changed = true;
      const dx = wx - g.wx, dy = wy - g.wy;
      elements = elements.map(el => g.orig.has(el.id) ? translated(g.orig.get(el.id), dx, dy) : el);
      break;
    }
    case 'resize': {
      const [ax, ay] = g.anchor, [cx, cy] = g.corner;
      const vx = cx - ax, vy = cy - ay;
      const s = Math.max(0.02, ((wx - ax) * vx + (wy - ay) * vy) / (vx * vx + vy * vy || 1));
      g.changed = true;
      elements = elements.map(el => g.orig.has(el.id) ? scaled(g.orig.get(el.id), ax, ay, s) : el);
      break;
    }
  }
  requestRender();
}

// A predicted point shortens the visible lag of the tail; it's never stored. Only the
// nearest one is used, and only when it carries on in the pen's direction and not much
// further than the last step: a prediction that overshoots and snaps back every frame
// makes the tip of the line jitter.
function predictedTail(el, e) {
  const pe = e.getPredictedEvents ? e.getPredictedEvents()[0] : null;
  const pts = el.points, a = pts[pts.length - 1], b = pts[pts.length - 2];
  if (!pe || !b) return [];
  const q = toWorld(...local(pe));
  const dx = q[0] - a[0], dy = q[1] - a[1], sx = a[0] - b[0], sy = a[1] - b[1];
  if (dx * sx + dy * sy <= 0 || Math.hypot(dx, dy) > 2 * Math.hypot(sx, sy)) return [];
  return [q];
}

function addPoint(el, ev) {
  const [x, y] = toWorld(...local(ev));
  const pts = el.points;
  const last = pts[pts.length - 1];
  if (Math.hypot(x - last[0], y - last[1]) * view.scale < 1) return;
  pts.push([x, y, last[2] * 0.5 + pressureOf(ev) * 0.5]);
}

function updateShapeDraft(el, wx, wy, constrain) {
  let dx = wx - el.x1, dy = wy - el.y1;
  if (constrain) {
    if (el.shape === 'line' || el.shape === 'arrow') {
      const step = Math.PI / 12;
      const a = Math.round(Math.atan2(dy, dx) / step) * step, len = Math.hypot(dx, dy);
      dx = Math.cos(a) * len;
      dy = Math.sin(a) * len;
    } else {
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      dx = Math.sign(dx || 1) * d;
      dy = Math.sign(dy || 1) * d;
    }
  }
  el.x2 = el.x1 + dx;
  el.y2 = el.y1 + dy;
  invalidate(el);
}

// The eraser removes whole ink strokes and shapes; notes, text and images need Delete.
function eraseAt(wx, wy) {
  const r = settings.eraser.size / 2 / view.scale;
  const erasable = el => (el.type === 'stroke' || el.type === 'shape') && hitTest(el, wx, wy, r);
  if (!elements.some(erasable)) return; // most samples hit nothing: don't copy the array
  elements = elements.filter(el => {
    if (!erasable(el)) return true;
    selection.delete(el.id);
    return false;
  });
  gesture.removed = true;
}

function onPointerUp(e) {
  pointers.delete(e.pointerId);
  const g = gesture;
  if (!g) return;
  if (g.kind === 'pinch') {
    if (touchPoints().length < 2) { gesture = null; updateCursor(); }
    return;
  }
  if (g.pointerId !== e.pointerId) return;
  gesture = null;
  switch (g.kind) {
    case 'draw':
      invalidate(g.el);
      finishStroke(g.builder);
      commit(g.el);
      // The stroke is on the scene now: clear the live layer in this same frame, so the
      // two never show it together (a highlighter would flash darker).
      if (sceneDirty) requestOverlay(); // the scene repaints next frame; clear together then
      else renderOverlay();
      break;
    case 'shape': {
      const [ax, ay] = toScreen(g.el.x1, g.el.y1), [bx, by] = toScreen(g.el.x2, g.el.y2);
      if (Math.abs(ax - bx) < 3 && Math.abs(ay - by) < 3) elements = elements.filter(el => el !== g.el);
      else commit(g.el);
      break;
    }
    case 'erase':
      if (g.removed) commit();
      break;
    case 'move':
    case 'resize':
      if (g.changed) commit();
      break;
    case 'lasso':
      finishLasso(g.pts);
      break;
  }
  updateCursor();
  requestOverlay();
}

function finishLasso(pts) {
  if (pts.length < 3) return;
  for (const el of elements) {
    const samples = samplePoints(el);
    let inside = 0;
    for (const [x, y] of samples) if (pointInPolygon(x, y, pts)) inside++;
    if (inside / samples.length >= 0.5) selection.add(el.id);
  }
}

canvas.addEventListener('pointerdown', onPointerDown);
canvas.addEventListener('pointermove', onPointerMove);
canvas.addEventListener('pointerup', onPointerUp);
canvas.addEventListener('pointercancel', onPointerUp);
canvas.addEventListener('lostpointercapture', onPointerUp); // otherwise the gesture never ends
canvas.addEventListener('pointerleave', () => { hover = null; requestOverlay(); });
canvas.addEventListener('mousedown', e => e.preventDefault()); // keep focus where it is (e.g. the text editor)
canvas.addEventListener('contextmenu', e => e.preventDefault());

canvas.addEventListener('dblclick', e => {
  if (settings.tool !== 'select' || editing) return;
  const [wx, wy] = toWorld(...local(e));
  const hit = topHit(wx, wy, 6 / view.scale);
  if (hit && (hit.type === 'text' || hit.type === 'note')) openEditor(hit, false);
  else if (!hit) addText(wx, wy, '');
});

canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? stageRect.height : 1;
  if (e.ctrlKey || e.metaKey) {
    zoomAt(...local(e), Math.exp(-e.deltaY * unit * 0.0025));
    return;
  }
  let dx = e.deltaX * unit, dy = e.deltaY * unit;
  if (e.shiftKey && !dx) { dx = dy; dy = 0; }
  view.x -= dx;
  view.y -= dy;
  viewChanged();
}, { passive: false });

// ---------- Text & note editing on the board ----------

function addText(wx, wy, text) {
  const size = settings.text.size / view.scale;
  const el = withAuthor({ id: uid(), type: 'text', x: wx, y: wy - size * 0.625, text, color: settings.text.color, size });
  elements.push(el);
  if (text) { commit(); return el; }
  openEditor(el, true);
  return el;
}

function openEditor(el, isNew) {
  editing = { id: el.id, isNew };
  selection.clear();
  editor.value = el.text || '';
  editor.className = el.type;
  editor.hidden = false;
  positionEditor();
  editor.focus();
  editor.setSelectionRange(editor.value.length, editor.value.length);
  setTimeout(() => { if (editing && document.activeElement !== editor) editor.focus(); });
  requestRender();
}

function positionEditor() {
  const el = findEl(editing.id);
  if (!el) return;
  const s = view.scale;
  const [sx, sy] = toScreen(el.x, el.y);
  const st = editor.style;
  st.left = sx + 'px';
  st.top = sy + 'px';
  const draft = { ...el, text: editor.value };
  if (el.type === 'note') {
    const L = noteLayout(draft);
    st.width = el.w * s + 'px';
    st.height = el.h * s + 'px';
    st.padding = notePad(el) * s + 'px';
    st.fontSize = L.size * s + 'px';
    st.background = el.color;
    st.color = '';
  } else {
    const L = textLayout(draft);
    st.width = (L.w + el.size) * s + 'px';
    st.height = L.h * s + 'px';
    st.padding = '0';
    st.fontSize = el.size * s + 'px';
    st.background = 'transparent';
    st.color = inkColor(el.color);
  }
}

function commitEditor() {
  if (!editing) return;
  const { id, isNew } = editing;
  editing = null;
  const text = editor.value;
  editor.hidden = true;
  const el = findEl(id);
  if (el) {
    if (el.type === 'text' && !text.trim()) {
      elements = elements.filter(x => x !== el);
      if (!isNew) commit();
    } else if (isNew || text !== el.text) {
      const next = isNew ? { ...el, text } : withAuthor({ ...el, text });
      elements = elements.map(x => x === el ? next : x);
      commit();
    }
  }
  requestRender();
}

editor.addEventListener('input', () => { positionEditor(); scheduleSave(); });
editor.addEventListener('blur', commitEditor);
editor.addEventListener('keydown', e => {
  e.stopPropagation();
  if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
    e.preventDefault();
    commitEditor();
  }
});

// ---------- Selection actions ----------

function selectAll() {
  setTool('select');
  selection = new Set(elements.map(el => el.id));
  requestRender();
}

function deleteSelection() {
  if (!selection.size) return;
  elements = elements.filter(el => !selection.has(el.id));
  selection.clear();
  commit();
}

function duplicateSelection() {
  const sel = selectedElements();
  if (!sel.length) return;
  const d = 20 / view.scale;
  const copies = sel.map(el => withAuthor({ ...translated(el, d, d), id: uid() }));
  elements.push(...copies);
  selection = new Set(copies.map(el => el.id));
  commit();
}

function reorderSelection(toFront) {
  if (!selection.size) return;
  const sel = elements.filter(el => selection.has(el.id));
  const rest = elements.filter(el => !selection.has(el.id));
  elements = toFront ? [...rest, ...sel] : [...sel, ...rest];
  commit();
}

function nudgeSelection(dx, dy) {
  if (!selection.size) return;
  elements = elements.map(el => selection.has(el.id) ? translated(el, dx / view.scale, dy / view.scale) : el);
  commit();
}

function recolorSelection(color, notesOnly) {
  elements = elements.map(el => {
    if (!selection.has(el.id) || el.type === 'image') return el;
    if ((el.type === 'note') !== notesOnly) return el;
    return { ...el, color };
  });
  commit();
}

function clearBoard() {
  closePopovers();
  if (!elements.length) return;
  elements = [];
  selection.clear();
  commit();
  toast('Board cleared', 'Undo', undo);
}

let selBarKey = '';
function updateSelBar() {
  const bar = $('selBar');
  const busy = gesture && ['move', 'resize', 'lasso'].includes(gesture.kind);
  const sel = settings.tool === 'select' && !editing && !busy ? selectedElements() : [];
  if (!sel.length) { bar.hidden = true; return; }
  const notesOnly = sel.every(el => el.type === 'note');
  const colorable = notesOnly || sel.some(el => el.type !== 'image' && el.type !== 'note');
  const hasInk = inkReady && sel.some(el => el.type === 'stroke' && !el.highlighter);
  const key = (notesOnly ? 'notes' : colorable ? 'ink' : 'plain') + (hasInk ? '+convert' : '');
  bar.hidden = false;
  if (key !== selBarKey) {
    selBarKey = key;
    fill(bar,
      colorable ? swatchRow(notesOnly ? NOTE_COLORS : INK_COLORS, null, c => recolorSelection(c, notesOnly), false) : null,
      colorable ? h('span', { class: 'sep' }) : null,
      hasInk ? h('button', { class: 'btn sm convert', title: 'Turn the selected handwriting into text', html: icon('toText') + 'To text', onclick: () => convertInk('text') }) : null,
      hasInk ? h('button', { class: 'btn sm convert', title: 'Turn drawn shapes into clean shapes', html: icon('toShape') + 'To shapes', onclick: () => convertInk('shapes') }) : null,
      hasInk ? h('span', { class: 'sep' }) : null,
      h('button', { class: 'icon-btn', title: 'Duplicate (Ctrl D)', html: icon('copy'), onclick: duplicateSelection }),
      h('button', { class: 'icon-btn', title: 'Bring to front', html: icon('front'), onclick: () => reorderSelection(true) }),
      h('button', { class: 'icon-btn', title: 'Send to back', html: icon('back'), onclick: () => reorderSelection(false) }),
      h('button', { class: 'icon-btn', title: 'Delete (Del)', html: icon('trash'), onclick: deleteSelection }),
    );
  }
  const f = selectionFrame();
  const bw = bar.offsetWidth, bh = bar.offsetHeight;
  const left = clamp(f.r.x + f.r.w / 2 - bw / 2, 8, stageRect.width - bw - 8);
  let top = f.r.y - bh - 12;
  if (top < 60) top = Math.min(f.r.y + f.r.h + 12, stageRect.height - bh - 80);
  bar.style.left = left + 'px';
  bar.style.top = Math.max(60, top) + 'px';
}

// ---------- Tools & popovers ----------

function setTool(tool, showOptions = false) {
  if (editing) commitEditor();
  settings.tool = tool;
  saveSettings();
  if (tool !== 'select') selection.clear();
  for (const btn of toolbarEl.querySelectorAll('[data-tool]')) btn.classList.toggle('active', btn.dataset.tool === tool);
  closePopovers();
  if (showOptions && TOOLS_WITH_OPTIONS.includes(tool)) openToolOptions(tool);
  updateCursor();
  requestRender();
}

function updateToolIndicators() {
  for (const tool of ['pen', 'highlighter', 'shape', 'text', 'note']) {
    const bar = toolbarEl.querySelector(`[data-tool="${tool}"] .tool-color`);
    if (bar) bar.style.background = settings[tool].color;
  }
}

function closePopovers() {
  for (const id of ['toolOptions', 'bgPanel', 'menu']) $(id).hidden = true;
  EmojiPicker.close();
}

// Places a popover next to an anchor element: above the toolbar by default, or below the anchor.
function placePopover(pop, anchor, below) {
  pop.hidden = false;
  const r = anchor.getBoundingClientRect();
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  if (below === 'right') pop.style.left = clamp(r.right - pw, 8, innerWidth - pw - 8) + 'px';
  else pop.style.left = clamp(r.left + r.width / 2 - pw / 2, 8, innerWidth - pw - 8) + 'px';
  if (below) pop.style.top = r.bottom + 8 + 'px';
  else pop.style.top = Math.max(8, toolbarEl.getBoundingClientRect().top - ph - 10) + 'px';
}

function swatchRow(colors, current, onPick, custom = true) {
  const row = h('div', { class: 'swatches' });
  const mark = target => row.querySelectorAll('.swatch').forEach(s => s.classList.toggle('active', s === target));
  for (const c of colors) {
    const active = current && c.toLowerCase() === current.toLowerCase();
    const b = h('button', { class: 'swatch' + (active ? ' active' : ''), style: `--c:${c}`, title: c, 'aria-label': c });
    b.addEventListener('click', () => { mark(b); onPick(c); });
    row.append(b);
  }
  if (custom) {
    const isCustom = current && !colors.some(c => c.toLowerCase() === current.toLowerCase());
    const label = h('label', { class: 'swatch custom' + (isCustom ? ' active' : ''), title: 'Custom color' });
    const input = h('input', { type: 'color', value: current || '#000000' });
    input.addEventListener('input', () => { mark(label); onPick(input.value); });
    label.append(input);
    row.append(label);
  }
  return row;
}

function sizeRow(label, min, max, value, onChange, color) {
  const dot = h('span');
  const paint = v => {
    const d = Math.min(v, 36);
    dot.style.width = dot.style.height = d + 'px';
  };
  const input = h('input', { type: 'range', min, max, value });
  input.addEventListener('input', () => { paint(+input.value); onChange(+input.value); });
  paint(value);
  return h('div', { class: 'row' }, h('label', {}, label), input, h('div', { class: 'size-preview', style: color ? `color:${color}` : '' }, dot));
}

function buildToolOptions(tool) {
  const s = settings[tool];
  const repaint = () => { saveSettings(); updateToolIndicators(); };
  const colorRow = colors => swatchRow(colors, s.color, c => {
    s.color = c;
    repaint();
    const prev = $('toolOptions').querySelector('.size-preview');
    if (prev) prev.style.color = c;
  });
  switch (tool) {
    case 'pen':
      return [h('div', { class: 'pop-title' }, 'Pen'), colorRow(INK_COLORS),
        sizeRow('Thickness', 1, 32, s.size, v => { s.size = v; saveSettings(); }, s.color)];
    case 'highlighter':
      return [h('div', { class: 'pop-title' }, 'Highlighter'), colorRow(HIGHLIGHT_COLORS),
        sizeRow('Thickness', 6, 60, s.size, v => { s.size = v; saveSettings(); }, s.color)];
    case 'eraser':
      return [h('div', { class: 'pop-title' }, 'Eraser'),
        sizeRow('Size', 6, 80, s.size, v => { s.size = v; saveSettings(); }),
        h('div', { class: 'row' }, h('button', { class: 'btn danger', html: icon('trash') + 'Clear board', onclick: clearBoard })),
        h('div', { class: 'pop-hint' }, 'Erases ink and shapes. Select notes, text and images to delete them.')];
    case 'shape': {
      const kinds = h('div', { class: 'seg' });
      for (const kind of SHAPE_KINDS) {
        const b = h('button', { class: kind === s.kind ? 'active' : '', title: kind[0].toUpperCase() + kind.slice(1), html: icon(kind) });
        b.addEventListener('click', () => {
          s.kind = kind;
          saveSettings();
          kinds.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
        });
        kinds.append(b);
      }
      const fill = h('input', { type: 'checkbox', checked: s.fill });
      fill.addEventListener('change', () => { s.fill = fill.checked; saveSettings(); });
      return [h('div', { class: 'pop-title' }, 'Shapes'), kinds, h('div', { class: 'row' }, colorRow(INK_COLORS)),
        sizeRow('Thickness', 1, 24, s.size, v => { s.size = v; saveSettings(); }, s.color),
        h('div', { class: 'row' }, h('label', { class: 'toggle' }, fill, 'Fill shapes')),
        h('div', { class: 'pop-hint' }, 'Hold Shift for squares, circles and straight lines.')];
    }
    case 'text':
      return [h('div', { class: 'pop-title' }, 'Text'), colorRow(INK_COLORS),
        sizeRow('Font size', 12, 120, s.size, v => { s.size = v; saveSettings(); })];
    case 'note':
      return [h('div', { class: 'pop-title' }, 'Sticky note'), swatchRow(NOTE_COLORS, s.color, c => { s.color = c; repaint(); }, false),
        h('div', { class: 'pop-hint' }, 'Click the board to add a note.')];
  }
  return [];
}

function openToolOptions(tool) {
  const pop = $('toolOptions');
  pop.replaceChildren(...buildToolOptions(tool));
  pop.dataset.tool = tool;
  placePopover(pop, toolbarEl.querySelector(`[data-tool="${tool}"]`));
}

function buildBgPanel() {
  const t = board.bg;
  const themes = h('div', { class: 'themes' });
  for (const [id, th] of Object.entries(THEMES)) {
    themes.append(h('button', {
      class: 'theme' + (t.theme === id ? ' active' : ''),
      onclick: () => { board.bg = { ...board.bg, theme: id }; applyTheme(); scheduleSave(); buildBgPanel(); },
    }, h('i', { style: `background:${th.color}` }), th.label));
  }
  const patterns = h('div', { class: 'seg' });
  for (const p of PATTERNS) {
    patterns.append(h('button', {
      class: t.pattern === p ? 'active' : '',
      onclick: () => { board.bg = { ...board.bg, pattern: p }; boardVersion++; requestRender(); scheduleSave(); buildBgPanel(); },
    }, p[0].toUpperCase() + p.slice(1)));
  }
  $('bgPanel').replaceChildren(h('div', { class: 'pop-title' }, 'Board color'), themes,
    h('div', { class: 'pop-title', style: 'margin-top:16px' }, 'Pattern'), patterns);
}

// Dark boards swap default black ink to white (and back) so ink stays visible.
function applyTheme() {
  const t = theme();
  boardVersion++;
  darkBoard = t.dark;
  document.body.classList.toggle('dark', t.dark);
  document.querySelector('meta[name=theme-color]').content = t.color;
  for (const key of ['pen', 'text', 'shape']) {
    const c = settings[key].color.toLowerCase();
    if (t.dark && c === DARK_INK) settings[key].color = LIGHT_INK;
    if (!t.dark && c === LIGHT_INK) settings[key].color = DARK_INK;
  }
  saveSettings();
  updateToolIndicators();
  requestRender();
}

// ---------- Toast ----------

let toastTimer = null;
function toast(message, actionLabel, action) {
  const t = $('toast');
  t.replaceChildren(h('span', {}, message));
  if (actionLabel) t.append(h('button', { onclick: () => { t.classList.remove('show'); action(); } }, actionLabel));
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), actionLabel ? 6000 : 3500);
}

// ---------- Your name ----------

function updateMe() {
  const btn = $('meBtn');
  if (settings.userName) {
    btn.innerHTML = '';
    btn.textContent = initials(settings.userName);
    btn.style.background = authorColor(settings.userName);
    btn.title = `You are ${settings.userName}. Click to change.`;
  } else {
    btn.innerHTML = icon('user');
    btn.style.background = '';
    btn.title = 'Set your name';
  }
}

let nameResolver = null;
async function askName() {
  closePopovers();
  const input = $('nameInput');
  input.value = settings.userName || (await Platform.userName()) || '';
  $('nameModal').hidden = false;
  setTimeout(() => { input.focus(); input.select(); });
  return new Promise(resolve => { nameResolver = resolve; });
}

function finishName(name) {
  $('nameModal').hidden = true;
  if (name) {
    settings.userName = name;
    saveSettings();
    updateMe();
  }
  if (nameResolver) { nameResolver(name || null); nameResolver = null; }
}

$('nameForm').addEventListener('submit', e => {
  e.preventDefault();
  finishName($('nameInput').value.trim().slice(0, 40));
});

async function ensureUserName() {
  return settings.userName || askName();
}

// ---------- Workspaces & persistence ----------

function makeThumb() {
  const bg = theme().color;
  if (elements.length) {
    const b = unionBounds(elements);
    const pad = Math.max(b.w, b.h) * 0.06;
    const region = { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 };
    return renderRegion(elements, region, 320, 200, bg).toDataURL('image/jpeg', 0.82);
  }
  if (!DocPane.hasDoc()) return null;
  // Document-only workspace: a little page with its first lines.
  const c = document.createElement('canvas');
  c.width = 320;
  c.height = 200;
  const g = c.getContext('2d');
  g.fillStyle = '#fbfbfa';
  g.fillRect(0, 0, 320, 200);
  g.fillStyle = '#3a3a3a';
  g.font = `12px ${FONT_FAMILY}`;
  DocPane.plainText().split('\n').slice(0, 11).forEach((line, i) => g.fillText(line.slice(0, 52), 16, 24 + i * 16));
  return c.toDataURL('image/jpeg', 0.82);
}

// Autosave waits for a quiet moment: not mid-stroke, and in idle time when it can.
const whenIdle = fn => (window.requestIdleCallback ? requestIdleCallback(fn, { timeout: 1500 }) : setTimeout(fn, 0));

// What saves store: the stroke or shape still being drawn is left out (it's mutated in
// place until the pen lifts), and text being typed in a note or text box goes in as it is.
function savedElements() {
  const draft = draftEl();
  if (!draft && !editing) return elements;
  const id = editing && editing.id, text = editor.value;
  return elements.filter(el => el !== draft).map(el => (el.id === id ? { ...el, text } : el));
}

function scheduleSave() {
  dirty = true;
  clearTimeout(saveTimer);
  // Encrypted workspaces re-seal everything on each save, so they save less often.
  saveTimer = setTimeout(() => {
    if (gesture) scheduleSave();
    else whenIdle(() => saveBoard(false));
  }, board && board.secure ? 4000 : 1000);
}


// `final`: leaving this workspace (switching, closing, hiding the window). Only then is the
// thumbnail redrawn: it renders the whole board, too slow to do after every stroke.
// Everything after an await uses `b`: the user may have switched workspaces meanwhile.
async function saveBoard(final = false) {
  clearTimeout(saveTimer);
  const b = board;
  if (!b || !dirty || (!b.saved && !elements.length && !DocPane.hasDoc())) return;
  dirty = false;
  const markSaved = () => { b.saved = true; if (board === b) localStorage.setItem('wb.last', b.id); };
  if (!board.thumb || (final && (thumbVersion !== boardVersion || !elements.length))) {
    board.thumb = makeThumb();
    thumbVersion = boardVersion;
  }
  const record = {
    id: board.id, name: board.name, bg: board.bg, layout: board.layout, filePath: board.filePath || null,
    view: { ...view }, doc: DocPane.serialize(), thumb: board.thumb, updated: Date.now(),
  };
  try {
    await DB.put(record, savedElements());
    markSaved();
  } catch (err) {
    console.warn('Autosave failed', err);
    if (!saveFailed) { saveFailed = true; toast('Autosave is unavailable here. Use Save workspace to keep your work.'); }
  }
}

function applyBoardRecord(rec, saved) {
  if (editing) { editing = null; editor.hidden = true; }
  gesture = null;
  board = {
    id: rec.id, name: rec.name || 'Untitled board', bg: { theme: 'white', pattern: 'dots', ...rec.bg },
    layout: { mode: 'board', split: 0.5, ...rec.layout }, saved, thumb: rec.thumb || null, filePath: rec.filePath || null,
    secure: rec.secure || null,
  };
  elements = (rec.elements || []).slice();
  view = rec.view ? { ...rec.view } : { x: 0, y: 0, scale: 1 };
  selection = new Set();
  undoStack = [elements.slice()];
  undoIndex = 0;
  for (const el of elements) if (el.type === 'image') getImage(el.src);
  $('boardName').value = board.name;
  document.title = board.name + ' – ZP Whiteboard';
  DocPane.load(rec.doc || null);
  applyTheme();
  setLayout(rec.doc ? board.layout.mode : 'board', board.layout.split);
  viewChanged();
  afterChange();
  thumbVersion = rec.thumb ? boardVersion : -1;
  clearTimeout(saveTimer); // loading a workspace is not an edit
  dirty = false;
}

function freshBoard(extra = {}) {
  return { id: uid(), name: 'Untitled board', bg: board ? { ...board.bg } : { theme: 'white', pattern: 'dots' }, elements: [], ...extra };
}

async function newBoard() {
  await saveBoard(true);
  applyBoardRecord(freshBoard(), false);
  toast('New board created');
}

async function newDocument() {
  await ensureUserName();
  await saveBoard(true);
  applyBoardRecord(freshBoard({ name: 'Untitled document', doc: { ...blankDoc(), name: 'Untitled.md' }, layout: { mode: 'split', split: 0.5 } }), false);
  scheduleSave();
  DocPane.focus();
}

// Sealed autosaves (encrypted workspaces) are opened with your keys first.
async function unsealRecord(rec) {
  if (!rec || !rec.sealed) return rec;
  if (!SECURE) { toast(FULL_EDITION_ONLY); return null; }
}

async function openBoard(id) {
  if (board && id === board.id) return;
  await saveBoard(true);
  try {
    const rec = await unsealRecord(await DB.get(id));
    if (rec) {
      applyBoardRecord(rec, true);
      localStorage.setItem('wb.last', rec.id);
    }
  } catch (err) {
    toast('Could not open that workspace');
  }
}

// toLocale*String with options builds a new formatter on every call (about 0.1 ms each,
// which adds up in long lists), so the formatters are made once.
const DATE_FMT = {
  time: new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' }),
  day: new Intl.DateTimeFormat([], { month: 'short', day: 'numeric' }),
  dayYear: new Intl.DateTimeFormat([], { month: 'short', day: 'numeric', year: 'numeric' }),
  full: new Intl.DateTimeFormat([], { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }),
};

function formatDate(ts) {
  if (!ts) return '';
  const d = new Date(ts), now = new Date();
  const time = DATE_FMT.time.format(d);
  if (d.toDateString() === now.toDateString()) return 'Today, ' + time;
  return (d.getFullYear() === now.getFullYear() ? DATE_FMT.day : DATE_FMT.dayYear).format(d) + ', ' + time;
}

// Date and time in full, for tooltips.
const fullDate = ts => DATE_FMT.full.format(new Date(ts));

async function showBoards() {
  closePopovers();
  await saveBoard(true);
  let list = [];
  try { list = await DB.list(); } catch { toast('Saved workspaces are unavailable in this browser mode'); }
  list.sort((a, b) => (b.updated || 0) - (a.updated || 0));
  const grid = $('boardsList');
  grid.replaceChildren(h('button', {
    class: 'board-card new',
    html: icon('plus') + '<span>New board</span>',
    onclick: () => { hideModals(); newBoard(); },
  }));
  for (const rec of list) {
    const meta = h('div', { class: 'meta' }, h('div', { class: 'name', title: rec.name }, rec.name || 'Untitled board'), h('div', { class: 'date' }, formatDate(rec.updated)));
    const del = h('button', { class: 'icon-btn del', title: 'Delete workspace', html: icon('trash') });
    const card = h('div', { class: 'board-card' + (board && rec.id === board.id ? ' current' : '') },
      h('button', { class: 'thumb', title: 'Open', onclick: () => { hideModals(); openBoard(rec.id); } },
        rec.thumb ? h('img', { src: rec.thumb, alt: '' }) : null),
      rec.doc ? h('span', { class: 'doc-tag' }, rec.doc.name) : null,
      meta, del);
    del.addEventListener('click', () => {
      meta.hidden = del.hidden = true;
      const confirmRow = h('div', { class: 'confirm' }, h('span', {}, 'Delete this workspace?'),
        h('button', { class: 'btn', onclick: () => { confirmRow.remove(); meta.hidden = del.hidden = false; } }, 'Cancel'),
        h('button', { class: 'btn danger', onclick: () => deleteBoard(rec.id) }, 'Delete'));
      card.append(confirmRow);
    });
    grid.append(card);
  }
  $('boardsModal').hidden = false;
}

async function deleteBoard(id) {
  try { await DB.remove(id); } catch { toast('Could not delete that workspace'); return; }
  if (localStorage.getItem('wb.last') === id) localStorage.removeItem('wb.last');
  if (board && id === board.id) applyBoardRecord(freshBoard(), false);
  showBoards();
}

function hideModals() {
  for (const m of document.querySelectorAll('.modal')) m.hidden = true;
  if (nameResolver) { nameResolver(null); nameResolver = null; }
  if (importResolver) { importResolver(null); importResolver = null; }
}

// ---------- Files: Markdown, workspaces, export ----------

function safeFileName(name) {
  return (name || 'whiteboard').replace(/[\\/:*?"<>|]+/g, '-').trim() || 'whiteboard';
}

let importResolver = null;
function chooseImportTarget(fileName) {
  $('importTitle').textContent = `Open “${fileName}”`;
  $('importCurrentHint').textContent = DocPane.hasDoc()
    ? `Replaces the document currently open (${DocPane.info().name}); keeps your drawings.`
    : 'Keeps your current drawings next to the document.';
  $('importModal').hidden = false;
  setTimeout(() => $('importModal').querySelector('.choice').focus());
  return new Promise(resolve => { importResolver = resolve; });
}

for (const btn of document.querySelectorAll('#importModal [data-choice]')) {
  btn.addEventListener('click', () => {
    $('importModal').hidden = true;
    if (importResolver) { importResolver(btn.dataset.choice); importResolver = null; }
  });
}

async function importMarkdown(file) {
  const hasStuff = elements.length || DocPane.hasDoc();
  const target = hasStuff ? await chooseImportTarget(file.name) : 'current';
  if (!target) return;
  await ensureUserName();
  const doc = { name: file.name, filePath: file.path || null, markdown: file.text, baseline: file.text, savedText: file.text, comments: [], lineAuthors: [] };
  if (target === 'new') {
    await saveBoard(true);
    applyBoardRecord(freshBoard({ name: stripExt(file.name), doc, layout: { mode: 'split', split: board.layout.split } }), false);
  } else {
    DocPane.load(doc);
    if (!elements.length && board.name === 'Untitled board') {
      board.name = stripExt(file.name);
      $('boardName').value = board.name;
      document.title = board.name + ' – ZP Whiteboard';
    }
    setLayout(board.layout.mode === 'board' ? 'split' : board.layout.mode);
  }
  scheduleSave();
  toast(`Opened ${file.name}`);
}

const ELEMENT_TYPES = new Set(['stroke', 'shape', 'text', 'note', 'image']);

function parseWorkspace(text) {
  const data = JSON.parse(text);
  if (!data || !Array.isArray(data.elements)) throw new Error('not a workspace');
  return data;
}

// Elements from a file are untrusted: keep known types with sane numbers only.
function cleanElements(list) {
  const finite = v => typeof v === 'number' && Number.isFinite(v);
  return (Array.isArray(list) ? list : []).filter(el => {
    if (!el || !ELEMENT_TYPES.has(el.type)) return false;
    switch (el.type) {
      case 'stroke': return Array.isArray(el.points) && el.points.length > 0 && el.points.every(p => Array.isArray(p) && finite(p[0]) && finite(p[1])) && finite(el.size);
      case 'shape': return ['x1', 'y1', 'x2', 'y2', 'size'].every(k => finite(el[k]));
      case 'text': return finite(el.x) && finite(el.y) && finite(el.size) && typeof el.text === 'string';
      case 'image': return finite(el.x) && finite(el.y) && finite(el.w) && finite(el.h) && /^data:image\//.test(el.src || '');
      default: return finite(el.x) && finite(el.y) && finite(el.w) && finite(el.h);
    }
  }).map(el => {
    // Fields the renderer relies on, so one bad element can't break every frame.
    const out = { ...el, id: typeof el.id === 'string' ? el.id : uid() };
    if (el.type !== 'image' && !/^#[0-9a-f]{3,8}$/i.test(out.color)) out.color = el.type === 'note' ? NOTE_COLORS[0] : '#1f1f1f';
    if (el.type === 'note' && typeof out.text !== 'string') out.text = '';
    if (el.type === 'stroke') out.points = el.points.map(([x, y, pr]) => [x, y, finite(pr) ? pr : 0.5]);
    return out;
  });
}

async function openWorkspaceData(data, file, secure = null) {
  await saveBoard(true);
  const els = cleanElements(data.elements);
  const name = data.name || stripExt(file.name);
  // A path inside the file is where its sender saved their Markdown, not a place to write to.
  const doc = data.doc ? { ...data.doc, filePath: null } : null;
  applyBoardRecord({
    id: uid(), name, bg: data.bg, elements: els, doc, layout: data.layout,
    filePath: !secure && Platform.desktop && /\.wbdoc$/i.test(file.path || '') ? file.path : null,
    secure: secure ? { path: file.path || null, signer: secure.signer } : null,
  }, false);
  if (els.length) fitToContent();
  scheduleSave();
  toast(`Opened “${name}”` + (data.savedBy ? ` (saved by ${data.savedBy})` : ''));
}

async function openWorkspaceFile(file) {
  let data;
  try { data = parseWorkspace(file.text); } catch { toast('That file is not a ZP Whiteboard workspace'); return; }
  await openWorkspaceData(data, file);
}


async function openAny(file) {
  if (!file) return;
  if (MD_EXT.test(file.name)) return importMarkdown(file);
  if ((SECURE_EXT.test(file.name) || KEY_EXT.test(file.name)) && !SECURE) { toast(FULL_EDITION_ONLY); return; }
  if (WORKSPACE_EXT.test(file.name)) return openWorkspaceFile(file);
  toast(SECURE ? 'Open a .md, .swbdx or .wbdoc file' : 'Open a .md or .wbdoc file');
}

// ---------- Export: Word, PDF, HTML, Markdown ----------

async function exportDocument() {
  closePopovers();
  if (!DocPane.hasDoc() && !elements.length) { toast('Nothing to export yet: open a document or draw something'); return; }
  await DocPane.flushWrite();
  const hasDoc = DocPane.hasDoc();
  const model = hasDoc ? DocPane.exportModel() : { name: board.name + '.md', text: '', comments: [], suggestions: [] };
  const hasReview = model.comments.length > 0 || model.suggestions.length > 0;
  const format = { value: 'docx' };
  const fmtSeg = h('div', { class: 'seg' });
  const formats = [['docx', 'Word (.docx)'], ['pdf', 'PDF'], ['html', 'Web page'], ...(hasDoc ? [['md', 'Markdown']] : [])];
  const modeMarkup = h('input', { type: 'radio', name: 'xmode', checked: hasReview });
  const modeFinal = h('input', { type: 'radio', name: 'xmode', checked: !hasReview });
  const withBoard = h('input', { type: 'checkbox', checked: !hasDoc || elements.length > 0, disabled: !elements.length });
  const withInk = h('input', { type: 'checkbox', checked: true });
  const note = h('p', { class: 'muted' });
  const refresh = () => {
    fmtSeg.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.f === format.value));
    const notes = {
      docx: 'Comments, replies and resolved threads become Word comments; suggestions become tracked changes you can accept in Word.',
      pdf: Platform.desktop ? 'A print-ready PDF. Comments are listed at the end, numbered where they’re anchored.' : 'Opens the print dialog: choose “Save as PDF”.',
      html: 'A single self-contained web page.',
      md: 'Plain Markdown with every suggestion accepted (Markdown can’t hold comments).',
    };
    const inkBlocked = modeFinal.checked && model.suggestions.length > 0;
    const inkFormat = format.value === 'pdf' || format.value === 'html';
    note.textContent = notes[format.value] + (inkBlocked && inkFormat && DocPane.hasInk() ? ' Ink isn’t included in Final while there are pending suggestions.' : '');
    modeMarkup.disabled = format.value === 'md';
    withInk.disabled = !inkFormat || inkBlocked;
  };
  modeMarkup.addEventListener('change', () => refresh());
  modeFinal.addEventListener('change', () => refresh());
  for (const [f, label] of formats) fmtSeg.append(h('button', { 'data-f': f, onclick: () => { format.value = f; refresh(); } }, label));
  refresh();
  dialog({
    title: 'Export',
    body: [
      h('div', { class: 'pop-title' }, 'Format'), fmtSeg, note,
      hasDoc ? h('div', { class: 'pop-title', style: 'margin-top:14px' }, 'Content') : null,
      hasDoc ? h('label', { class: 'toggle' }, modeMarkup, 'With comments and suggestions (markup)') : null,
      hasDoc ? h('label', { class: 'toggle', style: 'margin-top:6px' }, modeFinal, 'Final: suggestions accepted, no comments') : null,
      h('label', { class: 'toggle', style: 'margin-top:14px' }, withBoard, 'Include the board sketch'),
      hasDoc ? h('label', { class: 'toggle', style: 'margin-top:6px' }, withInk, 'Include ink drawn on the document (PDF and web page)') : null,
    ],
    actions: [
      { label: 'Cancel' },
      {
        label: 'Export', primary: true,
        onClick: () => runExport(model, {
          format: format.value,
          mode: modeMarkup.checked && format.value !== 'md' ? 'markup' : 'final',
          boardPng: withBoard.checked && elements.length ? boardCanvas().toDataURL('image/png') : null,
          ink: withInk.checked,
        }),
      },
    ],
  });
}

async function runExport(model, { format, mode, boardPng, ink }) {
  const base = safeFileName(stripExt(model.name || board.name));
  // Ink anchors are line numbers in the text as it stands, so they only fit where no
  // suggested deletion has been taken out.
  const inkFor = ink && (mode === 'markup' || !model.suggestions.length) ? DocPane.inkSvgFor : null;
  try {
    let res;
    if (format === 'docx') {
      const bytes = Exporter.docx(model, { mode, boardPng, author: settings.userName });
      res = await Platform.saveFile({ name: base + '.docx', data: bytes, kind: 'docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    } else if (format === 'html' || format === 'pdf') {
      const html = Exporter.html({ ...model, exportedBy: settings.userName }, { mode, inkFor, boardPng, title: stripExt(model.name || board.name) });
      if (format === 'html') res = await Platform.saveFile({ name: base + '.html', data: html, kind: 'html', type: 'text/html' });
      else {
        const pdf = await Platform.pdf(html);
        if (!pdf) return true; // browser: the print dialog took over
        res = await Platform.saveFile({ name: base + '.pdf', data: pdf, kind: 'pdf', type: 'application/pdf' });
      }
    } else {
      res = await Platform.saveFile({ name: base + '.md', data: DocPane.text(), kind: 'md', type: 'text/markdown' });
    }
    if (!res) return false;
    toast(res === 'downloaded' ? 'Exported' : `Exported ${Platform.baseName(res)}`, Platform.desktop ? 'Show in folder' : null, () => Platform.showInFolder(res));
    return true;
  } catch (err) {
    toast('Export failed: ' + (err.message || err));
    return false;
  }
}

// ---------- Merge a reviewed copy ----------

async function mergeFromCopy() {
  closePopovers();
  if (!DocPane.hasDoc()) return;
  let file;
  try { file = await Platform.open('any'); } catch (err) { toast(err.message); return; }
  if (!file) return;
  let data = null;
  if (SECURE_EXT.test(file.name) && !SECURE) { toast(FULL_EDITION_ONLY); return; }
  try {
    if (WORKSPACE_EXT.test(file.name)) data = parseWorkspace(file.text);
  } catch (err) {
    toast('That file is not a ZP Whiteboard workspace');
    return;
  }
  if (!data || !data.doc) { toast('That file has no document with comments in it'); return; }
  const { added, updated } = DocPane.mergeReview(data.doc);
  toast(added || updated ? `Merged: ${added} new comment thread${added === 1 ? '' : 's'}, ${updated} updated` : 'Nothing new to merge');
}

// ---------- Handwriting and shapes ----------

async function convertInk(mode) {
  const strokes = selectedElements().filter(el => el.type === 'stroke' && !el.highlighter);
  if (!strokes.length) return;
  let res;
  try {
    res = await Platform.recognizeInk(strokes.map(el => el.points.map(p => [p[0], p[1], p[2] == null ? 0.5 : p[2]])), mode === 'text' ? 'text' : 'auto');
  } catch (err) { toast(err.message || 'Recognition failed'); return; }
  const used = new Set();
  const created = [];
  if (mode === 'text') {
    const lines = (res.lines || []).filter(l => l.text.trim()).sort((p, q) => p.rect[1] - q.rect[1] || p.rect[0] - q.rect[0]);
    if (!lines.length) { toast('Couldn’t read that handwriting'); return; }
    const avgH = lines.reduce((s, l) => s + l.rect[3], 0) / lines.length;
    const size = Math.max(8 / view.scale, avgH / 1.25);
    const x = Math.min(...lines.map(l => l.rect[0])), y = Math.min(...lines.map(l => l.rect[1]));
    created.push(withAuthor({ id: uid(), type: 'text', x, y, text: lines.map(l => l.text).join('\n'), color: strokes[0].color, size }));
    for (const l of lines) for (const i of l.strokes) used.add(strokes[i]);
  } else {
    const KIND = { rectangle: 'rect', square: 'rect', quadrilateral: 'rect', circle: 'ellipse', ellipse: 'ellipse', triangle: 'triangle' };
    for (const d of res.drawings || []) {
      const shape = KIND[d.kind];
      if (!shape) continue;
      const [x, y, w, hh] = d.rect;
      const src = strokes[d.strokes[0]];
      created.push(withAuthor({ id: uid(), type: 'shape', shape, x1: x, y1: y, x2: x + w, y2: y + hh, color: src.color, size: src.size }));
      for (const i of d.strokes) used.add(strokes[i]);
    }
    if (!created.length) { toast('No shapes recognized. Try drawing rectangles, circles or triangles in one stroke.'); return; }
  }
  elements = elements.filter(el => !used.has(el)).concat(created);
  selection = new Set(created.map(el => el.id));
  commit();
  toast(mode === 'text' ? `Converted to “${created[0].text.length > 40 ? created[0].text.slice(0, 40) + '…' : created[0].text}”` : `Converted ${created.length} shape${created.length === 1 ? '' : 's'}`, 'Undo', undo);
}

// ---------- Emoji ----------

function insertEmojiOnBoard(emoji) {
  const size = 72 / view.scale;
  const [cx, cy] = hover ? toWorld(hover.x, hover.y) : viewCenter();
  const el = withAuthor({ id: uid(), type: 'text', x: cx - size * 0.6, y: cy - size * 0.625, text: emoji, color: DARK_INK, size });
  elements.push(el);
  setTool('select');
  selection = new Set([el.id]);
  commit();
}

async function openFromDialog() {
  closePopovers();
  try { await openAny(await Platform.open('any')); } catch (err) { toast(err.message || 'Could not open that file'); }
}

// Saving an encrypted workspace in the clear is allowed, but never by accident.
function confirmPlaintext(what) {
  return Promise.resolve('plain');
}

async function saveMarkdown() {
  closePopovers();
  if (!DocPane.hasDoc()) return saveWorkspace();
  await DocPane.flushWrite();
  const info = DocPane.info();
  if (!info.filePath) {
    const how = await confirmPlaintext('Markdown (.md)');
    if (!how) return false;
  }
  try {
    const res = await Platform.saveText({ path: info.filePath, name: info.name, text: DocPane.text(), kind: 'md', type: 'text/markdown' });
    if (!res) return false;
    if (res === 'downloaded') { DocPane.markSaved(null, null); toast(`Downloaded ${info.name}`); }
    else { DocPane.markSaved(res, Platform.baseName(res)); toast(`Saved ${Platform.baseName(res)}`); }
    scheduleSave();
    return true;
  } catch (err) {
    toast('Could not save: ' + (err.message || err));
    return false;
  }
}

// `forFile`: for a file someone else may open, so the document's local path
// (where Save Markdown writes) stays out of it.
function workspaceData(forFile = false) {
  const doc = DocPane.serialize();
  if (forFile && doc) delete doc.filePath;
  return {
    format: 'whiteboard-workspace',
    version: 3,
    name: board.name,
    savedBy: settings.userName || undefined,
    savedAt: new Date().toISOString(),
    layout: board.layout,
    view: { ...view },
    doc,
    bg: board.bg,
    elements: savedElements(),
  };
}

async function saveWorkspace() {
  closePopovers();
  const how = await confirmPlaintext('a .wbdoc workspace');
  if (!how) return;
  try {
    const res = await Platform.saveText({
      path: board.filePath, name: safeFileName(board.name) + '.wbdoc', kind: 'wbdoc',
      text: JSON.stringify(workspaceData(true)), type: 'application/json',
    });
    if (!res) return;
    if (res !== 'downloaded') { board.filePath = res; scheduleSave(); }
    toast(res === 'downloaded' ? 'Workspace downloaded' : `Saved ${Platform.baseName(res)}`);
  } catch (err) {
    toast('Could not save: ' + (err.message || err));
  }
}

function boardCanvas() {
  if (!elements.length) return null;
  const b = unionBounds(elements);
  const pad = Math.max(24 / view.scale, Math.max(b.w, b.h) * 0.03);
  const region = { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 };
  // At least 2px per world unit, at least ~2000px on the long side, at most 8192px.
  const longSide = Math.max(region.w, region.h);
  const s = Math.min(8192 / longSide, Math.max(2, 2000 / longSide));
  return renderRegion(elements, region, region.w * s, region.h * s, theme().color);
}

function exportPNG() {
  closePopovers();
  const c = boardCanvas();
  if (!c) { toast('Nothing on the board to export yet'); return; }
  c.toBlob(blob => Platform.download(blob, safeFileName(board.name) + '.png'), 'image/png');
}

// Text found on the board (notes, text boxes) plus a count of everything else.
function boardSummary() {
  const items = elements.filter(el => (el.type === 'note' || el.type === 'text') && el.text && el.text.trim())
    .map(el => ({ el, b: getBounds(el) }))
    .sort((p, q) => p.b.y - q.b.y || p.b.x - q.b.x)
    // The text is quoted verbatim (identifiers and all) under its item.
    .flatMap(({ el }) => [`- ${el.type === 'note' ? 'Sticky note' : 'Text'}${el.author ? ' by ' + Review.mdLabel(el.author) : ''}:`, '', ...Review.mdQuote(el.text.trim(), '  '), '']);
  const count = (type, filter = () => true) => elements.filter(el => el.type === type && filter(el)).length;
  const others = [
    [count('stroke', el => !el.highlighter), 'ink stroke'],
    [count('stroke', el => el.highlighter), 'highlighter stroke'],
    [count('shape'), 'shape'],
    [count('image'), 'image'],
  ].filter(([n]) => n).map(([n, label]) => `${n} ${label}${n === 1 ? '' : 's'}`);
  return { items, others };
}

function buildReview(pngName) {
  const out = [];
  const sections = DocPane.hasDoc() ? DocPane.reviewSections() : null;
  const title = sections ? sections.title : Review.mdCode(board.name);
  out.push(`# Review bundle: ${title}`, '');
  out.push(`Exported from ZP Whiteboard by ${Review.mdLabel(settings.userName) || 'unknown'} on ${stamp(Date.now())}.`);
  if (sections && sections.contributors.size) {
    const who = [...sections.contributors].map(([name, c]) => {
      const bits = [];
      if (c.lines) bits.push(`${c.lines} line${c.lines === 1 ? '' : 's'} edited`);
      if (c.comments) bits.push(`${c.comments} comment${c.comments === 1 ? '' : 's'}`);
      return `${Review.mdLabel(name)} (${bits.join(', ')})`;
    });
    out.push(`Contributors: ${who.join('; ')}.`);
  }
  out.push('', '> For the reader (an AI model or agent such as Claude Code, or a person): ' + [
    sections ? 'comments and changes below point at line numbers in the "Current document" section at the end' : null,
    sections ? '"Changes since import" is a unified diff against the version originally opened, with who edited each hunk' : null,
    pngName ? `the sketch on the whiteboard is the image \`${pngName}\` next to this file` : null,
  ].filter(Boolean).join('; ') + '.', '');

  if (sections) out.push(sections.body.trimEnd(), '');

  const { items, others } = boardSummary();
  if (pngName || items.length) {
    out.push('## Board sketch', '');
    if (pngName) out.push(`![Board sketch](${encodeURI(pngName)})`, '');
    if (items.length) out.push('Text on the board (top to bottom):', '', ...items, '');
    if (others.length) out.push(`Also on the board: ${others.join(', ')}.`, '');
  }

  // The document goes last and verbatim (no blank-line squashing inside it).
  return out.join('\n').replace(/\n{3,}/g, '\n\n') + (sections ? '\n' + sections.document : '');
}

async function exportForAI() {
  closePopovers();
  if (!DocPane.hasDoc() && !elements.length) { toast('Nothing to export yet: open a document or draw something'); return; }
  await ensureUserName();
  const base = safeFileName(DocPane.hasDoc() ? stripExt(DocPane.info().name) : board.name);
  const pngCanvas = boardCanvas();
  try {
    if (Platform.desktop) {
      const docPath = DocPane.hasDoc() && DocPane.info().filePath;
      const defaultPath = (docPath ? Platform.dirOf(docPath) : '') + base + '.review.md';
      const mdPath = await Platform.saveDialog(defaultPath, 'review');
      if (!mdPath) return;
      const stem = Platform.baseName(mdPath).replace(/(\.review)?\.md$/i, '');
      const pngName = pngCanvas ? stem + '.board.png' : null;
      await Platform.writeText(mdPath, buildReview(pngName));
      let pngPath = null;
      if (pngName) {
        pngPath = Platform.dirOf(mdPath) + pngName;
        await Platform.writeBase64(pngPath, pngCanvas.toDataURL('image/png').split(',')[1]);
      }
      const prompt = `Please read the ZP Whiteboard review bundle at ${mdPath}` +
        (pngPath ? ` and look at the board sketch ${pngPath}` : '') +
        '. Address the open comments and take the changes and the sketch into account.';
      let copied = false;
      try { await navigator.clipboard.writeText(prompt); copied = true; } catch { /* clipboard unavailable */ }
      toast(copied ? 'Exported. A prompt for your AI assistant is on your clipboard.' : `Exported ${Platform.baseName(mdPath)}`,
        'Show in folder', () => Platform.showInFolder(mdPath));
    } else {
      const pngName = pngCanvas ? base + '.board.png' : null;
      Platform.download(new Blob([buildReview(pngName)], { type: 'text/markdown' }), base + '.review.md');
      if (pngCanvas) pngCanvas.toBlob(blob => Platform.download(blob, pngName), 'image/png');
      toast(`Downloaded ${base}.review.md${pngName ? ' and ' + pngName : ''}. Keep them in the same folder.`);
    }
  } catch (err) {
    toast('Export failed: ' + (err.message || err));
  }
}

// ---------- Review panel ----------

// The Review tab on the toolbar: the document's comments and suggestions (with who edited
// which lines), and what's on the board by author, next to the board in any layout.
let reviewTab = 'comments', reviewFrame = 0;

function toggleReviewPanel(show = $('reviewPanel').hidden) {
  $('reviewPanel').hidden = !show;
  $('reviewTabBtn').classList.toggle('active', show);
  $('reviewTabBtn').setAttribute('aria-pressed', show);
  if (show) renderReviewPanel();
}

// Edits and strokes refresh the panel when the app is idle, not in the frame that has to
// show the keystroke or the ink.
function scheduleReviewPanel() {
  if (reviewFrame || $('reviewPanel').hidden) return;
  reviewFrame = whenIdle(() => { reviewFrame = 0; renderReviewPanel(); });
}

// Board items people wrote or drew, grouped by author.
function boardAuthors() {
  const by = new Map();
  for (const el of elements) {
    const who = el.author || 'Unknown';
    if (!by.has(who)) by.set(who, []);
    by.get(who).push(el);
  }
  return by;
}

// The tabs and the list are only rebuilt when what they show changed: typing that doesn't
// move a comment, or a stroke while the Comments tab is open, leaves the DOM alone.
let reviewTabsSig = '', reviewBodySig = '';

function renderReviewPanel() {
  if ($('reviewPanel').hidden) { reviewTabsSig = reviewBodySig = ''; return; }
  const hasDoc = DocPane.hasDoc();
  const data = hasDoc ? DocPane.panelData() : null;
  const counts = data ? data.counts : { open: 0, resolved: 0, pending: 0 };
  const showResolved = $('reviewShowResolved').checked;
  const tabs = [['comments', 'Comments', counts.open], ['changes', 'Changes', counts.pending], ['board', 'Board', elements.length]];
  const tabsSig = JSON.stringify([reviewTab, tabs]);
  if (tabsSig !== reviewTabsSig) {
    reviewTabsSig = tabsSig;
    const refocus = $('reviewTabs').contains(document.activeElement);
    fill($('reviewTabs'), tabs.map(([id, label, n]) => h('button', {
      class: 'rp-tab' + (reviewTab === id ? ' active' : ''), role: 'tab', 'aria-selected': String(reviewTab === id),
      'aria-controls': 'reviewBody', tabindex: reviewTab === id ? '0' : '-1', 'data-tab': id,
      onclick: () => { reviewTab = id; renderReviewPanel(); },
    }, label, n ? h('span', { class: 'rp-count' }, String(n)) : null)));
    if (refocus) $('reviewTabs').querySelector('.rp-tab.active').focus();
  }
  $('reviewResolvedToggle').hidden = reviewTab !== 'comments' || !counts.resolved;
  // Relative times ("5m ago") change by the minute.
  const bodySig = JSON.stringify([reviewTab, showResolved, hasDoc, Math.floor(Date.now() / 60000),
    reviewTab === 'board' ? boardVersion : data && data.sig[reviewTab]]);
  if (bodySig === reviewBodySig) return;
  reviewBodySig = bodySig;
  const body = $('reviewBody');
  const scroll = body.scrollTop;
  const focusables = () => [...body.querySelectorAll('[tabindex="0"], button')];
  const focusAt = body.contains(document.activeElement) ? focusables().indexOf(document.activeElement) : -1;
  if (reviewTab === 'board') fill(body, boardReviewList());
  else if (!hasDoc) {
    fill(body, h('div', { class: 'rp-empty' }, 'Comments and suggestions live in a document. ',
      h('button', { class: 'link', onclick: () => setLayout('split') }, 'Start a document next to this board'), '.'));
  } else {
    fill(body, DocPane.panelList(reviewTab, { open: openReviewItem, showResolved, data }));
  }
  body.scrollTop = scroll;
  if (focusAt >= 0) {
    const list = focusables();
    // Keep focus in the panel even when the list emptied, so Escape still closes it.
    if (list.length) list[Math.min(focusAt, list.length - 1)].focus({ preventScroll: true });
    else $('reviewPanel').focus({ preventScroll: true });
  }
}

function openReviewItem(target) {
  if (board.layout.mode === 'board') setLayout('split');
  DocPane.openItem(target);
}

function boardReviewList() {
  if (!elements.length) return [h('div', { class: 'rp-empty' }, 'Nothing on the board yet.')];
  const kinds = [['note', 'note'], ['text', 'text'], ['stroke', 'ink stroke'], ['shape', 'shape'], ['image', 'image']];
  const out = [];
  for (const [who, list] of [...boardAuthors()].sort((a, b) => b[1].length - a[1].length)) {
    const parts = kinds.map(([type, label]) => [list.filter(el => el.type === type).length, label])
      .filter(([n]) => n).map(([n, label]) => `${n} ${label}${n === 1 ? '' : 's'}`);
    out.push(h('div', { class: 'rp-section' }, who), h('div', { class: 'rp-summary' }, parts.join(', ')));
    const texts = list.filter(el => (el.type === 'note' || el.type === 'text') && el.text && el.text.trim())
      .sort((p, q) => getBounds(p).y - getBounds(q).y || getBounds(p).x - getBounds(q).x);
    for (const el of texts) {
      const text = el.text.trim().replace(/\s*\n\s*/g, ' / ');
      const row = h('div', { class: 'rp-item', style: `--author:${el.type === 'note' ? el.color : authorColor(who)}`, tabindex: '0', role: 'button', title: 'Show on the board' },
        h('div', { class: 'rp-meta' }, h('b', {}, el.type === 'note' ? 'Sticky note' : 'Text')),
        h('div', { class: 'cm-card-text' }, text.length > 200 ? text.slice(0, 200) + '…' : text));
      row.addEventListener('click', () => showElement(el));
      row.addEventListener('keydown', e => { if (e.key === 'Enter') showElement(el); });
      out.push(row);
    }
  }
  return out;
}

// Centers an element in the part of the board the Review panel leaves visible (zooming
// out if it doesn't fit) and selects it.
function showElement(el) {
  const panel = $('reviewPanel').getBoundingClientRect();
  const covered = panel.width && panel.width < stageRect.width / 2 ? stageRect.left + stageRect.width - panel.left : 0;
  const b = getBounds(el), W = stageRect.width - covered, H = stageRect.height;
  const s = clamp(Math.min(view.scale, (W - 160) / Math.max(b.w, 1), (H - 200) / Math.max(b.h, 1)), MIN_SCALE, MAX_SCALE);
  view = { scale: s, x: W / 2 - (b.x + b.w / 2) * s, y: H / 2 - (b.y + b.h / 2) * s };
  viewChanged();
  setTool('select');
  selection = new Set([el.id]);
  requestOverlay();
}

// ---------- Images & clipboard ----------

function readImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function insertImageFile(file, at, index = 0) {
  let img;
  try { img = await readImage(file); } catch { toast('Could not read that image'); return; }
  let src = img.src;
  let nw = img.naturalWidth || 300, nh = img.naturalHeight || 200;
  const MAX = 2048;
  if (Math.max(nw, nh) > MAX) {
    const k = MAX / Math.max(nw, nh);
    const c = document.createElement('canvas');
    c.width = Math.round(nw * k);
    c.height = Math.round(nh * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    src = c.toDataURL(file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png', 0.9);
    nw = c.width;
    nh = c.height;
  }
  const fit = Math.min(1, 480 / Math.max(nw, nh)) / view.scale;
  const w = nw * fit, hh = nh * fit;
  const [cx, cy] = at || viewCenter();
  const offset = index * 24 / view.scale;
  const el = withAuthor({ id: uid(), type: 'image', x: cx - w / 2 + offset, y: cy - hh / 2 + offset, w, h: hh, src });
  getImage(src);
  elements.push(el);
  setTool('select');
  selection = new Set([el.id]);
  commit();
}

function pastePoint() {
  return hover ? toWorld(hover.x, hover.y) : viewCenter();
}

function pasteElements(list) {
  const els = cleanElements(list);
  if (!els.length) return;
  const b = unionBounds(els);
  const [px, py] = pastePoint();
  const dx = px - (b.x + b.w / 2), dy = py - (b.y + b.h / 2);
  const copies = els.map(el => ({ ...translated(el, dx, dy), id: uid() }));
  for (const el of copies) if (el.type === 'image') getImage(el.src);
  elements.push(...copies);
  setTool('select');
  selection = new Set(copies.map(el => el.id));
  commit();
}

// True while the keyboard belongs to a text field or the Markdown editor.
const isTyping = () => {
  const a = document.activeElement;
  return !!a && (a.matches('input, textarea') || a.isContentEditable);
};
const boardVisible = () => board.layout.mode !== 'doc';

// Selected text (in the preview, a comment) copies as text, not the board selection.
const textSelected = () => { const s = getSelection(); return !!s && !s.isCollapsed && String(s).length > 0; };

document.addEventListener('copy', e => {
  if (isTyping() || textSelected() || !selection.size) return;
  e.clipboardData.setData('text/plain', JSON.stringify({ whiteboardClip: 1, elements: selectedElements() }));
  e.preventDefault();
});

document.addEventListener('cut', e => {
  if (isTyping() || textSelected() || !selection.size) return;
  e.clipboardData.setData('text/plain', JSON.stringify({ whiteboardClip: 1, elements: selectedElements() }));
  e.preventDefault();
  deleteSelection();
});

document.addEventListener('paste', e => {
  if (isTyping() || !boardVisible()) return;
  e.preventDefault();
  const dt = e.clipboardData;
  const images = [...dt.files].filter(f => f.type.startsWith('image/'));
  if (images.length) { images.forEach((f, i) => insertImageFile(f, pastePoint(), i)); return; }
  const text = dt.getData('text/plain');
  if (!text) return;
  try {
    const data = JSON.parse(text);
    if (data && data.whiteboardClip && Array.isArray(data.elements)) { pasteElements(data.elements); return; }
  } catch { /* plain text */ }
  const [wx, wy] = pastePoint();
  const el = addText(wx, wy, text.slice(0, 10000));
  setTool('select');
  selection = new Set([el.id]);
  requestRender();
});

window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', async e => {
  e.preventDefault();
  const files = [...e.dataTransfer.files];
  const docFile = files.find(f => MD_EXT.test(f.name) || WORKSPACE_EXT.test(f.name) || SECURE_EXT.test(f.name) || KEY_EXT.test(f.name));
  if (docFile) {
    try { await openAny(await Platform.readDropped(docFile)); } catch (err) { toast(err.message || 'Could not open that file'); }
    return;
  }
  const at = toWorld(...local(e));
  files.filter(f => f.type.startsWith('image/')).forEach((f, i) => insertImageFile(f, at, i));
});

// ---------- Keyboard ----------

const TOOL_KEYS = { v: 'select', h: 'hand', p: 'pen', i: 'highlighter', e: 'eraser', s: 'shape', t: 'text', n: 'note' };
const openBoardEmoji = () => EmojiPicker.open($('emojiBtn'), insertEmojiOnBoard);
const SHAPE_KEYS = { r: 'rect', o: 'ellipse', l: 'line', a: 'arrow' };

document.addEventListener('keydown', e => {
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  // File shortcuts work everywhere, including while typing in the document.
  if (mod && !e.altKey && ['s', 'o', 'e'].includes(k)) {
    if (e.defaultPrevented) return; // the editor used it (Ctrl+Shift+E toggles Suggesting there)
    e.preventDefault();
    if (k === 's' && !e.shiftKey) saveMarkdown();
    else if (k === 's' && !SECURE) toast(FULL_EDITION_ONLY);
    else if (k === 'o') openFromDialog();
    else if (e.shiftKey) { if (DocPane.hasDoc()) DocPane.setSuggesting(!DocPane.isSuggesting()); }
    else exportForAI();
    return;
  }
  if (e.altKey && !mod && (e.key === 'ArrowDown' || e.key === 'ArrowUp') && DocPane.hasDoc()) {
    e.preventDefault();
    DocPane.step(e.key === 'ArrowDown' ? 1 : -1);
    return;
  }
  if (document.querySelector('.modal.dyn')) return;
  if (e.key === 'Escape' && !$('nameModal').hidden) { finishName(null); return; }
  if (e.key === 'Escape' && !$('importModal').hidden) { hideModals(); return; }
  if (isTyping() || !$('nameModal').hidden || !$('importModal').hidden) return;
  if (DocPane.drawTool()) {
    if (mod && k === 'z' && !e.shiftKey) { e.preventDefault(); DocPane.undoInk(); return; }
    if (e.key === 'Escape') { DocPane.setDrawTool(null); return; }
  }
  if (e.key === ' ' && e.target.closest && e.target.closest('button, [role="button"]')) return; // Space presses a focused button
  if (e.key === ' ') {
    e.preventDefault();
    if (!spaceDown) { spaceDown = true; updateCursor(); requestOverlay(); }
    return;
  }
  if (mod) {
    if (k === 'z') e.shiftKey ? redo() : undo();
    else if (k === 'y') redo();
    else if (k === 'a') selectAll();
    else if (k === 'd') duplicateSelection();
    else if (k === '=' || k === '+') zoomBy(1.25);
    else if (k === '-') zoomBy(1 / 1.25);
    else if (k === '0') resetZoom();
    else if (k === '1') fitToContent();
    else return; // let copy/cut/paste reach their native events
    e.preventDefault();
    return;
  }
  if (e.altKey) return;
  const step = e.shiftKey ? 10 : 1;
  switch (e.key) {
    case 'Delete':
    case 'Backspace': deleteSelection(); break;
    case 'Escape':
      if (!$('boardsModal').hidden || !$('helpModal').hidden) { hideModals(); break; }
      if (gesture) cancelGesture();
      selection.clear();
      closePopovers();
      requestRender();
      break;
    case 'ArrowLeft': nudgeSelection(-step, 0); break;
    case 'ArrowRight': nudgeSelection(step, 0); break;
    case 'ArrowUp': nudgeSelection(0, -step); break;
    case 'ArrowDown': nudgeSelection(0, step); break;
    case '?': $('helpModal').hidden = false; break;
    default:
      if (!boardVisible()) return;
      if (SHAPE_KEYS[k]) { settings.shape.kind = SHAPE_KEYS[k]; setTool('shape'); }
      else if (TOOL_KEYS[k]) setTool(TOOL_KEYS[k]);
      else if (k === 'm') openBoardEmoji();
      else return;
  }
  e.preventDefault();
});

document.addEventListener('keyup', e => {
  if (e.key === ' ') { spaceDown = false; updateCursor(); requestOverlay(); }
});
window.addEventListener('blur', () => { spaceDown = false; updateCursor(); });

// ---------- UI wiring ----------

for (const el of document.querySelectorAll('[data-icon]')) el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon));

// Buttons shouldn't keep focus (Space would re-click them); inputs still can.
// That also keeps the note editor from blurring, so finish its text first.
document.addEventListener('mousedown', e => {
  if (!e.target.closest('button') || e.target.closest('.modal')) return;
  e.preventDefault();
  if (editing) commitEditor();
});

// Clicks outside popovers close them; their trigger bars manage themselves.
document.addEventListener('pointerdown', e => {
  if (!e.target.closest('.popover, .menu, [data-keep-popover]')) closePopovers();
}, true);

for (const btn of toolbarEl.querySelectorAll('[data-tool]')) {
  btn.addEventListener('click', () => {
    const tool = btn.dataset.tool;
    if (settings.tool === tool && TOOLS_WITH_OPTIONS.includes(tool)) {
      const pop = $('toolOptions');
      if (!pop.hidden && pop.dataset.tool === tool) closePopovers();
      else { closePopovers(); openToolOptions(tool); }
      return;
    }
    setTool(tool, true);
  });
}

$('imageBtn').addEventListener('click', () => { closePopovers(); $('imageInput').click(); });
$('imageInput').addEventListener('change', e => {
  [...e.target.files].forEach((f, i) => insertImageFile(f, null, i));
  e.target.value = '';
});
$('undoBtn').addEventListener('click', undo);
$('redoBtn').addEventListener('click', redo);
$('zoomIn').addEventListener('click', () => zoomBy(1.25));
$('zoomOut').addEventListener('click', () => zoomBy(1 / 1.25));
$('zoomLabel').addEventListener('click', resetZoom);
$('fitBtn').addEventListener('click', fitToContent);

function togglePopover(pop, anchor, build, side) {
  const wasOpen = !pop.hidden;
  closePopovers();
  if (wasOpen) return;
  build();
  placePopover(pop, anchor, side);
}

$('bgBtn').addEventListener('click', () => togglePopover($('bgPanel'), $('bgBtn'), buildBgPanel, 'right'));
$('emojiBtn').addEventListener('click', () => { closePopovers(); openBoardEmoji(); });
$('reviewBtn').addEventListener('click', () => DocPane.toggleMargin());
$('reviewTabBtn').addEventListener('click', () => { closePopovers(); toggleReviewPanel(); });
$('reviewPanelClose').addEventListener('click', () => toggleReviewPanel(false));
// Keyboard: Escape closes, arrows move between tabs, Space activates list items like Enter.
$('reviewPanel').addEventListener('keydown', e => {
  if (e.key === 'Escape') { e.stopPropagation(); toggleReviewPanel(false); $('reviewTabBtn').focus(); return; }
  const tab = e.target.closest('.rp-tab');
  if (tab && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    const ids = ['comments', 'changes', 'board'];
    reviewTab = ids[(ids.indexOf(tab.dataset.tab) + (e.key === 'ArrowRight' ? 1 : ids.length - 1)) % ids.length];
    renderReviewPanel();
    $('reviewTabs').querySelector('.rp-tab.active').focus();
    e.preventDefault();
    e.stopPropagation(); // not also a nudge of the selected board element
    return;
  }
  if (e.key === ' ' && e.target.matches('[role="button"]')) { e.preventDefault(); e.stopPropagation(); e.target.click(); }
});
$('reviewExportBtn').addEventListener('click', exportForAI);
$('reviewShowResolved').addEventListener('change', renderReviewPanel);
$('addCommentBtn').addEventListener('click', () => DocPane.addComment());
$('suggestBtn').addEventListener('click', () => DocPane.setSuggesting(!DocPane.isSuggesting()));
$('drawDocBtn').addEventListener('click', () => DocPane.toggleDraw());
$('docEmojiBtn').addEventListener('click', () => EmojiPicker.open($('docEmojiBtn'), e => DocPane.insertText(e)));
for (const b of $('docDrawBar').querySelectorAll('[data-ink-tool]')) {
  b.addEventListener('click', () => DocPane.setDrawTool(b.dataset.inkTool));
}
$('docInkColors').replaceWith(Object.assign(swatchRow(['#e81224', '#1f1f1f', '#0078d4', '#16c60c', '#886ce4', '#f7630c'], DocPane.inkSettings.color, c => { DocPane.inkSettings.color = c; if (['eraser', 'write'].includes(DocPane.drawTool())) DocPane.setDrawTool('pen'); }, false), { id: 'docInkColors' }));
$('docInkUndo').addEventListener('click', () => DocPane.undoInk());
$('docInkClear').addEventListener('click', () => DocPane.clearMyInk());
$('docInkDone').addEventListener('click', () => DocPane.setDrawTool(null));
$('docSaveBtn').addEventListener('click', saveMarkdown);
for (const b of document.querySelectorAll('#docViewSeg button')) {
  b.addEventListener('click', () => DocPane.setPreview(b.dataset.view === 'preview'));
}
for (const b of $('modeSeg').querySelectorAll('button')) {
  b.addEventListener('click', () => setLayout(b.dataset.mode));
}
$('meBtn').addEventListener('click', askName);

$('menuBtn').addEventListener('click', () => {
  const menu = $('menu');
  const wasOpen = !menu.hidden;
  closePopovers();
  if (wasOpen) return;
  for (const b of menu.querySelectorAll('[data-doc-only]')) b.hidden = !DocPane.hasDoc();
  menu.querySelector('[data-action=name]').lastChild.textContent = settings.userName ? `Your name: ${settings.userName}` : 'Your name…';
  menu.hidden = false;
  const r = $('menuBtn').getBoundingClientRect();
  menu.style.left = r.left + 'px';
  menu.style.top = r.bottom + 10 + 'px';
});

const MENU_ACTIONS = {
  new: newBoard,
  newDoc: newDocument,
  boards: showBoards,
  open: openFromDialog,
  saveMd: saveMarkdown,
  saveWorkspace,
  exportDoc: exportDocument,
  exportAI: exportForAI,
  merge: mergeFromCopy,
  exportPng: exportPNG,
  resetTracking: () => { DocPane.resetTracking(); toast('Changes accepted: the current text is the new baseline'); },
  clear: clearBoard,
  name: askName,
  help: () => { $('helpModal').hidden = false; },
  install: async () => {
    if (!deferredInstall) return;
    deferredInstall.prompt();
    await deferredInstall.userChoice;
    deferredInstall = null;
    document.querySelector('[data-action=install]').hidden = true;
  },
};
for (const btn of document.querySelectorAll('[data-action]')) {
  btn.addEventListener('click', () => { closePopovers(); MENU_ACTIONS[btn.dataset.action](); });
}

for (const modal of document.querySelectorAll('.modal')) {
  modal.addEventListener('click', e => {
    if (e.target === modal || e.target.closest('[data-close]')) {
      if (modal.id === 'nameModal') finishName(null);
      else hideModals();
    }
  });
}

// Split divider
$('divider').addEventListener('pointerdown', e => {
  const div = $('divider');
  div.setPointerCapture(e.pointerId);
  div.classList.add('dragging');
  const move = ev => { board.layout.split = clamp(ev.clientX / innerWidth, 0.2, 0.8); applyLayoutSize(); };
  const up = () => {
    div.classList.remove('dragging');
    div.removeEventListener('pointermove', move);
    div.removeEventListener('pointerup', up);
    scheduleSave();
  };
  div.addEventListener('pointermove', move);
  div.addEventListener('pointerup', up);
});

const nameInput = $('boardName');
nameInput.addEventListener('input', () => {
  board.name = nameInput.value.trim() || 'Untitled board';
  document.title = board.name + ' – ZP Whiteboard';
  scheduleSave();
});
nameInput.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === 'Escape') nameInput.blur(); });
nameInput.addEventListener('blur', () => { if (!nameInput.value.trim()) nameInput.value = board.name; });

window.addEventListener('resize', () => { if (board) applyLayoutSize(); closePopovers(); });
// Moving the window to a screen with different scaling changes the pixel ratio, often
// without a resize event.
(function watchPixelRatio() {
  matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener('change', () => {
    if (board) applyLayoutSize();
    watchPixelRatio();
  }, { once: true });
})();
window.addEventListener('beforeunload', () => { saveBoard(true); });
// A failure nobody caught (a click handler's promise) still tells the user something.
window.addEventListener('unhandledrejection', e => {
  console.error(e.reason);
  toast('Something went wrong: ' + ((e.reason && e.reason.message) || e.reason || 'unknown error'));
});
document.addEventListener('visibilitychange', () => { if (document.hidden) saveBoard(true); });

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredInstall = e;
  document.querySelector('[data-action=install]').hidden = false;
});

if (!Platform.desktop && 'serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(err => console.warn('Service worker not registered', err));
}

// Contacts for @mentions, and whether keys are unlocked (shown in the document's status line).
let contactNames = () => [], keysUnlocked = () => false;

DocPane.init({
  author: me,
  ensureAuthor: ensureUserName,
  changed: () => { scheduleSave(); scheduleReviewPanel(); },
  people: () => [settings.userName, ...contactNames()],
  keysUnlocked: () => keysUnlocked(),
});

Platform.onOpenPath(async p => {
  try { await openAny(await Platform.readPath(p)); } catch (err) { toast(err.message || 'Could not open that file'); }
});

Platform.onCloseRequest(async action => {
  if (action === 'save' && !(await saveMarkdown())) return; // save failed: keep the window open
  dirty = true;
  await saveBoard(true);
  Platform.closeNow();
});

// ---------- Startup ----------

async function init() {
  updateMe();
  resizeCanvas();
  let rec = null;
  try {
    const last = localStorage.getItem('wb.last');
    if (last) rec = await DB.get(last);
    if (!rec) {
      // The list leaves out elements, so load the newest workspace in full.
      const newest = (await DB.list()).sort((a, b) => (b.updated || 0) - (a.updated || 0))[0];
      if (newest) rec = await DB.get(newest.id);
    }
  } catch (err) {
    console.warn('Could not load saved workspaces', err);
  }
  board = null;
  // The last workspace was an encrypted document: it needs your keys first.
  if (rec && rec.sealed && !SECURE) { toast(FULL_EDITION_ONLY); rec = null; }
  applyBoardRecord(rec || freshBoard(), !!rec);
  Platform.inkAvailable().then(ok => { inkReady = ok; selBarKey = ''; requestOverlay(); }).catch(() => {});
  updateToolIndicators();
  setTool(settings.tool);
  Platform.ready();
}

init();
