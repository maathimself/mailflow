import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildAppCommandContext, commandTargetLabel, detectCommandPlatform } from './appContext.js';

const state = overrides => ({
  messages: [
    { id: 'row-a', message_id: '<a>', account_id: 'acct-1' },
    { id: 'row-b', message_id: '<b>', account_id: 'acct-1' },
  ],
  searchResults: [], searchQuery: '', threadMessages: {}, gtdSections: null,
  selectedMessageId: null, selectedMessageIds: new Set(), selectedAccountId: 'acct-1',
  selectedFolder: 'INBOX', composing: false, composeData: null, showAdmin: false,
  accounts: [{ id: 'acct-1', gtd_enabled: true }],
  carddavStatus: { connected: true }, carddavStatusLoaded: true,
  notifications: [], activeGtdTab: null,
  shortcuts: {}, ...overrides,
});
const translate = (key, values) => values?.count == null ? key : `${key}:${values.count}`;

describe('buildAppCommandContext', () => {
  it('maps list, conversation, compose, and settings surfaces', () => {
    assert.equal(buildAppCommandContext(state(), { translate, platform: 'mac' }).surface, 'list');
    assert.equal(buildAppCommandContext(state({ selectedMessageId: 'row-a' }), { translate, platform: 'mac' }).surface, 'conversation');
    assert.equal(buildAppCommandContext(state({ composing: true, composeData: { id: 'draft-1' } }), { translate, platform: 'mac' }).surface, 'compose');
    assert.equal(buildAppCommandContext(state({ showAdmin: true }), { translate, platform: 'mac' }).surface, 'settings');
  });

  it('converts selected row IDs to account-scoped RFC identities and exposes integrations', () => {
    const context = buildAppCommandContext(state({ selectedMessageIds: new Set(['row-a', 'row-b']) }), {
      translate, platform: 'linux',
    });
    assert.deepEqual(context.selectedConversationIds, ['acct-1:<a>', 'acct-1:<b>']);
    assert.deepEqual(context.visibleConversationIds, ['acct-1:<a>', 'acct-1:<b>']);
    assert.equal(context.gtdAvailable, true);
    assert.equal(context.cardDavConnected, true);
    assert.deepEqual(context.carddavStatus, { connected: true });
    assert.equal(context.carddavStatusLoaded, true);
  });

  it('requires every targeted account to support GTD and never reads CardDAV from accounts', () => {
    const context = buildAppCommandContext(state({
      messages: [
        { id: 'row-a', message_id: '<a>', account_id: 'acct-1' },
        { id: 'row-c', message_id: '<c>', account_id: 'acct-2' },
      ],
      selectedMessageIds: new Set(['row-a', 'row-c']),
      selectedAccountId: null,
      accounts: [{ id: 'acct-1', gtd_enabled: true }, { id: 'acct-2', gtd_enabled: false }],
      carddavStatus: null,
    }), { translate, platform: 'linux' });
    assert.equal(context.gtdAvailable, false);
    assert.equal(context.cardDavConnected, false);
    assert.equal(context.carddavStatusLoaded, true);
  });

  it('exposes active message and current undo availability', () => {
    const context = buildAppCommandContext(state({
      selectedMessageId: 'row-a', notifications: [{ id: 'undo-1', onUndo() {} }],
    }), { translate, platform: 'mac' });
    assert.equal(context.activeMessage.id, 'row-a');
    assert.equal(context.undoAvailable, true);
  });

  it('describes application, single, and bulk targets', () => {
    assert.deepEqual(commandTargetLabel(buildAppCommandContext(state(), { translate, platform: 'mac' })), {
      key: 'commandPalette.target.application', values: {},
    });
    assert.equal(commandTargetLabel(buildAppCommandContext(state({ selectedMessageId: 'row-a' }), {
      translate, platform: 'mac',
    })).key, 'commandPalette.target.conversation');
    assert.deepEqual(commandTargetLabel(buildAppCommandContext(state({ selectedMessageIds: new Set(['row-a', 'row-b']) }), {
      translate, platform: 'mac',
    })), { key: 'commandPalette.target.selected', values: { count: 2 } });
  });

  it('detects all three supported platform values', () => {
    assert.equal(detectCommandPlatform({ userAgentData: { platform: 'macOS' } }), 'mac');
    assert.equal(detectCommandPlatform({ userAgentData: { platform: 'Windows' } }), 'windows');
    assert.equal(detectCommandPlatform({ platform: 'Linux x86_64' }), 'linux');
  });

  it('maps existing persisted shortcut keys without mutating stored preferences', () => {
    const shortcuts = { compose: 'q', focusSearch: 'ctrl+f', goInbox: 'g u' };
    const context = buildAppCommandContext(state({ shortcuts }), { translate, platform: 'linux' });
    assert.deepEqual(context.shortcutOverrides, {
      compose: 'q', focusSearch: 'ctrl+f', goInbox: 'g u',
      'compose.new': 'q', 'navigation.search': 'ctrl+f', 'navigation.inbox': 'g u',
    });
    assert.deepEqual(shortcuts, { compose: 'q', focusSearch: 'ctrl+f', goInbox: 'g u' });
  });
});
