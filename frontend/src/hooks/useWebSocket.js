import { useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';
import { playNotificationSound } from '../utils/notificationSounds.js';
import { pendingMarkReadMap } from '../utils/pendingReads.js';
import { updateFaviconBadge } from '../themes.js';

// Compute the correct favicon count given unread counts and the currently
// selected account. Reads selectedAccountId from the store directly so this
// can be called outside React's render cycle.
function _faviconCount(counts) {
  const { selectedAccountId } = useStore.getState();
  return selectedAccountId ? (counts.byAccount[selectedAccountId] ?? 0) : counts.total;
}

// Apply a fresh server count, guarding against double-adjustment of in-flight
// mark-read operations.
//
// Since /unread-counts now queries messages directly, the DB reflects a
// mark-read as soon as the PATCH's UPDATE commits — which happens well before
// IMAP flag work finishes and before the HTTP response returns. This means
// pendingMarkReadMap can lag the DB by hundreds of milliseconds, and naively
// subtracting it from the server count would undercount by one per in-flight read.
//
// Guard: only subtract pending reads when the server count is still at least
// (current optimistic + pending size). If the server count is already lower,
// the DB has applied those reads and subtracting again would double-count.
function _applyServerCounts(counts) {
  if (pendingMarkReadMap.size > 0) {
    const current = useStore.getState().unreadCounts;
    if (counts.total >= current.total + pendingMarkReadMap.size) {
      // Server hasn't incorporated in-flight reads yet — subtract them.
      const byAccount = { ...counts.byAccount };
      for (const accountId of pendingMarkReadMap.values()) {
        if (byAccount[accountId] > 0) byAccount[accountId]--;
      }
      const total = Math.max(0, counts.total - pendingMarkReadMap.size);
      useStore.setState({ unreadCounts: { total, byAccount } });
    } else {
      // DB already applied the reads — use the authoritative count directly.
      useStore.setState({ unreadCounts: counts });
    }
  } else {
    useStore.setState({ unreadCounts: counts });
  }
}

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
  const { addNotification, updateAccount, setFolders, setBackfillProgress } = useStore();

  const connect = useCallback(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

    ws.onopen = () => {
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

        // Refresh unread counts from the server. Messages are fully inserted in the
        // DB by the time new_messages fires, so this returns the authoritative count
        // and corrects any optimistic delta that exists_hint applied earlier.
        // Also handles periodic syncs that have no preceding exists_hint.
        if (isInbox) {
          api.getUnreadCounts().then(_applyServerCounts).catch(() => {});
        }
        break;
      }

      case 'exists_hint': {
        // Optimistic unread increment: fired immediately when the IMAP server
        // signals new mail, before the full fetch+insert cycle completes.
        // The subsequent new_messages event will correct the count to the
        // authoritative server value.
        const { accountId, delta } = data;
        const counts = useStore.getState().unreadCounts;
        const byAccount = { ...counts.byAccount };
        byAccount[accountId] = (byAccount[accountId] || 0) + delta;
        const newCounts = { total: counts.total + delta, byAccount };
        useStore.setState({ unreadCounts: newCounts });
        // Update favicon immediately — do not wait for React's render cycle.
        // With a pre-cached base this is synchronous (no image load round-trip).
        updateFaviconBadge(_faviconCount(newCounts));
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

      case 'backfill_all_start': {
        setBackfillProgress(data.accountId, { synced: 0, total: null });
        break;
      }

      case 'backfill_progress': {
        // Update progress state for the settings UI
        setBackfillProgress(data.accountId, { synced: data.synced, total: data.total });
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

      case 'backfill_all_complete': {
        clearTimeout(backfillRefreshTimer);
        window.dispatchEvent(new CustomEvent('mailflow:refresh'));
        setBackfillProgress(data.accountId, null);
        break;
      }

      case 'folder_updated': {
        // Emitted by move/archive routes after messages land in a destination folder.
        // Triggers a silent refresh so the destination folder shows the moved messages
        // without playing sounds or popping notifications.
        const { accountId: fuAccountId, folder: fuFolder } = data;
        const fuStore = useStore.getState();
        const fuRelevant = fuStore.selectedAccountId === null || fuStore.selectedAccountId === fuAccountId;
        const fuVisible  = fuStore.selectedFolder === (fuFolder || 'INBOX');
        if (fuRelevant && fuVisible) {
          window.dispatchEvent(new CustomEvent('mailflow:refresh'));
        }
        break;
      }

      case 'sync_complete': {
        window.dispatchEvent(new CustomEvent('mailflow:refresh'));
        window.dispatchEvent(new CustomEvent('mailflow:sync_done'));
        // Re-fetch unread counts so sidebar badges reflect messages marked read
        // in external clients (the message list refresh alone doesn't update counts).
        api.getUnreadCounts().then(_applyServerCounts).catch(() => {});
        // Re-fetch per-folder counts for the affected account so sidebar folder
        // badges stay in sync (unread_count, total_count). Only refresh accounts
        // whose folders are already loaded to avoid unnecessary requests.
        if (data.accountId && useStore.getState().folders[data.accountId]) {
          api.getFolders(data.accountId).then(f => setFolders(data.accountId, f)).catch(() => {});
        }
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
        api.getUnreadCounts().then(_applyServerCounts).catch(() => {});
        break;
      }
    }
  }, [addNotification, updateAccount, setFolders, t]);

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
