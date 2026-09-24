import test from 'node:test';
import assert from 'node:assert/strict';
import * as applicability from './shortcutApplicability.js';

const { canRunSelectedAction, canRunGlobalAction, canHandlePaneShortcut } = applicability;

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

test('frontmost open message window enables its pane actions without a main selection', () => {
  const popout = {
    selectedMessageId: null,
    messages: [{ id: 'front', account_id: 'a1' }, { id: 'behind', account_id: 'a1' }],
    messageWindows: [
      { messageId: 'behind', z: 2, minimized: false },
      { messageId: 'front', z: 4, minimized: false },
    ],
  };
  for (const action of ['reply', 'replyAll', 'forward', 'replyAllFromSelection', 'toggleStar', 'printMessage', 'markUnread', 'openLabelPicker']) {
    assert.equal(canRunSelectedAction(action, popout), true, action);
  }
  for (const action of ['unsubscribe', 'loadRemoteImages', 'selectMessage']) {
    assert.equal(canRunSelectedAction(action, popout), false, action);
  }
  assert.equal(canHandlePaneShortcut('front', popout), true);
  assert.equal(canHandlePaneShortcut('behind', popout), false);
  assert.equal(canHandlePaneShortcut(null, popout), false);
});
