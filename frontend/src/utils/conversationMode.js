export const CONVERSATION_MODES = Object.freeze(['off', 'list', 'pane']);

export const isConversationMode = value => CONVERSATION_MODES.includes(value);

export function resolveConversationMode(prefs = {}) {
  if (isConversationMode(prefs.conversationMode)) return prefs.conversationMode;
  if (typeof prefs.threadedView === 'boolean') return prefs.threadedView ? 'list' : 'off';
  return 'off';
}

export const groupsMessageList = mode => mode === 'list' || mode === 'pane';
export const expandsThreadsInline = mode => mode === 'list';

export function conversationListParams(mode) {
  if (!groupsMessageList(mode)) return {};
  return mode === 'pane'
    ? { threaded: 'true', threadScope: 'all' }
    : { threaded: 'true' };
}

export function conversationModeTransition(mode) {
  return {
    conversationMode: resolveConversationMode({ conversationMode: mode }),
    expandedThreadId: null,
    threadMessages: {},
    selectedMessageId: null,
  };
}
