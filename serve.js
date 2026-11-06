'use strict';
// Tiny static server so the app can run as an installable, offline-capable PWA.
// Usage: node serve.js [--no-open]   (PORT env var overrides the default port)

const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 5180;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// Only the app itself is served: not the rest of the folder (node_modules, native, tools...).
const SERVED = /^\/(?:index\.html|styles\.css|sw\.js|manifest\.webmanifest|(?:js|vendor|icons)\/[\w./-]+)$/;
// A page on another site could point its own domain at 127.0.0.1 (DNS rebinding) and read
// what this server returns; it would have to send its own Host header, so only ours is accepted.
const HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
const HEADERS = { 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "frame-ancestors 'none'" };

const server = http.createServer((req, res) => {
  if (!HOSTS.has(String(req.headers.host).toLowerCase())) { res.writeHead(421, HEADERS); res.end(); return; }
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); } catch { pathname = '/'; }
  if (pathname.endsWith('/')) pathname += 'index.html';
  const file = path.join(ROOT, path.normalize(pathname));
  if (!SERVED.test(pathname) || pathname.includes('..') || !file.startsWith(ROOT + path.sep)) {
    res.writeHead(404, { ...HEADERS, 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { ...HEADERS, 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
    res.writeHead(200, { ...HEADERS, 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
});

server.on('error', err => {
  const retry = process.platform === 'win32' ? 'set PORT=5181 && node serve.js' : 'PORT=5181 node serve.js';
  console.error(err.code === 'EADDRINUSE' ? `Port ${PORT} is busy. Try: ${retry}` : err.message);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}/`;
  console.log(`ZP Whiteboard running at ${url}  (Ctrl+C to stop)`);
  if (process.argv.includes('--no-open')) return;
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd);
});
