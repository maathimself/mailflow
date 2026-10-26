const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('printPreview', {
  load: () => ipcRenderer.invoke('mailflow:print:load'),
  render: (options) => ipcRenderer.invoke('mailflow:print:render', options),
  print: (options, systemDialog) => ipcRenderer.invoke('mailflow:print:submit', options, systemDialog),
  save: (options) => ipcRenderer.invoke('mailflow:print:save', options),
});
