// A row that carries unread_count (every conversation row, and any row the list has marked read
// on open) is drawn by it in the context menu, the swipe action and the thread controls, while
// the row itself and the reading pane go by is_read. An update that flips is_read and says
// nothing about unread_count moves the count by that one message, so the two cannot disagree:
// "Mark as unread" from the reading pane left unread_count at 0, and the row's menu went on
// offering "Mark as unread" for a message shown unread (#683). Every writer of a row's read
// state goes through this: the store's updateMessage and the list refresh's read guard.
export function applyMessageUpdate(m, updates) {
  const next = { ...m, ...updates };
  if (typeof updates.is_read !== 'boolean' || 'unread_count' in updates || updates.is_read === !!m.is_read) return next;
  const count = Number.parseInt(m.unread_count, 10);
  if (!Number.isFinite(count)) return next;
  next.unread_count = updates.is_read ? Math.max(0, count - 1) : count + 1;
  return next;
}
