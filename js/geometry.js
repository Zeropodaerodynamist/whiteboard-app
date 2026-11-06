'use strict';
// Geometry for whiteboard elements: bounds, hit testing, transforms and text layout.
// (This is the first script, so it also defines the `$` every other script uses.)
// Elements are plain objects. Once committed to history they are never mutated;
// transforms return new objects so undo snapshots stay valid.

const $ = id => document.getElementById(id);

const FONT_FAMILY = '"Segoe UI", system-ui, -apple-system, sans-serif';
const measureCtx = document.createElement('canvas').getContext('2d');

let idCounter = 0;
function uid() {
  return Date.now().toString(36) + (idCounter++).toString(36) + Math.random().toString(36).slice(2, 6);
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? clamp(((px - ax) * dx + (py - ay) * dy) / len2, 0, 1) : 0;
  return Math.hypot(ax + t * dx - px, ay + t * dy - py);
}

function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// ---------- Text layout ----------

const layoutCache = new WeakMap();

function textLayout(el) {
  let L = layoutCache.get(el);
  if (L) return L;
  measureCtx.font = `${el.size}px ${FONT_FAMILY}`;
  const lines = (el.text || '').split('\n');
  let w = 0;
  for (const line of lines) w = Math.max(w, measureCtx.measureText(line).width);
  const lineHeight = el.size * 1.25;
  L = { lines, lineHeight, w: Math.max(w, el.size * 0.5), h: lines.length * lineHeight };
  layoutCache.set(el, L);
  return L;
}

// Wraps text to maxW using the font currently set on measureCtx.
function wrapLines(text, maxW) {
  const out = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const token of para.split(/(?<=\s)/)) {
      if (measureCtx.measureText(line + token).width <= maxW) { line += token; continue; }
      if (line) { out.push(line); line = ''; }
      // A single word wider than the box gets hard-broken.
      let t = token;
      while (t.length > 1 && measureCtx.measureText(t).width > maxW) {
        let n = t.length - 1;
        while (n > 1 && measureCtx.measureText(t.slice(0, n)).width > maxW) n--;
        out.push(t.slice(0, n));
        t = t.slice(n);
      }
      line = t;
    }
    out.push(line);
  }
  return out;
}

function notePad(el) { return Math.min(el.w, el.h) * 0.08; }

// Sticky note text shrinks until it fits the note.
function noteLayout(el) {
  let L = layoutCache.get(el);
  if (L) return L;
  const pad = notePad(el);
  const maxW = el.w - pad * 2, maxH = el.h - pad * 2;
  const base = Math.min(el.w, el.h);
  let size = base * 0.12;
  let lines;
  for (;;) {
    measureCtx.font = `${size}px ${FONT_FAMILY}`;
    lines = wrapLines(el.text || '', maxW);
    if (lines.length * size * 1.25 <= maxH || size <= base * 0.045) break;
    size *= 0.9;
  }
  L = { lines, size, lineHeight: size * 1.25 };
  layoutCache.set(el, L);
  return L;
}

// ---------- Shapes ----------

function arrowHead(el) {
  return Math.min(el.size * 5, Math.hypot(el.x2 - el.x1, el.y2 - el.y1) * 0.45);
}

function shapeOutline(el) {
  const { x1, y1, x2, y2 } = el;
  switch (el.shape) {
    case 'rect':
      return { closed: true, pts: [[x1, y1], [x2, y1], [x2, y2], [x1, y2]] };
    case 'ellipse': {
      const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2, rx = Math.abs(x2 - x1) / 2, ry = Math.abs(y2 - y1) / 2;
      const pts = [];
      for (let i = 0; i < 48; i++) {
        const a = (i / 48) * Math.PI * 2;
        pts.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
      }
      return { closed: true, pts };
    }
    case 'triangle':
      return { closed: true, pts: [[(x1 + x2) / 2, y1], [x2, y2], [x1, y2]] };
    default:
      return { closed: false, pts: [[x1, y1], [x2, y2]] };
  }
}

// ---------- Bounds ----------

const boundsCache = new WeakMap();

function getBounds(el) {
  let b = boundsCache.get(el);
  if (b) return b;
  switch (el.type) {
    case 'stroke': {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of el.points) {
        if (p[0] < minX) minX = p[0];
        if (p[1] < minY) minY = p[1];
        if (p[0] > maxX) maxX = p[0];
        if (p[1] > maxY) maxY = p[1];
      }
      const r = el.size * (el.pressure ? 0.8 : 0.5);
      b = { x: minX - r, y: minY - r, w: maxX - minX + 2 * r, h: maxY - minY + 2 * r };
      break;
    }
    case 'shape': {
      const r = el.size / 2 + (el.shape === 'arrow' ? arrowHead(el) : 0);
      const x = Math.min(el.x1, el.x2), y = Math.min(el.y1, el.y2);
      b = { x: x - r, y: y - r, w: Math.abs(el.x2 - el.x1) + 2 * r, h: Math.abs(el.y2 - el.y1) + 2 * r };
      break;
    }
    case 'text': {
      const L = textLayout(el);
      b = { x: el.x, y: el.y, w: L.w, h: L.h };
      break;
    }
    default:
      b = { x: el.x, y: el.y, w: el.w, h: el.h };
  }
  boundsCache.set(el, b);
  return b;
}

function unionBounds(list) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const el of list) {
    const b = getBounds(el);
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function inBox(x, y, b, tol = 0) {
  return x >= b.x - tol && y >= b.y - tol && x <= b.x + b.w + tol && y <= b.y + b.h + tol;
}

// ---------- Hit testing ----------

function hitTest(el, x, y, tol) {
  if (!inBox(x, y, getBounds(el), tol)) return false;
  switch (el.type) {
    case 'stroke': {
      const r = el.size * (el.pressure ? 0.65 : 0.5) + tol;
      const pts = el.points;
      if (pts.length === 1) return Math.hypot(pts[0][0] - x, pts[0][1] - y) <= r;
      for (let i = 1; i < pts.length; i++) {
        if (distToSegment(x, y, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) <= r) return true;
      }
      return false;
    }
    case 'shape': {
      const { pts, closed } = shapeOutline(el);
      const r = el.size / 2 + tol;
      if (el.fill && closed && pointInPolygon(x, y, pts)) return true;
      const n = closed ? pts.length : pts.length - 1;
      for (let i = 0; i < n; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        if (distToSegment(x, y, a[0], a[1], b[0], b[1]) <= r) return true;
      }
      return false;
    }
    default:
      return true; // text, notes and images hit anywhere inside their box
  }
}

// Points used to decide whether a lasso encloses an element.
function samplePoints(el) {
  if (el.type === 'stroke') {
    const step = Math.max(1, Math.ceil(el.points.length / 40));
    return el.points.filter((_, i) => i % step === 0);
  }
  if (el.type === 'shape') {
    const { pts } = shapeOutline(el);
    return pts.length === 2 ? [pts[0], [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2], pts[1]] : pts;
  }
  const b = getBounds(el);
  return [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h], [b.x + b.w / 2, b.y + b.h / 2]];
}

// ---------- Transforms (return new objects) ----------

function translated(el, dx, dy) {
  switch (el.type) {
    case 'stroke': return { ...el, points: el.points.map(p => [p[0] + dx, p[1] + dy, p[2]]) };
    case 'shape': return { ...el, x1: el.x1 + dx, y1: el.y1 + dy, x2: el.x2 + dx, y2: el.y2 + dy };
    default: return { ...el, x: el.x + dx, y: el.y + dy };
  }
}

function scaled(el, ox, oy, s) {
  const tx = v => ox + (v - ox) * s, ty = v => oy + (v - oy) * s;
  switch (el.type) {
    case 'stroke': return { ...el, size: el.size * s, points: el.points.map(p => [tx(p[0]), ty(p[1]), p[2]]) };
    case 'shape': return { ...el, size: el.size * s, x1: tx(el.x1), y1: ty(el.y1), x2: tx(el.x2), y2: ty(el.y2) };
    case 'text': return { ...el, x: tx(el.x), y: ty(el.y), size: el.size * s };
    default: return { ...el, x: tx(el.x), y: ty(el.y), w: el.w * s, h: el.h * s };
  }
}
