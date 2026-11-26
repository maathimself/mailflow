// One row per React key in the message list. A conversation row is keyed by its thread and a
// message row by its id (MessageList), and two rows sharing a key are worse than a duplicate on
// screen: once the list reorders, React keeps one of them and never removes the other's DOM, so
// that row stayed in the list through every mailbox opened after it, until a reload.

// SNOOZED_FOLDER in snoozeActions.js, which imports the store; the store imports this file.
const SNOOZED_FOLDER = 'Snoozed';

// Whether the list draws conversation rows, by MessageList's rule: the Snoozed view and search
// results list single messages.
export function isThreadedList({ threadedView, selectedFolder }, { search = false } = {}) {
  return Boolean(threadedView) && selectedFolder !== SNOOZED_FOLDER && !search;
}

export const listRowKey = (message, threaded) => (threaded && message.thread_id) || message.id;

// The rows with one per key, each where it was listed. Of a conversation listed twice the newest
// row stays: it is the conversation as it is now, the older one a copy an Undo put back or a
// refresh has since replaced. Returns the same array when nothing repeats.
export function uniqueListRows(rows, threaded) {
  const kept = new Map();
  for (const row of rows) {
    const key = listRowKey(row, threaded);
    const held = kept.get(key);
    if (!held || Date.parse(row.date) > Date.parse(held.date)) kept.set(key, row);
  }
  if (kept.size === rows.length) return rows;
  const out = [];
  for (const row of rows) {
    const key = listRowKey(row, threaded);
    if (kept.get(key) === row) { out.push(row); kept.delete(key); }
  }
  return out;
}
