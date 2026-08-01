import { mailCommandDefinitions } from './mailActions.js';
import { shortcutCommandDefinitions } from './shortcutCommands.js';
import {
  composeSessionCommandDefinitions,
  createComposeSessionCommandExecutors,
} from './composeSessionCommands.js';

const globalCommand = (id, titleKey, icon, group, executorId, params = {}, overrides = {}) => ({
  id, titleKey, aliasKeys: [], icon, group,
  defaultKeys: { primary: null, secondary: [] },
  rank: { base: 50 }, isAvailable: () => true, targetMode: 'global', executorId, params,
  ...overrides,
});

const settingsTabs = ['accounts', 'notifications', 'rules', 'categories', 'appearance', 'shortcuts',
  'security', 'integrations', 'ai-actions', 'about'];
const adminTabs = ['users', 'sso', 'ai'];
const gtdSections = ['todo', 'watch', 'delegated', 'reference', 'someday'];

export function createAppCommandDefinitions({ accounts = [], folders = {}, themes = {}, user = {} }) {
  const definitions = [
    globalCommand('navigation.search', 'commands.navigation.search.title', 'search', 'navigation', 'navigation.search', {}, {
      defaultKeys: { primary: '/', secondary: [] }, rank: { base: 90 },
      isAvailable: context => context.surface !== 'compose' && context.surface !== 'settings',
    }),
    globalCommand('navigation.unified-inbox', 'commands.navigation.unifiedInbox.title', 'inbox', 'navigation', 'navigation.inbox', {
      accountId: null, folder: 'INBOX',
    }),
  ];

  for (const account of accounts) {
    definitions.push(globalCommand(
      `navigation.account-inbox.${account.id}`,
      'commands.navigation.accountInbox.title',
      'inbox', 'navigation', 'navigation.inbox',
      { accountId: account.id, folder: 'INBOX', name: account.name || account.email_address },
    ));
    for (const folder of folders[account.id] || []) {
      if (folder.path === 'INBOX') continue;
      definitions.push(globalCommand(
        `navigation.folder.${account.id}.${folder.path}`,
        'commands.navigation.folder.title',
        'folder', 'navigation', 'navigation.folder',
        { accountId: account.id, folder: folder.path, name: folder.name || folder.path },
      ));
    }
  }

  for (const section of gtdSections) {
    definitions.push(globalCommand(
      `navigation.gtd.${section}`,
      `commands.navigation.gtd.${section}.title`,
      'gtd', 'navigation', 'navigation.gtd', { section },
      { isAvailable: context => context.gtdAvailable },
    ));
  }
  for (const [theme, value] of Object.entries(themes)) {
    definitions.push(globalCommand(
      `appearance.theme.${theme}`,
      'commands.appearance.theme.title',
      'appearance', 'appearance', 'appearance.theme', { theme, name: value.label || theme },
    ));
  }
  for (const tab of [...settingsTabs, ...(user.isAdmin ? adminTabs : [])]) {
    definitions.push(globalCommand(
      `settings.${tab}`,
      `commands.settings.${tab}.title`,
      'settings', 'settings', 'settings.open', { tab },
    ));
  }
  definitions.push(...composeSessionCommandDefinitions);
  definitions.push(...mailCommandDefinitions);
  definitions.push(...shortcutCommandDefinitions.filter(command => command.id !== 'compose.send'));
  return definitions;
}

export function createAppCommandExecutors({ getState, emitShortcut }) {
  return Object.freeze({
    ...createComposeSessionCommandExecutors({
      getController: () => getState().composeWorkspaceController,
      openCompose: changes => getState().openCompose(changes),
    }),
    'navigation.search': () => {
      emitShortcut('focusSearch');
      return { status: 'success' };
    },
    'navigation.contacts': () => {
      const state = getState();
      state.setSelectedMessage(null);
      state.clearSelectedMessageIds();
      state.setShowContacts(true);
      return { status: 'success' };
    },
    'navigation.inbox': ({ command }) => {
      getState().setSelectedAccount(command.params.accountId, 'INBOX');
      return { status: 'success' };
    },
    'navigation.folder': ({ command }) => {
      getState().setSelectedAccount(command.params.accountId, command.params.folder);
      return { status: 'success' };
    },
    'navigation.gtd': ({ command }) => {
      const state = getState();
      state.setSelectedAccount(state.selectedAccountId, 'INBOX');
      state.setActiveGtdTab(command.params.section);
      return { status: 'success' };
    },
    'appearance.theme': ({ command }) => {
      getState().setTheme(command.params.theme);
      return { status: 'success' };
    },
    'settings.open': ({ command }) => {
      const state = getState();
      state.setAdminTab(command.params.tab);
      state.setShowAdmin(true);
      return { status: 'success' };
    },
  });
}
