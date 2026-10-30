// Which read-state action is the user's latest, per message.
//
// Every read or unread goes out as a bulk-read POST, from wherever it starts: the reading pane, the
// list, a conversation card, a hotkey, the GTD rail. The GTD rail's read waits on a getThread round
// trip before it sends anything, so a quick "Mark as unread" from the reading pane went out first
// and the older read after it: the message ended up read on the server although the user's last
// action had been unread.
//
// An action that has to look something up before it can send reserves its place when the user acts
// (reserveReadIntent), sends only for the messages nobody has acted on since, and then releases the
// reservation (releaseReadIntent). The newer action has already been sent for the rest. "Message"
// there means every copy of it: the server fans a read or unread out to the account's other copies
// with the same Message-ID, so a stale read of the GTD label copy would undo an unread of the Inbox
// copy (useGtdTriage).
//
// This does not rely on the server applying requests in the order they were sent. It does for
// actions seconds apart, but two requests sent back to back race, and nothing here changes that:
// it only stops an action from going out after a newer one it never knew about. Requests are not
// held back until the one before them answers either: the server writes the row before it answers,
// after the IMAP store, so holding an unread behind a slow read kept the message read on the server,
// and in every list refresh, for as long as the read took.

// A counter, not a clock: two actions in the same millisecond still have an order.
let lastSeq = 0;
// Message id: the seq of the latest read-state action on it. Only kept while a reservation is
// outstanding, and only what one could still ask about.
const latestIntent = new Map();
// The reservations not yet released.
const outstanding = new Set();

// Drops what no outstanding reservation can ask about: entries at or below the oldest one, or every
// entry when none is outstanding.
function prune() {
  if (!outstanding.size) {
    latestIntent.clear();
    return;
  }
  const oldest = Math.min(...outstanding);
  for (const [id, seq] of latestIntent) if (seq <= oldest) latestIntent.delete(id);
}

// The place of an action that sends later. Pass it to orderedRead as `since`, and release it with
// releaseReadIntent once the action is done.
export function reserveReadIntent() {
  const seq = ++lastSeq;
  outstanding.add(seq);
  return seq;
}

export function releaseReadIntent(since) {
  outstanding.delete(since);
  prune();
}

// Whether the user has acted on the message's read state since `since` was reserved.
export function readIntentSince(id, since) {
  return (latestIntent.get(id) ?? 0) > since;
}

// Every message acted on since `since` was reserved.
export function readIntentIdsSince(since) {
  const ids = new Set();
  for (const [id, seq] of latestIntent) if (seq > since) ids.add(id);
  return ids;
}

// Records the action on `ids`, for a reservation outstanding to see, and sends `send(ids)` at once.
// With `since`, the ids acted on after it was reserved are left out, and with none left nothing is
// sent and the result is null.
export function orderedRead(ids, send, { since } = {}) {
  const list = since == null ? [...ids] : ids.filter(id => !readIntentSince(id, since));
  if (!list.length) return Promise.resolve(null);
  const seq = ++lastSeq;
  if (outstanding.size) for (const id of list) latestIntent.set(id, seq);
  try {
    return Promise.resolve(send(list));
  } catch (err) {
    return Promise.reject(err);
  }
}

// Tests only.
export function _resetReadOrder() {
  lastSeq = 0;
  latestIntent.clear();
  outstanding.clear();
}

export function _readIntentSize() {
  return latestIntent.size;
}
