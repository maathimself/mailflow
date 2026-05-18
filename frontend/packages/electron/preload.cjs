const { contextBridge, ipcRenderer } = require('electron');
const pendingNativeActions = [];
const nativeActionSubscribers = new Set();

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

ipcRenderer.on('mailflow:native-action', (_event, payload) => {
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

contextBridge.exposeInMainWorld('mailflowNative', {
  getHost: () => ipcRenderer.invoke('mailflow:getHost'),
  saveHost: (host) => ipcRenderer.invoke('mailflow:saveHost', host),
  resetHost: () => ipcRenderer.invoke('mailflow:resetHost'),
  badges: {
    setUnreadCount: (count) => ipcRenderer.invoke('mailflow:badge:set-unread-count', count),
  },
  updates: {
    check: (verbose) => ipcRenderer.invoke('mailflow:updates:check', { verbose }),
    installDownloaded: () => ipcRenderer.invoke('mailflow:updates:install-downloaded'),
    installAuto: () => ipcRenderer.invoke('mailflow:updates:install-auto'),
    openDownload: () => ipcRenderer.invoke('mailflow:updates:open-download'),
    onStatus: (callback) => subscribe('mailflow:updates:status', callback),
  },
  notifications: {
    onPush: (callback) => subscribe('mailflow:notifications:push', callback),
    showNewMail: (notification) => ipcRenderer.invoke('mailflow:notification:new-mail', notification),
  },
  actions: {
    getPending: () => ipcRenderer.invoke('mailflow:native-actions:pending'),
    ack: (id) => ipcRenderer.invoke('mailflow:native-actions:ack', id),
    onAction: subscribeNativeAction,
  },
});
