// Which local changes move an account's unread badge.
//
// The badge is the unread count of that account's INBOX folder and nothing else: GET
// /mail/unread-counts reads the server's STATUS of the folder whose path is literally 'INBOX', and
// the category counts are INBOX-only as well. So reading, deleting, archiving or moving unread mail
// in any other folder leaves it as it is. Charging those changes to it made the badge drop for mail
// that was never in the Inbox and come back once the server's count arrived, up to 15 s later
// (PENDING_COUNT_MS).
//
// The optimistic change is made only where its result is certain. Where it is not (a "not spam"
// moves mail to the account's mapped inbox, which need not be the folder named INBOX), nothing is
// charged and the server's count brings the change: a badge that is late is better than one that
// is wrong.
export const BADGE_FOLDER = 'INBOX';

export const inInbox = message => message?.folder === BADGE_FOLDER;

// `count` when the message is in INBOX, else 0. A message without a folder is not known to be in
// INBOX, so it charges nothing.
export function inboxShare(message, count = 1) {
  return inInbox(message) && Number.isFinite(count) && count > 0 ? count : 0;
}

// The unread INBOX messages among `messages`, per account.
export function inboxUnreadByAccount(messages) {
  const counts = new Map();
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message?.account_id || message.is_read || !inInbox(message)) continue;
    counts.set(message.account_id, (counts.get(message.account_id) || 0) + 1);
  }
  return counts;
}

// The immediate estimate for a list row, before its conversation is read: a thread row's own
// unread_count (which counts only the listed folder, see messageService.listMessages), else one
// for an unread row. Nothing for a row outside INBOX, even a conversation: the messages an action
// takes from INBOX are known only once it is read, and the actions that read it correct the
// estimate then.
export function rowInboxUnread(row, isThreadRow) {
  if (!inInbox(row)) return 0;
  const aggregate = Number.parseInt(row.unread_count, 10);
  if (isThreadRow && Number.isFinite(aggregate)) return Math.max(0, aggregate);
  return row.is_read ? 0 : 1;
}

// How a move of `count` unread messages to `destination` changes the badge: down when they leave
// INBOX, up when they arrive in it, nothing between two other folders. Read mail moves nothing.
export function inboxMoveDelta(message, destination, count = 1) {
  if (!message || message.is_read || !Number.isFinite(count) || count <= 0) return 0;
  const from = inInbox(message);
  const to = destination === BADGE_FOLDER;
  if (from === to) return 0;
  return to ? count : -count;
}
