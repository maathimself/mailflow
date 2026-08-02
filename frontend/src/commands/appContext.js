import { createCommandContext, stableConversationId } from './contracts.js';
import { normalizeLegacyShortcutOverrides } from '../utils/defaultShortcuts.js';

export function detectCommandPlatform(navigatorLike = {}) {
  const value = navigatorLike.userAgentData?.platform || navigatorLike.platform || '';
  if (/mac|iphone|ipad|ipod/i.test(value)) return 'mac';
  if (/win/i.test(value)) return 'windows';
  return 'linux';
}

function allConversations(state) {
  const gtd = Object.values(state.gtdSections || {}).flatMap(section => section?.threads || []);
  return [
    ...(state.messages || []),
    ...(state.searchResults || []),
    ...Object.values(state.threadMessages || {}).flat(),
    ...gtd,
  ].filter((message, index, all) => {
    const id = stableConversationId(message);
    return id && all.findIndex(candidate => stableConversationId(candidate) === id) === index;
  });
}

export function buildAppCommandContext(state, {
  translate,
  platform = detectCommandPlatform(globalThis.navigator),
  editing = false,
  modal = null,
} = {}) {
  const conversations = allConversations(state);
  const visibleMessages = state.searchQuery?.trim()
    ? (state.searchResults || [])
    : state.activeGtdTab
      ? (state.gtdSections?.[state.activeGtdTab]?.threads || [])
      : (state.messages || []);
  const selectedRows = new Set(state.selectedMessageIds || []);
  const selectedConversationIds = conversations
    .filter(message => selectedRows.has(message.id))
    .map(stableConversationId);
  const selected = conversations.find(message => message.id === state.selectedMessageId);
  const listCursor = visibleMessages.find(message => message.id === state.lastViewedMessageId);
  const active = state.showContacts ? null : (selected || listCursor);
  const targetedMessages = selectedConversationIds.length
    ? conversations.filter(message => selectedConversationIds.includes(stableConversationId(message)))
    : active ? [active] : [];
  const targetedAccountIds = [...new Set(targetedMessages.map(message => message.account_id).filter(Boolean))];
  const accounts = state.accounts || [];
  const gtdAvailable = targetedAccountIds.length
    ? targetedAccountIds.every(id => accounts.find(account => account.id === id)?.gtd_enabled)
    : state.selectedAccountId
      ? Boolean(accounts.find(account => account.id === state.selectedAccountId)?.gtd_enabled)
      : accounts.some(account => account.gtd_enabled);
  const surface = modal ? 'picker'
    : state.showAdmin || state.showContacts ? 'settings'
      : state.composing ? 'compose'
        : state.selectedMessageId ? 'conversation' : 'list';
  const shortcutOverrides = normalizeLegacyShortcutOverrides(state.shortcuts || {});

  return createCommandContext({
    surface,
    activeConversationId: stableConversationId(active),
    activeMessage: active || null,
    selectedConversationIds,
    visibleConversationIds: state.showContacts ? [] : visibleMessages.map(stableConversationId).filter(Boolean),
    conversations,
    accountId: state.selectedAccountId,
    folder: state.selectedFolder,
    draft: state.composing ? (state.composeData || { id: 'active-compose' }) : null,
    gtdAvailable,
    cardDavConnected: Boolean(state.carddavStatus?.connected),
    carddavStatus: state.carddavStatus,
    carddavStatusLoaded: state.carddavStatusLoaded,
    modal,
    editing: editing || Boolean(state.composing) || Boolean(state.showAdmin) || Boolean(state.showContacts),
    undoAvailable: (state.notifications || []).some(notification => typeof notification.onUndo === 'function'),
    platform,
    shortcutOverrides,
    translate,
  });
}

export function commandTargetLabel(context) {
  if (context.selectedConversationIds.length > 1) {
    return { key: 'commandPalette.target.selected', values: { count: context.selectedConversationIds.length } };
  }
  if (context.selectedConversationIds.length === 1 || context.activeConversationId) {
    return { key: 'commandPalette.target.conversation', values: {} };
  }
  return { key: 'commandPalette.target.application', values: {} };
}
