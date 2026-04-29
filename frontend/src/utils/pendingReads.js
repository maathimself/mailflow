// Tracks messageId → accountId for in-flight markRead(true) API calls.
// Shared between MessageList (writer) and useWebSocket (reader) so that
// both the message-list refresh and the unread-count refresh can avoid
// overwriting optimistic UI state during the race window between an
// optimistic mark-read and the server acknowledgement.
export const pendingMarkReadMap = new Map();
