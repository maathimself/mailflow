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
