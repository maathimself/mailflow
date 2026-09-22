import test from 'node:test';
import assert from 'node:assert/strict';
import { visibleMailboxRows, navigateVisibleMailbox, runMailboxShortcut } from './visibleMailboxes.js';

test('numbered mailbox navigation follows rendered rows and ignores unavailable rows', () => {
  const clicked = [];
  const row = (name, available = true) => ({
    dataset: { mailboxRow: '', mailboxAvailable: String(available) },
    click: () => clicked.push(name),
  });
  const rows = [row('unified'), row('favorite'), row('disabled', false), row('account'), row('folder')];
  const root = { querySelectorAll: () => rows };
  assert.deepEqual(visibleMailboxRows(root), [rows[0], rows[1], rows[3], rows[4]]);
  assert.equal(navigateVisibleMailbox(root, 3), true);
  assert.equal(navigateVisibleMailbox(root, 9), false);
  assert.deepEqual(clicked, ['account']);
});

test('collapsed or hidden rows are absent from navigation because they are absent from rendered DOM', () => {
  const clicked = [];
  const root = { querySelectorAll: () => [
    { dataset: { mailboxAvailable: 'true' }, click: () => clicked.push('account') },
  ] };
  assert.equal(navigateVisibleMailbox(root, 1), true);
  assert.equal(navigateVisibleMailbox(root, 2), false);
  assert.deepEqual(clicked, ['account']);
});

test('left sidebar toggles in both directions and All Mail opens independently of row index', () => {
  let collapsed = false;
  const navigated = [];
  const actions = {
    toggleSidebar: () => { collapsed = !collapsed; },
    setSelectedAccount: (...args) => navigated.push(args),
  };
  assert.equal(runMailboxShortcut('toggleLeftSidebar', actions, null), true);
  assert.equal(collapsed, true);
  assert.equal(runMailboxShortcut('toggleLeftSidebar', actions, null), true);
  assert.equal(collapsed, false);
  assert.equal(runMailboxShortcut('goAllMail', actions, null), true);
  assert.deepEqual(navigated, [[null, 'ALL_MAIL']]);
});
