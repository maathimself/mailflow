import { useStore } from '../store/index.js';
import { api } from './api.js';
import { setPending, settleMarkRead, failMarkRead, onReadRollback, pendingMarkReadMap, completedMarkReadMap } from './pendingReads.js';

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
// Idempotent: an already-read message is a no-op, so callers do not have to guard. So is one whose
// read is already in flight or has just landed, whatever the copy passed in says.

// onChange(isRead) hears the optimistic change and its rollback, for a caller that keeps its own
// copy of the message beside the store's: a conversation card does.
export function applyMarkRead(msg, { onChange } = {}) {
  if (!msg || msg.is_read) return;
  const st = useStore.getState();
  // A read of this message is already under way, or has just landed and the store still shows it:
  // a stale copy must not count it a second time. Opening a conversation marks its row read from the
  // list, and the card the pane opens then marked the same message read again from the thread's
  // copy, fetched before the first read landed. It goes by that read's guard, not the store's flag
  // alone, which may itself be stale (an unread on another device while the socket was down); a
  // failed read has given its guard up, and a manual unread clears it.
  if (readUnderWay(st, msg.id)) {
    onChange?.(true);
    // That read failing rolls the store back; the caller's own copy has to follow it.
    if (onChange) onReadRollback(msg.id, () => onChange(false));
    return;
  }
  st.updateMessage(msg.id, { is_read: true });
  onChange?.(true);
  st.decrementUnread(msg.account_id);
  st.adjustCategoryCount(msg.category, -1);
  // The guard stops a concurrent sync from reverting the optimistic flag before
  // the server has committed.
  const token = setPending(msg.id, msg.account_id);
  api.bulkRead([msg.id], true)
    // Covers the window where the PATCH has committed but a getMessages SELECT
    // already in flight still returns the old is_read. Expires after 10s.
    .then(() => settleMarkRead(msg.id, msg.account_id, token))
    .catch(e => {
      console.error('markRead failed:', e.message);
      // Marked unread (or read again) by hand meanwhile: that state is the user's.
      if (!failMarkRead(msg.id, token)) return;
      st.updateMessage(msg.id, { is_read: false });
      onChange?.(false);
      st.incrementUnread(msg.account_id);
      st.adjustCategoryCount(msg.category, 1);
    });
}

function readUnderWay(st, id) {
  if (pendingMarkReadMap.has(id)) return true;
  if (!completedMarkReadMap.has(id)) return false;
  const lists = [st.messages, st.searchResults, ...Object.values(st.threadMessages || {})];
  return lists.some(list => Array.isArray(list) && list.some(m => m?.id === id && m.is_read));
}

// Honors the user's markReadBehavior preference. Returns a timer handle when the
// mark was deferred, so the caller can cancelScheduledMarkRead it if the reader
// moves on first, and null when there is nothing to cancel.
export function scheduleMarkRead(msg, options) {
  if (!msg || msg.is_read) return null;
  const { markReadBehavior, markReadDelay } = useStore.getState();
  if (markReadBehavior === 'manual') return null;
  if (markReadBehavior === 'delay') {
    return scheduleMarkReadTimer(msg.id, () => applyMarkRead(msg, options), (markReadDelay || 1) * 1000);
  }
  applyMarkRead(msg, options);
  return null;
}

// Every delayed automatic read goes through this registry, whoever schedules it, so that an
// explicit read or unread on the message can cancel it with cancelScheduledMarkReadFor(id). The
// list's own open-time delay was a bare setTimeout no other path could reach: marking the message
// read by hand counted it twice when the delay ran out, and marking it unread again was undone by
// it, on screen and on the server (#683).
export function scheduleMarkReadTimer(id, run, delayMs) {
  const timer = setTimeout(() => {
    const timers = scheduledByMessage.get(id);
    timers?.delete(timer);
    scheduledMessageByTimer.delete(timer);
    if (timers?.size === 0) scheduledByMessage.delete(id);
    run();
  }, delayMs);
  if (!scheduledByMessage.has(id)) scheduledByMessage.set(id, new Set());
  scheduledByMessage.get(id).add(timer);
  scheduledMessageByTimer.set(timer, id);
  return timer;
}
