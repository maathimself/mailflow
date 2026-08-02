const keys = (primary = null, secondary = []) => ({ primary, secondary });
const modKey = (mac, key) => ({ mac, windows: `ctrl+${key}`, linux: `ctrl+${key}`, default: `ctrl+${key}` });
const ICONS = {
  'app.undo': 'clock',
  'navigation.nextConversation': 'mail-open', 'navigation.previousConversation': 'mail-open',
  'navigation.nextThreadMessage': 'mail-open', 'navigation.previousThreadMessage': 'mail-open',
  'navigation.scrollDown': 'eye', 'navigation.scrollUp': 'eye',
  'navigation.openConversation': 'mail-open', 'navigation.inbox': 'inbox',
  'navigation.sent': 'folder', 'navigation.drafts': 'folder', 'navigation.contacts': 'contacts',
  'selection.toggle': 'check-square', 'selection.extendNext': 'check-square',
  'selection.extendPrevious': 'check-square', 'selection.focusedAndOlder': 'check-square',
  'selection.all': 'check-square', 'selection.clear': 'check-square',
  'navigation.back': 'mail-open',
  'help.shortcuts': 'settings', 'layout.toggleRightSidebar': 'appearance', 'mail.print': 'mail',
  'compose.send': 'compose',
};
const command = (id, titleKey, targetMode, defaultKeys, executorId, rank = 40, isAvailable = () => true) => ({
  id, titleKey, aliasKeys: [], icon: ICONS[id] || 'settings', group: id.split('.')[0], targetMode, defaultKeys,
  executorId, rank: { base: rank }, isAvailable,
});

export const shortcutCommandDefinitions = [
  command('app.undo', 'commands.shortcuts.undo', 'global', keys('z'), 'app.undo', 90, context => context.undoAvailable),
  command('navigation.nextConversation', 'shortcuts.actions.nextMessage.label', 'global', keys('j'), 'navigation.nextConversation', 70, context => ['list', 'conversation'].includes(context.surface)),
  command('navigation.previousConversation', 'shortcuts.actions.prevMessage.label', 'global', keys('k'), 'navigation.previousConversation', 70, context => ['list', 'conversation'].includes(context.surface)),
  command('navigation.nextThreadMessage', 'commands.shortcuts.nextThreadMessage', 'single_conversation', keys('n'), 'navigation.nextThreadMessage', 70, context => context.surface === 'conversation'),
  command('navigation.previousThreadMessage', 'commands.shortcuts.previousThreadMessage', 'single_conversation', keys('p'), 'navigation.previousThreadMessage', 70, context => context.surface === 'conversation'),
  command('navigation.scrollDown', 'commands.shortcuts.scrollDown', 'global', keys('space'), 'navigation.scrollDown', 30, context => context.surface === 'conversation'),
  command('navigation.scrollUp', 'commands.shortcuts.scrollUp', 'global', keys('shift+space'), 'navigation.scrollUp', 30, context => context.surface === 'conversation'),
  command('navigation.openConversation', 'commands.shortcuts.openConversation', 'global', keys('enter', ['o']), 'navigation.openConversation', 100, context => context.surface === 'list' && context.visibleConversationIds.length > 0),
  command('selection.toggle', 'shortcuts.actions.selectMessage.label', 'global', keys('x'), 'selection.toggle', 60, context => context.surface === 'list' && context.visibleConversationIds.length > 0),
  command('selection.extendNext', 'commands.shortcuts.extendNext', 'global', keys('shift+j'), 'selection.extendNext', 60, context => context.surface === 'list'),
  command('selection.extendPrevious', 'commands.shortcuts.extendPrevious', 'global', keys('shift+k'), 'selection.extendPrevious', 60, context => context.surface === 'list'),
  command('selection.focusedAndOlder', 'commands.shortcuts.selectOlder', 'global', keys(modKey('meta+a', 'a')), 'selection.focusedAndOlder', 80, context => context.surface === 'list' && context.visibleConversationIds.length > 0),
  command('selection.all', 'commands.shortcuts.selectAll', 'global', keys(modKey('meta+shift+a', 'shift+a')), 'selection.all', 85, context => context.surface === 'list'),
  command('selection.clear', 'commands.shortcuts.clearSelection', 'global', keys('escape'), 'selection.clear', 110, context => context.selectedConversationIds.length > 0),
  command('navigation.back', 'common.back', 'global', keys('escape'), 'navigation.back', 50, context => context.surface === 'conversation'),
  command('navigation.inbox', 'commands.navigation.unifiedInbox.title', 'global', keys('g i'), 'navigation.shortcutInbox'),
  command('navigation.sent', 'commands.shortcuts.sent', 'account', keys('g t'), 'navigation.sent', 40, context => !!context.accountId),
  command('navigation.drafts', 'commands.shortcuts.drafts', 'account', keys('g d'), 'navigation.drafts', 40, context => !!context.accountId),
  command('navigation.contacts', 'commands.shortcuts.contacts', 'global', keys('g c'), 'navigation.contacts'),
  command('help.shortcuts', 'shortcuts.title', 'global', keys('?'), 'help.shortcuts'),
  command('layout.toggleRightSidebar', 'shortcuts.actions.toggleRightSidebar.label', 'global', keys(modKey('meta+/', '/')), 'layout.toggleRightSidebar'),
  command('mail.print', 'shortcuts.actions.printMessage.label', 'single_conversation', keys(modKey('meta+p', 'p')), 'mail.print', 60, context => context.surface === 'conversation'),
  command('compose.send', 'compose.send', 'draft', keys(modKey('meta+enter', 'enter')), 'editor.send', 0, () => false),
];

const success = (ids = []) => ({ status: 'success', succeededIds: ids.filter(Boolean), failed: [] });

export function createShortcutCommandExecutors(deps) {
  const stepConversation = direction => ({ context }) => {
    const ids = context.visibleConversationIds;
    if (!ids.length) return { status: 'cancelled' };
    const index = ids.indexOf(context.activeConversationId);
    const nextIndex = index < 0
      ? (direction > 0 ? 0 : ids.length - 1)
      : Math.max(0, Math.min(ids.length - 1, index + direction));
    const next = ids[nextIndex];
    deps.selectTarget(next, context);
    return success([next]);
  };
  const stepThread = direction => async ({ context }) => {
    const ids = await deps.loadThreadTargets(context);
    if (ids.length < 2) return { status: 'cancelled' };
    const index = Math.max(0, ids.indexOf(context.activeConversationId));
    const next = ids[Math.max(0, Math.min(ids.length - 1, index + direction))];
    deps.selectTarget(next, context);
    return success([next]);
  };
  const specialFolder = specialUse => async ({ context }) => {
    const folders = await deps.getFolders(context.accountId);
    const folder = folders.find(item => item.special_use?.toLowerCase() === specialUse.toLowerCase());
    if (!folder) return { status: 'failed', failed: [{ id: context.accountId, error: `${specialUse} folder unavailable` }] };
    deps.navigate({ accountId: context.accountId, folder: folder.path });
    return success([folder.path]);
  };
  return {
    'app.undo': () => { deps.undoLatest(); return success(); },
    'navigation.nextConversation': stepConversation(1),
    'navigation.previousConversation': stepConversation(-1),
    'navigation.nextThreadMessage': stepThread(1),
    'navigation.previousThreadMessage': stepThread(-1),
    'navigation.scrollDown': () => { deps.scrollConversation(0.8); return success(); },
    'navigation.scrollUp': () => { deps.scrollConversation(-0.8); return success(); },
    'navigation.openConversation': ({ context }) => { const id = context.activeConversationId || context.visibleConversationIds[0]; deps.selectTarget(id, context); return success([id]); },
    'selection.toggle': ({ context }) => { const id = context.activeConversationId || context.visibleConversationIds[0]; deps.selection.toggle(id, context); return success([id]); },
    'selection.extendNext': ({ context }) => { deps.selection.extend(1, context); return success(); },
    'selection.extendPrevious': ({ context }) => { deps.selection.extend(-1, context); return success(); },
    'selection.focusedAndOlder': ({ context }) => { deps.selection.selectFocusedAndOlder(context); return success(); },
    'selection.all': ({ context }) => { deps.selection.selectAllVisible(context); return success(); },
    'selection.clear': () => { deps.selection.clear(); return success(); },
    'navigation.back': () => { deps.goBack(); return success(); },
    'navigation.shortcutInbox': () => { deps.navigate({ accountId: null, folder: 'INBOX' }); return success(); },
    'navigation.sent': specialFolder('\\Sent'),
    'navigation.drafts': specialFolder('\\Drafts'),
    'navigation.contacts': () => { deps.navigate({ contacts: true }); return success(); },
    'help.shortcuts': () => { deps.emitShortcut('showHelp'); return success(); },
    'layout.toggleRightSidebar': () => { deps.emitShortcut('toggleRightSidebar'); return success(); },
    'mail.print': () => { deps.emitShortcut('printMessage'); return success(); },
  };
}
