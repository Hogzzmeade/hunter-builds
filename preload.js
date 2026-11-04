// Bridge between the builds page and the app (refresh, DIM window, status messages)
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('hunterApp', {
  refresh: () => ipcRenderer.send('refresh'),
  openDim: () => ipcRenderer.send('open-dim'),
  equip: p => ipcRenderer.invoke('equip', p),
  bulk: p => ipcRenderer.invoke('bulk', p),
  undo: () => ipcRenderer.invoke('undo'),
  diagnostics: () => ipcRenderer.invoke('diagnostics'),
  notify: (t, b) => ipcRenderer.send('notify', t, b),
  getSettings: () => ipcRenderer.invoke('settings'),
  setStartup: on => ipcRenderer.send('set-startup', on),
  onUpdate: cb => ipcRenderer.on('update', (_e, v) => cb(v)),
  installUpdate: () => ipcRenderer.send('install-update'),
  onStatus: cb => { ipcRenderer.on('status', (_e, m) => cb(m)); ipcRenderer.invoke('status').then(m => m && cb(m)); }
});
