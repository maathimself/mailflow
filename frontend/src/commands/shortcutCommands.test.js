import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createShortcutCommandExecutors, shortcutCommandDefinitions } from './shortcutCommands.js';

function harness() {
  const calls = [];
  const deps = {
    selection: {
      toggle: id => calls.push(['toggle', id]), extend: direction => calls.push(['extend', direction]),
      selectFocusedAndOlder: () => calls.push(['older']), selectAllVisible: () => calls.push(['all']),
      clear: () => calls.push(['clear']),
    },
    selectTarget: id => calls.push(['select', id]),
    loadThreadTargets: async () => ['a', 'b', 'c'], scrollConversation: n => calls.push(['scroll', n]),
    navigate: value => calls.push(['navigate', value]),
    getFolders: async accountId => [{ accountId, path: 'Sent', special_use: '\\Sent' }, { accountId, path: 'Drafts', special_use: '\\Drafts' }],
    undoLatest: () => calls.push(['undo']),
  };
  return { calls, executors: createShortcutCommandExecutors(deps) };
}

describe('shortcut commands', () => {
  it('owns selection directions and thread navigation', async () => {
    const h = harness();
    await h.executors['selection.extendNext']({ context: {} });
    await h.executors['selection.extendPrevious']({ context: {} });
    await h.executors['navigation.nextThreadMessage']({ context: { activeConversationId: 'b' } });
    assert.deepEqual(h.calls, [['extend', 1], ['extend', -1], ['select', 'c']]);
  });

  it('resolves special folders and the latest undo', async () => {
    const h = harness();
    await h.executors['navigation.sent']({ context: { accountId: 'account-1' } });
    await h.executors['app.undo']({ context: {} });
    assert.deepEqual(h.calls, [['navigate', { accountId: 'account-1', folder: 'Sent' }], ['undo']]);
  });

  it('declares contextual Enter, selection modifiers, and G sequences', () => {
    const byId = new Map(shortcutCommandDefinitions.map(command => [command.id, command]));
    assert.equal(byId.get('navigation.openConversation').defaultKeys.primary, 'enter');
    assert.deepEqual(byId.get('navigation.openConversation').defaultKeys.secondary, ['o']);
    assert.equal(byId.get('selection.focusedAndOlder').defaultKeys.primary.mac, 'meta+a');
    assert.equal(byId.get('selection.all').defaultKeys.primary.windows, 'ctrl+shift+a');
    assert.equal(byId.get('navigation.inbox').defaultKeys.primary, 'g i');
  });
});
