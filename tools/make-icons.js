'use strict';
// Rasterizes the app icon (same design as icons/icon.svg) to PNGs without dependencies.
// Usage: node tools/make-icons.js

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'icons');
const SIZE = 512, RADIUS = 112, STROKE = 22;

function cubic(p0, p1, p2, p3, n) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    pts.push([
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ]);
  }
  return pts;
}

// M120 330 C170 200 230 200 256 290 S340 380 392 182
const curve = [...cubic([120, 330], [170, 200], [230, 200], [256, 290], 48), ...cubic([256, 290], [282, 380], [340, 380], [392, 182], 48)];

function distToCurve(x, y) {
  let best = Infinity;
  for (let i = 1; i < curve.length; i++) {
    const [ax, ay] = curve[i - 1], [bx, by] = curve[i];
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(ax + t * dx - x, ay + t * dy - y));
  }
  return best;
}

function insideRoundRect(x, y) {
  const cx = Math.max(RADIUS, Math.min(SIZE - RADIUS, x));
  const cy = Math.max(RADIUS, Math.min(SIZE - RADIUS, y));
  return x >= 0 && y >= 0 && x <= SIZE && y <= SIZE && Math.hypot(x - cx, y - cy) <= RADIUS;
}

function render(size) {
  const k = SIZE / size, ss = 4;
  const rgba = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = (px + (sx + 0.5) / ss) * k, y = (py + (sy + 0.5) / ss) * k;
          if (!insideRoundRect(x, y)) continue;
          a++;
          if (x > 90 && x < 420 && y > 160 && y < 380 && distToCurve(x, y) <= STROKE) { r += 255; g += 255; b += 255; continue; }
          const t = (x + y) / (2 * SIZE); // gradient #5b7cfa -> #7b5cf0
          r += 0x5b + (0x7b - 0x5b) * t;
          g += 0x7c + (0x5c - 0x7c) * t;
          b += 0xfa + (0xf0 - 0xfa) * t;
        }
      }
      const i = (py * size + px) * 4;
      if (a) { rgba[i] = r / a; rgba[i + 1] = g / a; rgba[i + 2] = b / a; }
      rgba[i + 3] = (a / (ss * ss)) * 255;
    }
  }
  return rgba;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [192, 512]) {
  const file = path.join(OUT, `icon-${size}.png`);
  fs.writeFileSync(file, encodePNG(size, render(size)));
  console.log('wrote', path.relative(process.cwd(), file));
}

// electron-builder turns this into the Windows .ico and the Linux icon.
const buildDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(buildDir, { recursive: true });
fs.copyFileSync(path.join(OUT, 'icon-512.png'), path.join(buildDir, 'icon.png'));
console.log('wrote', path.relative(process.cwd(), path.join(buildDir, 'icon.png')));
