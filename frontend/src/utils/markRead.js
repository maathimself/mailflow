import { useStore } from '../store/index.js';
import { api } from './api.js';
import { pendingMarkReadMap, completedMarkReadMap, setPending } from './pendingReads.js';

const scheduledByMessage = new Map();
const scheduledMessageByTimer = new Map();

export function cancelScheduledMarkRead(timer) {
  if (!timer) return;
  clearTimeout(timer);
  const id = scheduledMessageByTimer.get(timer);
  if (id == null) return;
  scheduledMessageByTimer.delete(timer);
  const timers = scheduledByMessage.get(id);
  timers?.delete(timer);
  if (timers?.size === 0) scheduledByMessage.delete(id);
}

export function cancelScheduledMarkReadFor(id) {
  const timers = scheduledByMessage.get(id);
  if (!timers) return;
  for (const timer of timers) {
    clearTimeout(timer);
    scheduledMessageByTimer.delete(timer);
  }
  scheduledByMessage.delete(id);
}

// The mark-read protocol, in one place.
//
// Three callers need it: MessagePane (opening a message in the reading pane),
// ConversationPane (expanding a card in a thread) and MailApp (the deep-link and
// notification-tap path). It is not a one-liner worth copying: the optimistic flag,
// the unread badge, the category count and the pending-read guard have to be set
// together and rolled back together, or a failed PATCH leaves the badge drifting
// away from the list it is supposed to be counting.
//
// Idempotent: an already-read message is a no-op, so callers do not have to guard.

export function applyMarkRead(msg) {
  if (!msg || msg.is_read) return;
  const st = useStore.getState();
  st.updateMessage(msg.id, { is_read: true });
  st.decrementUnread(msg.account_id);
  st.adjustCategoryCount(msg.category, -1);
  // The guard stops a concurrent sync from reverting the optimistic flag before
  // the server has committed.
  setPending(msg.id, msg.account_id);
  api.bulkRead([msg.id], true)
    .then(() => {
      pendingMarkReadMap.delete(msg.id);
      // Covers the window where the PATCH has committed but a getMessages SELECT
      // already in flight still returns the old is_read. Expires after 10s.
      completedMarkReadMap.set(msg.id, msg.account_id);
      setTimeout(() => completedMarkReadMap.delete(msg.id), 10000);
    })
    .catch(e => {
      console.error('markRead failed:', e.message);
      st.updateMessage(msg.id, { is_read: false });
      st.incrementUnread(msg.account_id);
      st.adjustCategoryCount(msg.category, 1);
      pendingMarkReadMap.delete(msg.id);
    });
}

// Honors the user's markReadBehavior preference. Returns a timer handle when the
// mark was deferred, so the caller can cancelScheduledMarkRead it if the reader
// moves on first, and null when there is nothing to cancel.
export function scheduleMarkRead(msg) {
  if (!msg || msg.is_read) return null;
  const { markReadBehavior, markReadDelay } = useStore.getState();
  if (markReadBehavior === 'manual') return null;
  if (markReadBehavior === 'delay') {
    const timer = setTimeout(() => {
      const timers = scheduledByMessage.get(msg.id);
      timers?.delete(timer);
      scheduledMessageByTimer.delete(timer);
      if (timers?.size === 0) scheduledByMessage.delete(msg.id);
      applyMarkRead(msg);
    }, (markReadDelay || 1) * 1000);
    if (!scheduledByMessage.has(msg.id)) scheduledByMessage.set(msg.id, new Set());
    scheduledByMessage.get(msg.id).add(timer);
    scheduledMessageByTimer.set(timer, msg.id);
    return timer;
  }
  applyMarkRead(msg);
  return null;
}
