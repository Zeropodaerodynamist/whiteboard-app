'use strict';
// Network-first service worker: always fresh when online, still works offline.

const CACHE = 'whiteboard-v4';
const ASSETS = [
  './',
  'index.html',
  'styles.css',
  'vendor/codemirror/codemirror.css',
  'vendor/codemirror/codemirror.js',
  'vendor/codemirror/xml.js',
  'vendor/codemirror/markdown.js',
  'vendor/codemirror/continuelist.js',
  'vendor/codemirror/placeholder.js',
  'vendor/codemirror/active-line.js',
  'vendor/marked.js',
  'vendor/purify.min.js',
  'vendor/emoji-data.js',
  'js/geometry.js',
  'js/render.js',
  'js/storage.js',
  'js/platform.js',
  'js/export.js',
  'js/emoji.js',
  'js/doc.js',
  'js/app.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || !e.request.url.startsWith(self.location.origin)) return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
