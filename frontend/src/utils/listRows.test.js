import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isThreadedList, listRowKey, uniqueListRows } from './listRows.js';

const row = (id, thread_id, date) => ({ id, thread_id, date });

describe('uniqueListRows', () => {
  test('keeps the newest row of a conversation listed twice, where it was listed', () => {
    const fresh = row('m2', 't', '2026-11-25T14:42:54Z');
    const other = row('o', 'u', '2026-11-24T00:00:00Z');
    const stale = row('m1', 't', '2026-11-20T11:55:16Z');
    assert.deepEqual(uniqueListRows([fresh, other, stale], true).map(m => m.id), ['m2', 'o']);
    assert.deepEqual(uniqueListRows([stale, other, fresh], true).map(m => m.id), ['o', 'm2']);
  });

  test('an exact tie keeps the first, and the same row twice is listed once', () => {
    const a = row('a', 't', '2026-11-20T00:00:00Z');
    const b = row('b', 't', '2026-11-20T00:00:00Z');
    assert.deepEqual(uniqueListRows([a, b], true).map(m => m.id), ['a']);
    assert.deepEqual(uniqueListRows([a, a], true).map(m => m.id), ['a']);
  });

  test('without threading the messages of one conversation are each a row', () => {
    const rows = [row('m2', 't', '2026-11-25T00:00:00Z'), row('m1', 't', '2026-11-20T00:00:00Z')];
    assert.equal(uniqueListRows(rows, false), rows);
    assert.deepEqual(uniqueListRows([...rows, rows[0]], false).map(m => m.id), ['m2', 'm1']);
  });

  test('returns the same array when nothing repeats', () => {
    const rows = [row('a', 't', '2026-11-25T00:00:00Z'), row('b', null, '2026-11-24T00:00:00Z')];
    assert.equal(uniqueListRows(rows, true), rows);
  });
});

describe('listRowKey and isThreadedList', () => {
  test('a row without a thread is keyed by its id', () => {
    assert.equal(listRowKey({ id: 'a', thread_id: 't' }, true), 't');
    assert.equal(listRowKey({ id: 'a', thread_id: null }, true), 'a');
    assert.equal(listRowKey({ id: 'a', thread_id: 't' }, false), 'a');
  });

  test('the Snoozed view and search results list messages', () => {
    const on = { threadedView: true, selectedFolder: 'INBOX' };
    assert.equal(isThreadedList(on), true);
    assert.equal(isThreadedList(on, { search: true }), false);
    assert.equal(isThreadedList({ ...on, selectedFolder: 'Snoozed' }), false);
    assert.equal(isThreadedList({ ...on, threadedView: false }), false);
  });
});
