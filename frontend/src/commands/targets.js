import { TARGET_MODES } from './contracts.js';

function contextualIds(context) {
  return context.selectedConversationIds.length
    ? context.selectedConversationIds
    : context.activeConversationId ? [context.activeConversationId] : [];
}

export function hasTargets(command, context) {
  switch (command.targetMode) {
    case TARGET_MODES.GLOBAL: return true;
    case TARGET_MODES.ACCOUNT: return Boolean(context.accountId);
    case TARGET_MODES.DRAFT: return Boolean(context.draft?.id);
    case TARGET_MODES.SINGLE_CONVERSATION: return contextualIds(context).length === 1;
    case TARGET_MODES.BULK_SAFE: return contextualIds(context).length > 0;
    default: return false;
  }
}

export function resolveTargetIds(command, context, frozenTargetIds) {
  if (command.targetMode === TARGET_MODES.DRAFT) {
    const currentId = context.draft?.id || null;
    const requested = frozenTargetIds == null
      ? (currentId ? [currentId] : [])
      : [...new Set(frozenTargetIds)];
    return {
      targetIds: requested.filter(id => id === currentId),
      missingTargetIds: requested.filter(id => id !== currentId),
    };
  }
  if (![TARGET_MODES.SINGLE_CONVERSATION, TARGET_MODES.BULK_SAFE].includes(command.targetMode)) {
    return { targetIds: [], missingTargetIds: [] };
  }
  const requested = frozenTargetIds == null ? contextualIds(context) : [...new Set(frozenTargetIds)];
  const targetIds = requested.filter(id => context.conversationsById[id]);
  const missingTargetIds = requested.filter(id => !context.conversationsById[id]);
  return { targetIds, missingTargetIds };
}
