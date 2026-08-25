import {
  summarizeMessage,
  summarizeAvailable,
  getMessageFields,
  validateMessageFieldsSnapshot,
  getMessageAnnotations,
  setMessageAnnotationForSnapshot,
} from '../api.js';

// AI-condensed one-line gist for GTD "waiting" entries. The client shows the raw
// message snippet by default; when a gist has been generated for a waiting thread's
// head it is shown instead. Generation is lazy and bounded:
//
//   - triggered only by a sections fetch that returns waiting heads lacking a gist,
//     and only when an AI provider is configured (never at ingest — cost control);
//   - at most GIST_CONCURRENCY AI calls in flight per account, capped per invocation;
//   - one gtd_sections_updated broadcast per account once its batch writes ≥1 gist,
//     so clients receive the gist on the next refetch with no spinner.
//
// The prompt-building / output-sanitising / provider mechanics now live in the generic
// `summarize` capability (summarizeMessage/summarizeAvailable); this module keeps only the
// GTD-specific orchestration — which states carry a gist, the gtd_gist column, the bounded
// per-account batch, and the section-refresh broadcast.

const GIST_CONCURRENCY = 2;
// Per-account, per-invocation cap. Concurrency already rate-limits load; this bounds
// a pathological first-load burst (a section is capped at 50 heads). Any remainder is
// picked up on the next refetch (each completed batch broadcasts an update).
const MAX_GISTS_PER_ACCOUNT = 20;

// Only "waiting" states carry a gist (the Watch/Delegated entry's last line).
const GIST_STATES = ['watch', 'delegated'];

// Pick the waiting heads that still need a gist from a sections payload. Pure and
// DB-free so "no candidates" and "no provider" can short-circuit before any query.
// Returns [{ id, account_id }] deduped by id.
export function selectGistCandidates(sections) {
  const out = [];
  const seen = new Set();
  for (const state of GIST_STATES) {
    const threads = sections?.[state]?.threads;
    if (!Array.isArray(threads)) continue;
    for (const h of threads) {
      if (!h || !h.id || h.account_id == null) continue;
      if (h.gist != null && h.gist !== '') continue;
      if (seen.has(h.id)) continue;
      seen.add(h.id);
      out.push({ id: h.id, account_id: h.account_id });
    }
  }
  return out;
}

// Bounded-concurrency runner: at most `limit` workers in flight over `items`.
async function runPool(items, limit, worker) {
  let idx = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      await worker(items[i]);
    }
  });
  await Promise.all(runners);
}

// Guards against two overlapping sections fetches queueing the same message twice.
const _inFlight = new Set();

async function generateForAccount(accountId, ids) {
  // Skip ids that already carry a cached gist (belt-and-suspenders over the sections-side filter,
  // so a head that got a gist since the sections snapshot isn't regenerated / doesn't re-broadcast).
  const existing = await getMessageAnnotations(accountId, ids, 'gtd');
  const need = ids.filter((id) => !existing[id]?.gist);
  if (!need.length) return 0;

  const rows = await getMessageFields(accountId, need);
  let wrote = 0;
  await runPool(rows, GIST_CONCURRENCY, async (row) => {
    if (!await validateMessageFieldsSnapshot(accountId, row)) return;
    const gist = await summarizeMessage({
      subject: row.subject,
      from: row.from_name || row.from_email,
      content: row.content,
    });
    if (!gist) return;
    if (!await validateMessageFieldsSnapshot(accountId, row)) return;
    // Store under GTD's annotation namespace on the message (cleaned with the message on delete).
    const n = await setMessageAnnotationForSnapshot(accountId, row, 'gtd', { gist });
    if (n > 0) wrote++;
  });
  return wrote;
}

// Lazily generate gists for the waiting heads in a sections payload. Fire-and-forget
// from the sections route — never blocks the response. Short-circuits (no queries)
// when there are no candidates or no provider is configured.
export async function queueGistGeneration({ sections, userId, broadcast } = {}) {
  const candidates = selectGistCandidates(sections).filter(c => !_inFlight.has(c.id));
  if (!candidates.length) return;

  // Reserve the ids synchronously — before the first await — so a second sections
  // fetch that overlaps our provider load can't slip the same heads past the filter
  // above and regenerate them. `reserved` tracks the ids we still own; each is dropped
  // from it as its account batch finishes (releasing that id below), and the finally
  // releases whatever is left — ids trimmed by the per-account cap, or all of them if
  // the provider load throws — so a reservation never leaks.
  candidates.forEach(c => _inFlight.add(c.id));
  const reserved = new Set(candidates.map(c => c.id));

  try {
    if (!await summarizeAvailable()) return;

    const byAccount = new Map();
    for (const c of candidates) {
      if (!byAccount.has(c.account_id)) byAccount.set(c.account_id, []);
      const ids = byAccount.get(c.account_id);
      if (ids.length < MAX_GISTS_PER_ACCOUNT) ids.push(c.id);
    }

    for (const [accountId, ids] of byAccount) {
      let wrote = 0;
      try {
        wrote = await generateForAccount(accountId, ids);
      } catch (err) {
        console.warn(`GTD gist generation failed for account ${accountId}:`, err.message);
      } finally {
        // Release this batch's ids as soon as it settles (existing per-account
        // semantics), and stop tracking them so the outer finally can't later delete
        // a reservation a fresh overlapping call may by then have re-taken. Both
        // deletes must stay in one synchronous statement: an await between them
        // would reopen the window where an overlapping call re-reserves an id our
        // outer finally then wrongly releases.
        ids.forEach(id => { _inFlight.delete(id); reserved.delete(id); });
      }
      if (wrote > 0 && typeof broadcast === 'function') {
        broadcast({ type: 'gtd_sections_updated', accountId }, userId);
      }
    }
  } finally {
    reserved.forEach(id => _inFlight.delete(id));
  }
}
