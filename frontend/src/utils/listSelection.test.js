// What opens when the open message leaves the list (#572): the afterRemove setting picks the row,
// an advance opens it through the list's own opener (exactly as a click), and a phone always goes
// back to the list.
//
// Real store, no list mounted: the opener is registered by hand.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.json')) {
      return { format: 'module', shortCircuit: true, source: `export default ${readFileSync(new URL(url), 'utf8')}` };
    }
    return nextLoad(url, context);
  },
});

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid' });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  localStorage: dom.window.localStorage,
  CustomEvent: dom.window.CustomEvent,
});
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

const { useStore } = await import('../store/index.js');
const { rowAfterRemoval, advanceSelectionAfterRemoval, registerRowOpener } = await import('./listSelection.js');

const ROWS = ['r1', 'r2', 'r3'].map(id => ({ id, account_id: 'acct', folder: 'INBOX', is_read: false }));
let opened;
let unregister;

beforeEach(() => {
  window.innerWidth = 1280;
  opened = [];
  unregister?.();
  unregister = registerRowOpener(row => { opened.push(row.id); useStore.getState().setSelectedMessage(row.id); });
  useStore.setState({ messages: ROWS.map(r => ({ ...r })), searchResults: [], searchQuery: '', selectedMessageId: 'r2', afterRemove: 'next' });
});

describe('rowAfterRemoval', () => {
  test('next opens the row below, or the one above at the end of the list', () => {
    assert.equal(rowAfterRemoval('r2').id, 'r3');
    assert.equal(rowAfterRemoval('r3').id, 'r2');
  });

  test('previous opens the row above, or the one below at the top', () => {
    useStore.setState({ afterRemove: 'previous' });
    assert.equal(rowAfterRemoval('r2').id, 'r1');
    assert.equal(rowAfterRemoval('r1').id, 'r2');
  });

  test('list, a phone, or an emptied list mean nothing opens', () => {
    useStore.setState({ afterRemove: 'list' });
    assert.equal(rowAfterRemoval('r2'), null);
    useStore.setState({ afterRemove: 'next' });
    window.innerWidth = 390;
    assert.equal(rowAfterRemoval('r2'), null);
    window.innerWidth = 1280;
    useStore.setState({ messages: [ROWS[0]] });
    assert.equal(rowAfterRemoval('r1'), null);
  });

  test('a message that is not a row of the list on screen is not decided', () => {
    assert.equal(rowAfterRemoval('thread-child'), undefined);
  });

  test('search results are the list while searching', () => {
    useStore.setState({ searchQuery: 'invoice', searchResults: [{ id: 's1' }, { id: 's2' }] });
    assert.equal(rowAfterRemoval('s1').id, 's2');
    assert.equal(rowAfterRemoval('r2'), undefined);
  });
});

describe('advanceSelectionAfterRemoval', () => {
  test('opens the next row through the list\'s opener, as a click would', () => {
    advanceSelectionAfterRemoval('r2');
    assert.deepEqual(opened, ['r3']);
    assert.equal(useStore.getState().selectedMessageId, 'r3');
  });

  test('does nothing when the removed message is not the open one', () => {
    advanceSelectionAfterRemoval('r1');
    assert.deepEqual(opened, []);
    assert.equal(useStore.getState().selectedMessageId, 'r2');
  });

  test('a removed row holding the open message advances too (a conversation acted on whole)', () => {
    useStore.setState({ selectedMessageId: 'card-in-r2' });
    advanceSelectionAfterRemoval('r2', true);
    assert.deepEqual(opened, ['r3']);
  });

  test('back to the list clears the pane without opening anything', () => {
    useStore.setState({ afterRemove: 'list' });
    advanceSelectionAfterRemoval('r2');
    assert.deepEqual(opened, []);
    assert.equal(useStore.getState().selectedMessageId, null);
  });

  test('a thread child that is not a row leaves the selection to the caller', () => {
    useStore.setState({ selectedMessageId: 'child' });
    advanceSelectionAfterRemoval('child');
    assert.deepEqual(opened, []);
    assert.equal(useStore.getState().selectedMessageId, 'child');
  });

  test('without a list mounted the row is only selected', () => {
    unregister();
    unregister = null;
    advanceSelectionAfterRemoval('r2');
    assert.deepEqual(opened, []);
    assert.equal(useStore.getState().selectedMessageId, 'r3');
  });
});

describe('the afterRemove setting', () => {
  test('accepts only the three choices and remembers the one picked', () => {
    useStore.getState().setAfterRemove('previous');
    assert.equal(useStore.getState().afterRemove, 'previous');
    assert.equal(localStorage.getItem('mailflow_after_remove'), 'previous');
    useStore.getState().setAfterRemove('sideways');
    assert.equal(useStore.getState().afterRemove, 'previous');
  });
});
