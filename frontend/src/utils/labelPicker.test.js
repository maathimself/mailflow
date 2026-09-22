import test from 'node:test';
import assert from 'node:assert/strict';
import { selectedPickerMessage, labelPickerOptions, pickerNavigationDirection, executeLabelChoice } from './labelPicker.js';

const account = { id: 'a1', enabled: true, gtd_enabled: true, gtd_folders: { todo: 'Action' },
  folder_mappings: { archive: 'Archive' } };
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

test('picker captures selected message identity, including a GTD rail row', () => {
  const s = { selectedMessageId: 'rail', messages: [{ id: 'other' }], searchResults: [], threadMessages: {},
    gtdSections: { todo: { threads: [{ id: 'rail', account_id: 'a1', folder: 'Action' }] } } };
  const captured = selectedPickerMessage(s);
  s.selectedMessageId = 'other';
  assert.deepEqual(captured, { id: 'rail', account_id: 'a1', folder: 'Action', thread_id: undefined, message_count: undefined });
});

test('options stay in one account, exclude system folders, and gate GTD states', () => {
  const ordinary = labelPickerOptions(folders, account, []);
  assert.deepEqual(ordinary.map(o => o.path), ['Projects']);
  const withGtd = labelPickerOptions(folders, account, ['gtd']);
  assert.deepEqual(withGtd.map(o => o.path), ['Projects', 'Action', 'Reference']);
  assert.equal(withGtd[1].state, 'todo');
});

test('picker navigation accepts arrows and Ctrl+N/J/P/K only', () => {
  assert.equal(pickerNavigationDirection({ key: 'ArrowDown' }), 1);
  assert.equal(pickerNavigationDirection({ key: 'n', ctrlKey: true }), 1);
  assert.equal(pickerNavigationDirection({ key: 'J', ctrlKey: true }), 1);
  assert.equal(pickerNavigationDirection({ key: 'p', ctrlKey: true }), -1);
  assert.equal(pickerNavigationDirection({ key: 'k', ctrlKey: true }), -1);
  assert.equal(pickerNavigationDirection({ key: 'k', metaKey: true }), 0);
});

test('ordinary choice copies captured message; GTD choice classifies it', async () => {
  const calls = [];
  const api = { copyMessage: async (...args) => calls.push(['copy', ...args]),
    gtdClassify: async (...args) => calls.push(['gtd', ...args]) };
  const captured = { id: 'captured', account_id: 'a1', folder: 'INBOX' };
  await executeLabelChoice(captured, { path: 'Projects' }, api);
  await executeLabelChoice(captured, { path: 'Action', state: 'todo' }, api);
  assert.deepEqual(calls, [['copy', 'captured', 'Projects'], ['gtd', 'captured', 'todo']]);
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

test('GTD choice classifies every distinct message in the captured account thread', async () => {
  const classified = [];
  const api = {
    getThread: async () => ({ messages: [
      { id: 'm1', account_id: 'a1', folder: 'INBOX', message_id: '<one>' },
      { id: 'dup', account_id: 'a1', folder: 'Sent', message_id: '<one>' },
      { id: 'm2', account_id: 'a1', folder: 'INBOX', message_id: '<two>' },
      { id: 'foreign', account_id: 'a2', folder: 'INBOX', message_id: '<three>' },
    ] }),
    gtdClassify: async (...args) => classified.push(args),
  };
  await executeLabelChoice({ id: 'm1', account_id: 'a1', folder: 'INBOX', thread_id: 't1', message_count: 4 },
    { path: 'Action', state: 'todo' }, api);
  assert.deepEqual(classified, [['m1', 'todo'], ['m2', 'todo']]);
});
