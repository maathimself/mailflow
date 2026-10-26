import { applyMessageUpdate } from './readState.js';

// pendingMarkReadMap: messageId → accountId for PATCHes that are still in-flight.
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
const _graceTimers = new Map();

// Which mark-read each message's guard belongs to: the token setPending handed out. A read the
// user has since undone by hand (clearReadGuard) no longer owns it, so its reply, arriving
// after, neither records a grace entry nor rolls anything back. A grace entry recorded then
// turned the message read again on the next list refresh, for up to 10 seconds after the user
// had marked it unread, and the row's menu went back to offering "Mark as unread".
const _owners = new Map();

// Message id: callbacks to run if the read in flight for it fails (onReadRollback).
const _rollbackListeners = new Map();

// Runs `fn` if the read now in flight for the message fails and is rolled back, for a caller that
// keeps its own copy of the message and leaned on that read instead of sending its own (markRead.js).
// Nothing in flight, nothing to hear: returns false.
export function onReadRollback(messageId, fn) {
  if (!pendingMarkReadMap.has(messageId)) return false;
  if (!_rollbackListeners.has(messageId)) _rollbackListeners.set(messageId, new Set());
  _rollbackListeners.get(messageId).add(fn);
  return true;
}

// Set a pending entry with a 30-second safety timeout, and return the token that settles it.
// The timeout is a fallback so a hung or abandoned request never leaves a permanent entry.
export function setPending(messageId, accountId) {
  const prev = _pendingTimers.get(messageId);
  if (prev) clearTimeout(prev);
  const timer = setTimeout(() => {
    pendingMarkReadMap.delete(messageId);
    _pendingTimers.delete(messageId);
    _rollbackListeners.delete(messageId);
  }, 30000);
  _pendingTimers.set(messageId, timer);
  pendingMarkReadMap.set(messageId, accountId);
  const token = Symbol(messageId);
  _owners.set(messageId, token);
  return token;
}

function releasePending(messageId) {
  pendingMarkReadMap.delete(messageId);
  clearTimeout(_pendingTimers.get(messageId));
  _pendingTimers.delete(messageId);
}

// The server accepted the mark-read that got `token`: its grace entry is recorded, unless the
// user has changed the message's read state since. Returns whether it still stood.
export function settleMarkRead(messageId, accountId, token) {
  if (_owners.get(messageId) !== token) return false;
  _owners.delete(messageId);
  releasePending(messageId);
  _rollbackListeners.delete(messageId);
  completedMarkReadMap.set(messageId, accountId);
  clearTimeout(_graceTimers.get(messageId));
  _graceTimers.set(messageId, setTimeout(() => {
    completedMarkReadMap.delete(messageId);
    _graceTimers.delete(messageId);
  }, 10000));
  return true;
}

// The mark-read that got `token` failed. Returns whether it still stood, so the caller rolls its
// optimistic change back only then: one the user has undone or redone since is theirs now.
export function failMarkRead(messageId, token) {
  if (_owners.get(messageId) !== token) return false;
  _owners.delete(messageId);
  releasePending(messageId);
  const listeners = _rollbackListeners.get(messageId);
  _rollbackListeners.delete(messageId);
  for (const fn of listeners || []) fn();
  return true;
}

// The user has just set the message's read state by hand: any mark-read still in flight or in
// its grace period no longer speaks for it.
export function clearReadGuard(messageId) {
  _owners.delete(messageId);
  _rollbackListeners.delete(messageId);
  releasePending(messageId);
  completedMarkReadMap.delete(messageId);
  clearTimeout(_graceTimers.get(messageId));
  _graceTimers.delete(messageId);
}

// Applied to a batch of rows from the server. Prevents a concurrent sync refresh from reverting
// a pending or recently-completed mark-read before the IMAP flag has propagated back to the DB.
// A conversation row's unread_count, which the context menu and swipe actions go by, has to come
// down with is_read. `current` is what the list shows now: a guarded row keeps the count it has
// there, which every read since went through. Marking a whole conversation read set it to 0,
// where taking one off the server's stale count left a row shown read with unread mail in it.
// Without a copy on screen, the row is marked read the way the store marks it.
export function applyReadGuard(messages, current = []) {
  if (pendingMarkReadMap.size === 0 && completedMarkReadMap.size === 0) return messages;
  let shown = null;
  return messages.map(m => {
    const inFlight = pendingMarkReadMap.has(m.id);
    const inGrace = completedMarkReadMap.has(m.id);
    if (!inFlight && !inGrace) return m;
    if (!m.is_read) {
      shown ??= new Map(current.map(row => [row.id, row]));
      const local = shown.get(m.id);
      // Only from a row of the same kind: a flat row left over from before a switch to
      // conversations must not hand a conversation row its count.
      if (local?.is_read && local.unread_count !== undefined && ('message_count' in local) === ('message_count' in m)) {
        return { ...m, is_read: true, unread_count: local.unread_count };
      }
      return applyMessageUpdate(m, { is_read: true });
    }
    if (inGrace) completedMarkReadMap.delete(m.id);
    return m;
  });
}
