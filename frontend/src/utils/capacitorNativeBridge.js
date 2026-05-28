import { Capacitor, registerPlugin } from '@capacitor/core';

let installed = false;
let plugin = null;

function getPlugin() {
  if (plugin) return plugin;
  plugin = registerPlugin('MailFlowNative');
  return plugin;
}

export function installCapacitorNativeBridge() {
  if (installed || window.mailflowNative || !Capacitor.isNativePlatform()) return;

  const MailFlowNative = getPlugin();

  window.mailflowNative = {
    getHost: async () => {
      const result = await MailFlowNative.getHost();
      return result?.host || null;
    },
    saveHost: async (host) => {
      const result = await MailFlowNative.saveHost({ host });
      return result?.host || host;
    },
    resetHost: async () => MailFlowNative.resetHost(),
    badges: {
      setUnreadCount: async (count) => MailFlowNative.setUnreadCount({ count }),
    },
    notifications: {
      checkPermission: async () => {
        const result = await MailFlowNative.checkNotificationPermission();
        return result?.permission || 'default';
      },
      requestPermission: async () => {
        const result = await MailFlowNative.requestNotificationPermission();
        return result?.permission || 'default';
      },
      openSettings: async () => MailFlowNative.openNotificationSettings(),
      showNewMail: async (notification) => MailFlowNative.showNewMail(notification || {}),
    },
    actions: {
      getPending: async () => {
        const result = await MailFlowNative.getPendingActions();
        return result?.actions || [];
      },
      ack: async (id) => MailFlowNative.ackAction({ id }),
      onAction: (callback) => {
        const handlePromise = MailFlowNative.addListener('nativeAction', callback);
        return () => {
          handlePromise.then((handle) => handle.remove()).catch(() => {});
        };
      },
    },
  };

  installed = true;
}
