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
    if (window.mailflowNative?.platform !== 'android') return;
    window.mailflowNative?.updates?.check?.(false)?.catch?.(() => {});
  }, []);

  useEffect(() => {
    const getPayloadMessage = (payload) => {
      const state = useStore.getState();
      return payload?.message || state.messages.find((item) => item.id === payload?.messageId) || null;
    };

    const openMessageFromPayload = (payload) => {
      const messageId = payload?.messageId;
      if (!messageId) return null;

      const folder = payload.folder || 'INBOX';
      const message = getPayloadMessage(payload);
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
      return message;
    };

    const normalizeAddressList = (value) => {
      if (Array.isArray(value)) return value;
      try {
        const parsed = JSON.parse(value || '[]');
        return Array.isArray(parsed) ? parsed : [];
      } catch (_) {
        return [];
      }
    };

    const openReplyFromPayload = (payload) => {
      const message = getPayloadMessage(payload);
      if (!message) return;

      const replyTo = normalizeAddressList(message.reply_to ?? message.replyTo);
      const replyTarget = replyTo[0]?.email
        ? replyTo[0]
        : {
            name: message.from_name || message.fromName || '',
            email: message.from_email || message.fromEmail || '',
          };
      const sender = replyTarget.email ? [replyTarget] : [];
      const rawSubject = (message.subject || '').trim();
      const subject = rawSubject.startsWith('Re:') ? rawSubject : rawSubject ? `Re: ${rawSubject}` : 'Re:';
      const originalMessageId = message.message_id || message.messageId;
      const priorInReplyTo = message.in_reply_to || message.inReplyTo;

      openCompose({
        to: sender,
        cc: [],
        subject,
        body: '',
        inReplyTo: originalMessageId,
        references: [priorInReplyTo, originalMessageId].filter(Boolean).join(' ').trim() || null,
        accountId: message.account_id || message.accountId || payload.accountId,
        isReply: true,
        originalFrom: sender,
        allRecipients: [],
      });
    };

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
          openMessageFromPayload(payload);
          return;
        }

        if (action === 'reply-message') {
          openReplyFromPayload(payload);
          return;
        }

        if (action === 'delete-message') {
          const messageId = payload?.messageId;
          if (!messageId) return;

          await api.deleteMessage(messageId);
          useStore.getState().removeMessage(messageId);
          window.dispatchEvent(new CustomEvent('mailflow:refresh'));
          return;
        }

        if (action === 'star-message') {
          const messageId = payload?.messageId;
          if (!messageId) return;

          await api.markStarred(messageId, true);
          useStore.getState().updateMessage(messageId, { is_starred: true });
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
      if (event.data?.type === 'mailflow:native-action') {
        runNativeAction(event.data.payload);
      } else if (event.data?.type === 'mailflow:native-actions-ready') {
        drainInjectedActions();
      }
    };

    const drainInjectedActions = () => {
      const actions = Array.isArray(window.__mailflowPendingNativeActions)
        ? window.__mailflowPendingNativeActions.splice(0)
        : [];
      actions.forEach(runNativeAction);
    };

    const unsubscribe = window.mailflowNative?.actions?.onAction?.((payload) => {
      runNativeAction(payload);
    });

    window.mailflowNative?.actions?.getPending?.()
      .then((actions = []) => {
        actions.forEach(runNativeAction);
      })
      .catch(() => {});

    drainInjectedActions();
    window.addEventListener('mailflow:native-action', handleNativeAction);
    window.addEventListener('mailflow:native-actions-ready', drainInjectedActions);
    window.addEventListener('message', handleNativeMessage);
    return () => {
      window.removeEventListener('mailflow:native-action', handleNativeAction);
      window.removeEventListener('mailflow:native-actions-ready', drainInjectedActions);
      window.removeEventListener('message', handleNativeMessage);
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, [addNotification, openCompose, setSearchQuery, setSelectedAccount, setSelectedMessage]);

  return null;
}
