import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
registerHooks({ load(url, context, nextLoad) {
  return url.endsWith('.json') ? { format: 'module', source: `export default ${readFileSync(new URL(url), 'utf8')}`, shortCircuit: true } : nextLoad(url, context);
} });
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const { useStore } = await import('./index.js');
globalThis.window = new EventTarget();

// #630: an Undo (or a failed request) put messages back into whatever list was showing, so a
// conversation archived from the Inbox and undone after opening another folder appeared in that
// folder. Messages go back only into the list they left.
const INBOX = [
  { id: 'm1', account_id: 'a', folder: 'INBOX', date: '2026-10-02T10:00:00Z' },
  { id: 'm2', account_id: 'a', folder: 'INBOX', date: '2026-10-01T10:00:00Z' },
];
const ids = () => useStore.getState().messages.map(m => m.id);
const open = (selectedAccountId, selectedFolder, messages) =>
  useStore.setState({ selectedAccountId, selectedFolder, searchQuery: '', messages, searchResults: [] });

test('restored into the list they left', () => {
  open('a', 'INBOX', INBOX);
  useStore.getState().removeMessages(['m1']);
  useStore.getState().restoreMessages([INBOX[0]]);
  assert.deepEqual(ids(), ['m1', 'm2']);
});

test('not restored into another folder\'s list', () => {
  open('a', 'INBOX', INBOX);
  useStore.getState().removeMessage('m1');
  useStore.getState().removeMessage('m2');
  open('a', 'Archive', [{ id: 'x', account_id: 'a', folder: 'Archive', date: '2026-09-01T00:00:00Z' }]);
  useStore.getState().restoreMessages(INBOX);
  assert.deepEqual(ids(), ['x']);
});

test('not restored into another account\'s list, nor into a search', () => {
  open('a', 'INBOX', INBOX);
  useStore.getState().removeMessages(['m1', 'm2']);
  open('b', 'INBOX', []);
  useStore.getState().restoreMessages(INBOX);
  assert.deepEqual(ids(), []);
  open('a', 'INBOX', INBOX.slice(1));
  useStore.getState().removeMessages(['m2']);
  useStore.setState({ searchQuery: 'invoice' });
  useStore.getState().restoreMessages([INBOX[1]]);
  assert.deepEqual(useStore.getState().searchResults, []);
});

test('messages of a conversation not shown as rows go back with it', () => {
  open('a', 'INBOX', [INBOX[0]]);
  // The conversation row and a message that is only in the conversation, not a row of its own.
  useStore.getState().removeMessages(['m1', 'm2']);
  useStore.getState().restoreMessages(INBOX);
  assert.deepEqual(ids(), ['m1', 'm2']);
  open('a', 'INBOX', [INBOX[0]]);
  useStore.getState().removeMessages(['m1', 'm2']);
  open('a', 'Sent', []);
  useStore.getState().restoreMessages(INBOX);
  assert.deepEqual(ids(), []);
});

test('a message restored without being removed here is added as before', () => {
  open('a', 'Archive', []);
  useStore.getState().restoreMessages([{ id: 'n1', account_id: 'a', folder: 'Archive', date: '2026-10-03T00:00:00Z' }]);
  assert.deepEqual(ids(), ['n1']);
});

// #528: an Undo puts the row back where the folder's order lists it, and not into a list whose
// order changed meanwhile (that list loads it again).
test('restored in the folder\'s order', () => {
  const rows = [
    { id: 's1', account_id: 'a', folder: 'INBOX', from_name: 'Ann', date: '2026-10-01T10:00:00Z' },
    { id: 's2', account_id: 'a', folder: 'INBOX', from_name: 'Bob', date: '2026-10-03T10:00:00Z' },
    { id: 's3', account_id: 'a', folder: 'INBOX', from_name: 'Cy', date: '2026-10-02T10:00:00Z' },
  ];
  useStore.getState().setListOrder('a', 'INBOX', { sort: 'from', dir: 'asc', starredFirst: false });
  open('a', 'INBOX', rows);
  useStore.getState().removeMessages(['s2']);
  useStore.getState().restoreMessages([rows[1]]);
  assert.deepEqual(ids(), ['s1', 's2', 's3']);

  useStore.getState().removeMessages(['s2']);
  useStore.getState().setListOrder('a', 'INBOX', { sort: 'from', dir: 'desc', starredFirst: false });
  useStore.getState().restoreMessages([rows[1]]);
  assert.deepEqual(ids(), ['s1', 's3']);
  useStore.getState().setListOrder('a', 'INBOX', { sort: 'date', dir: 'desc', starredFirst: false });
});

test('a folder set back to newest first has no entry', () => {
  useStore.getState().setListOrder('a', 'Archive', { sort: 'subject', dir: 'asc', starredFirst: false });
  assert.deepEqual(useStore.getState().listSort['a:Archive'], { sort: 'subject', dir: 'asc', starredFirst: false });
  useStore.getState().setListOrder('a', 'Archive', { sort: 'date', dir: 'desc', starredFirst: false });
  assert.equal('a:Archive' in useStore.getState().listSort, false);
});

test('not restored into another category tab or filter of the same folder', () => {
  const row = { id: 'c1', account_id: 'a', folder: 'INBOX', date: '2026-10-05T10:00:00Z' };
  open('a', 'INBOX', [row]);
  useStore.setState({ listFilter: 'newsletter|all' });
  useStore.getState().removeMessages(['c1']);
  useStore.setState({ listFilter: 'primary|all', messages: [] });
  useStore.getState().restoreMessages([row]);
  assert.deepEqual(ids(), []);
  useStore.setState({ listFilter: null });
});

test('the saved sort orders stay under the server\'s limit, oldest dropped first', () => {
  useStore.setState({ listSort: {} });
  for (let i = 0; i < 405; i++) useStore.getState().setListOrder('a', `F${i}`, { sort: 'from', dir: 'asc', starredFirst: false });
  const keys = Object.keys(useStore.getState().listSort);
  assert.equal(keys.length, 400);
  assert.equal(keys[0], 'a:F5');
  assert.equal(keys.at(-1), 'a:F404');
  useStore.setState({ listSort: {} });
});
