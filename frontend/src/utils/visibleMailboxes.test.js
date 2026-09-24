import test from 'node:test';
import assert from 'node:assert/strict';
import { visibleMailboxRows, navigateVisibleMailbox, runMailboxShortcut, canRunMailboxShortcut, browserShortcutFallback } from './visibleMailboxes.js';

test('browser fallback uses g1–g9 and gl without intercepting other sequences', () => {
  assert.equal(browserShortcutFallback('g0'), null);
  assert.equal(browserShortcutFallback('g1'), 'goVisibleMailbox1');
  assert.equal(browserShortcutFallback('g9'), 'goVisibleMailbox9');
  assert.equal(browserShortcutFallback('gl'), 'openLabelPicker');
  assert.equal(browserShortcutFallback('gi'), null);
  assert.equal(browserShortcutFallback('g#'), null);
});

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
  assert.equal(canRunMailboxShortcut('goVisibleMailbox9', root), false);
  assert.equal(canRunMailboxShortcut('goVisibleMailbox3', root), true);
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

test('left sidebar toggles in both directions', () => {
  let collapsed = false;
  const actions = {
    toggleSidebar: () => { collapsed = !collapsed; },
  };
  assert.equal(runMailboxShortcut('toggleLeftSidebar', actions, null), true);
  assert.equal(collapsed, true);
  assert.equal(runMailboxShortcut('toggleLeftSidebar', actions, null), true);
  assert.equal(collapsed, false);
});
