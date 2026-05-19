const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mailflowNative', {
  getHost: () => ipcRenderer.invoke('mailflow:getHost'),
  saveHost: (host) => ipcRenderer.invoke('mailflow:saveHost', host),
  resetHost: () => ipcRenderer.invoke('mailflow:resetHost'),
  notify: (payload) => ipcRenderer.invoke('mailflow:notify', payload),
  setUnreadCount: (count) => ipcRenderer.invoke('mailflow:setUnreadCount', count),
});
