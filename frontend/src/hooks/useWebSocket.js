import { useEffect, useRef, useCallback } from 'react';
import { useStore } from '../store/index.js';

export function useWebSocket() {
  const wsRef = useRef(null);
  const reconnectTimer = useRef(null);
  const { addNotification, prependMessages, selectedAccountId, selectedFolder, updateAccount } = useStore();

  const connect = useCallback(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

    ws.onopen = () => {
      console.log('WebSocket connected');
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

    ws.onclose = () => {
      clearInterval(ws._pingInterval);
      // Reconnect after 3s
      reconnectTimer.current = setTimeout(connect, 3000);
    };

    ws.onerror = () => ws.close();
    wsRef.current = ws;
  }, []);

  const handleMessage = useCallback((data) => {
    switch (data.type) {
      case 'new_messages': {
        // Show notification
        const { messages, count, accountId } = data;
        if (messages && messages.length > 0) {
          const latest = messages[0];
          addNotification({
            type: 'new_mail',
            accountId,
            title: latest.fromName || latest.fromEmail || 'New message',
            body: latest.subject || '(no subject)',
            count,
          });

          // If we're viewing this account's inbox or unified inbox, prepend
          const store = useStore.getState();
          const isRelevant =
            store.selectedAccountId === null || // unified inbox
            store.selectedAccountId === accountId;

          if (isRelevant && store.selectedFolder === 'INBOX') {
            // Refresh the message list so new mail appears immediately
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
        break;
      }
    }
  }, [addNotification, updateAccount]);

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(reconnectTimer.current);
      if (wsRef.current) wsRef.current.close();
    };
  }, [connect]);

  return wsRef;
}
