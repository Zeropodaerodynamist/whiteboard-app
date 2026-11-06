'use strict';
// Exposes a small, explicit API to the page. The page never gets Node access.

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('wbNative', {
  platform: process.platform,
  userName: () => ipcRenderer.invoke('app:user'),
  openDialog: kind => ipcRenderer.invoke('file:open-dialog', kind),
  readFile: path => ipcRenderer.invoke('file:read', path),
  saveDialog: (defaultPath, kind) => ipcRenderer.invoke('file:save-dialog', { defaultPath, kind }),
  writeText: (path, text) => ipcRenderer.invoke('file:write', { path, text }),
  writeBase64: (path, base64) => ipcRenderer.invoke('file:write', { path, base64 }),
  writeBytes: (path, bytes) => ipcRenderer.invoke('file:write', { path, bytes }),
  // A dropped file is read by the path Electron gives its File object, worked out here: the
  // page can't name an arbitrary path for this (a File it makes itself has no path).
  readDropped: file => {
    let p = null;
    try { p = webUtils.getPathForFile(file) || null; } catch { /* not a real file */ }
    return p ? ipcRenderer.invoke('file:read-dropped', p) : Promise.resolve(null);
  },
  openExternal: url => ipcRenderer.invoke('shell:open-external', url),
  showInFolder: path => ipcRenderer.invoke('shell:show-item', path),
  printToPDF: html => ipcRenderer.invoke('export:pdf', html),
  recognizeInk: (strokes, mode) => ipcRenderer.invoke('ink:recognize', { strokes, mode }),
  inkAvailable: () => ipcRenderer.invoke('ink:available'),
  setDirty: dirty => ipcRenderer.send('app:set-dirty', dirty),
  closeNow: () => ipcRenderer.send('app:close-now'),
  ready: () => ipcRenderer.send('app:ready'),
  onOpenPath: cb => ipcRenderer.on('app:open-path', (_e, p) => cb(p)),
  onCloseRequest: cb => ipcRenderer.on('app:close-request', (_e, action) => cb(action)),
});
