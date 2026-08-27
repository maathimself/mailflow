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

  const batches = [];
  for (const [accountId, idSet] of idsByAccount) {
    const ids = [...idSet];
    for (let offset = 0; offset < ids.length; offset += 100) {
      const chunk = ids.slice(offset, offset + 100);
      let request;
      try {
        request = Promise.resolve(api.gtdMetadata(accountId, chunk));
      } catch (error) {
        request = Promise.reject(error);
      }
      batches.push({
        ids: chunk,
        request,
      });
    }
  }
  const responses = await Promise.allSettled(batches.map(batch => batch.request));
  if (generation !== requestGeneration) return 'stale';

  let failed = false;
  for (const [index, response] of responses.entries()) {
    if (response.status === 'rejected') {
      failed = true;
      continue;
    }
    const fresh = new Map(Object.entries(response.value?.messages || {}));
    for (const id of batches[index].ids) {
      if (fresh.has(id)) metadata.set(id, fresh.get(id));
      else metadata.delete(id);
    }
  }
  emit();
  return failed ? 'partial' : 'complete';
}

export function startGtdMetadataFetch(messages, {
  api,
  delay = 2000,
  schedule = setTimeout,
  cancelSchedule = clearTimeout,
  onError = error => console.error('GTD metadata fetch failed:', error),
}) {
  let cancelled = false;
  let retryTimer;
  const fetchMetadata = async (allowRetry) => {
    if (cancelled) return;
    try {
      const status = await fetchVisibleGtdMetadata(messages, { api });
      if (!cancelled && status === 'partial' && allowRetry) {
        retryTimer = schedule(() => { void fetchMetadata(false); }, delay);
      }
    } catch (error) {
      if (!cancelled) onError(error);
    }
  };
  void fetchMetadata(true);
  return () => {
    cancelled = true;
    if (retryTimer !== undefined) cancelSchedule(retryTimer);
  };
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
