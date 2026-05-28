import { Capacitor, registerPlugin } from '@capacitor/core';

let installed = false;
let plugin = null;
let pluginUnavailable = false;

function getPlugin() {
  if (plugin) return plugin;
  plugin = registerPlugin('MailFlowNative');
  return plugin;
}

async function callNative(method, args, fallback = null) {
  if (pluginUnavailable) return fallback;

  try {
    const MailFlowNative = getPlugin();
    return await MailFlowNative[method](args);
  } catch (error) {
    if (String(error?.message || error).includes('not implemented')) {
      pluginUnavailable = true;
    }
    return fallback;
  }
}

export function installCapacitorNativeBridge() {
  if (installed || window.mailflowNative || !Capacitor.isNativePlatform()) return;

  window.mailflowNative = {
    getHost: async () => {
      const result = await callNative('getHost', undefined, {});
      return result?.host || null;
    },
    saveHost: async (host) => {
      const result = await callNative('saveHost', { host }, { host });
      return result?.host || host;
    },
    resetHost: async () => callNative('resetHost'),
    badges: {
      setUnreadCount: async (count) => callNative('setUnreadCount', { count }),
    },
    notifications: {
      checkPermission: async () => {
        const result = await callNative('checkNotificationPermission', undefined, {});
        return result?.permission || 'default';
      },
      requestPermission: async () => {
        const result = await callNative('requestNotificationPermission', undefined, {});
        return result?.permission || 'default';
      },
      openSettings: async () => callNative('openNotificationSettings'),
      showNewMail: async (notification) => callNative('showNewMail', notification || {}),
    },
    actions: {
      getPending: async () => {
        const result = await callNative('getPendingActions', undefined, {});
        return result?.actions || [];
      },
      ack: async (id) => callNative('ackAction', { id }),
      onAction: (callback) => {
        if (pluginUnavailable) return () => {};
        const MailFlowNative = getPlugin();
        const handlePromise = MailFlowNative.addListener('nativeAction', callback).catch((error) => {
          // Listener support can be unavailable on hosted/older native shells while
          // direct plugin methods such as showNewMail still work.
          return null;
        });
        return () => {
          handlePromise.then((handle) => handle?.remove?.()).catch(() => {});
        };
      },
    },
  };

  installed = true;
}
