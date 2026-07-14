import { query } from './db.js';
import { decrypt } from './encryption.js';

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
// The pure pieces (prompt building, output sanitising, candidate selection) are
// exported and unit-tested; the DB/AI/broadcast orchestration reuses the same
// OpenAI-compatible provider plumbing as categorizer.aiClassifyMessage.

const GIST_CONCURRENCY = 2;
// Per-account, per-invocation cap. Concurrency already rate-limits load; this bounds
// a pathological first-load burst (a section is capped at 50 heads). Any remainder is
// picked up on the next refetch (each completed batch broadcasts an update).
const MAX_GISTS_PER_ACCOUNT = 20;
const GIST_MAX_LEN = 120;

// Only "waiting" states carry a gist (the Watch/Delegated entry's last line).
const GIST_STATES = ['watch', 'delegated'];

// Build the one-line-gist prompt for a message. Pure — the load-bearing decision
// (what we ask the model for) is unit-testable without a provider.
export function buildGistPrompt({ subject, from, content } = {}) {
  const body = (content || '').replace(/\s+/g, ' ').trim().slice(0, 1000);
  return `Condense this email into ONE line of at most ${GIST_MAX_LEN} characters.
Rules: plain text only, no quotation marks, no emoji, present tense. Capture what the sender said and what happens next. Reply with only the line, nothing else.

From: ${from || '(unknown)'}
Subject: ${(subject || '').slice(0, 200)}
Body: ${body}`;
}

// Strip emoji ("no emoji" rule) while leaving accented letters and CJK intact so
// non-English gists survive: pictographs + regional-indicator flags via Unicode
// property escapes, then the zero-width joiner / variation selectors / keycap
// combiner that stitch emoji sequences together (removed with single-char escapes —
// a character class of combining chars trips no-misleading-character-class).
function stripEmoji(s) {
  return s
    .replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}]/gu, '')
    .replace(/‍/g, '')  // zero-width joiner
    .replace(/︎/g, '')  // variation selector-15 (text)
    .replace(/️/g, '')  // variation selector-16 (emoji)
    .replace(/⃣/g, ''); // combining enclosing keycap
}

// Sanitise a model response into a single clean ≤120-char line, or null when the
// output is unusable. Pure. Takes the first non-empty line, strips wrapping quotes
// and emoji, collapses whitespace, and hard-caps the length.
export function sanitizeGist(raw) {
  if (typeof raw !== 'string') return null;
  let s = (raw.split(/\r?\n/).map(l => l.trim()).find(l => l.length > 0) || '');
  s = s.replace(/^["'“”‘’`]+/, '').replace(/["'“”‘’`]+$/, '');
  s = stripEmoji(s);
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) return null;
  if (s.length > GIST_MAX_LEN) s = s.slice(0, GIST_MAX_LEN).trim();
  return s || null;
}

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

// Load the OpenAI-compatible provider config, gated on the summarize feature.
// Returns { baseUrl, model, apiKey } or null when the provider is unavailable —
// the seam that guarantees zero generation work when no provider is configured.
async function loadGistProvider() {
  const cfgResult = await query("SELECT value FROM system_settings WHERE key = 'ai_config'").catch(() => null);
  if (!cfgResult?.rows?.length) return null;
  let cfg;
  try { cfg = JSON.parse(cfgResult.rows[0].value); } catch { return null; }
  if (!cfg.enabled || !cfg.baseUrl || !cfg.model) return null;
  // The gist is a summarisation feature; respect the admin toggle if present.
  if (cfg.features && cfg.features.summarize === false) return null;
  return { baseUrl: cfg.baseUrl, model: cfg.model, apiKey: cfg.apiKey ? decrypt(cfg.apiKey) : null };
}

async function callGistProvider(provider, prompt) {
  const headers = { 'Content-Type': 'application/json' };
  if (provider.apiKey) headers['Authorization'] = `Bearer ${provider.apiKey}`;
  try {
    // Trust boundary: intentionally plain fetch, NOT safeFetch — the AI base URL is
    // admin-configured and legitimately internal (e.g. a LAN/Tailscale Ollama), which
    // the private-host guard would block. Validated when saved via the admin AI routes.
    const res = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: provider.model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 120,
        stream: false,
        think: false,
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return sanitizeGist(data.choices?.[0]?.message?.content || '');
  } catch {
    return null;
  }
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

async function generateForAccount(accountId, ids, provider) {
  const { rows } = await query(
    `SELECT id, subject, from_name, from_email,
            COALESCE(NULLIF(body_text, ''), snippet) AS content
     FROM messages
     WHERE id = ANY($1::uuid[]) AND account_id = $2 AND gtd_gist IS NULL`,
    [ids, accountId]
  );
  let wrote = 0;
  await runPool(rows, GIST_CONCURRENCY, async (row) => {
    const gist = await callGistProvider(provider, buildGistPrompt({
      subject: row.subject,
      from: row.from_name || row.from_email,
      content: row.content,
    }));
    if (!gist) return;
    // Re-check NULL so a newer head that raced in isn't clobbered.
    const res = await query(
      'UPDATE messages SET gtd_gist = $1 WHERE id = $2 AND gtd_gist IS NULL',
      [gist, row.id]
    );
    if (res.rowCount > 0) wrote++;
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
    const provider = await loadGistProvider();
    if (!provider) return;

    const byAccount = new Map();
    for (const c of candidates) {
      if (!byAccount.has(c.account_id)) byAccount.set(c.account_id, []);
      const ids = byAccount.get(c.account_id);
      if (ids.length < MAX_GISTS_PER_ACCOUNT) ids.push(c.id);
    }

    for (const [accountId, ids] of byAccount) {
      let wrote = 0;
      try {
        wrote = await generateForAccount(accountId, ids, provider);
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
