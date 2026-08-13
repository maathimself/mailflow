const STATE_ORDER = ['todo', 'watch', 'delegated', 'reference', 'someday'];
const metadata = new Map();
const listeners = new Set();
const refreshListeners = new Set();
let requestGeneration = 0;
let refreshGeneration = 0;

function emit() {
  for (const listener of listeners) listener();
}

export function subscribeGtdMetadata(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getGtdMetadata(messageId) {
  return metadata.get(messageId) ?? null;
}

export function subscribeGtdMetadataRefresh(listener) {
  refreshListeners.add(listener);
  return () => refreshListeners.delete(listener);
}

export function getGtdMetadataRefreshGeneration() {
  return refreshGeneration;
}

export function invalidateGtdMetadata() {
  requestGeneration += 1;
  refreshGeneration += 1;
  for (const listener of refreshListeners) listener();
}

export async function fetchVisibleGtdMetadata(messages, { api }) {
  const generation = ++requestGeneration;
  const idsByAccount = new Map();
  for (const message of messages || []) {
    if (!message?.id || !message.account_id) continue;
    if (!idsByAccount.has(message.account_id)) idsByAccount.set(message.account_id, new Set());
    idsByAccount.get(message.account_id).add(message.id);
  }

  const requests = [];
  const requestedIds = [];
  for (const [accountId, idSet] of idsByAccount) {
    const ids = [...idSet];
    requestedIds.push(...ids);
    for (let offset = 0; offset < ids.length; offset += 100) {
      const chunk = ids.slice(offset, offset + 100);
      requests.push(api.gtdMetadata(accountId, chunk));
    }
  }
  const responses = await Promise.all(requests);
  if (generation !== requestGeneration) return false;

  const fresh = new Map();
  for (const response of responses) {
    for (const [id, value] of Object.entries(response?.messages || {})) fresh.set(id, value);
  }
  for (const id of requestedIds) {
    if (fresh.has(id)) metadata.set(id, fresh.get(id));
    else metadata.delete(id);
  }
  emit();
  return true;
}

export function patchGtdMetadata(message, state, date) {
  const messageId = typeof message === 'string' ? message : message?.id;
  if (!messageId || !STATE_ORDER.includes(state)) return;
  const current = metadata.get(messageId) || { states: [], dates: {}, date: null };
  const states = [...new Set([...current.states, state])]
    .sort((a, b) => STATE_ORDER.indexOf(a) - STATE_ORDER.indexOf(b));
  const dates = { ...current.dates };
  if (!(state in dates)) dates[state] = date ?? null;
  const dated = Object.values(dates).filter(Boolean).sort();
  metadata.set(messageId, {
    ...current,
    states,
    dates,
    date: dated.at(-1) ?? null,
  });
  requestGeneration += 1;
  emit();
}

export function removeGtdMetadataState(message, state) {
  const messageId = typeof message === 'string' ? message : message?.id;
  const current = messageId ? metadata.get(messageId) : null;
  if (!current?.states?.includes(state)) return;

  const states = current.states.filter(item => item !== state);
  if (states.length === 0) {
    metadata.delete(messageId);
  } else {
    const dates = { ...current.dates };
    delete dates[state];
    const dated = Object.values(dates).filter(Boolean).sort();
    metadata.set(messageId, {
      ...current,
      states,
      dates,
      date: dated.at(-1) ?? null,
    });
  }
  requestGeneration += 1;
  emit();
}
