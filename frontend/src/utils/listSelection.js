import { useStore } from '../store/index.js';

// What the reading pane shows when the open message (or conversation) leaves the list: by delete,
// archive, move, spam or snooze, from the list, the reading pane or the conversation pane alike
// (#572). The afterRemove preference picks the row that takes its place: the next one in display
// order (falling back to the previous one at the end of the list), the previous one (falling back
// to the next), or none, back to the list. On a phone it is always back to the list: the list is
// hidden while a message is open, and swiping into an unrelated message after a delete would be
// surprising.
//
// Call before removeMessage, so the outgoing row is still there to look up. A no-op unless the
// removed message is the selected one. selectedWithinRemovedRow: advance even when the selected id
// is not removedId itself, because the open message is part of the removed row (a thread child
// under its head, or a conversation acted on as a whole).

// The list registers how a row is opened, so an advance opens it exactly as a click does: marked
// read by the reader's setting, the body warmed, the Drafts folder's rules applied. Without one
// (no list mounted) the row is only selected.
let openRow = null;
export function registerRowOpener(fn) {
  openRow = fn;
  return () => { if (openRow === fn) openRow = null; };
}

const isPhone = () => typeof window !== 'undefined' && window.innerWidth < 768;

// The row that takes removedId's place: a row, null for "back to the list", or undefined when
// removedId is not a row of the list on screen (nothing to decide; the caller leaves selection be).
export function rowAfterRemoval(removedId) {
  const { messages, searchResults, searchQuery, afterRemove } = useStore.getState();
  const displayMsgs = searchQuery.trim() ? searchResults : messages;
  const idx = displayMsgs.findIndex(m => m.id === removedId);
  if (idx === -1) return undefined;
  if (afterRemove === 'list' || isPhone()) return null;
  const [first, second] = afterRemove === 'previous' ? [idx - 1, idx + 1] : [idx + 1, idx - 1];
  return displayMsgs[first] || displayMsgs[second] || null;
}

export function advanceSelectionAfterRemoval(removedId, selectedWithinRemovedRow = false) {
  const { selectedMessageId, setSelectedMessage } = useStore.getState();
  if (!selectedWithinRemovedRow && selectedMessageId !== removedId) return;
  const next = rowAfterRemoval(removedId);
  if (next === undefined) return;
  if (next && openRow) openRow(next);
  else setSelectedMessage(next?.id ?? null);
}

// Swiping between messages on a phone (#229): the row before or after the open one in the list on
// screen. The open message is a row itself, or a message inside a row's thread (a conversation's
// message, an expanded thread's child), whose row is found by its thread. `threadId` names the
// conversation the reader is in when the selected message may not be in the store at all.
export function adjacentRow(direction, threadId = null) {
  const { messages, searchResults, searchQuery, selectedMessageId, threadMessages } = useStore.getState();
  const rows = searchQuery.trim() ? searchResults : messages;
  let idx = rows.findIndex(m => m.id === selectedMessageId);
  if (idx === -1) {
    const open = Object.values(threadMessages || {}).flat().find(m => m.id === selectedMessageId);
    const tid = open?.thread_id || threadId;
    if (tid) idx = rows.findIndex(m => (m.thread_id || m.id) === tid);
  }
  if (idx === -1) return null;
  return rows[idx + (direction === 'next' ? 1 : -1)] ?? null;
}

// Opens that row exactly as a click does (registerRowOpener above): marked read by the reader's
// setting, its body warmed, a conversation opened as one. False when there is none that way.
export function openAdjacentRow(direction, threadId = null) {
  const row = adjacentRow(direction, threadId);
  if (!row) return false;
  if (openRow) openRow(row);
  else useStore.getState().setSelectedMessage(row.id);
  return true;
}
