import { test } from 'node:test';
import assert from 'node:assert/strict';
import { undoBarHost, undoWindowLeft } from './undoBarHost.js';
import { UNDO_WINDOW_MS } from './undoableAction.js';

test('the list shows the Undo bars while it is on screen (#813)', () => {
  const at = s => undoBarHost({ isMobile: false, listFirst: false, showContacts: false, messageOpen: false, ...s });
  assert.equal(at({}), 'list');
  assert.equal(at({ messageOpen: true }), 'list', 'a split layout keeps the list beside the message');
  assert.equal(at({ listFirst: true }), 'list');
  assert.equal(at({ listFirst: true, messageOpen: true }), 'floating', 'List first: the message hides the list');
  assert.equal(at({ showContacts: true }), 'floating');
  assert.equal(at({ isMobile: true, listFirst: true, messageOpen: true }), null, 'a phone has its own action bars');
});

test('the Undo window is counted from when the notification was raised', () => {
  assert.deepEqual(undoWindowLeft({ createdAt: 1000 }, 1000), { windowMs: UNDO_WINDOW_MS, leftMs: UNDO_WINDOW_MS });
  assert.deepEqual(undoWindowLeft({ createdAt: 1000, undoMs: 10_000 }, 4000), { windowMs: 10_000, leftMs: 7000 });
  assert.equal(undoWindowLeft({ createdAt: 1000 }, 1000 + UNDO_WINDOW_MS + 5).leftMs, 0);
  assert.equal(undoWindowLeft({ createdAt: 5000 }, 1000).leftMs, UNDO_WINDOW_MS, 'never more than the window');
  assert.equal(undoWindowLeft({}, 1000).leftMs, UNDO_WINDOW_MS, 'no time stamp: the whole window');
});
