// Read-time compatibility for shortcut preferences written before the command registry.
// Persisted objects are never rewritten merely because they were read.
export const LEGACY_ACTION_TO_COMMAND_ID = Object.freeze({
  compose: 'compose.new',
  focusSearch: 'navigation.search',
  showHelp: 'help.shortcuts',
  nextMessage: 'navigation.nextConversation',
  prevMessage: 'navigation.previousConversation',
  openMessage: 'navigation.openConversation',
  goInbox: 'navigation.inbox',
  toggleRightSidebar: 'layout.toggleRightSidebar',
  reply: 'mail.reply',
  replyAll: 'mail.replyAll',
  forward: 'mail.forward',
  archive: 'mail.archive',
  delete: 'mail.trash',
  toggleStar: 'mail.toggleStar',
  toggleRead: 'mail.toggleRead',
  selectMessage: 'selection.toggle',
  printMessage: 'mail.print',
  gtdTodo: 'gtd.todo',
  gtdWatch: 'gtd.watch',
  gtdDelegated: 'gtd.delegate',
});

export function normalizeLegacyShortcutOverrides(overrides = {}) {
  const normalized = { ...overrides };
  for (const [legacyId, commandId] of Object.entries(LEGACY_ACTION_TO_COMMAND_ID)) {
    if (!Object.hasOwn(normalized, commandId) && Object.hasOwn(overrides, legacyId)) {
      normalized[commandId] = overrides[legacyId];
    }
  }
  return normalized;
}
