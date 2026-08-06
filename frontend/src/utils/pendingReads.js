// pendingMarkReadMap: messageId → accountId for PATCHes that are still in-flight.
// Used by useWebSocket to adjust unread counts before the server has committed.
export const pendingMarkReadMap = new Map();

// completedMarkReadMap: messageId → accountId for PATCHes that returned successfully
// but whose DB write may not yet be visible to a concurrent getMessages SELECT.
// Entries expire after 10s — long enough to cover any in-flight getMessages response
// that raced with the mark-read commit.
export const completedMarkReadMap = new Map();

// Safety timeout handles keyed by messageId — cancels the previous timer if the
// same messageId is re-used before the old one fires, preventing a stale timer
// from deleting a newer in-flight entry for the same message.
const _pendingTimers = new Map();
const _completedTimers = new Map();

// Set a pending entry with a 30-second safety timeout.
// Callers still call pendingMarkReadMap.delete() on success/error; the timeout
// is a fallback so a hung or abandoned request never leaves a permanent entry.
export function setPending(messageId, accountId) {
  const prev = _pendingTimers.get(messageId);
  if (prev) clearTimeout(prev);
  const timer = setTimeout(() => {
    pendingMarkReadMap.delete(messageId);
    _pendingTimers.delete(messageId);
  }, 30000);
  _pendingTimers.set(messageId, timer);
  pendingMarkReadMap.set(messageId, accountId);
}

export function clearPending(messageId) {
  const timer = _pendingTimers.get(messageId);
  if (timer) clearTimeout(timer);
  _pendingTimers.delete(messageId);
  pendingMarkReadMap.delete(messageId);
}

export function setCompleted(messageId, accountId) {
  clearPending(messageId);
  const previous = _completedTimers.get(messageId);
  if (previous) clearTimeout(previous);
  completedMarkReadMap.set(messageId, accountId);
  const timer = setTimeout(() => {
    completedMarkReadMap.delete(messageId);
    _completedTimers.delete(messageId);
  }, 10000);
  _completedTimers.set(messageId, timer);
}

export function clearReadGuard(messageId) {
  clearPending(messageId);
  const timer = _completedTimers.get(messageId);
  if (timer) clearTimeout(timer);
  _completedTimers.delete(messageId);
  completedMarkReadMap.delete(messageId);
}
