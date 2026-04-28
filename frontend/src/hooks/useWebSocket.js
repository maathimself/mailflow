import { useEffect, useRef, useCallback } from 'react';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';
import { playNotificationSound } from '../utils/notificationSounds.js';

// Auth-related close codes that should not trigger reconnect
const NO_RECONNECT_CODES = new Set([4001, 4003]);
const BACKOFF_BASE = 1000;
const BACKOFF_MAX = 30000;

export function useWebSocket() {
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
      reconnectAttempt.current = 0;
      // Ping every 30s to keep alive
      const pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
      }, 30000);
      ws._pingInterval = pingInterval;
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        handleMessage(data);
      } catch (_) {}
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
        const { messages, count, accountId } = data;
        if (messages && messages.length > 0) {
          // Only notify on the tab the user is actively looking at.
          // When MailFlow is open on multiple devices (or tabs), this prevents
          // duplicate notification sounds — only the visible/focused instance reacts.
          if (document.visibilityState === 'visible') {
            const latest = messages[0];
            addNotification({
              type: 'new_mail',
              accountId,
              title: latest.fromName || latest.fromEmail || 'New message',
              body: latest.subject || '(no subject)',
              count,
            });
            const { notificationSound, customSoundDataUrl } = useStore.getState();
            playNotificationSound(notificationSound, customSoundDataUrl);
          }

          // Always refresh the message list on all tabs so new mail appears
          const store = useStore.getState();
          const isRelevant =
            store.selectedAccountId === null ||
            store.selectedAccountId === accountId;

          if (isRelevant && store.selectedFolder === 'INBOX') {
            window.dispatchEvent(new CustomEvent('mailflow:refresh'));
          }
        }

        // Update unread counts
        const countsStore = useStore.getState();
        const byAccount = { ...countsStore.unreadCounts.byAccount };
        byAccount[data.accountId] = (byAccount[data.accountId] || 0) + data.count;
        useStore.setState({
          unreadCounts: {
            total: countsStore.unreadCounts.total + data.count,
            byAccount,
          }
        });
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
        clearTimeout(window._backfillRefreshTimer);
        window._backfillRefreshTimer = setTimeout(() => {
          window.dispatchEvent(new CustomEvent('mailflow:refresh'));
        }, 2000);
        break;
      }

      case 'backfill_complete': {
        clearTimeout(window._backfillRefreshTimer);
        window.dispatchEvent(new CustomEvent('mailflow:refresh'));
        break;
      }

      case 'sync_complete': {
        window.dispatchEvent(new CustomEvent('mailflow:refresh'));
        window.dispatchEvent(new CustomEvent('mailflow:sync_done'));
        // Re-fetch unread counts so sidebar badges reflect messages marked read
        // in external clients (the message list refresh alone doesn't update counts)
        api.getUnreadCounts().then(counts => {
          useStore.setState({ unreadCounts: counts });
        }).catch(() => {});
        break;
      }
    }
  }, [addNotification, updateAccount]);

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
