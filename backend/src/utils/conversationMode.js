const MODES = new Set(['off', 'list', 'pane']);

export function sanitizeConversationMode(value) {
  return MODES.has(value) ? value : null;
}
