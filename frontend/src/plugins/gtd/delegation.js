import {
  closeDelegation,
  getDelegationSnapshot,
  MAX_DELEGATION_MESSAGES,
  openDelegation,
  updateDelegation,
} from './delegationController.js';
import { invalidateGtdMetadata, patchGtdDelegation } from './metadataStore.js';

export function contactOption(contact) {
  if (!contact?.id) return null;
  const email = contact.primary_email || contact.email || '';
  return { id: contact.id, label: contact.display_name || email || 'Unknown contact', email };
}

export function delegationPillData(delegation, now = Date.now()) {
  if (!delegation) return null;
  const label = delegation.displayName || delegation.primaryEmail || '';
  if (!label) return null;
  const timestamp = new Date(delegation.delegatedAt).getTime();
  const days = Number.isFinite(timestamp) ? Math.max(0, Math.floor((now - timestamp) / 86400000)) : null;
  return { label, email: delegation.primaryEmail || '', days };
}

export function findMessageById(state, messageId) {
  if (!messageId) return null;
  const pool = state.searchQuery?.trim() ? state.searchResults : state.messages;
  return pool?.find(message => message.id === messageId)
    ?? Object.values(state.threadMessages || {}).flat()
      .find(message => message.id === messageId)
    ?? null;
}

export function findDelegationTarget(state) {
  return findMessageById(state, state?.selectedMessageId);
}

export function findMessageWindowTargets(state) {
  return [...new Map((state?.messageWindows || [])
    .map(windowState => findMessageById(state, windowState.messageId))
    .filter(Boolean)
    .map(message => [message.id, message])).values()];
}

function outcomeNotification(result, t) {
  if (result.status === 'success') {
    return { title: t('gtd.delegate.success', { count: result.successCount }) };
  }
  if (result.status === 'partial') {
    return { title: t('gtd.delegate.partial', { success: result.successCount, failed: result.failureCount }) };
  }
  return { type: 'error', title: t('gtd.delegate.failed', { count: result.failureCount }) };
}

export async function submitDelegation(messageIds, contactId, { api, store, t }, { background = false } = {}) {
  updateDelegation(background ? 'submitting-background' : 'submitting');
  const submittedState = getDelegationSnapshot();
  try {
    const result = await api.gtdDelegate([...messageIds], contactId);
    for (const item of result.results || []) {
      if (item.ok) patchGtdDelegation(item.messageId, item.delegation ?? null);
    }
    invalidateGtdMetadata();
    if (result.successCount > 0) store.scheduleGtdSectionsFetch?.();
    store.addNotification(outcomeNotification(result, t));
    if (getDelegationSnapshot() === submittedState) closeDelegation();
    return result;
  } catch (error) {
    store.addNotification({ type: 'error', title: t('gtd.delegate.failed', { count: messageIds.length }) });
    if (getDelegationSnapshot() === submittedState && background) {
      closeDelegation();
    } else if (getDelegationSnapshot() === submittedState) {
      updateDelegation('picker', error.message || t('gtd.delegate.failed', { count: messageIds.length }));
    }
    return null;
  }
}

export async function runDelegation(messageIds, deps) {
  const snapshot = openDelegation(messageIds);
  if (snapshot.phase === 'rejected') {
    deps.store.addNotification({
      type: 'error',
      title: deps.t('gtd.delegate.tooMany', { max: MAX_DELEGATION_MESSAGES }),
    });
    closeDelegation();
    return null;
  }
  if (!snapshot.messageIds.length) {
    closeDelegation();
    return null;
  }
  try {
    const status = await deps.api.carddav.status();
    if (getDelegationSnapshot() !== snapshot) return null;
    if (status?.connected) {
      updateDelegation('picker');
      return null;
    }
    return submitDelegation(snapshot.messageIds, null, deps, { background: true });
  } catch {
    if (getDelegationSnapshot() !== snapshot) return null;
    updateDelegation('picker', deps.t('gtd.delegate.loadFailed'));
    return null;
  }
}

export function submitOpenDelegation(contactId, deps) {
  const snapshot = getDelegationSnapshot();
  if (snapshot.phase !== 'picker') return Promise.resolve(null);
  return submitDelegation(snapshot.messageIds, contactId, deps);
}
