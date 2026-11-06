'use strict';
// IndexedDB autosave. Each workspace is a record in `boards` ({ id, name, bg, layout,
// filePath, view, doc, thumb, updated, chunks }) and its elements are stored in `chunks` of
// CHUNK elements, keyed "<id>:<n>" (n zero-padded).
// Elements are never mutated once committed (the stroke being
// drawn isn't saved until it is), so a chunk whose element objects are the same as last
// time is skipped: a stroke on a big board writes one chunk, not the board.
// Records from version 1 keep their elements inline and are still read.

const DB = (() => {
  const CHUNK = 200;
  const HIGH = String.fromCharCode(0xffff);
  let dbPromise = null;
  const savedChunks = new Map(); // board id -> element arrays as last written (by identity)

  function open() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open('whiteboard', 2);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('boards')) db.createObjectStore('boards', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }

  // Runs fn(stores) in one transaction over both stores; resolves with fn's return value.
  function tx(mode, fn) {
    return open().then(db => new Promise((resolve, reject) => {
      const t = db.transaction(['boards', 'chunks'], mode);
      let result;
      Promise.resolve(fn({ boards: t.objectStore('boards'), chunks: t.objectStore('chunks') })).then(r => { result = r; }, reject);
      t.oncomplete = () => resolve(typeof result === 'function' ? result() : result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    }));
  }

  const req = r => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  // Zero-padded so keys sort like numbers ("id:000010" after "id:000002").
  const key = (id, i) => `${id}:${String(i).padStart(6, '0')}`;
  const range = id => IDBKeyRange.bound(id + ':', id + ':' + HIGH);

  // Saves the record and only the element chunks that changed. Everything is copied
  // synchronously (put() clones its value), so later edits can't leak into this save.
  function put(record, elements) {
    if (!elements) {
      return tx('readwrite', s => { s.boards.put(record); s.chunks.delete(range(record.id)); savedChunks.delete(record.id); });
    }
    const id = record.id;
    const prev = savedChunks.get(id);
    const next = [];
    return tx('readwrite', s => {
      const n = Math.ceil(elements.length / CHUNK);
      for (let i = 0; i < n; i++) {
        const slice = elements.slice(i * CHUNK, (i + 1) * CHUNK);
        next.push(slice);
        const old = prev && prev[i];
        if (old && old.length === slice.length && old.every((el, k) => el === slice[k])) continue;
        s.chunks.put(slice, key(id, i));
      }
      // Chunks past the end (the board shrank, or we don't know what was there before).
      if (!prev || prev.length > n) s.chunks.delete(IDBKeyRange.bound(key(id, n), id + ':' + HIGH));
      const { elements: _inline, ...meta } = record;
      s.boards.put({ ...meta, chunks: n });
    }).then(() => { savedChunks.set(id, next); });
  }

  async function get(id) {
    const rec = await tx('readonly', s => req(s.boards.get(id)));
    if (!rec || rec.chunks == null) return rec;
    const parts = await tx('readonly', s => Promise.all(Array.from({ length: rec.chunks }, (_, i) => req(s.chunks.get(key(id, i))))));
    if (parts.some(p => !Array.isArray(p))) throw new Error('A saved workspace is incomplete');
    savedChunks.set(id, parts);
    return { ...rec, elements: parts.flat() };
  }

  return {
    get,
    // Workspace records without their elements (enough for the list).
    list: () => tx('readonly', s => req(s.boards.getAll())),
    put,
    remove: id => tx('readwrite', s => { s.boards.delete(id); s.chunks.delete(range(id)); savedChunks.delete(id); }),
  };
})();
