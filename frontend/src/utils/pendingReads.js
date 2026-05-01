// pendingMarkReadMap: messageId → accountId for PATCHes that are still in-flight.
// Used by useWebSocket to adjust unread counts before the server has committed.
export const pendingMarkReadMap = new Map();

// completedMarkReadMap: messageId → accountId for PATCHes that returned successfully
// but whose DB write may not yet be visible to a concurrent getMessages SELECT.
// Entries expire after 10s — long enough to cover any in-flight getMessages response
// that raced with the mark-read commit.
export const completedMarkReadMap = new Map();

// Set a pending entry with a 30-second safety timeout.
// Callers still call pendingMarkReadMap.delete() on success/error; the timeout
// is a fallback so a hung or abandoned request never leaves a permanent entry.
export function setPending(messageId, accountId) {
  pendingMarkReadMap.set(messageId, accountId);
  setTimeout(() => pendingMarkReadMap.delete(messageId), 30000);
}
