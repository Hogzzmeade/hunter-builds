// Bridge between the builds page and the app (refresh, DIM window, status messages)
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('hunterApp', {
  refresh: () => ipcRenderer.send('refresh'),
  openDim: () => ipcRenderer.send('open-dim'),
  equip: p => ipcRenderer.invoke('equip', p),
  bulk: p => ipcRenderer.invoke('bulk', p),
  undo: () => ipcRenderer.invoke('undo'),
  compact: () => ipcRenderer.send('compact'),
  openMain: () => ipcRenderer.send('open-main'),
  setHotkeys: l => ipcRenderer.send('set-hotkeys', l),
  setRecWeapons: l => ipcRenderer.send('rec-weapons', l),
  getLook: () => ipcRenderer.invoke('get-look'),
  weekStatus: s => ipcRenderer.send('week-status', s),
  onActivity: cb => { ipcRenderer.on('activity', (_e, a) => cb(a)); ipcRenderer.invoke('activity').then(a => a && cb(a)); },
  backup: d => ipcRenderer.invoke('backup', d),
  copyImage: url => ipcRenderer.invoke('copy-image', url),
  diagnostics: () => ipcRenderer.invoke('diagnostics'),
  notify: (t, b) => ipcRenderer.send('notify', t, b),
  getSettings: () => ipcRenderer.invoke('settings'),
  setStartup: on => ipcRenderer.send('set-startup', on),
  onUpdate: cb => ipcRenderer.on('update', (_e, v) => cb(v)),
  installUpdate: () => ipcRenderer.send('install-update'),
  onStatus: cb => { ipcRenderer.on('status', (_e, m) => cb(m)); ipcRenderer.invoke('status').then(m => m && cb(m)); }
});
