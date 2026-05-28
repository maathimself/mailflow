import { useEffect, useRef } from 'react';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';
import { installCapacitorNativeBridge } from '../utils/capacitorNativeBridge.js';

export default function ElectronNotificationBridge() {
  installCapacitorNativeBridge();

  const addNotification = useStore(state => state.addNotification);
  const openCompose = useStore(state => state.openCompose);
  const setSelectedAccount = useStore(state => state.setSelectedAccount);
  const setSelectedMessage = useStore(state => state.setSelectedMessage);
  const setSearchQuery = useStore(state => state.setSearchQuery);
  const totalUnread = useStore(state => state.unreadCounts.total);
  const lastActionRef = useRef({ action: null, time: 0 });
  const processedActionIdsRef = useRef(new Set());
  const forwardedNotificationIdsRef = useRef(new Set());

  useEffect(() => {
    window.__mailflowNativeBridgeReady = true;

    return () => {
      window.__mailflowNativeBridgeReady = false;
    };
  }, []);

  useEffect(() => {
    window.mailflowNative?.badges?.setUnreadCount?.(totalUnread || 0);
  }, [totalUnread]);

  useEffect(() => {
    const showNewMail = window.mailflowNative?.notifications?.showNewMail;
    if (typeof showNewMail !== 'function') return undefined;

    const forwardNewMail = (notification) => {
      showNewMail({
        title: notification.title,
        body: notification.body,
        count: notification.count,
        accountId: notification.accountId,
        folder: notification.folder,
        messageId: notification.messageId,
        message: notification.message,
      }).catch(() => {});
    };

    const handleHiddenNewMail = (event) => {
      forwardNewMail(event.detail || {});
    };

    useStore.getState().notifications.forEach((notification) => {
      if (notification?.id) forwardedNotificationIdsRef.current.add(notification.id);
    });

    const unsubscribe = useStore.subscribe((state) => {
      for (const notification of state.notifications) {
        if (notification?.type !== 'new_mail' || !notification.id) continue;
        if (forwardedNotificationIdsRef.current.has(notification.id)) continue;

        forwardedNotificationIdsRef.current.add(notification.id);
        forwardNewMail(notification);
      }
    });

    window.addEventListener('mailflow:new-mail-notification', handleHiddenNewMail);
    return () => {
      unsubscribe();
      window.removeEventListener('mailflow:new-mail-notification', handleHiddenNewMail);
    };
  }, []);

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
        persistent: true,
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
    const runNativeAction = async (payload) => {
      const action = typeof payload === 'string' ? payload : payload?.action;
      const id = typeof payload === 'object' ? payload?.id : null;

      if (!action) return;
      if (id && processedActionIdsRef.current.has(id)) return;
      if (id) processedActionIdsRef.current.add(id);

      const now = Date.now();
      const last = lastActionRef.current;

      if (!id && last.action === action && now - last.time < 500) return;
      lastActionRef.current = { action, time: now };

      try {
        if (action === 'new-mail') {
          openCompose(payload?.composeData || {});
          return;
        }

        if (action === 'open-message') {
          const messageId = payload?.messageId;
          if (!messageId) return;

          const folder = payload.folder || 'INBOX';
          const message = payload.message;
          const state = useStore.getState();

          setSearchQuery('');
          if (payload.accountId) {
            setSelectedAccount(payload.accountId, folder);
          }

          if (message && !state.messages.some((item) => item.id === message.id)) {
            useStore.setState((current) => ({
              messages: [{ ...message, account_id: message.account_id || payload.accountId }, ...current.messages],
            }));
          }

          window.dispatchEvent(new CustomEvent('mailflow:refresh'));
          window.setTimeout(() => setSelectedMessage(messageId), 0);
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
      } finally {
        if (id) {
          window.mailflowNative?.actions?.ack?.(id);
        }
      }
    };

    const handleNativeAction = (event) => {
      runNativeAction(event.detail);
    };

    const handleNativeMessage = (event) => {
      if (event.source !== window) return;
      if (event.data?.type !== 'mailflow:native-action') return;
      runNativeAction(event.data.payload);
    };

    const unsubscribe = window.mailflowNative?.actions?.onAction?.((payload) => {
      runNativeAction(payload);
    });

    window.mailflowNative?.actions?.getPending?.()
      .then((actions = []) => {
        actions.forEach(runNativeAction);
      })
      .catch(() => {});

    window.addEventListener('mailflow:native-action', handleNativeAction);
    window.addEventListener('message', handleNativeMessage);
    return () => {
      window.removeEventListener('mailflow:native-action', handleNativeAction);
      window.removeEventListener('message', handleNativeMessage);
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, [addNotification, openCompose, setSearchQuery, setSelectedAccount, setSelectedMessage]);

  return null;
}
