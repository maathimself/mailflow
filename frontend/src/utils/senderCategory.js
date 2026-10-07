// "Always for this sender" / "Always for this domain" from a message's Categorize menu (#490).
// The server saves it as an inbox rule (From equals the address, or ends with @domain, then Set
// category) and recategorizes that sender's existing inbox mail; this keeps the loaded list in step.

// The address or "@domain" the rule matches, as the server derives it; null without a usable address.
export function senderScopeValue(message, scope) {
  const email = String(message?.from_email || '').trim().toLowerCase();
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return null;
  return scope === 'domain' ? email.slice(at) : email;
}

// Whether a loaded message is one the rule and the server update cover: an inbox message whose
// sender address equals the value (sender) or ends with it (domain).
export function matchesSenderScope(message, scope, value) {
  if (String(message?.folder || '').toLowerCase() !== 'inbox') return false;
  const email = String(message?.from_email || '').trim().toLowerCase();
  return scope === 'domain' ? email.endsWith(value) : email === value;
}

// Saves the choice and calls onMatch for every loaded message it now covers. Reports the outcome
// as a notification; returns the server's answer, or null when nothing was saved. The API and the
// store come in as arguments, so this module imports nothing and its tests run under plain node.
export async function saveSenderCategory(message, scope, category, { t, onMatch, api, getState }) {
  const value = senderScopeValue(message, scope);
  if (!value) return null;
  const { addNotification } = getState();
  const label = t(`messageList.categories.${category}`);
  try {
    const result = await api.setSenderCategory(message.id, scope, category, `${value} → ${label}`);
    for (const loaded of getState().messages) {
      if (matchesSenderScope(loaded, scope, result.value)) onMatch(loaded);
    }
    addNotification({
      title: t('messageList.categoryAlways.done', { value: result.value, category: label }),
      body: t('messageList.categoryAlways.doneBody'),
    });
    return result;
  } catch (err) {
    console.error('setSenderCategory failed:', err?.message);
    addNotification({ type: 'error', title: t('messageList.categoryAlways.failed'), body: err?.message || '' });
    return null;
  }
}
