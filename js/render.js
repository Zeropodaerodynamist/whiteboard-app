'use strict';
// Canvas drawing for elements and the board background.

const THEMES = {
  white: { label: 'White', color: '#ffffff', grid: 'rgba(0,0,0,0.16)', dark: false },
  paper: { label: 'Paper', color: '#f8f5ec', grid: 'rgba(120,90,40,0.2)', dark: false },
  mist: { label: 'Mist', color: '#edf2f8', grid: 'rgba(30,60,110,0.16)', dark: false },
  slate: { label: 'Slate', color: '#202327', grid: 'rgba(255,255,255,0.13)', dark: true },
  chalk: { label: 'Chalkboard', color: '#1e3a2d', grid: 'rgba(255,255,255,0.12)', dark: true },
  night: { label: 'Night', color: '#151b2e', grid: 'rgba(160,180,255,0.15)', dark: true },
};
const PATTERNS = ['none', 'dots', 'grid', 'lines'];
const NOTE_TEXT = '#1f1f1f';

const strokeCache = new WeakMap();
const imageCache = new Map();
let onImageLoad = () => {};

// Black ink shows as white on dark boards (and white as black on light ones),
// so switching the board color never hides existing ink.
let darkBoard = false;
function inkColor(c) {
  const lc = c.toLowerCase();
  if (darkBoard && lc === '#1f1f1f') return '#ffffff';
  if (!darkBoard && lc === '#ffffff') return '#1f1f1f';
  return c;
}

// Call after mutating an uncommitted (draft) element in place.
function invalidate(el) {
  strokeCache.delete(el);
  boundsCache.delete(el);
  layoutCache.delete(el);
}

function strokeWidth(el, p) {
  return el.pressure ? el.size * (0.4 + 1.2 * p) : el.size;
}

// Smoothed paths for a stroke: quadratic curves through the midpoints between
// samples. Pressure strokes are split into runs of similar width; opaque
// round-capped runs overlap seamlessly. A builder extends the paths one segment
// at a time, so the stroke being drawn never rebuilds its whole path per point.
// `live` builders also list each new segment in `fresh` for the live ink layer.
function strokeBuilder(el, live = false) {
  const p0 = el.points[0];
  return { el, pieces: [], cur: null, curW: -1, start: [p0[0], p0[1]], next: 1, fresh: live ? [] : null };
}

function segmentWidth(el, i) {
  if (!el.pressure) return el.size;
  const pts = el.points, step = el.size * 0.08;
  return Math.max(step, Math.round(strokeWidth(el, (pts[i - 1][2] + pts[i][2]) / 2) / step) * step);
}

function addSegment(b, w, ctrl, end) {
  if (w !== b.curW) {
    b.cur = new Path2D();
    b.cur.moveTo(b.start[0], b.start[1]);
    b.pieces.push({ w, path: b.cur });
    b.curW = w;
  }
  b.cur.quadraticCurveTo(ctrl[0], ctrl[1], end[0], end[1]);
  if (b.fresh) b.fresh.push([w, b.start[0], b.start[1], ctrl[0], ctrl[1], end[0], end[1]]);
  b.start = end;
}

// Adds every segment whose end is settled: all but the last, which ends at the
// newest sample and moves when the next one arrives.
function extendStroke(b) {
  const pts = b.el.points;
  for (; b.next < pts.length - 1; b.next++) {
    const p = pts[b.next], q = pts[b.next + 1];
    addSegment(b, segmentWidth(b.el, b.next), p, [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]);
  }
}

// Closes the stroke with a straight run to its last sample and caches the result.
function finishStroke(b) {
  const el = b.el, pts = el.points;
  extendStroke(b);
  if (pts.length === 1) {
    const path = new Path2D();
    path.arc(pts[0][0], pts[0][1], strokeWidth(el, pts[0][2]) / 2, 0, Math.PI * 2);
    b.pieces = [{ dot: true, path }];
  } else if (b.next === pts.length - 1) {
    const last = pts[pts.length - 1];
    addSegment(b, segmentWidth(el, b.next), last, [last[0], last[1]]);
    b.next++;
  }
  strokeCache.set(el, b.pieces);
  return b.pieces;
}

function strokePieces(el) {
  return strokeCache.get(el) || finishStroke(strokeBuilder(el));
}

// The same smoothed pieces as SVG markup (document ink prints and exports as vectors).
// dx/dy shift the points; colors are taken literally (documents have no dark board).
function strokeSvg(el, dx = 0, dy = 0) {
  const pts = el.points, n = v => +v.toFixed(2);
  const color = Review.esc(el.color), alpha = el.highlighter ? ' opacity="0.4"' : '';
  if (pts.length === 1) {
    return `<circle cx="${n(pts[0][0] + dx)}" cy="${n(pts[0][1] + dy)}" r="${n(strokeWidth(el, pts[0][2]) / 2)}" fill="${color}"${alpha}/>`;
  }
  const pieces = [];
  let cur = null, curW = -1, start = [pts[0][0] + dx, pts[0][1] + dy];
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i], q = pts[i + 1];
    const end = q ? [(p[0] + q[0]) / 2 + dx, (p[1] + q[1]) / 2 + dy] : [p[0] + dx, p[1] + dy];
    const w = segmentWidth(el, i);
    if (w !== curW) { cur = { w, d: `M${n(start[0])} ${n(start[1])}` }; pieces.push(cur); curW = w; }
    cur.d += `Q${n(p[0] + dx)} ${n(p[1] + dy)} ${n(end[0])} ${n(end[1])}`;
    start = end;
  }
  const paths = pieces.map(pc => `<path d="${pc.d}" stroke-width="${n(pc.w)}"/>`).join('');
  return `<g fill="none" stroke="${color}" stroke-linecap="round" stroke-linejoin="round"${alpha}>${paths}</g>`;
}

function strokeStyle(ctx, el) {
  ctx.strokeStyle = ctx.fillStyle = inkColor(el.color);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
}

// Paints the stroke being drawn (a `live` builder) onto `canvas`: settled segments, then
// a tail through the newest sample and any predicted points. Each segment is drawn once,
// onto an offscreen copy of the settled part; a frame then clears and repaints only the
// rectangle that the new segments and the old and new tail cover. Repainting the whole
// stroke every frame made the GPU work grow with the stroke, which on a high-DPI screen
// with integrated graphics showed up as choppy drawing.
// Highlighter opacity comes from the layer, so the tail overlaps the segments without
// darkening. `k`, `ox`, `oy` map world to device pixels (x * k + ox).
function createLiveInk(canvas, ctx) {
  const ink = document.createElement('canvas'), inkCtx = ink.getContext('2d');
  let cur = null; // { b, k, ox, oy, tail }: what the two canvases hold now

  // Grows device-pixel box r = [x0, y0, x1, y1] around world points xy (flat x, y list),
  // padded by half the line width plus antialiasing.
  function grow(r, xy, w) {
    const { k, ox, oy } = cur, pad = w * k / 2 + 2;
    for (let i = 0; i < xy.length; i += 2) {
      const x = xy[i] * k + ox, y = xy[i + 1] * k + oy;
      if (x - pad < r[0]) r[0] = x - pad;
      if (y - pad < r[1]) r[1] = y - pad;
      if (x + pad > r[2]) r[2] = x + pad;
      if (y + pad > r[3]) r[3] = y + pad;
    }
    return r;
  }
  const empty = () => [Infinity, Infinity, -Infinity, -Infinity];

  // The tail: a dot for a single sample, else a line from the last settled segment end
  // through the newest sample and the predicted points.
  function tailOf(b, predicted) {
    const el = b.el, pts = el.points, last = pts[pts.length - 1];
    if (pts.length === 1 && !predicted.length) return { dot: true, xy: [last[0], last[1]], w: strokeWidth(el, last[2]) };
    const xy = [b.start[0], b.start[1], last[0], last[1]];
    for (const q of predicted) xy.push(q[0], q[1]);
    return { dot: false, xy, w: pts.length > 1 ? segmentWidth(el, pts.length - 1) : strokeWidth(el, last[2]) };
  }

  // Saves and restores the live canvas's state: overlays drawn there later (selection
  // frames, the lasso) must not inherit the stroke's round caps and joins.
  function drawTail(t) {
    const { k, ox, oy } = cur, xy = t.xy;
    ctx.save();
    ctx.setTransform(k, 0, 0, k, ox, oy);
    strokeStyle(ctx, cur.b.el);
    ctx.beginPath();
    if (t.dot) {
      ctx.arc(xy[0], xy[1], t.w / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.moveTo(xy[0], xy[1]);
      for (let i = 2; i < xy.length; i += 2) ctx.lineTo(xy[i], xy[i + 1]);
      ctx.lineWidth = t.w;
      ctx.stroke();
    }
    ctx.restore();
  }

  // Draws the segments settled since the last frame onto the offscreen copy, one path per
  // run of equal width, growing r by the area they cover.
  function drawFresh(b, r) {
    const segs = b.fresh;
    for (let i = 0; i < segs.length;) {
      const w = segs[i][0];
      inkCtx.beginPath();
      inkCtx.moveTo(segs[i][1], segs[i][2]);
      for (; i < segs.length && segs[i][0] === w; i++) {
        const s = segs[i];
        inkCtx.quadraticCurveTo(s[3], s[4], s[5], s[6]);
        grow(r, s.slice(1), w); // a quadratic curve stays inside its control points
      }
      inkCtx.lineWidth = w;
      inkCtx.stroke();
    }
    segs.length = 0;
  }

  return {
    draw(b, predicted, k, ox, oy) {
      const W = canvas.width, H = canvas.height;
      const tail = tailOf(b, predicted);
      if (!cur || cur.b !== b || cur.k !== k || cur.ox !== ox || cur.oy !== oy || ink.width !== W || ink.height !== H) {
        // A new stroke, or the view or canvas changed: start both canvases over.
        if (ink.width !== W || ink.height !== H) { ink.width = W; ink.height = H; }
        cur = { b, k, ox, oy, tail: null };
        for (const c of [inkCtx, ctx]) { c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, W, H); }
        inkCtx.setTransform(k, 0, 0, k, ox, oy);
        strokeStyle(inkCtx, b.el);
        for (const piece of b.pieces) { inkCtx.lineWidth = piece.w; inkCtx.stroke(piece.path); }
        b.fresh.length = 0;
        ctx.drawImage(ink, 0, 0);
      } else {
        // Restore the box that the new segments and the old and new tail cover from the
        // settled copy, then draw the new tail over it.
        const r = cur.tail ? cur.tail.slice() : empty();
        drawFresh(b, r);
        grow(r, tail.xy, tail.w);
        const x0 = Math.max(0, Math.floor(r[0])), y0 = Math.max(0, Math.floor(r[1]));
        const x1 = Math.min(W, Math.ceil(r[2])), y1 = Math.min(H, Math.ceil(r[3]));
        if (x1 > x0 && y1 > y0) {
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.clearRect(x0, y0, x1 - x0, y1 - y0);
          ctx.drawImage(ink, x0, y0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0);
        }
      }
      drawTail(tail);
      cur.tail = grow(empty(), tail.xy, tail.w);
    },
    // Someone else cleared, resized or drew on the canvas, or the stroke is done: the next
    // draw starts over. The offscreen copy (a whole canvas of pixels) is let go meanwhile.
    reset() {
      cur = null;
      if (ink.width) ink.width = ink.height = 0;
    },
  };
}

function drawStroke(ctx, el) {
  ctx.save();
  if (el.highlighter) ctx.globalAlpha = 0.4;
  strokeStyle(ctx, el);
  for (const piece of strokePieces(el)) {
    if (piece.dot) { ctx.fill(piece.path); continue; }
    ctx.lineWidth = piece.w;
    ctx.stroke(piece.path);
  }
  ctx.restore();
}

function drawShape(ctx, el) {
  const { x1, y1, x2, y2 } = el;
  const path = new Path2D();
  if (el.shape === 'ellipse') {
    path.ellipse((x1 + x2) / 2, (y1 + y2) / 2, Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2, 0, 0, Math.PI * 2);
  } else {
    const { pts, closed } = shapeOutline(el);
    path.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) path.lineTo(pts[i][0], pts[i][1]);
    if (closed) path.closePath();
  }
  ctx.save();
  ctx.strokeStyle = ctx.fillStyle = inkColor(el.color);
  ctx.lineWidth = el.size;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (el.fill && el.shape !== 'line' && el.shape !== 'arrow') {
    ctx.globalAlpha = 0.25;
    ctx.fill(path);
    ctx.globalAlpha = 1;
  }
  ctx.stroke(path);
  if (el.shape === 'arrow') {
    const a = Math.atan2(y2 - y1, x2 - x1), head = arrowHead(el);
    const head2 = new Path2D();
    head2.moveTo(x2 - head * Math.cos(a - 0.45), y2 - head * Math.sin(a - 0.45));
    head2.lineTo(x2, y2);
    head2.lineTo(x2 - head * Math.cos(a + 0.45), y2 - head * Math.sin(a + 0.45));
    ctx.stroke(head2);
  }
  ctx.restore();
}

function drawText(ctx, el) {
  const L = textLayout(el);
  ctx.fillStyle = inkColor(el.color);
  ctx.font = `${el.size}px ${FONT_FAMILY}`;
  ctx.textBaseline = 'middle';
  L.lines.forEach((line, i) => ctx.fillText(line, el.x, el.y + (i + 0.5) * L.lineHeight));
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

// pxRatio = device pixels per world unit; shadows are not affected by the transform.
function drawNote(ctx, el, pxRatio) {
  const base = Math.min(el.w, el.h);
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.2)';
  ctx.shadowBlur = base * 0.06 * pxRatio;
  ctx.shadowOffsetY = base * 0.02 * pxRatio;
  ctx.fillStyle = el.color;
  roundRectPath(ctx, el.x, el.y, el.w, el.h, base * 0.02);
  ctx.fill();
  ctx.restore();

  if (!el.text) return;
  const L = noteLayout(el), pad = notePad(el);
  ctx.save();
  ctx.clip();
  ctx.fillStyle = NOTE_TEXT;
  ctx.font = `${L.size}px ${FONT_FAMILY}`;
  ctx.textBaseline = 'middle';
  L.lines.forEach((line, i) => ctx.fillText(line, el.x + pad, el.y + pad + (i + 0.5) * L.lineHeight));
  ctx.restore();
}

function getImage(src) {
  let img = imageCache.get(src);
  if (!img) {
    img = new Image();
    img.onload = () => onImageLoad();
    img.src = src;
    imageCache.set(src, img);
  }
  return img;
}

function drawImageEl(ctx, el) {
  const img = getImage(el.src);
  if (img.complete && img.naturalWidth) {
    ctx.drawImage(img, el.x, el.y, el.w, el.h);
  } else {
    ctx.fillStyle = 'rgba(128,128,128,0.15)';
    ctx.fillRect(el.x, el.y, el.w, el.h);
  }
}

function drawElement(ctx, el, pxRatio) {
  switch (el.type) {
    case 'stroke': return drawStroke(ctx, el);
    case 'shape': return drawShape(ctx, el);
    case 'text': return drawText(ctx, el);
    case 'note': return drawNote(ctx, el, pxRatio);
    case 'image': return drawImageEl(ctx, el);
  }
}

// The dots or lines are one cached Path2D (in device pixels) covering the view plus one
// step, shifted by the pan offset: nothing is rebuilt while panning, and filling plain
// shapes is much cheaper than filling the canvas with a pattern.
let bgPath = { key: '', path: null };

function backgroundPath(kind, stepDev, wDev, hDev, dpr) {
  const key = `${kind}|${stepDev}|${wDev}|${hDev}|${dpr}`;
  if (bgPath.key === key) return bgPath.path;
  const path = new Path2D();
  const W = wDev + stepDev * 2, H = hDev + stepDev * 2;
  if (kind === 'dots') {
    const r = 1.1 * dpr;
    for (let x = 0; x < W; x += stepDev) for (let y = 0; y < H; y += stepDev) path.rect(Math.round(x) - r, Math.round(y) - r, r * 2, r * 2);
  } else {
    const half = Math.max(1, Math.round(dpr)) % 2 ? 0.5 : 0; // odd widths sit on pixel centers
    if (kind === 'grid') for (let x = 0; x < W; x += stepDev) { path.moveTo(Math.round(x) + half, 0); path.lineTo(Math.round(x) + half, H); }
    for (let y = 0; y < H; y += stepDev) { path.moveTo(0, Math.round(y) + half); path.lineTo(W, Math.round(y) + half); }
  }
  bgPath = { key, path };
  return path;
}

// Draws the background in device pixels (resets the transform).
function drawBackground(ctx, view, w, h, theme, pattern, dpr = 1) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = theme.color;
  ctx.fillRect(0, 0, w * dpr, h * dpr);
  if (pattern === 'none') return;
  let step = 32 * view.scale;
  while (step < 14) step *= 2;
  while (step > 120) step /= 2;
  const stepDev = step * dpr;
  const path = backgroundPath(pattern, stepDev, Math.ceil(w * dpr), Math.ceil(h * dpr), dpr);
  const ox = (((view.x * dpr) % stepDev) + stepDev) % stepDev, oy = (((view.y * dpr) % stepDev) + stepDev) % stepDev;
  ctx.setTransform(1, 0, 0, 1, Math.round(ox - stepDev), Math.round(oy - stepDev));
  if (pattern === 'dots') {
    ctx.fillStyle = theme.grid;
    ctx.fill(path);
  } else {
    ctx.strokeStyle = theme.grid;
    ctx.lineWidth = Math.max(1, Math.round(dpr));
    ctx.globalAlpha = 0.6;
    ctx.stroke(path);
    ctx.globalAlpha = 1;
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

// Renders a world-space region onto a new canvas, scaled uniformly and centered.
function renderRegion(list, region, outW, outH, background) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(outW));
  c.height = Math.max(1, Math.round(outH));
  const g = c.getContext('2d');
  g.fillStyle = background;
  g.fillRect(0, 0, c.width, c.height);
  const s = Math.min(c.width / region.w, c.height / region.h);
  const ox = (c.width - region.w * s) / 2 - region.x * s;
  const oy = (c.height - region.h * s) / 2 - region.y * s;
  g.setTransform(s, 0, 0, s, ox, oy);
  for (const el of list) drawElement(g, el, s);
  return c;
}
