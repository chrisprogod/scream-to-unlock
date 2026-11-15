// The only bridge between the lock screen page and Electron.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lockApi', {
  onLock: (cb) => ipcRenderer.on('lock', () => cb()),
  onForceUnlock: (cb) => ipcRenderer.on('force-unlock', () => cb()),
  ready: () => ipcRenderer.send('renderer-ready'),
  unlocked: () => ipcRenderer.send('unlocked'),
});
