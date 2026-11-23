import { isAccountInUnifiedInbox } from './unifiedInbox.js';
import { inInbox } from './inboxBadge.js';

// The backstop on an optimistic window. Reaching it, the window asks for the server's count again
// (a 'mailflow:counts_refresh'), and retires if the server has counted the mailbox since the
// change; if not, it holds (PENDING_HOLD_MS). It must exceed the observation path or every
// mutation visibly bounces: the backend debounces its mutation-triggered STATUS by 5s and then
// needs a connect, login and STATUS on top, measured at 1-2s, so a 5s window expired ~1-2s
// BEFORE its own replacement value landed.
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

// How long a window holds the user's change while the server has not counted the mailbox since:
// its STATUS failed (a connect timeout, a provider cooldown) or did not run. The count it would
// fall back to is from before the change, so it is known to be wrong. Falling back after
// PENDING_COUNT_MS put every message the user had just read back on the badge, until the next
// STATUS got through minutes later. Past this the server's count is marked stale anyway
// (ACCOUNT_COUNT_STALE_MS), and the badge shows it, marked so.
export const PENDING_HOLD_MS = ACCOUNT_COUNT_STALE_MS;

// Orders snapshots: a failed STATUS gets a revision too, so a slow success cannot replace it.
const revision = snapshot => BigInt(snapshot?.attemptRevision || snapshot?.revision || '0');
// The revision of the last STATUS that came back with a count. Only that can show a change was
// counted: a failed attempt carries the count from before it.
const countedRevision = snapshot => BigInt(snapshot?.revision || '0');

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

// Whether the window for account `id` still stands at `now`. Until its backstop, always. Past it,
// only while the server has not counted the mailbox since the change, and for PENDING_HOLD_MS at
// most. Without `server` (or a window without a watermark), the backstop alone decides.
function pendingOpen(id, p, server, now) {
  if (p.expiresAt > now) return true;
  if (!server || p.sinceRevision == null || !(p.holdUntil > now)) return false;
  return countedRevision(server.snapshots?.[id]) <= BigInt(p.sinceRevision);
}

export function expireCountPending(pending, now = Date.now(), server = null) {
  return Object.fromEntries(Object.entries(pending).filter(([id, p]) => pendingOpen(id, p, server, now)));
}

// When the windows in `pending` next need looking at: a backstop, or, for a window held past it,
// another PENDING_COUNT_MS (each look asks the server again) up to the end of its hold. Null when
// there are none.
export function nextCountDeadline(pending, now = Date.now()) {
  const deadlines = Object.values(pending).map(p => (p.expiresAt > now ? p.expiresAt
    : Math.min(p.holdUntil ?? now, now + PENDING_COUNT_MS)));
  return deadlines.length ? Math.min(...deadlines) : null;
}

export function adjustCountPending(pending, displayed, accountId, delta, now = Date.now(), { commitDelayMs = 0 } = {}) {
  const next = expireCountPending(pending, now, displayed);
  const base = displayed.byAccount[accountId];
  if (!Number.isFinite(base) || !Number.isFinite(delta)) return next;
  // The baseline and observation watermark never move while this window is open. sinceRevision
  // records which observation was on screen when the window opened, so settleCountPending can
  // recognise a strictly later one.
  //
  // The floor and backstop count from the latest change, from when the server is told of it: a
  // change held for undo (delete, archive, move) is sent only when its undo window closes. Counted
  // from the first click, the count measured after an earlier change settled the window, or the
  // backstop expired it, before the latest change could be observed, and the badge went back to
  // the count from before it. After the last unread message that read as the badge sticking at
  // 1 (#701). The cost is that while the user keeps acting, an arrival reaches the badge only
  // once they stop; their own changes are always shown.
  const sentAt = now + commitDelayMs;
  const p = next[accountId] || { base, delta: 0, openedAt: sentAt, expiresAt: sentAt + PENDING_COUNT_MS,
    holdUntil: sentAt + PENDING_HOLD_MS, sinceRevision: String(countedRevision(displayed.snapshots?.[accountId])) };
  next[accountId] = { ...p, delta: p.delta + delta,
    openedAt: Math.max(p.openedAt ?? sentAt, sentAt), expiresAt: Math.max(p.expiresAt, sentAt + PENDING_COUNT_MS),
    holdUntil: Math.max(p.holdUntil ?? 0, sentAt + PENDING_HOLD_MS) };
  return next;
}

// Retire windows whose mutation the server has now counted.
//
// Only a STATUS that came back with a count settles a window. A failed one is numbered as well,
// and settling on it adopted the count from before the change: reading eleven messages while
// PurelyMail refused connections put all of them back on the badge for three minutes.
//
// This reads the observation's own revision, never the count it carries: inferring
// acknowledgement from a total is invalid, because simultaneous arrivals, reads in another
// client and other-account changes can all cancel out. A strictly later observation taken after
// the settle floor is evidence about TIMING only, which is what the backend's debounce is for.
export function settleCountPending(pending, server, now = Date.now()) {
  const out = {};
  for (const [id, p] of Object.entries(expireCountPending(pending, now, server))) {
    const pastFloor = Number.isFinite(p.openedAt) && now - p.openedAt >= PENDING_SETTLE_MS;
    const observed = countedRevision(server?.snapshots?.[id]) > BigInt(p.sinceRevision || '0');
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
    if (pendingOpen(id, p, server, now) && Object.hasOwn(byAccount, id)) byAccount[id] = Math.max(0, p.base + p.delta);
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

// How many of `messages` change unread state when the conversation is marked `read`, grouped
// by the account whose badge each change belongs to. A message with no account_id is charged
// to `fallbackAccountId`, the acted-on row's account. Only messages in INBOX count: the badge is
// that folder's unread count, and a conversation's copies in Archive or Sent are not in it
// (utils/inboxBadge.js).
//
// With conversations on, one thread row can hold another account's copy of the same email
// (#476). Charging the row's whole unread_count to the row's own account, which is what the
// pre-resolution estimate has to do, moves that copy's unread off the wrong badge: the row's
// account drops by two, the other account drops by nothing, and the sidebar is wrong until
// the next server snapshot (PENDING_COUNT_MS). The unified total is a sum, so it stays right;
// only the per-account split is off. Pure.
export function unreadDeltaByAccount(messages, read, fallbackAccountId) {
  const out = new Map();
  for (const m of messages || []) {
    if (!m || !inInbox(m)) continue;
    const changes = read ? !m.is_read : !!m.is_read;
    if (!changes) continue;
    const account = m.account_id ?? fallbackAccountId;
    out.set(account, (out.get(account) || 0) + 1);
  }
  return out;
}
