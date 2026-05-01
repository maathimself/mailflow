import { useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';
import { playNotificationSound } from '../utils/notificationSounds.js';
import { pendingMarkReadMap } from '../utils/pendingReads.js';

// Auth-related close codes that should not trigger reconnect
const NO_RECONNECT_CODES = new Set([4001, 4003]);

// Module-level timer for debouncing backfill_progress refreshes
let backfillRefreshTimer = null;
const BACKOFF_BASE = 1000;
const BACKOFF_MAX = 30000;

export function useWebSocket() {
  const { t } = useTranslation();
  const wsRef = useRef(null);
  const reconnectTimer = useRef(null);
  const mountedRef = useRef(true);
  const reconnectAttempt = useRef(0);
  const { addNotification, updateAccount } = useStore();

  const connect = useCallback(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

    ws.onopen = () => {
      console.log('WebSocket connected');
      const wasReconnect = reconnectAttempt.current > 0;
      reconnectAttempt.current = 0;
      // Ping every 30s to keep alive
      const pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
      }, 30000);
      ws._pingInterval = pingInterval;
      // On reconnect, catch up on any messages that arrived during the outage
      if (wasReconnect) {
        window.dispatchEvent(new CustomEvent('mailflow:refresh'));
        api.getUnreadCounts().then(counts => {
          useStore.setState({ unreadCounts: counts });
        }).catch(() => {});
      }
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        handleMessage(data);
      } catch (err) { console.error('WS message error:', err); }
    };

    ws.onclose = (event) => {
      clearInterval(ws._pingInterval);
      if (!mountedRef.current || NO_RECONNECT_CODES.has(event.code)) return;
      const attempt = reconnectAttempt.current;
      const delay = Math.min(BACKOFF_BASE * 2 ** attempt, BACKOFF_MAX);
      const jitter = Math.random() * 0.3 * delay;
      reconnectAttempt.current = attempt + 1;
      reconnectTimer.current = setTimeout(connect, delay + jitter);
    };

    ws.onerror = () => ws.close();
    wsRef.current = ws;
  }, []);

  const handleMessage = useCallback((data) => {
    switch (data.type) {
      case 'new_messages': {
        const { messages, count, accountId, folder } = data;
        const isInbox = !folder || folder === 'INBOX';

        if (messages && messages.length > 0) {
          // In-app notifications and sounds are inbox-only — non-inbox folder syncs
          // (Archive, Spam, on-demand syncs) should not trigger alerts for old mail.
          if (isInbox && document.visibilityState === 'visible') {
            const latest = messages[0];
            addNotification({
              type: 'new_mail',
              accountId,
              title: latest.fromName || latest.fromEmail || t('notifications.newMessage'),
              body: latest.subject || t('common.noSubject'),
              count,
            });
            const { notificationSound, customSoundDataUrl } = useStore.getState();
            playNotificationSound(notificationSound, customSoundDataUrl);
          }

          // Refresh the message list when the affected folder is visible
          const store = useStore.getState();
          const isRelevant =
            store.selectedAccountId === null ||
            store.selectedAccountId === accountId;
          const folderVisible = store.selectedFolder === (folder || 'INBOX');

          if (isRelevant && folderVisible) {
            window.dispatchEvent(new CustomEvent('mailflow:refresh'));
          }
        }

        // Unread badge counts are keyed to INBOX only — the canonical unread endpoint
        // only counts INBOX messages. Non-inbox new_messages events must not inflate it.
        if (isInbox) {
          const countsStore = useStore.getState();
          const byAccount = { ...countsStore.unreadCounts.byAccount };
          byAccount[data.accountId] = (byAccount[data.accountId] || 0) + data.count;
          useStore.setState({
            unreadCounts: {
              total: countsStore.unreadCounts.total + data.count,
              byAccount,
            }
          });
        }
        break;
      }

      case 'account_connected': {
        updateAccount(data.accountId, { sync_error: null });
        break;
      }

      case 'account_error': {
        updateAccount(data.accountId, { sync_error: data.error });
        break;
      }

      case 'backfill_progress': {
        // Trigger a silent message list refresh so newly synced messages appear
        // Debounce to avoid hammering the API on every batch
        clearTimeout(backfillRefreshTimer);
        backfillRefreshTimer = setTimeout(() => {
          window.dispatchEvent(new CustomEvent('mailflow:refresh'));
        }, 2000);
        break;
      }

      case 'backfill_complete': {
        clearTimeout(backfillRefreshTimer);
        window.dispatchEvent(new CustomEvent('mailflow:refresh'));
        break;
      }

      case 'sync_complete': {
        window.dispatchEvent(new CustomEvent('mailflow:refresh'));
        window.dispatchEvent(new CustomEvent('mailflow:sync_done'));
        // Re-fetch unread counts so sidebar badges reflect messages marked read
        // in external clients (the message list refresh alone doesn't update counts).
        // Adjust for any markRead calls that are still in-flight so that a sync
        // arriving before the PATCH response doesn't undo optimistic decrements.
        api.getUnreadCounts().then(counts => {
          if (pendingMarkReadMap.size > 0) {
            const byAccount = { ...counts.byAccount };
            for (const accountId of pendingMarkReadMap.values()) {
              if (byAccount[accountId] > 0) byAccount[accountId]--;
            }
            const total = Math.max(0, counts.total - pendingMarkReadMap.size);
            useStore.setState({ unreadCounts: { total, byAccount } });
          } else {
            useStore.setState({ unreadCounts: counts });
          }
        }).catch(() => {});
        break;
      }

      case 'snooze_wakeup': {
        window.dispatchEvent(new CustomEvent('mailflow:refresh'));
        api.getUnreadCounts().then(counts => {
          useStore.setState({ unreadCounts: counts });
        }).catch(() => {});
        break;
      }

      case 'flags_synced': {
        // Lightweight flag update (read/starred changed on another client).
        // Refresh the message list and unread counts without the full sync_done event.
        window.dispatchEvent(new CustomEvent('mailflow:refresh'));
        api.getUnreadCounts().then(counts => {
          if (pendingMarkReadMap.size > 0) {
            const byAccount = { ...counts.byAccount };
            for (const accountId of pendingMarkReadMap.values()) {
              if (byAccount[accountId] > 0) byAccount[accountId]--;
            }
            const total = Math.max(0, counts.total - pendingMarkReadMap.size);
            useStore.setState({ unreadCounts: { total, byAccount } });
          } else {
            useStore.setState({ unreadCounts: counts });
          }
        }).catch(() => {});
        break;
      }
    }
  }, [addNotification, updateAccount, t]);

  useEffect(() => {
    mountedRef.current = true;
    connect();
    return () => {
      mountedRef.current = false;
      clearTimeout(reconnectTimer.current);
      if (wsRef.current) wsRef.current.close();
    };
  }, [connect]);

  return wsRef;
}
