// Pure helpers for GTD display surfaces. Kept free of React/DOM so they can be
// unit-tested under `node --test` at their pure seams.

// A commitment older than this many days is shown with a red-tinted aging chip.
// Module constant (no "N stale" header aggregate — per-row only).
export const STALE_DAYS = 14;

// GTD state display colors (contrast-validated set). Inline-style values, not
// theme vars — five distinct per-state hues (plus the neutral someday grey)
// don't map onto the four accent/green/red/amber tokens the theme exposes.
export const GTD_COLORS = {
  todo: '#4A9EDD',
  watch: '#D9B430',
  delegated: '#E08B3D',
  someday: 'var(--text-tertiary)',
  reference: '#7157d9',
  done: '#2FBD85',
};

// Same-hue ~15% alpha backgrounds for count chips / kind chips (color recipe:
// saturated glyph/text + same-hue low-alpha chip + always a text label).
export const GTD_CHIP_BG = {
  todo: 'rgba(74,158,221,0.16)',
  watch: 'rgba(217,180,48,0.15)',
  delegated: 'rgba(224,139,61,0.15)',
  someday: 'rgba(139,139,155,0.16)',
  reference: 'rgba(113,87,217,0.16)',
  done: 'rgba(47,189,133,0.14)',
};

// GTD section display order (Waiting merges watch + delegated): Todo → Waiting →
// Reference → Someday — actionable items first, then delegated/waiting-on items,
// then reference material, then someday/maybe deferred to last.
export const GTD_DISPLAY_SECTION_ORDER = ['todo', 'waiting', 'reference', 'someday'];

// The five GTD states and their default state→folder map (mirrors the backend
// gtdConfig defaults). Classify actions COPY into the resolved folder.
export const GTD_STATES = ['todo', 'watch', 'delegated', 'someday', 'reference'];
export const DEFAULT_GTD_FOLDERS = {
  todo: 'Todo', watch: 'Watch', delegated: 'Delegated', someday: 'Someday', reference: 'Reference',
};

// Merge an account's stored gtd_folders overrides over the defaults (same shape
// the backend getGtdConfig produces).
export function resolveAccountGtdFolders(account) {
  const stored = account?.gtd_folders && typeof account.gtd_folders === 'object' && !Array.isArray(account.gtd_folders)
    ? account.gtd_folders : {};
  return { ...DEFAULT_GTD_FOLDERS, ...stored };
}

// Reduce a settings-form folder map to only the entries that differ from the
// defaults, trimmed. Stored as the account's gtd_folders so an untouched mapping
// persists as {} ("all defaults") and a later default change still propagates. A
// blank field falls back to its default (dropped here).
export function diffGtdFolders(folders) {
  const out = {};
  for (const state of GTD_STATES) {
    const v = (folders?.[state] ?? '').trim();
    if (v && v !== DEFAULT_GTD_FOLDERS[state]) out[state] = v;
  }
  return out;
}

// Detect GTD states whose resolved folder path collides with another state's.
// Mirrors the backend guard so the settings form can block a save before it hits
// the API: a blank field falls back to its default (and both sides are trimmed)
// before comparison, so two states pointing at the same folder — by override or by
// a typo onto another state's default name — are caught. Returns collision groups
// [{ folder, states }], empty when all five are distinct.
export function findGtdFolderCollisions(folders) {
  const byFolder = {};
  for (const state of GTD_STATES) {
    const path = (folders?.[state] ?? '').trim() || DEFAULT_GTD_FOLDERS[state];
    (byFolder[path] ||= []).push(state);
  }
  return Object.entries(byFolder)
    .filter(([, states]) => states.length > 1)
    .map(([folder, states]) => ({ folder, states }));
}

// Which GTD states a message's thread is currently labelled with, given the
// thread's folder paths and the account's resolved state→folder map. Drives the
// "Remove from <state>" context-menu options (only shown for labels present).
export function gtdStatesInFolders(folders, resolvedMap) {
  const set = new Set(Array.isArray(folders) ? folders : []);
  return GTD_STATES.filter(state => set.has(resolvedMap?.[state]));
}

// Whole days between a thread head's date and now. null when there is no
// parseable date. Future dates clamp to 0 (a freshly-synced head can carry a
// clock-skewed date slightly ahead of the client).
export function agingDays(dateStr, now = Date.now()) {
  if (!dateStr) return null;
  const t = new Date(dateStr).getTime();
  if (!Number.isFinite(t)) return null;
  const days = Math.floor((now - t) / (24 * 60 * 60 * 1000));
  return days < 0 ? 0 : days;
}

export function isStale(days) {
  return days != null && days > STALE_DAYS;
}

export function agingLabel(days) {
  if (days == null) return '';
  return `⏱ ${days}d`;
}

// Derive a GTD entry's display fields from its thread + section key. A merged-Waiting
// row carries gtdKinds (watch and/or delegated); everything else uses the section's own
// state for its left border and aging-pill color. The primary kind (kinds[0], watch-first)
// drives both — so a merged W+D row reads as watch (yellow), matching the Waiting section
// color. Age comes from the conservative (older) waiting date on a merged row; agingDate
// falls back to the row's own date for a single-kind row. Shared by the GTD display surfaces.
export function resolveRowDisplay(thread, sectionKey) {
  const isWaiting = sectionKey === 'waiting';
  const kinds = isWaiting ? (thread.gtdKinds?.length ? thread.gtdKinds : [thread.gtdKind || 'watch']) : [];
  const rowState = isWaiting ? (kinds[0] || 'watch') : sectionKey;
  const unread = !thread.is_read;
  const days = agingDays(thread.agingDate ?? thread.date);
  const stale = isStale(days);
  const sender = thread.from_name || thread.from_email || '';
  return { kinds, rowState, unread, days, stale, sender };
}

// Whether GTD display surfaces apply to the current context.
// Unified (no account selected) → any account with GTD on; single account →
// that account's flag only.
export function gtdActiveForContext(accounts, selectedAccountId) {
  if (!Array.isArray(accounts) || accounts.length === 0) return false;
  if (selectedAccountId == null) return accounts.some(a => a?.gtd_enabled);
  const acct = accounts.find(a => a?.id === selectedAccountId);
  return !!acct?.gtd_enabled;
}

const EMPTY_SECTION = { total: 0, unread: 0, threads: [] };

function normSection(section) {
  if (!section) return EMPTY_SECTION;
  return {
    total: Number(section.total) || 0,
    unread: Number(section.unread) || 0,
    threads: Array.isArray(section.threads) ? section.threads : [],
  };
}

// Thread identity for deduping the merged Waiting view. The same thread labelled
// BOTH Watch and Delegated yields two heads (one per state) that must collapse to a
// single row. message_id is preferred (stable across accounts, matching the
// backend's cross-account dedupe), then the row id — no thread_key step, to match
// the backend's analogous dedupe (gtdSections.js: message_id || id).
function waitingIdentity(t) {
  return t.message_id || t.id;
}

const WAITING_KIND_ORDER = ['watch', 'delegated'];

// Merge the watch + delegated sections into one WAITING view. Heads are interleaved
// newest-first and deduped by thread identity: a thread in both folders becomes ONE
// row that carries both kinds (gtdKinds, ordered W then D), displays the newer head's
// date, and ages from the OLDER of its two waiting dates (agingDate — conservative,
// so the aging chip reflects the longest time actually waiting). Each surviving row
// also keeps a single gtdKind (its primary/first kind) for the left-border colour and
// snippet fallback.
//
// Counts: prefer the server's `waiting` rollup, which dedupes a both-labelled thread
// across the FULL watch ∪ delegated set — correct even when the overlap sits past the
// per-section head window this client holds. Only when that rollup is absent (a stale
// payload) do we fall back to deducing the dedupe from the visible heads: sum the two
// totals and subtract the collapses we can actually see, which drifts high once an
// overlap escapes the window.
export function mergeWaiting(watch, delegated, waiting) {
  const w = normSection(watch);
  const d = normSection(delegated);
  const tagged = [
    ...w.threads.map(t => ({ ...t, gtdKind: 'watch' })),
    ...d.threads.map(t => ({ ...t, gtdKind: 'delegated' })),
  ].sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));

  const byId = new Map();
  const order = [];
  let dupCount = 0;        // rows collapsed onto an existing thread
  let dupUnread = 0;       // of those, how many double-counted an unread thread (both copies unread)
  for (const row of tagged) {
    const key = waitingIdentity(row);
    const existing = byId.get(key);
    if (!existing) {
      // First-seen head is the newer one (tagged is newest-first): it owns display.
      byId.set(key, { ...row, gtdKinds: [row.gtdKind], agingDate: row.date });
      order.push(key);
      continue;
    }
    dupCount += 1;
    // The per-folder unread sums count each unread copy once, so a both-labelled thread is
    // over-counted only when BOTH its copies are unread — subtract exactly then. Any single
    // unread copy already yields the correct 1 (undoing this only for the older copy dropped
    // a newer-read + older-unread thread to 0).
    if (!row.is_read && !existing.is_read) dupUnread += 1;
    if (!existing.gtdKinds.includes(row.gtdKind)) existing.gtdKinds.push(row.gtdKind);
    // Age from the earlier of the two dates.
    if (row.date && (!existing.agingDate || new Date(row.date) < new Date(existing.agingDate))) {
      existing.agingDate = row.date;
    }
  }

  const threads = order.map(key => {
    const row = byId.get(key);
    row.gtdKinds.sort((a, b) => WAITING_KIND_ORDER.indexOf(a) - WAITING_KIND_ORDER.indexOf(b));
    row.gtdKind = row.gtdKinds[0];
    return row;
  });

  const rollup = waiting && typeof waiting === 'object' ? waiting : null;
  return {
    total: rollup ? Math.max(0, Number(rollup.total) || 0) : Math.max(0, w.total + d.total - dupCount),
    unread: rollup ? Math.max(0, Number(rollup.unread) || 0) : Math.max(0, w.unread + d.unread - dupUnread),
    threads,
  };
}

// Ordered GTD display sections with Waiting merged. Each entry:
// { key, total, unread, threads }.
export function buildGtdDisplaySections(sections) {
  const s = sections || {};
  const waiting = mergeWaiting(s.watch, s.delegated, s.waiting);
  const byKey = {
    todo: normSection(s.todo),
    waiting,
    reference: normSection(s.reference),
    someday: normSection(s.someday),
  };
  return GTD_DISPLAY_SECTION_ORDER.map(key => ({ key, ...byKey[key] }));
}

// Optimistically drop a thread's head from the given GTD state sections (after a
// done/delete/move so the GTD entry vanishes instantly; the gtd refetch reconciles the
// authoritative counts). identity is message_id||id; states are the backend section keys
// whose labels were removed (todo/watch/delegated/…). Also keeps the deduped Waiting
// rollup in step: a thread removed from watch and/or delegated adjusts sections.waiting
// ONCE (total -1; unread -1 if any removed waiting copy was unread) — because a thread in
// both folders is a single Waiting row — so the Waiting badge is correct instantly instead
// of only after the refetch. Returns the same sections reference when nothing changed, a
// new object otherwise; never mutates the input.
export function removeGtdThreadFromSections(sections, identity, states) {
  if (!sections || identity == null) return sections;
  const next = { ...sections };
  let changed = false;
  let waitingRemoved = false;   // present in watch and/or delegated → adjust rollup once
  let waitingUnread = false;    // any removed waiting copy was unread
  for (const key of states || []) {
    const sec = sections[key];
    if (!sec || !Array.isArray(sec.threads)) continue;
    let removed = 0, removedUnread = 0;
    const threads = sec.threads.filter(th => {
      if ((th.message_id || th.id) !== identity) return true;
      removed += 1;
      if (!th.is_read) removedUnread += 1;
      return false;
    });
    if (!removed) continue;
    changed = true;
    if (key === 'watch' || key === 'delegated') {
      waitingRemoved = true;
      if (removedUnread) waitingUnread = true;
    }
    next[key] = {
      total: Math.max(0, (Number(sec.total) || 0) - removed),
      unread: Math.max(0, (Number(sec.unread) || 0) - removedUnread),
      threads,
    };
  }
  if (waitingRemoved && sections.waiting && typeof sections.waiting === 'object') {
    next.waiting = {
      ...sections.waiting,
      total: Math.max(0, (Number(sections.waiting.total) || 0) - 1),
      unread: Math.max(0, (Number(sections.waiting.unread) || 0) - (waitingUnread ? 1 : 0)),
    };
  }
  return changed ? next : sections;
}

// Optimistically flip a section thread's read flag across every state it is labelled with
// (a merged Waiting row lives in both watch and delegated), so a GTD entry's bold/normal
// styling updates instantly on a mark-read/unread; the gtd refetch reconciles. Also nudges
// the deduped Waiting rollup's unread ONCE (a row in both watch and delegated flips the
// merged unread by one, not two); the rollup total is unaffected — the thread stays in
// Waiting, only its read styling changes. Returns the same sections reference when nothing
// changed, a new object otherwise; never mutates the input.
export function setGtdThreadReadInSections(sections, identity, isRead) {
  if (!sections || identity == null) return sections;
  const next = { ...sections };
  let changed = false;
  let waitingTouched = false;
  for (const [key, sec] of Object.entries(sections)) {
    if (!sec || !Array.isArray(sec.threads)) continue;
    let unreadDelta = 0, touched = false;
    const threads = sec.threads.map(th => {
      if ((th.message_id || th.id) !== identity || !!th.is_read === isRead) return th;
      touched = true;
      unreadDelta += isRead ? -1 : 1;
      return { ...th, is_read: isRead };
    });
    if (!touched) continue;
    changed = true;
    if (key === 'watch' || key === 'delegated') waitingTouched = true;
    next[key] = { ...sec, threads, unread: Math.max(0, (Number(sec.unread) || 0) + unreadDelta) };
  }
  if (waitingTouched && sections.waiting && typeof sections.waiting === 'object') {
    next.waiting = {
      ...sections.waiting,
      unread: Math.max(0, (Number(sections.waiting.unread) || 0) + (isRead ? -1 : 1)),
    };
  }
  return changed ? next : sections;
}

// Which message rows a GTD entry's read-toggle should act on. Section rows carry THREAD-LEVEL
// unread (a thread is unread while ANY copy is unread), which makes the two directions
// asymmetric:
//   - mark READ must reach every message in the thread: the head alone (plus the
//     server's same-message_id fan-out) misses a sibling reply that exists only in
//     INBOX, so the thread would stay unread and the refetch would revert the flip;
//   - mark UNREAD needs only the head copy — one unread copy already makes the thread
//     unread, and flipping every sibling would bold the whole thread in the inbox.
// getThread is injected (like openDeepLinkMessage) so the seam stays unit-testable.
// Degrades to the head id when the thread lookup fails or returns nothing: bulk-read
// still flips the head's copies and the gtd refetch re-shows any residual unread.
export async function collectThreadReadIds(thread, read, getThread) {
  if (!read || !getThread || !thread?.thread_key) return [thread.id];
  try {
    const { messages } = await getThread(thread.thread_key);
    const ids = (Array.isArray(messages) ? messages : []).map(m => m?.id).filter(Boolean);
    return ids.length ? ids : [thread.id];
  } catch {
    return [thread.id];
  }
}

export function scheduleGtdThreadAutoRead(thread, {
  markReadBehavior,
  markReadDelay,
  readThread,
  setTimer = setTimeout,
} = {}) {
  if (!thread || thread.is_read || markReadBehavior === 'manual') return null;
  if (markReadBehavior === 'delay') {
    const seconds = Math.max(1, Number(markReadDelay) || 1);
    return setTimer(() => readThread(thread, true), seconds * 1000);
  }
  readThread(thread, true);
  return null;
}

export async function openGtdThreadWithAutoRead(thread, {
  openThread,
  isCancelled,
  getPreferences,
  readThread,
  setTimer,
  publishTimer,
}) {
  const message = await openThread();
  if (!message || isCancelled()) return null;
  const { markReadBehavior, markReadDelay } = getPreferences();
  const timerHandle = scheduleGtdThreadAutoRead(thread, {
    markReadBehavior,
    markReadDelay,
    readThread,
    setTimer,
  });
  publishTimer(timerHandle);
  return timerHandle;
}

export function sectionBadge(count) {
  const n = Number(count) || 0;
  if (n <= 0) return '';
  return n > 99 ? '99+' : String(n);
}

// Whether a list row is the currently selected message. Matches across the multi-folder
// model, where one message's INBOX copy and its label-folder copy are distinct DB rows (each
// with its own id) that share an RFC message_id: so a GTD entry and the inbox row for the same
// email highlight together even though their ids differ. Prefers message_id when BOTH the row
// and the selection carry one — never matches two null/absent message_ids — and otherwise
// falls back to exact id equality, which is all a single-copy account (or a row/selection
// without a message_id) ever needs. Pure and unit-testable.
export function isSelectedRow(row, selectedId, selectedMid) {
  if (!row) return false;
  if (selectedMid != null && row.message_id != null && row.message_id === selectedMid) return true;
  return row.id != null && row.id === selectedId;
}

// Choose which message of a thread a deep-link should open, given the thread's rows and
// the head's RFC message_id. Prefers the row whose message_id matches — that identity is
// stable across a purge+reinsert, whereas the row PK is not — then the newest row, then
// the first. Rows without an id (nothing to open) are ignored. Pure and unit-testable.
export function pickThreadMessage(messages, messageId) {
  const list = Array.isArray(messages) ? messages.filter(m => m && m.id) : [];
  if (list.length === 0) return null;
  const byMid = messageId && list.find(m => m.message_id === messageId);
  if (byMid) return byMid;
  return list.reduce((newest, m) =>
    (new Date(m.date || 0) >= new Date(newest.date || 0) ? m : newest), list[0]);
}

// Classify (add a state label) / unclassify (strip one) a message. Classify COPIES into
// the state's label folder; the message stays put (no optimistic removal/undo — it does
// not leave INBOX), so both just fire the API call and poke the GTD sections store to reconverge
// instead of waiting on the WS event. Deps injected (like openDeepLinkMessage) so the call
// is unit-testable; mirrors the GTD display callers' classify/remove handlers.
export async function classifyThread(id, state, { gtdClassify, addNotification, scheduleGtdSectionsFetch, t }) {
  try {
    await gtdClassify(id, state);
    scheduleGtdSectionsFetch();
    addNotification({ title: t('gtd.classified'), body: t(`gtd.state.${state}`) });
  } catch (err) {
    console.error('GTD classify failed:', err.message);
    addNotification({ title: t('gtd.classifyFailed'), body: t(`gtd.state.${state}`) });
  }
}

export async function unclassifyThread(id, state, { gtdUnclassify, addNotification, scheduleGtdSectionsFetch, t }) {
  try {
    await gtdUnclassify(id, state);
    scheduleGtdSectionsFetch();
    addNotification({ title: t('gtd.removed'), body: t(`gtd.state.${state}`) });
  } catch (err) {
    console.error('GTD unclassify failed:', err.message);
    addNotification({ title: t('gtd.removeFailed'), body: t(`gtd.state.${state}`) });
  }
}

// Monotonic click token. Each openDeepLinkMessage call claims the next value on entry
// and re-checks it before any state write; a call whose token has been superseded by a
// newer click drops its write and returns null. Because both GTD display surfaces import
// this module, the counter serialises clicks across them — the latest
// click always wins the reading pane even when a slow fetch resolves out of order.
let _deepLinkSeq = 0;

// Open an out-of-list message in the reading pane WITHOUT switching folders, using the
// deep-link stash pattern (MailApp's __dl_ threadMessages). Kept pure (deps injected) so
// the sequence is unit-testable; a naive setSelectedMessage on an out-of-list id renders a
// blank pane.
//
// The head's row id (a random PK) can go stale between the sections snapshot and the click:
// its INBOX/label copy may be archived or purged+re-inserted with a fresh id during a
// resync. A click that lands on a falsy or 404'd id must never silently do nothing — it
// warns, self-heals the snapshot via onMiss (a sections refetch), and retries once by
// resolving the row's thread and matching the stable message_id. thread/getThread/onMiss
// are optional so a bare (id, {getMessage,...}) call still degrades gracefully.
export async function openDeepLinkMessage(id, {
  getMessage, setThreadMessages, setSelectedMessage,
  thread, getThread, onMiss,
} = {}) {
  const seq = ++_deepLinkSeq;
  const open = (msg) => {
    // A newer click superseded this one while we awaited the fetch — losing the race is
    // not an error, so drop the stale write silently (no warn). Guards every state write,
    // including the recovery path below.
    if (seq !== _deepLinkSeq) return null;
    setThreadMessages(`__dl_${msg.id}`, [msg]);
    setSelectedMessage(msg.id);
    return msg;
  };

  if (id) {
    try {
      const msg = await getMessage(id);
      if (msg) return open(msg);
    } catch {
      // Fall through to recovery — a 404 here means the snapshot id is stale.
    }
  }

  console.warn(`GTD deep-link miss (id=${id ?? 'null'}, thread_key=${thread?.thread_key ?? 'null'}); refetching sections`);
  onMiss?.();

  if (getThread && thread?.thread_key) {
    try {
      const { messages } = await getThread(thread.thread_key);
      const msg = pickThreadMessage(messages, thread.message_id);
      if (msg) return open(msg);
    } catch {
      // Best-effort; the onMiss refetch still refreshes the ids for the next click.
    }
  }
  return null;
}

// Frame math for the Inbox-Zero pet sprite. Given a cached pet's descriptor
// (grid + frame size + static frame + hover sequence) and a target render size,
// return the pixel layout the GtdZeroPet CSS needs: the scaled frame size, the full
// background-size, the at-rest static frame position, and the horizontal hover run
// (background-position-x from → to over `hoverCount` steps, on a single row).
// Pure and DOM-free so the frame math is unit-testable.
export function computeSpriteLayout({ cols, rows, frameW, frameH, staticFrame = 0, hover, size = 104 } = {}) {
  const c = Math.max(1, Math.trunc(cols) || 1);
  const r = Math.max(1, Math.trunc(rows) || 1);
  const fw = frameW > 0 ? frameW : 1;
  const fh = frameH > 0 ? frameH : 1;
  const scale = size / Math.max(fw, fh);
  const dispW = fw * scale;
  const dispH = fh * scale;
  const frameCount = c * r;

  const sf = Math.max(0, Math.min(frameCount - 1, Math.trunc(staticFrame) || 0));
  const staticX = -((sf % c) * dispW);
  const staticY = -(Math.floor(sf / c) * dispH);

  const hStart = Math.max(0, Math.min(frameCount - 1, Math.trunc(hover?.start ?? 0) || 0));
  const hRow = Math.floor(hStart / c);
  const hCol = hStart % c;
  // Clamp the sequence to the rest of its row — the CSS animates only
  // background-position-x, so a hover loop lives on one row.
  const hCount = Math.max(1, Math.min(Math.trunc(hover?.count ?? c) || c, c - hCol));

  // Normalise -0 (from -(0 * …)) to 0 so it never reaches the CSS as "-0px".
  const nz = (v) => (v === 0 ? 0 : v);

  return {
    dispW, dispH,
    bgW: c * dispW,
    bgH: r * dispH,
    staticX: nz(staticX), staticY: nz(staticY),
    hoverY: nz(-(hRow * dispH)),
    hoverX0: nz(-(hCol * dispW)),
    hoverX1: nz(-((hCol + hCount) * dispW)),
    hoverCount: hCount,
  };
}
