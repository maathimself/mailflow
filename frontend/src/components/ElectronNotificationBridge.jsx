import { useEffect, useRef } from 'react';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';

export default function ElectronNotificationBridge() {
  const addNotification = useStore(state => state.addNotification);
  const openCompose = useStore(state => state.openCompose);
  const lastActionRef = useRef({ action: null, time: 0 });

  useEffect(() => {
    const unsubscribe = window.mailflowNative?.notifications?.onPush?.((notification) => {
      addNotification({
        type: notification.type === 'negative' ? 'error' : notification.type,
        title: notification.title,
        body: notification.body || notification.message,
      });
    });

    return () => {
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, [addNotification]);

  useEffect(() => {
    const unsubscribe = window.mailflowNative?.updates?.onStatus?.((status) => {
      if (status?.type !== 'downloaded') return;

      addNotification({
        type: 'success',
        title: 'Update ready',
        body: 'MailFlow downloaded the update.',
        allowWrap: true,
        actionLabel: 'Install',
        onAction: async () => {
          const result = await window.mailflowNative?.updates?.installDownloaded?.();
          if (result && result.installed === false) {
            addNotification({
              type: 'error',
              title: 'Install failed',
              body: 'The update was downloaded, but the installer could not be started.',
            });
          }
        },
      });
    });

    return () => {
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, [addNotification]);

  useEffect(() => {
    const runNativeAction = async (action) => {
      const now = Date.now();
      const last = lastActionRef.current;

      if (last.action === action && now - last.time < 500) return;
      lastActionRef.current = { action, time: now };

      if (action === 'new-mail') {
        openCompose({});
        return;
      }

      if (action === 'sync') {
        try {
          addNotification({
            type: 'info',
            title: 'Sync started',
            body: 'MailFlow is checking for new mail.',
          });
          await api.syncNow();
        } catch (error) {
          addNotification({
            type: 'error',
            title: 'Sync failed',
            body: error.message || 'Could not sync mail.',
          });
        }
      }
    };

    const handleNativeAction = (event) => {
      runNativeAction(event.detail?.action);
    };

    const unsubscribe = window.mailflowNative?.actions?.onAction?.((payload) => {
      runNativeAction(payload?.action);
    });

    window.addEventListener('mailflow:native-action', handleNativeAction);
    return () => {
      window.removeEventListener('mailflow:native-action', handleNativeAction);
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, [addNotification, openCompose]);

  return null;
}
