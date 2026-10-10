const STATE_ORDER = ['todo', 'watch', 'delegated', 'reference', 'someday'];
const metadata = new Map();
let visibleMessages = new Map();
const listeners = new Set();
const refreshListeners = new Set();
const clockListeners = new Set();
let requestGeneration = 0;
let refreshGeneration = 0;
let sessionGeneration = 0;
let clock = Date.now();

const emit = () => { for (const listener of listeners) listener(); };

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

export const getGtdMetadataRefreshGeneration = () => refreshGeneration;
export const getGtdMetadataSessionGeneration = () => sessionGeneration;
export const getGtdMetadataClock = () => clock;

export function subscribeGtdMetadataClock(listener) {
  clockListeners.add(listener);
  return () => clockListeners.delete(listener);
}

export function tickGtdMetadataClock(now = Date.now()) {
  clock = now;
  for (const listener of clockListeners) listener();
}

export function invalidateGtdMetadata() {
  requestGeneration += 1;
  refreshGeneration += 1;
  for (const listener of refreshListeners) listener();
}

function relatedIds(message) {
  const row = typeof message === 'string' ? visibleMessages.get(message) || { id: message } : message;
  if (!row?.id) return [];
  const ids = new Set([row.id]);
  const threadKey = row.thread_key ?? row.thread_id;
  for (const candidate of visibleMessages.values()) {
    if (row.account_id && candidate.account_id === row.account_id && (
      (threadKey && (candidate.thread_key ?? candidate.thread_id) === threadKey)
      || (row.message_id && candidate.message_id === row.message_id)
    )) ids.add(candidate.id);
  }
  return [...ids];
}

export function clearGtdMetadata(message) {
  if (message) {
    for (const id of relatedIds(message)) metadata.delete(id);
  } else {
    metadata.clear();
    visibleMessages.clear();
    sessionGeneration += 1;
  }
  requestGeneration += 1;
  emit();
}

export function refreshGtdMetadata(message, session = sessionGeneration) {
  if (session !== sessionGeneration) return;
  clearGtdMetadata(message);
  invalidateGtdMetadata();
}

export async function fetchVisibleGtdMetadata(messages, { api }) {
  const generation = ++requestGeneration;
  visibleMessages = new Map((messages || []).filter(message => message?.id && message.account_id)
    .map(message => [message.id, message]));
  for (const id of metadata.keys()) if (!visibleMessages.has(id)) metadata.delete(id);
  emit();
  const idsByAccount = new Map();
  for (const message of visibleMessages.values()) {
    if (!idsByAccount.has(message.account_id)) idsByAccount.set(message.account_id, []);
    idsByAccount.get(message.account_id).push(message.id);
  }

  const batches = [];
  for (const [accountId, ids] of idsByAccount) {
    for (let offset = 0; offset < ids.length; offset += 100) {
      const chunk = ids.slice(offset, offset + 100);
      let request;
      try { request = Promise.resolve(api.gtdMetadata(accountId, chunk)); }
      catch (error) { request = Promise.reject(error); }
      batches.push({ ids: chunk, request });
    }
  }
  const responses = await Promise.all(batches.map(async batch => {
    let fresh;
    try { fresh = (await batch.request)?.messages; }
    catch { return false; }
    if (generation !== requestGeneration) return false;
    if (!fresh || typeof fresh !== 'object' || Array.isArray(fresh)) return false;
    let complete = true;
    for (const id of batch.ids) {
      if (!Object.hasOwn(fresh, id)) metadata.delete(id);
      else if (Array.isArray(fresh[id]?.states)) metadata.set(id, fresh[id]);
      else complete = false;
    }
    emit();
    return complete;
  }));
  if (generation !== requestGeneration) return 'stale';
  return responses.every(Boolean) ? 'complete' : 'partial';
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
  let generation;
  const session = sessionGeneration;
  const fetchMetadata = async allowRetry => {
    if (cancelled || session !== sessionGeneration || (generation !== undefined && generation !== requestGeneration)) return;
    try {
      const pending = fetchVisibleGtdMetadata(messages, { api });
      generation = requestGeneration;
      const status = await pending;
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
    if (generation === requestGeneration) requestGeneration += 1;
    if (retryTimer !== undefined) cancelSchedule(retryTimer);
  };
}

export function patchGtdMetadata(message, state, date) {
  if (!STATE_ORDER.includes(state)) return;
  for (const id of relatedIds(message)) {
    const current = metadata.get(id) || { states: [], dates: {}, date: null };
    const states = [...new Set([...current.states, state])]
      .sort((a, b) => STATE_ORDER.indexOf(a) - STATE_ORDER.indexOf(b));
    const dates = { ...current.dates };
    if (!(state in dates) || (date && (!dates[state] || new Date(date) < new Date(dates[state])))) dates[state] = date ?? null;
    const dated = Object.values(dates).filter(Boolean).sort();
    metadata.set(id, { ...current, states, dates, date: dated[0] ?? null });
  }
  requestGeneration += 1;
  emit();
}
