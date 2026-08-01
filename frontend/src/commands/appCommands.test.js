import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCommandContext } from './contracts.js';
import { createCommandRegistry } from './registry.js';
import { createAppCommandDefinitions, createAppCommandExecutors } from './appCommands.js';

const snapshot = {
  accounts: [{ id: 'acct-1', name: 'Work', gtd_enabled: true }],
  folders: { 'acct-1': [{ path: 'INBOX', name: 'Inbox' }, { path: 'Projects', name: 'Projects' }] },
  themes: { system: { label: 'System' }, midnight: { label: 'Midnight' } },
  user: { isAdmin: false },
};
const context = createCommandContext({
  surface: 'list', activeConversationId: null, selectedConversationIds: [], conversations: [],
  accountId: 'acct-1', folder: 'INBOX', draft: null, gtdAvailable: true,
  cardDavConnected: false, modal: null, editing: false, platform: 'mac', shortcutOverrides: {},
  translate: (key, values) => values?.name || key,
});

describe('application commands', () => {
  it('builds application destinations and the shared mail command set', () => {
    const ids = createAppCommandDefinitions(snapshot).map(command => command.id);
    for (const id of [
      'compose.new', 'navigation.search', 'navigation.contacts', 'navigation.unified-inbox',
      'navigation.account-inbox.acct-1', 'navigation.folder.acct-1.Projects',
      'navigation.gtd.todo', 'appearance.theme.system', 'settings.accounts', 'settings.shortcuts',
      'mail.archive', 'mail.move', 'mail.replyAll', 'mail.toggleRead', 'gtd.todo',
    ]) assert.ok(ids.includes(id), `missing ${id}`);
  });

  it('keeps administrator-only settings absent for non-admin users', () => {
    const userIds = createAppCommandDefinitions(snapshot).map(command => command.id);
    assert.equal(userIds.includes('settings.users'), false);
    const adminIds = createAppCommandDefinitions({ ...snapshot, user: { isAdmin: true } }).map(command => command.id);
    assert.equal(adminIds.includes('settings.users'), true);
    assert.equal(adminIds.includes('settings.sso'), true);
    assert.equal(adminIds.includes('settings.ai'), true);
  });

  it('searches account/folder labels through localized dynamic keys', () => {
    const registry = createCommandRegistry(createAppCommandDefinitions(snapshot));
    assert.equal(registry.search('Projects', context)[0].command.id, 'navigation.folder.acct-1.Projects');
  });

  it('routes execution through injected state services', async () => {
    const calls = [];
    const state = {
      openCompose: value => calls.push(['compose', value]),
      setSelectedAccount: (accountId, folder) => calls.push(['navigate', accountId, folder]),
      setShowContacts: value => calls.push(['contacts', value]),
      setActiveGtdTab: value => calls.push(['gtd', value]),
      setAdminTab: value => calls.push(['tab', value]),
      setShowAdmin: value => calls.push(['admin', value]),
      setTheme: value => calls.push(['theme', value]),
    };
    const executors = createAppCommandExecutors({ getState: () => state, emitShortcut: id => calls.push(['shortcut', id]) });
    await executors['navigation.folder']({ command: { params: { accountId: 'acct-1', folder: 'Projects' } } });
    await executors['settings.open']({ command: { params: { tab: 'appearance' } } });
    await executors['navigation.search']({ command: { params: {} } });
    assert.deepEqual(calls, [
      ['navigate', 'acct-1', 'Projects'], ['tab', 'appearance'], ['admin', true], ['shortcut', 'focusSearch'],
    ]);
  });

  it('selects a GTD destination after navigation clears the previous tab', async () => {
    const state = {
      selectedAccountId: 'acct-1',
      activeGtdTab: 'watch',
      setSelectedAccount(accountId, folder) {
        this.selectedAccountId = accountId;
        this.selectedFolder = folder;
        this.activeGtdTab = null;
      },
      setActiveGtdTab(section) {
        this.activeGtdTab = section;
      },
    };
    const executors = createAppCommandExecutors({ getState: () => state, emitShortcut() {} });
    await executors['navigation.gtd']({ command: { params: { section: 'delegated' } } });
    assert.equal(state.selectedFolder, 'INBOX');
    assert.equal(state.activeGtdTab, 'delegated');
  });
});
