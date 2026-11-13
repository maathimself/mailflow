import { extractImapError } from './imapError.js';

// Loaded on first use, so the search route does not pull the IMAP engine in at import time.
// A failed load is forgotten, so the next search tries again instead of Gmail search staying
// off until a restart. `load` is replaceable for tests.
let enginePromise = null;
let loadEngine = () => import('./imapManager.js');
const engine = () => {
  if (!enginePromise) {
    enginePromise = loadEngine();
    enginePromise.catch(() => { enginePromise = null; });
  }
  return enginePromise;
};
export function _setEngineLoader(load) {
  loadEngine = load;
  enginePromise = null;
}

// Body search on Gmail's own copy (D#320). MailFlow does not download Gmail bodies in the
// background (Gmail throttles BODY[] fetches), so a Gmail message nobody has opened is in the
// local cache with its subject, sender and snippet only, and a word deeper in its body cannot be
// found locally. Gmail can search its full text itself: X-GM-RAW in the All Mail mailbox.
//
// The search route asks for the free-text terms, gets back the matching messages' Gmail ids
// (X-GM-MSGID, stored as provider_msgid) and Message-IDs, and lets those rows satisfy the text
// part of the query; every other condition still applies in SQL. Only envelopes are fetched,
// which Gmail does not throttle. A slow or failing Gmail never holds up or breaks a search: each
// account has a time budget, after which the local results are returned alone.

export const GMAIL_SEARCH_TIMEOUT_MS = 4000;
export const GMAIL_SEARCH_MAX_RESULTS = 500;
const CACHE_MS = 60_000;
const CACHE_MAX = 200;

const cache = new Map();       // `${accountId}\n${raw}` -> { at, result }
const allMailPaths = new Map(); // accountId -> the \All mailbox path

// Each term quoted, so Gmail takes it as a word to find rather than an operator
// ("from:x" typed as a word stays a word). AND between terms, as in local search.
export function gmailRawQuery(terms) {
  return terms
    .map(term => String(term).replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map(term => `"${term}"`)
    .join(' ');
}

async function searchAccount(account, raw, withClient) {
  return withClient(account, async (client) => {
    if (!client.capabilities?.has?.('X-GM-EXT-1')) return null;
    let path = allMailPaths.get(account.id);
    if (!path) {
      const boxes = await client.list();
      path = boxes.find(box => box.specialUse === '\\All')?.path;
      if (!path) return null;
      allMailPaths.set(account.id, path);
    }
    const lock = await client.getMailboxLock(path, { readOnly: true });
    try {
      const uids = await client.search({ gmraw: raw }, { uid: true });
      const result = { providerIds: [], messageIds: [] };
      if (!uids?.length) return result;
      // The newest matches, as local search orders by date.
      const recent = [...uids].sort((a, b) => a - b).slice(-GMAIL_SEARCH_MAX_RESULTS);
      for await (const msg of client.fetch(recent.join(','), { emailId: true, envelope: true }, { uid: true })) {
        if (msg.emailId) result.providerIds.push(String(msg.emailId));
        if (msg.envelope?.messageId) result.messageIds.push(msg.envelope.messageId);
      }
      return result;
    } finally {
      lock.release();
    }
  });
}

// One Gmail search per account at a time, so searches typed in quick succession never hold more
// than one pooled connection (sync and opening mail share the pool). A search still waiting when a
// newer one for the account arrives is dropped instead of run: nobody is waiting for its answer.
const running = new Map(); // accountId -> the tail of its queue
const latest = new Map();  // accountId -> the newest query asked for
function queued(account, raw, run) {
  latest.set(account.id, raw);
  const turn = (running.get(account.id) || Promise.resolve())
    .catch(() => {})
    .then(() => (latest.get(account.id) === raw ? run() : 'superseded'));
  running.set(account.id, turn);
  turn.finally(() => { if (running.get(account.id) === turn) running.delete(account.id); }).catch(() => {});
  return turn;
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), ms); }),
  ]);
}

// Gmail's matches for `terms` across the Gmail accounts among `accounts` (rows with at least id
// and imap_host). `loadAccounts(ids)` returns the full rows needed to log in; it is called only
// when a Gmail account is in scope. Returns the ids to accept in SQL, or null when there is
// nothing to add. Never throws.
export async function gmailServerMatches(accounts, terms, {
  loadAccounts, withClient, timeoutMs = GMAIL_SEARCH_TIMEOUT_MS, now = Date.now,
} = {}) {
  const raw = gmailRawQuery(terms);
  if (!raw || !accounts.length) return null;
  let gmail;
  try {
    const { providerProfile, withFreshClient } = await engine();
    const ids = accounts.filter(account => providerProfile(account)?.labelStore).map(account => account.id);
    if (!ids.length) return null;
    gmail = loadAccounts ? await loadAccounts(ids) : accounts.filter(account => ids.includes(account.id));
    withClient ??= withFreshClient;
  } catch (err) {
    console.warn(`Gmail search skipped: ${extractImapError(err)}`);
    return null;
  }

  const results = await Promise.all(gmail.map(async (account) => {
    const key = `${account.id}\n${raw}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < CACHE_MS) return { account, result: hit.result };
    try {
      const result = await withTimeout(queued(account, raw, () => searchAccount(account, raw, withClient)), timeoutMs);
      if (result === 'superseded') return { account, result: null };
      if (result === 'timeout') {
        console.warn(`Gmail search took longer than ${timeoutMs} ms for account ${account.id}; showing local results`);
        return { account, result: null };
      }
      cache.set(key, { at: now(), result });
      if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
      return { account, result };
    } catch (err) {
      console.warn(`Gmail search failed for account ${account.id}; showing local results: ${extractImapError(err)}`);
      return { account, result: null };
    }
  }));

  const accountIds = [];
  const providerIds = [];
  const messageIds = [];
  for (const { account, result } of results) {
    if (!result || (!result.providerIds.length && !result.messageIds.length)) continue;
    accountIds.push(account.id);
    providerIds.push(...result.providerIds);
    messageIds.push(...result.messageIds);
  }
  return accountIds.length ? { accountIds, providerIds, messageIds } : null;
}

// For tests.
export function _resetGmailSearchCache() {
  cache.clear();
  allMailPaths.clear();
  running.clear();
  latest.clear();
}
