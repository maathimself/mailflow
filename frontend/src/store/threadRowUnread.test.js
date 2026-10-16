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

// updateMessage rebuilds a conversation row's unread state from the cached conversation whenever
// a message that is not itself a row changes. The WebSocket echo of the reader's own mark-read is
// one such change: the server reports every id it marked, and only the newest is the row. One
// email delivered to two of the reader's accounts is in that cache twice (#476).
const ROW = { id: 'a-new', thread_id: 't', account_id: 'a', is_read: true, unread_count: 0, message_count: 2 };
const CACHED = [
  { id: 'a-old', thread_id: 't', account_id: 'a', is_read: true },
  { id: 'a-new', thread_id: 't', account_id: 'a', is_read: true },
  { id: 'b-new', thread_id: 't', account_id: 'b', is_read: false },
];
const echo = (selectedAccountId) => {
  useStore.setState({ selectedAccountId, messages: [ROW], searchResults: [], threadMessages: { t: CACHED } });
  useStore.getState().updateMessage('a-old', { is_read: true });
  return useStore.getState().messages[0];
};

test('in one account\'s view the echo of its mark-read leaves the conversation row read', () => {
  // Marking A's row read took A's copies only and left B's unread, which is what the cache shows.
  const row = echo('a');
  assert.equal(row.unread_count, 0, 'B\'s unread copy is not counted against A\'s row');
  assert.equal(row.is_read, true);
});

test('in the unified inbox the row still counts every cached copy', () => {
  // A unified row stands for every unified account's copies, so B's unread copy is its own.
  const row = echo(null);
  assert.equal(row.unread_count, 1);
  assert.equal(row.is_read, false);
});
