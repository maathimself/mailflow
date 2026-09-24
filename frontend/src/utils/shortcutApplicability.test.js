import test from 'node:test';
import assert from 'node:assert/strict';
import { canRunSelectedAction, canRunGlobalAction } from './shortcutApplicability.js';

const selected = { selectedMessageId: 'm1', messages: [{ id: 'm1', account_id: 'a1' }] };

test('selected-row actions leave browser behavior alone without a selection', () => {
  for (const action of ['markUnread', 'forward', 'replyAllFromSelection', 'unsubscribe', 'loadRemoteImages', 'openLabelPicker', 'reply', 'replyAll', 'toggleStar', 'printMessage', 'toggleRead', 'selectMessage']) {
    assert.equal(canRunSelectedAction(action, { ...selected, selectedMessageId: null }), false, action);
    assert.equal(canRunSelectedAction(action, selected), true, action);
  }
  assert.equal(canRunSelectedAction('compose', { ...selected, selectedMessageId: null }), true);
});

test('right sidebar toggle only captures a key when its sidebar is rendered', () => {
  assert.equal(canRunGlobalAction('toggleRightSidebar', { rightSidebarApplicable: false }), false);
  assert.equal(canRunGlobalAction('toggleRightSidebar', { rightSidebarApplicable: true }), true);
  assert.equal(canRunGlobalAction('compose', { rightSidebarApplicable: false }), true);
});
