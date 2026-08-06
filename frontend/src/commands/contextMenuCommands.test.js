import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { contextMenuTargetMessages, toContextMenuCommand } from './contextMenuCommands.js';

test('maps migrated context actions to command IDs and typed input', () => {
  assert.deepEqual(toContextMenuCommand('archive'), { commandId: 'mail.archive' });
  assert.deepEqual(toContextMenuCommand('markRead'), { commandId: 'mail.read' });
  assert.deepEqual(toContextMenuCommand('markUnread'), { commandId: 'mail.unread' });
  assert.deepEqual(toContextMenuCommand('toggleStar'), { commandId: 'mail.toggleStar' });
  assert.deepEqual(toContextMenuCommand('replyAll'), { commandId: 'mail.replyAll' });
  assert.deepEqual(toContextMenuCommand('moveTo', 'Archive'), {
    commandId: 'mail.move', input: { folder: 'Archive' },
  });
  assert.deepEqual(toContextMenuCommand('snooze', '2026-08-01T09:00:00.000Z'), {
    commandId: 'mail.snooze', input: { until: '2026-08-01T09:00:00.000Z' },
  });
  assert.deepEqual(toContextMenuCommand('gtdClassify', 'todo'), { commandId: 'gtd.todo' });
});

test('returns null for intentionally unmigrated utilities', () => {
  assert.equal(toContextMenuCommand('copy'), null);
  assert.equal(toContextMenuCommand('createRuleFromMessage'), null);
  assert.equal(toContextMenuCommand('setCategory', 'social'), null);
});

test('targets the clicked row for responses and the frozen selection for bulk-safe actions', () => {
  const clicked = { id: 'clicked' };
  const selected = [{ id: 'first' }, clicked, { id: 'third' }];
  assert.deepEqual(contextMenuTargetMessages('mail.reply', clicked, selected), [clicked]);
  assert.deepEqual(contextMenuTargetMessages('mail.forward', clicked, selected), [clicked]);
  assert.deepEqual(contextMenuTargetMessages('mail.archive', clicked, selected), selected);
  assert.deepEqual(contextMenuTargetMessages('mail.archive', clicked, [{ id: 'first' }]), [clicked]);
});

test('routes list, context-menu, bulk, hover, and swipe mail actions through one controller', () => {
  const list = fs.readFileSync(new URL('../components/MessageList.jsx', import.meta.url), 'utf8');
  const menu = fs.readFileSync(new URL('../components/ContextMenu.jsx', import.meta.url), 'utf8');
  assert.match(list, /useCommandRuntimeContext\(\)/);
  assert.match(list, /actionableMessages\.map\(stableConversationId\)/);
  assert.match(list, /source,\s*input,\s*frozenTargetIds/);
  assert.match(menu, /toContextMenuCommand\(action, data\)/);
  assert.match(menu, /source: 'context-menu'/);
  assert.match(menu, /onCommand\(invocation\.commandId, invocation\.input\)/);
  assert.match(list, /contextMenuTargetMessages/);
  assert.match(list, /executeForMessages\(commandId, 'context-menu', targetMessages, input\)/);
  assert.doesNotMatch(
    list,
    /api\.(bulkArchive|bulkDelete|bulkMove|bulkRead|markStarred|markSpam|markHam|snoozeMessage)/,
  );
  assert.doesNotMatch(
    list,
    /shortcutBus\.on\('(archive|delete|toggleRead|gtdTodo|gtdWatch|gtdDelegated)'/,
  );
});

test('routes pane toolbar and menu mail actions through the shared controller', () => {
  const pane = fs.readFileSync(new URL('../components/MessagePane.jsx', import.meta.url), 'utf8');
  assert.match(pane, /useCommandRuntimeContext\(\)/);
  assert.match(pane, /stableConversationId\(message\)/);
  assert.match(pane, /source,\s*input,\s*frozenTargetIds/);
  assert.doesNotMatch(
    pane,
    /api\.(bulkArchive|bulkDelete|bulkMove|bulkRead|deleteMessage|markStarred|markSpam|markHam|snoozeMessage)/,
  );
  assert.doesNotMatch(pane, /shortcutBus\.on\('(reply|replyAll|forward|toggleStar)'/);
});
