const COMMANDS = Object.freeze({
  markRead: 'mail.read',
  markUnread: 'mail.unread',
  toggleStar: 'mail.toggleStar',
  reply: 'mail.reply',
  replyAll: 'mail.replyAll',
  forward: 'mail.forward',
  archive: 'mail.archive',
  delete: 'mail.trash',
  markSpam: 'mail.spam',
  markHam: 'mail.notSpam',
});

const SINGLE_CONVERSATION_COMMANDS = new Set(['mail.reply', 'mail.replyAll', 'mail.forward']);

export function contextMenuTargetMessages(commandId, message, selectedMessages) {
  if (SINGLE_CONVERSATION_COMMANDS.has(commandId)) return [message];
  return selectedMessages.length > 1 && selectedMessages.some(candidate => candidate.id === message.id)
    ? selectedMessages
    : [message];
}

export function toContextMenuCommand(action, data) {
  if (COMMANDS[action]) return { commandId: COMMANDS[action] };
  if (action === 'moveTo' && data) return { commandId: 'mail.move', input: { folder: data } };
  if (action === 'snooze' && data) return { commandId: 'mail.snooze', input: { until: data } };
  if (action === 'gtdClassify' && ['todo', 'watch', 'delegated', 'someday', 'reference'].includes(data)) {
    return { commandId: data === 'delegated' ? 'gtd.delegate' : `gtd.${data}` };
  }
  return null;
}
