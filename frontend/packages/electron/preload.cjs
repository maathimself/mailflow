const { contextBridge, ipcRenderer } = require('electron');
const pendingNativeActions = [];
const nativeActionSubscribers = new Set();

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

ipcRenderer.on('mailexpert:native-action', (_event, payload) => {
  if (nativeActionSubscribers.size === 0) {
    pendingNativeActions.push(payload);
    return;
  }

  nativeActionSubscribers.forEach((callback) => callback(payload));
});

function subscribeNativeAction(callback) {
  nativeActionSubscribers.add(callback);

  while (pendingNativeActions.length > 0) {
    callback(pendingNativeActions.shift());
  }

  return () => nativeActionSubscribers.delete(callback);
}

contextBridge.exposeInMainWorld('mailexpertNative', {
  platform: process.platform,
  getHost: () => ipcRenderer.invoke('mailexpert:getHost'),
  saveHost: (host) => ipcRenderer.invoke('mailexpert:saveHost', host),
  resetHost: () => ipcRenderer.invoke('mailexpert:resetHost'),
  badges: {
    setUnreadCount: (count) => ipcRenderer.invoke('mailexpert:badge:set-unread-count', count),
  },
  updates: {
    check: (verbose) => ipcRenderer.invoke('mailexpert:updates:check', { verbose }),
    installDownloaded: () => ipcRenderer.invoke('mailexpert:updates:install-downloaded'),
    installAuto: () => ipcRenderer.invoke('mailexpert:updates:install-auto'),
    copyInstallCommandAndQuit: (options) => ipcRenderer.invoke('mailexpert:updates:copy-install-command-and-quit', options),
    openDownload: () => ipcRenderer.invoke('mailexpert:updates:open-download'),
    onStatus: (callback) => subscribe('mailexpert:updates:status', callback),
  },
  notifications: {
    onPush: (callback) => subscribe('mailexpert:notifications:push', callback),
    showNewMail: (notification) => ipcRenderer.invoke('mailexpert:notification:new-mail', notification),
  },
  actions: {
    getPending: () => ipcRenderer.invoke('mailexpert:native-actions:pending'),
    ack: (id) => ipcRenderer.invoke('mailexpert:native-actions:ack', id),
    onAction: subscribeNativeAction,
  },
});
