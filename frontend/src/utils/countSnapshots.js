import { isAccountInUnifiedInbox } from './unifiedInbox.js';

// Absolute backstop on an optimistic window. Reaching it means the observation our mutation
// was supposed to trigger never arrived, so adopting the server value is the honest outcome.
// It must exceed the observation path or every mutation visibly bounces: the backend debounces
// its mutation-triggered STATUS by 5s and then needs a connect, login and STATUS on top,
// measured at 1-2s, so a 5s window expired ~1-2s BEFORE its own replacement value landed.
export const PENDING_COUNT_MS = 15000;

// A window cannot settle before this. The backend's 5s debounce exists so the IMAP flag write
// lands before it asks the server, so an observation arriving sooner may predate our write and
// must not be treated as reflecting it. Past this floor, the next observation settles the
// window immediately, which is what keeps the common case at ~6-7s rather than the backstop.
export const PENDING_SETTLE_MS = 6000;

// Freshness allowance for the per-account totals, which come from INBOX. INBOX is polled every
// monitor cycle, so three cycles of slack. Mirrors STATUS_STALE_MS in backend folderStatus.js;
// rotating folders get a longer, rotation-derived allowance computed server-side.
export const ACCOUNT_COUNT_STALE_MS = 180000;
const revision = snapshot => BigInt(snapshot?.attemptRevision || snapshot?.revision || '0');

// A snapshot is independently ordered per account. Comparing unified totals cannot
// acknowledge individual reads: arrivals and writes in another account can cancel them.
export function mergeCountSnapshots(previous, incoming) {
  const byAccount = {}, snapshots = {};
  for (const [id, count] of Object.entries(incoming.byAccount || {})) {
    const old = previous.snapshots?.[id], next = incoming.snapshots?.[id];
    const keep = old && revision(old) > revision(next);
    byAccount[id] = keep ? previous.byAccount[id] : count;
    snapshots[id] = keep ? old : next;
  }
  return { ...incoming, byAccount, snapshots };
}

export function expireCountPending(pending, now = Date.now()) {
  return Object.fromEntries(Object.entries(pending).filter(([, p]) => p.expiresAt > now));
}

export function adjustCountPending(pending, displayed, accountId, delta, now = Date.now()) {
  const next = expireCountPending(pending, now);
  const base = displayed.byAccount[accountId];
  if (!Number.isFinite(base) || !Number.isFinite(delta)) return next;
  // The baseline, deadline and observation watermark never move while this window is open, so
  // continuous activity cannot freeze the count. sinceRevision records which observation was on
  // screen when the window opened, so settleCountPending can recognise a strictly later one.
  const p = next[accountId] || { base, delta: 0, openedAt: now, expiresAt: now + PENDING_COUNT_MS,
    sinceRevision: String(revision(displayed.snapshots?.[accountId])) };
  next[accountId] = { ...p, delta: p.delta + delta };
  return next;
}

// Retire windows whose mutation the server has now had a chance to observe.
//
// This reads the observation's own revision, never the count it carries: inferring
// acknowledgement from a total is invalid, because simultaneous arrivals, reads in another
// client and other-account changes can all cancel out. A strictly later observation taken after
// the settle floor is evidence about TIMING only, which is what the backend's debounce is for.
export function settleCountPending(pending, server, now = Date.now()) {
  const out = {};
  for (const [id, p] of Object.entries(expireCountPending(pending, now))) {
    const pastFloor = Number.isFinite(p.openedAt) && now - p.openedAt >= PENDING_SETTLE_MS;
    const observed = revision(server?.snapshots?.[id]) > BigInt(p.sinceRevision || '0');
    if (!(pastFloor && observed)) out[id] = p;
  }
  return out;
}

export function displayCountSnapshot(server, pending, accounts, now = Date.now()) {
  const byAccount = { ...server.byAccount };
  const snapshots = { ...server.snapshots };
  for (const [id, s] of Object.entries(snapshots)) {
    if (s) snapshots[id] = { ...s, stale: s.stale || !s.observedAt || now - new Date(s.observedAt).getTime() > ACCOUNT_COUNT_STALE_MS };
  }
  for (const [id, p] of Object.entries(pending)) {
    if (p.expiresAt > now && Object.hasOwn(byAccount, id)) byAccount[id] = Math.max(0, p.base + p.delta);
  }
  const included = accounts.filter(isAccountInUnifiedInbox);
  const total = included.reduce((sum, a) => sum + (byAccount[a.id] || 0), 0);
  const complete = included.every(a => snapshots[a.id]?.known && !snapshots[a.id]?.stale);
  return { ...server, byAccount, snapshots, total, complete };
}

export function mergeFolderSnapshots(previous = [], incoming = []) {
  const old = new Map(previous.map(f => [f.path, f]));
  return incoming.map(f => {
    const p = old.get(f.path);
    // Folder metadata comes from the current list; only retain newer observations.
    if (!p || BigInt(p.status_attempt_revision || '0') <= BigInt(f.status_attempt_revision || '0')) return f;
    const fields = ['total_count', 'unread_count', 'counts_known', 'counts_stale', 'server_counts_at',
      'server_count_revision', 'status_attempt_revision', 'status_attempted_at', 'status_error'];
    return { ...f, ...Object.fromEntries(fields.map(k => [k, p[k]])) };
  });
}
