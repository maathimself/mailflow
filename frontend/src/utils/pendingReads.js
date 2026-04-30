// pendingMarkReadMap: messageId → accountId for PATCHes that are still in-flight.
// Used by useWebSocket to adjust unread counts before the server has committed.
export const pendingMarkReadMap = new Map();

// completedMarkReadMap: messageId → accountId for PATCHes that returned successfully
// but whose DB write may not yet be visible to a concurrent getMessages SELECT.
// Entries expire after 3s — long enough to cover any in-flight getMessages response
// that raced with the mark-read commit.
export const completedMarkReadMap = new Map();
