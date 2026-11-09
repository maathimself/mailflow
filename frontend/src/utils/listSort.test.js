import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_LIST_ORDER, applyListOrder, compareListOrder, isSortableList, listOrderFor, listSortKey, pickListSort,
} from './listSort.js';

// #528 list orders, #196 starred on top.
test('a folder\'s key names its account, or all for All Inboxes', () => {
  assert.equal(listSortKey('acct-1', 'Archive'), 'acct-1:Archive');
  assert.equal(listSortKey(null, 'INBOX'), 'all:INBOX');
});

test('a folder without an entry is newest first', () => {
  assert.deepEqual(listOrderFor({}, 'acct-1', 'INBOX'), DEFAULT_LIST_ORDER);
  assert.deepEqual(listOrderFor({ 'acct-1:INBOX': { sort: 'size' } }, 'acct-1', 'INBOX'), DEFAULT_LIST_ORDER);
  assert.deepEqual(listOrderFor({ 'acct-1:INBOX': { sort: 'from', dir: 'asc' } }, 'acct-1', 'INBOX'),
    { sort: 'from', dir: 'asc', starredFirst: false });
});

test('the default order sends nothing; others send what differs', () => {
  assert.deepEqual(applyListOrder({ folder: 'INBOX' }, DEFAULT_LIST_ORDER), { folder: 'INBOX' });
  assert.deepEqual(applyListOrder({}, { sort: 'subject', dir: 'desc', starredFirst: false }), { sort: 'subject', dir: 'desc' });
  assert.deepEqual(applyListOrder({}, { sort: 'date', dir: 'desc', starredFirst: true }), { starredFirst: 'true' });
});

test('a newly picked sort starts at its natural direction', () => {
  assert.deepEqual(pickListSort(DEFAULT_LIST_ORDER, 'from'), { sort: 'from', dir: 'asc', starredFirst: false });
  const zToA = { sort: 'from', dir: 'desc', starredFirst: true };
  assert.equal(pickListSort(zToA, 'from'), zToA);
  assert.deepEqual(pickListSort(zToA, 'date'), { sort: 'date', dir: 'desc', starredFirst: true });
});

test('only folders and All Inboxes can be sorted', () => {
  assert.equal(isSortableList({ accountId: 'acct-1', folder: 'Archive' }), true);
  assert.equal(isSortableList({ accountId: null, folder: 'INBOX' }), true);
  assert.equal(isSortableList({ accountId: null, folder: 'Snoozed' }), false);
  assert.equal(isSortableList({ accountId: null, folder: '__scheduled__' }), false);
  assert.equal(isSortableList({ accountId: 'acct-1', folder: 'INBOX', searchQuery: 'invoice' }), false);
  assert.equal(isSortableList({ accountId: 'acct-1', folder: 'INBOX', gtdTab: true }), false);
});

const rows = [
  { id: 'a', subject: 'Re: banana', from_name: 'Carol', date: '2026-10-03T00:00:00Z' },
  { id: 'b', subject: 'apple', from_name: null, from_email: 'bob@example.com', date: '2026-10-01T00:00:00Z' },
  { id: 'c', subject: 'FW: Cherry', from_name: 'alice', date: '2026-10-02T00:00:00Z', is_starred: true },
];
const order = (o) => [...rows].sort(compareListOrder(o)).map(r => r.id);

test('rows are ordered as the server orders them', () => {
  assert.deepEqual(order(DEFAULT_LIST_ORDER), ['a', 'c', 'b']);
  assert.deepEqual(order({ sort: 'date', dir: 'asc' }), ['b', 'c', 'a']);
  assert.deepEqual(order({ sort: 'from', dir: 'asc' }), ['c', 'b', 'a']);
  assert.deepEqual(order({ sort: 'subject', dir: 'asc' }), ['b', 'a', 'c']);
  assert.deepEqual(order({ sort: 'subject', dir: 'desc' }), ['c', 'a', 'b']);
  assert.deepEqual(order({ sort: 'subject', dir: 'asc', starredFirst: true }), ['c', 'b', 'a']);
});

// Undo puts a conversation back where the server would list it: one whose older message is
// starred stays on top even though the row shows an unstarred message.
test('a conversation row with another starred message sorts as starred', () => {
  const threads = [
    { id: 'plain', date: '2026-10-05T00:00:00Z' },
    { id: 'older-starred', date: '2026-10-01T00:00:00Z', is_starred: false, others_starred: true },
  ];
  assert.deepEqual([...threads].sort(compareListOrder({ sort: 'date', dir: 'desc', starredFirst: true })).map(r => r.id), ['older-starred', 'plain']);
});

test('equal keys fall back to newest first, and an empty key goes last', () => {
  const same = [
    { id: 'old', from_name: 'Sam', date: '2026-01-01T00:00:00Z' },
    { id: 'none', from_name: '', from_email: '', date: '2026-12-01T00:00:00Z' },
    { id: 'new', from_name: 'sam', date: '2026-02-01T00:00:00Z' },
  ];
  assert.deepEqual([...same].sort(compareListOrder({ sort: 'from', dir: 'asc' })).map(r => r.id), ['new', 'old', 'none']);
  assert.deepEqual([...same].sort(compareListOrder({ sort: 'from', dir: 'desc' })).map(r => r.id), ['new', 'old', 'none']);
});
