export function delegateNeedsContact(carddavStatus) {
  return carddavStatus?.connected === true;
}

export function normalizeCarddavStatus(status) {
  return status && typeof status === 'object'
    ? { ...status, connected: status.connected === true }
    : { connected: false };
}

export function delegateLabel(delegation) {
  return delegation?.display_name?.trim()
    || delegation?.primary_email?.trim()
    || '';
}

export function normalizeDelegateOutcome(result, targets) {
  const byMessageId = new Map((result?.results || []).map(item => [item.messageId, item]));
  const succeededIds = [];
  const failed = [];
  for (const target of targets) {
    const item = byMessageId.get(target.message.id);
    if (item?.ok) succeededIds.push(target.id);
    else failed.push({ id: target.id, error: item?.error?.code || 'delegate_failed' });
  }
  const successCount = Number(result?.successCount) || 0;
  const failureCount = Number(result?.failureCount) || 0;
  const status = result?.status || (failed.length ? 'failed' : 'success');
  return {
    status,
    succeededIds,
    failed,
    value: {
      messageKey: status === 'success'
        ? 'gtd.delegate.success'
        : status === 'partial'
          ? 'gtd.delegate.partial'
          : 'gtd.delegate.failed',
      messageParams: {
        count: successCount + failureCount,
        succeeded: successCount,
        failed: failureCount,
      },
    },
  };
}

export function nextPickerIndex(index, delta, count) {
  if (count === 0) return -1;
  return (index + delta + count) % count;
}

export function contactOption(contact) {
  return {
    id: contact.id,
    label: contact.display_name?.trim() || contact.primary_email?.trim() || '',
    email: contact.primary_email || '',
  };
}

export function createPickerRequestGate() {
  let current = 0;
  return {
    start() { current += 1; return current; },
    isCurrent(requestId) { return requestId === current; },
  };
}

export function pickerDecision(action, contactId) {
  if (action === 'cancel') return { type: 'cancel' };
  return { type: 'submit', contactId: action === 'no-person' ? null : contactId };
}

export function delegateTooltip(delegation) {
  const name = delegation?.display_name?.trim();
  const email = delegation?.primary_email?.trim();
  if (name && email && name !== email) return `${name} <${email}>`;
  return name || email || '';
}

export function delegationCacheIds(state, targetMessage) {
  const ids = new Set(targetMessage?.id ? [targetMessage.id] : []);
  const threadIdentity = targetMessage?.thread_id || targetMessage?.thread_key;
  if (!threadIdentity) return [...ids];
  const cached = [
    ...(state.messages || []),
    ...(state.searchResults || []),
    ...Object.values(state.threadMessages || {}).flat(),
  ];
  cached.forEach(message => {
    const sameAccount = targetMessage.account_id == null
      || message.account_id === targetMessage.account_id;
    if (sameAccount && (message.thread_id || message.thread_key) === threadIdentity && message.id) {
      ids.add(message.id);
    }
  });
  return [...ids];
}
