import test from 'node:test';
import assert from 'node:assert/strict';
import { selectedPickerMessage, labelPickerOptions, pickerNavigationDirection, executeLabelChoice } from './labelPicker.js';

const account = { id: 'a1', enabled: true, folder_mappings: { archive: 'Archive' } };
const folders = [
  { path: 'INBOX', name: 'Inbox', special_use: '\\Inbox' },
  { path: 'Sent', name: 'Sent', special_use: '\\Sent' },
  { path: 'Trash', name: 'Trash', special_use: '\\Trash' },
  { path: 'Archive', name: 'Archive' },
  { path: 'Projects', name: 'Projects' },
  { path: 'Action', name: 'Action' },
  { path: 'Reference', name: 'Reference' },
  { path: 'Disabled', name: 'Disabled', no_select: true },
];

test('picker captures selected message identity from a sidebar section', () => {
  const s = { selectedMessageId: 'rail', messages: [{ id: 'other' }], searchResults: [], threadMessages: {},
    gtdSections: { todo: { threads: [{ id: 'rail', account_id: 'a1', folder: 'Action' }] } } };
  const captured = selectedPickerMessage(s);
  s.selectedMessageId = 'other';
  assert.deepEqual(captured, { id: 'rail', account_id: 'a1', folder: 'Action', thread_id: undefined, message_count: undefined });
});

test('picker captures the frontmost open message window when the list has no selection', () => {
  const captured = selectedPickerMessage({
    selectedMessageId: null,
    messages: [
      { id: 'behind', account_id: 'a1', folder: 'INBOX' },
      { id: 'front', account_id: 'a1', folder: 'Projects' },
    ],
    messageWindows: [
      { messageId: 'behind', z: 2, minimized: false },
      { messageId: 'front', z: 4, minimized: false },
    ],
  });
  assert.equal(captured.id, 'front');
  assert.equal(captured.folder, 'Projects');
});

test('picker uses the active search row when its id also exists in the mailbox list', () => {
  const captured = selectedPickerMessage({
    selectedMessageId: 'same', searchQuery: 'project',
    messages: [{ id: 'same', account_id: 'a1', folder: 'INBOX' }],
    searchResults: [{ id: 'same', account_id: 'a2', folder: 'Projects' }],
  });
  assert.equal(captured.account_id, 'a2');
  assert.equal(captured.folder, 'Projects');
});

test('options stay in one account and exclude system folders', () => {
  const options = labelPickerOptions(folders, account, 'Action');
  assert.deepEqual(options.map(o => o.path), ['Projects', 'Reference']);
});

test('picker navigation accepts arrows and Ctrl+N/J/P/K only', () => {
  assert.equal(pickerNavigationDirection({ key: 'ArrowDown' }), 1);
  assert.equal(pickerNavigationDirection({ key: 'n', ctrlKey: true }), 1);
  assert.equal(pickerNavigationDirection({ key: 'J', ctrlKey: true }), 1);
  assert.equal(pickerNavigationDirection({ key: 'p', ctrlKey: true }), -1);
  assert.equal(pickerNavigationDirection({ key: 'k', ctrlKey: true }), -1);
  assert.equal(pickerNavigationDirection({ key: 'k', metaKey: true }), 0);
});

test('choice copies captured message', async () => {
  const calls = [];
  const api = { copyMessage: async (...args) => calls.push(['copy', ...args]) };
  const captured = { id: 'captured', account_id: 'a1', folder: 'INBOX' };
  await executeLabelChoice(captured, { path: 'Projects' }, api);
  assert.deepEqual(calls, [['copy', 'captured', 'Projects']]);
});

test('thread copy keeps account scope, skips existing target copies, and copies each message once', async () => {
  const copied = [];
  const api = {
    getThread: async () => ({ messages: [
      { id: 'm1', account_id: 'a1', folder: 'INBOX', message_id: '<one>' },
      { id: 'duplicate', account_id: 'a1', folder: 'Archive', message_id: '<one>' },
      { id: 'm2', account_id: 'a1', folder: 'INBOX', message_id: '<two>' },
      { id: 'other', account_id: 'a2', folder: 'INBOX', message_id: '<three>' },
    ] }),
    copyMessage: async (...args) => copied.push(args),
  };
  await executeLabelChoice({ id: 'm1', account_id: 'a1', folder: 'INBOX', thread_id: 'thread', message_count: 4 },
    { path: 'Projects' }, api);
  assert.deepEqual(copied, [['m1', 'Projects'], ['m2', 'Projects']]);
});

test('thread copy falls back to the captured message when fetched rows have no copyable target', async () => {
  const copied = [];
  await executeLabelChoice({ id: 'captured', account_id: 'a1', folder: 'INBOX', thread_id: 'thread', message_count: 2 },
    { path: 'Projects' }, {
      getThread: async () => ({ messages: [{ id: 'other', account_id: 'a2', folder: 'INBOX' }] }),
      copyMessage: async (...args) => copied.push(args),
    });
  assert.deepEqual(copied, [['captured', 'Projects']]);
});
