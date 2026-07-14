import { ImapFlow } from 'imapflow';
import { query } from './db.js';
import { parseMessage, snippetFromBody, detectBulkFromParsedHeaders, parseHeadersInput, headersToRawString, decodeMimeWords, enrichParsedMetadata } from './messageParser.js';
import { classifyMessage, loadSocialDomains, getGlobalCategorizationEnabled } from './categorizer.js';
import { getGtdFolderSet, getGtdConfig, gtdTickFolders } from './gtdConfig.js';
import { runGtdTransitions, threadKeysForMessageIds, threadKeysInFolders } from './gtdTransitions.js';
import { refreshMicrosoftToken } from '../routes/oauth.js';
import { sanitizeEmail } from './emailSanitizer.js';
import { logger } from './logger.js';
import { decrypt } from './encryption.js';
import { sendPushToUser } from './pushNotifications.js';
import { redactEmail } from '../utils/redact.js';
import { adjustFolderCounts } from '../utils/mailUtils.js';
import { resolveForConnection } from './hostValidation.js';
import { getConnectionPolicy } from './connectionPolicy.js';
import { applyInboxRules, applyBlockList } from './inboxRules.js';
import { generateVCard } from '../utils/vcard.js';
import { randomUUID } from 'crypto';


// Shorthand for log lines — keeps domain visible while masking the local part.
const logAccount = (account) => redactEmail(account?.email_address || '');

// Resolves the IMAP host for an account, applying server-level connection policy.
// Returns { resolved, policy } so callers can pass policy to makeClientCfg.
const resolveAccountHost = async (account) => {
  const policy = await getConnectionPolicy();
  const resolved = await resolveForConnection(account.imap_host, { allowPrivate: policy.allowPrivateHosts });
  return { resolved, policy };
};

// Race a promise against a timeout. On timeout the underlying promise keeps running (JS
// can't cancel it) but its result is ignored, so use this only for steps that hold no
// resource needing explicit teardown (token refresh, DNS resolution) — an abandoned
// pending promise is then harmless. Prevents a single hung network step from wedging a
// sequential loop whose re-entrancy guard would otherwise never reset.
function raceTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timeout (${ms}ms)`)), ms)),
  ]);
}

// A per-key counting semaphore: at most `limit` holders per key run concurrently; the rest
// await FIFO until a holder releases. Used to cap concurrent IMAP backfills per provider
// host so a user with many accounts on one provider doesn't open a backfill connection for
// every account at once (which trips per-IP/per-account connection limits, bans, locks).
// Every acquire() MUST be paired with exactly one release(key) in a finally.
export function createKeyedSemaphore(limit) {
  const slots = new Map(); // key -> { active: number, waiters: (() => void)[] }
  return {
    async acquire(key) {
      let s = slots.get(key);
      if (!s) { s = { active: 0, waiters: [] }; slots.set(key, s); }
      if (s.active < limit) { s.active++; return; }
      // At capacity — wait to be handed a slot by a future release (active is not
      // incremented here; release hands its own slot over without changing the count).
      await new Promise(resolve => s.waiters.push(resolve));
    },
    release(key) {
      const s = slots.get(key);
      if (!s) return;
      const next = s.waiters.shift();
      if (next) {
        next(); // hand this slot directly to the next waiter — active count unchanged
      } else {
        s.active = Math.max(0, s.active - 1);
        if (s.active === 0) slots.delete(key); // no holders, no waiters — drop the entry
      }
    },
    activeCount(key) { return slots.get(key)?.active || 0; },
    waitingCount(key) { return slots.get(key)?.waiters.length || 0; },
  };
}

// Max concurrent full backfills per provider host. Small so a many-account-on-one-provider
// user stays well under connection limits; backfill is background catch-up, so serialising
// it is safe. Other providers/accounts are unaffected (the semaphore is keyed by host).
const BACKFILL_MAX_PER_HOST = 2;

// Connection-refusal cooldown. When a provider refuses a NEW connection (per-IP/per-account
// limit, "try again later", temporary lock, throttling), back that account off with growing
// delay instead of retrying it every health-check tick — repeated refusals are exactly what
// escalate a provider to IP bans / account locks. Cleared the moment the account connects.
const CONNECT_COOLDOWN_BASE_MS = 30 * 1000;      // first refusal ≈ 30s
const CONNECT_COOLDOWN_MAX_MS = 15 * 60 * 1000;  // capped at 15 min

// True when an IMAP error looks like a connection-limit / throttle / temporary refusal —
// the class of failure that should back off rather than retry hard. Deliberately broad on
// the safe side: a false positive only means a ~30s backoff, never data loss.
export function isConnectionRefusal(detail) {
  return /connection not available|too many|maximum number|number of connections|rate.?limit|temporarily|try again|connection limit|over quota|throttl/i.test(String(detail || ''));
}

// Exponential backoff for consecutive connection refusals: 30s, 60s, 120s, 240s, 480s, …
// capped at CONNECT_COOLDOWN_MAX_MS.
export function connectCooldownMs(failures) {
  const n = Math.max(1, failures);
  return Math.min(CONNECT_COOLDOWN_BASE_MS * (2 ** Math.min(n - 1, 5)), CONNECT_COOLDOWN_MAX_MS);
}

// Decide a folder's sync fetch strategy from its CONDSTORE modseq state. Pure and total so
// it can be exhaustively unit-tested — it is the load-bearing correctness decision for delta
// sync. Returns one of:
//   'unchanged' — server HIGHESTMODSEQ equals our stored watermark: nothing changed, skip fetch.
//   'delta'     — modseq advanced: one CHANGEDSINCE fetch returns every new message AND flag
//                 change since the watermark (strictly more complete than the UID/seq phases).
//   'full'      — no usable baseline (first sync, UIDVALIDITY reset, or a server without
//                 CONDSTORE): run the legacy UID-watermark + sequence phases and re-seed.
// modseq values are 64-bit unsigned and only comparable within one UIDVALIDITY epoch — inputs
// may be BigInt, decimal string, or null; comparison is done in BigInt to avoid Number()
// precision loss above 2^53. NEVER compare these as JS Numbers.
export function planModseqSync({ storedModseq, serverModseq, uidValidityChanged }) {
  if (uidValidityChanged) return 'full';    // epoch reset — the stored modseq is meaningless now
  if (serverModseq == null) return 'full';  // server didn't advertise CONDSTORE HIGHESTMODSEQ
  if (storedModseq == null) return 'full';  // no baseline yet — full sync seeds the watermark
  return BigInt(storedModseq) === BigInt(serverModseq) ? 'unchanged' : 'delta';
}

// Body parts that cover ~99% of real-world email structures (used for full body caching)
const BODY_PREFETCH_PARTS = ['1', '1.1', '1.2', '2', '2.1', '2.2', '1.1.1', '1.2.1'];

// The flag-change scan in syncMessages gets its OWN budget, shorter than the whole-sync
// wall-clock. When a provider throttles the connection (iCloud right after a startup backfill
// burst), the flag scan crawls — but new mail was already caught by the UID phase, so a slow
// flag scan must not burn the full sync budget and force a reconnect (which piles another
// connection onto the throttled account and feeds the churn). Instead it defers to the next
// tick WITHOUT advancing the modseq watermark, so no flag change is lost. The sentinel is
// resolved (not thrown) by the race so it's never confused with a real fetch error.
const FLAG_SCAN_TIMEOUT_MS = 20000;
const FLAG_SCAN_TIMED_OUT = Symbol('flagScanTimedOut');

// Upper bound on how far back the delta flag scan looks. iCloud advertises CONDSTORE (so we take
// the delta path) but IGNORES the changedSince fetch modifier — it returns EVERY message in the
// requested range. Since the scan only pulls uid+flags (cheap), this window mainly caps that
// worst case so a huge mailbox doesn't fetch tens of thousands of records per tick. Recent
// messages are the ones whose flags change, and the reactive IDLE flag path (_syncFlagsForRange)
// already covers live read/star events, so the window is a generous backstop. A flag change on a
// message older than this window won't be caught by the periodic scan, but that gap already
// exists (the IDLE path only looks at the last 200) and matters only for cross-device changes to
// very old mail. Servers that honor changedSince (PurelyMail, Gmail) return only what changed
// regardless of the window.
const DELTA_SCAN_UID_WINDOW = 5000;

// How long (ms) user must be idle before background IMAP jobs (snippet indexer, folder
// body prefetch) resume after a live body fetch. Keeps click-time fetches snappy by
// deprioritising background traffic whenever the user is actively reading mail.
const QUIET_WINDOW_MS = 8000;

// How often (ms) to sync a gtd_enabled account's designated label folders. Only INBOX
// gets IDLE + the fast periodic tick; GTD label folders otherwise sync on open only, so
// this slower tick keeps the non-INBOX GTD sections (Todo/Watch/…) fresh in the
// background. Slower than the INBOX interval on purpose — label folders change far less.
const GTD_SYNC_INTERVAL_MS = 120000;

// Circuit-breaker backoff for the snippet indexer. When a run indexes nothing because
// the provider keeps refusing the extra connection (e.g. iCloud's cap on simultaneous
// IMAP connections per account), skip that account for an exponentially growing window
// instead of letting the 10-minute scheduler reopen competing connections every tick —
// which starves live click-time body fetches. Base 10 min, doubling, capped at 2 h;
// any real indexing progress clears the backoff so a recovered account resumes promptly.
const SNIPPET_BACKOFF_BASE_MS = 10 * 60 * 1000;
const SNIPPET_BACKOFF_MAX_MS = 2 * 60 * 60 * 1000;

// A connected account that hasn't completed a successful sync tick in this long is
// likely on a stale/half-open connection — the socket is alive so it passes the
// presence-only health check and never gets reconnected. Well above the max 120s sync
// interval so it only fires on a genuine stall. Logged for diagnosis; auto-recovery is
// deliberately deferred until the mechanism is confirmed from these logs.
const STALE_SYNC_WARN_MS = 5 * 60 * 1000;

// How often to actively probe each connected account for a "deaf" sync connection —
// one that still passes commands but has stopped reflecting new mail (the ~60-min
// delay we observed). A fresh connection's UID SEARCH is authoritative; if the server
// holds any UID above our highest synced UID, the persistent connection missed new mail
// and is force-reconnected. Accounts are probed sequentially, so worst-case new-mail
// latency is ~this interval only when providers respond promptly; several simultaneously
// unreachable servers can serialize-delay later accounts within a cycle.
const STALENESS_CHECK_MS = 3 * 60 * 1000;

// A sync tick that has been running longer than this is "hung" (half-open connection) —
// a normal INBOX sync fetches 20 messages, envelope/flags only, and completes in a few
// seconds. The staleness check uses this to tell a HEALTHY in-flight sync (started
// recently, about to commit — leave it alone) from a HUNG one that has pinned the
// account's sync lock and must be torn down so a fresh reconnect can catch up. Generous
// enough (30s) that a merely-slow-but-progressing sync is not misread as hung, yet well
// below the 55s sync wall-clock so recovery beats the slow timeout-then-reconnect self-heal.
const SYNC_HUNG_MS = 30 * 1000;

// Durable flag push. A read/star change is written to the DB and pushed to IMAP
// immediately; if that push fails (deaf/half-open pool connection, provider blip) the
// message is queued here and re-pushed every cycle until the server confirms — otherwise
// a later flag-sync PULL would silently revert the user's change. The cycle interval MUST
// stay below the 30s read_changed_at/star_changed_at "local wins" window: each cycle
// re-bumps the marker so that window never lapses while a push is still outstanding, which
// is why we don't need to touch the three pull-sync guards. Give up (clear the marker so
// the server's truth can show through) after MAX_ATTEMPTS connected failures.
const FLAG_PUSH_RECONCILE_MS = 15 * 1000;
const FLAG_PUSH_MAX_ATTEMPTS = 40;   // ~10 min of connected retries before honest revert
const FLAG_PUSH_PER_CYCLE = 30;      // cap setFlag attempts per account per cycle (bounds cycle time)

// Unicode bidi override/embedding characters that can visually reverse a filename,
// making "malware.exe" display as "malware.pdf" to the user.
// U+202A-U+202E: LRE, RLE, PDF, LRO, RLO
// U+2066-U+2069: LRI, RLI, FSI, PDI
// U+200F: RTL mark  U+061C: Arabic letter mark
const BIDI_OVERRIDE_RE = new RegExp(
  [...Array.from({ length: 5 }, (_, i) => String.fromCodePoint(0x202A + i)),
   ...Array.from({ length: 4 }, (_, i) => String.fromCodePoint(0x2066 + i)),
   String.fromCodePoint(0x200F),
   String.fromCodePoint(0x061C),
  ].join(''),
  'g'
);

// Extract html/text/attachments from an already-fetched msg (no extra IMAP round-trip)
function extractBodyFromMsg(msg) {
  if (!msg.bodyStructure) return { html: null, text: null, attachments: [] };
  const results = { textParts: [], attachments: [] };
  walkStructure(msg.bodyStructure, results);
  if (results.textParts.length === 0) {
    const rootType = (msg.bodyStructure.type || '').toLowerCase();
    results.textParts.push({
      part: msg.bodyStructure.part || '1',
      type: (rootType === 'text/html' || rootType === 'text/plain') ? rootType : 'text/plain',
      encoding: msg.bodyStructure.encoding || '',
    });
  }
  let html = null, text = null;
  for (const part of results.textParts) {
    const buf = msg.bodyParts?.get(part.part);
    if (!buf) continue;
    const decoded = decodeBody(buf, part.encoding, part.charset);
    if (part.type === 'text/html' && !html) html = decoded;
    else if (part.type === 'text/plain' && !text) text = decoded;
  }
  return { html, text, attachments: results.attachments };
}

// Decode a MIME body part from its raw Buffer.
//
// encoding: transfer encoding (quoted-printable, base64, 7bit, 8bit, binary)
// charset:  character set from Content-Type (utf-8, windows-1252, iso-8859-1, …)
//
// Key invariant: we work with Buffers of raw bytes until the very last step so
// that multi-byte sequences (e.g. =E2=80=94 → em-dash in UTF-8) are reassembled
// correctly before being interpreted as any character set.
function decodeBody(buf, encoding, charset) {
  const enc = (encoding || '').toLowerCase();
  // Normalise charset — TextDecoder knows aliases like 'latin-1', but strip quotes
  // that some mailers wrap around the value (charset="utf-8").
  let cs = (charset || 'utf-8').toLowerCase().trim().replace(/^['"]|['"]$/g, '');
  if (!cs || cs === 'us-ascii' || cs === 'ascii') cs = 'utf-8'; // ASCII ⊂ UTF-8

  let rawBytes;
  if (enc === 'base64') {
    // base64 payload is 7-bit ASCII so toString('ascii') is safe here
    const b64 = (Buffer.isBuffer(buf) ? buf : Buffer.from(buf)).toString('ascii').replace(/\s/g, '');
    try { rawBytes = Buffer.from(b64, 'base64'); } catch { rawBytes = buf; }
  } else if (enc === 'quoted-printable') {
    const qpStr = (Buffer.isBuffer(buf) ? buf : Buffer.from(buf)).toString('ascii');
    const cleaned = qpStr.replace(/=\r\n/g, '').replace(/=\n/g, '');
    const bytes = [];
    let i = 0;
    while (i < cleaned.length) {
      if (cleaned[i] === '=' && i + 2 < cleaned.length) {
        const hex = cleaned.slice(i + 1, i + 3);
        if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
          bytes.push(parseInt(hex, 16));
          i += 3;
          continue;
        }
      }
      bytes.push(cleaned.charCodeAt(i) & 0xFF);
      i++;
    }
    rawBytes = Buffer.from(bytes);
  } else {
    // 7bit / 8bit / binary — the buffer already holds the raw content bytes
    rawBytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  }

  // TextDecoder handles utf-8, iso-8859-*, windows-125*, koi8-r, big5, etc.
  // fatal:false replaces unrecognised bytes with U+FFFD rather than throwing.
  try {
    return new TextDecoder(cs, { fatal: false }).decode(rawBytes);
  } catch {
    return rawBytes.toString('utf8'); // unknown charset — best effort
  }
}

function decodeAttachmentBuffer(buf, encoding) {
  const enc = (encoding || '').toLowerCase();
  if (enc === 'base64') {
    return Buffer.from(buf.toString('utf8').replace(/\s/g, ''), 'base64');
  }
  if (enc === 'quoted-printable') {
    const qpStr = buf.toString('ascii');
    const cleaned = qpStr.replace(/=\r\n/g, '').replace(/=\n/g, '');
    const bytes = [];
    let i = 0;
    while (i < cleaned.length) {
      if (cleaned[i] === '=' && i + 2 < cleaned.length) {
        const hex = cleaned.slice(i + 1, i + 3);
        if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
          bytes.push(parseInt(hex, 16));
          i += 3;
          continue;
        }
      }
      bytes.push(cleaned.charCodeAt(i) & 0xFF);
      i++;
    }
    return Buffer.from(bytes);
  }
  // 7bit / 8bit / binary — raw bytes, no decoding needed
  return Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
}

function walkStructure(node, results) {
  if (!node) return;
  const type = (node.type || '').toLowerCase();
  if (node.childNodes && node.childNodes.length > 0) {
    for (const child of node.childNodes) walkStructure(child, results);
    return;
  }
  const disposition = (node.disposition || '').toLowerCase();
  const rawFilename = node.dispositionParameters?.filename || node.parameters?.name || null;
  const filename = rawFilename ? rawFilename.replace(BIDI_OVERRIDE_RE, '').trim() || 'attachment' : null;
  if (type === 'text/html') {
    results.textParts.push({
      part: node.part || '1', type,
      encoding: node.encoding || '',
      charset: node.parameters?.charset || 'utf-8',
    });
  } else if (type === 'application/xhtml+xml') {
    results.textParts.push({
      part: node.part || '1', type: 'text/html',
      encoding: node.encoding || '',
      charset: node.parameters?.charset || 'utf-8',
    });
  } else if (type === 'text/plain') {
    results.textParts.push({
      part: node.part || '1', type,
      encoding: node.encoding || '',
      charset: node.parameters?.charset || 'utf-8',
    });
  } else if (type.startsWith('image/') && node.id && disposition !== 'attachment') {
    // Inline image referenced via cid: in the HTML body
    results.inlineImages = results.inlineImages || [];
    results.inlineImages.push({
      part: node.part || '1',
      type: node.type || 'image/png',
      encoding: node.encoding || 'base64',
      // Content-ID header value is wrapped in angle brackets — strip them
      cid: (node.id || '').replace(/^<|>$/g, ''),
    });
  } else if (disposition === 'attachment' || filename) {
    results.attachments.push({
      part: node.part || '1',
      filename: filename || 'attachment',
      type: node.type || 'application/octet-stream',
      encoding: node.encoding || 'base64',
      size: node.dispositionParameters?.size ? parseInt(node.dispositionParameters.size) : node.size || 0,
      disposition,
    });
  }
}

// Extract a human-readable message from an imapflow error.
// imapflow command failures have a structured .response object; fall back to .message.
function extractImapError(err) {
  if (err.response && typeof err.response === 'object') {
    const text = err.response.attributes?.find(a => a.type === 'TEXT')?.value;
    if (text) return text;
    if (err.response.command) return `${err.response.command}: ${err.message}`;
  }
  return err.serverResponse || err.message || String(err);
}

// Sanitize a date value — handles Go-style timestamps and other malformed dates
function safeDate(d) {
  if (!d) return new Date();
  const date = new Date(d);
  if (!isNaN(date.getTime())) return date;
  // Try stripping Go monotonic clock suffix (e.g. " m=+12345.678")
  const stripped = String(d).replace(/\s+m=[+-][\d.]+$/, '').trim();
  const date2 = new Date(stripped);
  if (!isNaN(date2.getTime())) return date2;
  return new Date();
}

// Per-provider capability flags and rate-limit tuning.
//
// fetchBody:           store body_html/body_text during backfill/sync.
//                      Disabled for providers that throttle BODY[] fetches at scale.
// usesIdle:            keep the persistent sync connection in IMAP IDLE for push events.
// maxSyncIntervalMs:   clamp the user's sync interval for providers whose IDLE is unreliable.
// pushesFlags:         server pushes flag changes via IDLE; false = poll every sync tick.
// flagPollEveryTicks:  for non-push flag providers, poll flags every N successful sync ticks.
// snippetIndex:        run the background snippet indexer after backfill.
//                      Disabled for providers that throttle body fetches too aggressively.
// skipFolderPatterns:  folder path substrings to skip during backfill (label-view dedup).
// skipFolderNames:     exact folder paths to skip (non-selectable namespace containers).
// batchSize/Delay/errorDelay/batchesPerConn: backfill rate-limit tuning.
// connectStaggerMs:     base gap between successive account connects at startup, to keep the
//                       initial burst under a provider's per-IP connection rate limit.
//                       Omitted → 200ms default. See connectStaggerFor(). (#218)
const PROVIDERS = {
  google: {
    // Large batches, short delay: Gmail only throttles BODY[] not envelope/flags/uid.
    // Backfills 30k+ messages in ~2 min instead of 12+ hours.
    batchSize: 500, batchDelay: 2000, errorDelay: 30000, batchesPerConn: 10,
    fetchBody: false,
    pushesFlags: false,
    snippetIndex: false,
    speculativeFetch: false,
    skipFolderPatterns: ['all mail', '[gmail]/starred', '[gmail]/important'],
    // [Gmail] is a namespace container — not a selectable mailbox. It must be
    // matched exactly so that real subfolders like [Gmail]/Drafts are not skipped.
    skipFolderNames: ['[gmail]'],
  },
  yahoo: {
    batchSize: 100, batchDelay: 2000, errorDelay: 30000, batchesPerConn: 10,
    fetchBody: false,
    pushesFlags: true,
    snippetIndex: true,
    speculativeFetch: false,
    skipFolderPatterns: [],
    skipFolderNames: [],
  },
  apple: {
    // iCloud is permissive — large batches, short delay.
    batchSize: 200, batchDelay: 1000, errorDelay: 10000, batchesPerConn: 20,
    fetchBody: false,
    pushesFlags: true,
    snippetIndex: true,
    speculativeFetch: true,
    skipFolderPatterns: [],
    skipFolderNames: [],
  },
  microsoft: {
    batchSize: 100, batchDelay: 1500, errorDelay: 15000, batchesPerConn: 15,
    fetchBody: false,
    pushesFlags: true,
    snippetIndex: true,
    speculativeFetch: true,
    skipFolderPatterns: [],
    skipFolderNames: [],
  },
  purelymail: {
    // PurelyMail (Dovecot-based) is connection-sensitive and shows three failure modes on
    // large, mostly-uncached mailboxes: (1) long-lived IDLE sessions go "deaf"/half-open,
    // (2) IDLE EXISTS can simply not arrive, so new mail is only discovered by polling, and
    // (3) heavy background BODY[] work saturates the small body-fetch pool, timing out live
    // opens. So it gets a deliberately conservative, poll-first profile:
    //   snippetIndex:false      — disables BOTH the background snippet indexer AND the
    //                             on-view folder body prefetch (both gate on this flag), the
    //                             bulk of the BODY[] load on a 50k-message uncached mailbox.
    //   speculativeFetch:false  — PurelyMail returns malformed 0-byte literals for batched
    //                             multi-part BODY[] fetches; two-step (structure then parts)
    //                             is reliable.
    //   preferFreshBodyFetch    — user/new-mail body fetches use a brand-new login instead of
    //                             the shared pool, so they neither contend with flag writes on
    //                             the size-2 pool nor inherit a frozen pooled session view.
    //   usesIdle:false          — new mail IDLE is unreliable on the observed account; fresh
    //                             poll sync is the source of truth for notifications.
    batchSize: 100, batchDelay: 1500, errorDelay: 15000, batchesPerConn: 15,
    connectStaggerMs: 1200, // connection-sensitive — space initial connects wide (#218)
    fetchBody: false,
    usesIdle: false,
    pushesFlags: false,
    snippetIndex: false,
    speculativeFetch: false,
    preferFreshBodyFetch: true,
    freshInboxSync: true,
    autoBackfillExistingOnConnect: false,
    maxSyncIntervalMs: 10000,
    flagPollEveryTicks: 6,
    prefetchNewBodies: true,
    prefetchNewBodiesLimit: 1, // warm only the newest arrival; avoids BODY[] bursts while
                               // making notification-click opens use the DB cache.
    skipFolderPatterns: [],
    skipFolderNames: [],
  },
  generic: {
    batchSize: 100, batchDelay: 1500, errorDelay: 15000, batchesPerConn: 15,
    connectStaggerMs: 500, // unknown provider — moderate connect spacing (#218)
    fetchBody: false,
    pushesFlags: true,
    snippetIndex: true,
    speculativeFetch: true,
    skipFolderPatterns: [],
    skipFolderNames: [],
  },
};

// Builds the GTD portion of the move-detector relocate guard, shared by the
// sync and backfill relocate UPDATEs so their exemption logic stays identical.
// A GTD-labeled message intentionally lives in multiple folders as sibling rows;
// relocating in place would collapse them and ping-pong the message. So a row is
// exempt from relocation when either the folder being synced ($1, the relocate
// target) or the row's current folder is GTD-designated — both fall through to a
// sibling INSERT instead.
//
// gtdFolders: array of designated folder paths (empty when GTD is disabled).
// paramIndex: the next positional bind index ($N) available in the caller's query.
// Returns { clause, params }. With no GTD folders the clause is '' and params is
// [], so a GTD-disabled account runs byte-identical SQL to before this feature.
export function gtdRelocateGuard(gtdFolders, paramIndex) {
  if (!gtdFolders || gtdFolders.length === 0) return { clause: '', params: [] };
  const p = `$${paramIndex}`;
  const clause =
    `\n                  AND $1 <> ALL(${p}::text[])` +
    `\n                  AND folder <> ALL(${p}::text[])`;
  return { clause, params: [gtdFolders] };
}

// DB half of copyMessage: insert the destination sibling row for a message that was
// just COPY'd from `fromFolder` to `toFolder`. Content columns are copied verbatim
// from the source row (same set the move CTE re-inserts); only uid ($4, the UIDPLUS
// copyuid) and folder ($5) change. ON CONFLICT (account_id, uid, folder) DO NOTHING
// makes it idempotent against the destination folder's next sync, which would insert
// the same row. Destination counts are bumped only when a row is actually created
// (RETURNING is empty if a sync beat us to it), and unread only when the copy is
// unread. Extracted (like gtdRelocateGuard) so the DB behavior is unit-testable
// without a live IMAP pool.
export async function insertCopiedSibling(accountId, uid, fromFolder, toFolder, newUid) {
  const res = await query(`
    INSERT INTO messages (
      account_id, uid, folder, message_id, subject,
      from_name, from_email, to_addresses, cc_addresses,
      reply_to, in_reply_to, date, snippet, is_read, is_starred,
      has_attachments, flags, body_html, body_text, attachments,
      thread_references, thread_id, is_bulk,
      read_changed_at, star_changed_at, spam_score_sa, spam_score_ml,
      spam_verdict, spam_analyzed_at, spam_details, spam_user_override,
      category, list_unsubscribe, list_unsubscribe_post, unsubscribed_at
    )
    SELECT
      account_id, $4, $5, message_id, subject,
      from_name, from_email, to_addresses, cc_addresses,
      reply_to, in_reply_to, date, snippet, is_read, is_starred,
      has_attachments, flags, body_html, body_text, attachments,
      thread_references, thread_id, is_bulk,
      read_changed_at, star_changed_at, spam_score_sa, spam_score_ml,
      spam_verdict, spam_analyzed_at, spam_details, spam_user_override,
      category, list_unsubscribe, list_unsubscribe_post, unsubscribed_at
    FROM messages
    WHERE account_id = $1 AND folder = $2 AND uid = $3
    ON CONFLICT (account_id, uid, folder) DO NOTHING
    RETURNING id, is_read
  `, [accountId, fromFolder, uid, newUid, toFolder]);
  const row = res.rows[0];
  if (row) {
    adjustFolderCounts(accountId, toFolder, 1, row.is_read ? 0 : 1);
  }
  return row ? row.id : null;
}

// DB half of removeMessageCopy: delete exactly one folder's copy of a message. Scoped
// to (account_id, uid, folder) — the messages unique key — so sibling rows in other
// folders are never touched. Decrements that folder's counts off the removed row's
// read state. Returns the number of rows removed (0 if it was already gone).
export async function deleteMessageCopyRow(accountId, uid, folder) {
  const res = await query(
    'DELETE FROM messages WHERE account_id = $1 AND uid = $2 AND folder = $3 RETURNING is_read',
    [accountId, uid, folder]
  );
  const row = res.rows[0];
  if (row) {
    adjustFolderCounts(accountId, folder, -1, row.is_read ? 0 : -1);
  }
  return row ? 1 : 0;
}

// On a non-UIDPLUS COPY the destination sibling row is deferred to syncFolderOnDemand, so
// the early gtd_sections_updated emit can leave GTD section data stale until that sync lands (up
// to a GTD tick away). Re-emit once the deferred sync resolves so the data converges
// immediately; on sync failure keep the existing warn and skip the re-emit (the next GTD
// tick still reconciles). srcUid/fromFolder identify the copied message so the transition
// engine can be re-run over its thread now that the sibling exists: a transition run that
// raced ahead of the deferred insert saw stale thread state, so re-running here applies any
// needed strip immediately instead of at the next tick. Gated on gtd_enabled; transition
// failures are debug-level (the tick still reconciles). Extracted (like insertCopiedSibling)
// so the emit/transition sequencing is unit-testable without a live IMAP pool.
export function emitAfterDeferredCopySync(mgr, account, toFolder, srcUid, fromFolder) {
  return mgr.syncFolderOnDemand(account, toFolder)
    .then(async () => {
      mgr.broadcast({ type: 'gtd_sections_updated', accountId: account.id }, account.user_id);
      if (!account.gtd_enabled) return;
      try {
        const { rows } = await query(
          'SELECT thread_key FROM messages WHERE account_id = $1 AND uid = $2 AND folder = $3 LIMIT 1',
          [account.id, srcUid, fromFolder]
        );
        const threadKey = rows[0]?.thread_key;
        if (threadKey) await runGtdTransitions(mgr, account, [threadKey]);
      } catch (err) {
        logger.debug(`post-copy transition re-run failed for ${toFolder}: ${err.message}`);
      }
    })
    .catch(err => console.warn(`post-copy destination sync failed for ${toFolder}:`, err.message));
}

// Broadcast a GTD sections refresh after a batch changed the messages table outside a GTD tick, so
// the tick's fingerprint can't detect the change on its own. Two triggers:
//   • an ORDINARY sync that DELETED rows the server no longer has (reconcile orphan-removal,
//     UIDVALIDITY purge) — dropping a GTD thread's INBOX/label copy; and
//   • a BACKFILL that INSERTED historical rows into a GTD folder (account remap/toggle
//     reconnect, POST /reindex) — the tick's before==after fingerprint misses rows backfill
//     already wrote.
// Either way clients would otherwise show stale GTD section data until the next GTD tick or a user
// action (the frontend click self-heal only masks the worst symptom). Gated cheaply: skip when
// nothing changed, and skip when GTD is off for the account (getGtdConfig is cached, so a
// disabled account adds no query on the hot path — and, per that cache's 5-min TTL, an account
// whose GTD was just toggled converges within a tick). No per-row relevance check: the client
// debounces refreshes at 400ms, so a harmless over-emit is preferred to a missed one, and a
// missed emit leaves durable stale GTD section data. mgr is injected (like emitAfterDeferredCopySync) so this
// stays unit-testable without a live socket server; emit failures never disturb the caller.
export async function emitGtdSectionsRefreshIfEnabled(mgr, account, changedCount) {
  if (!(changedCount > 0)) return;
  try {
    const { enabled } = await getGtdConfig(account.id);
    if (enabled) mgr.broadcast({ type: 'gtd_sections_updated', accountId: account.id }, account.user_id);
  } catch (err) {
    logger.debug(`GTD sections refresh emit skipped for ${logAccount(account)}: ${err.message}`);
  }
}

// Alias so each call site's name documents which trigger fired the emit: insert-triggered
// (backfill) call sites import emitGtdSectionsRefreshIfEnabled, delete-triggered (reconcile
// orphan-removal / UIDVALIDITY purge) call sites import this name — the gate logic itself
// is identical either way.
export const emitGtdSectionsRefreshOnDelete = emitGtdSectionsRefreshIfEnabled;

// One GTD tick's body: sync each designated label folder for a connected gtd_enabled
// account, then broadcast a single gtd_sections_updated if any folder actually changed.
// Folders are synced one at a time (not in parallel) so a multi-folder account doesn't
// grab a handful of pooled connections at once, and the on-demand sync lock is respected
// so a user-triggered folder open and this tick never double-sync the same folder.
// Extracted out of the class (like emitAfterDeferredCopySync) so this sequencing is
// unit-testable with a mock manager, without a live socket server or IMAP pool; mgr is
// injected for the same reason. The whole body is wrapped in one try/catch (mirrors
// _syncTick) so a config-fetch DB blip is logged with account context here instead of
// only surfacing via the process-wide unhandledRejection handler.
export async function runGtdSyncTick(mgr, account) {
  try {
    // Live persistent connection is our signal the account is healthy; syncMessages here
    // runs on a pooled connection, so it never disturbs the IDLE sync client.
    if (!mgr.connections.has(account.id)) return;
    const config = await getGtdConfig(account.id);
    const folders = gtdTickFolders(config); // [] when GTD was turned off — inert
    if (folders.length === 0) return;

    const changedFolders = [];
    for (const folder of folders) {
      const key = `${account.id}:${folder}`;
      if (mgr.onDemandSyncing.has(key)) continue; // a user-triggered sync owns this folder
      mgr.onDemandSyncing.add(key);
      try {
        const before = await mgr._gtdFolderFingerprint(account.id, folder);
        await mgr._gtdSyncFolder(account, folder);
        const after = await mgr._gtdFolderFingerprint(account.id, folder);
        if (before !== after) changedFolders.push(folder);
      } catch (err) {
        console.warn(`GTD sync error ${logAccount(account)}/${folder}:`, err.message);
      } finally {
        mgr.onDemandSyncing.delete(key);
      }
    }

    if (changedFolders.length > 0) {
      // A label folder's membership changed (a state added/removed elsewhere — another
      // client or an external automation). Re-run transitions for the threads those folders
      // now touch so a newly-labeled thread whose newest message already satisfies a strip
      // rule converges without waiting for new INBOX mail. Idempotent: re-evaluating a
      // thread the tick just stripped finds nothing left and is a no-op. Runs before the
      // emit so the GTD sections refetch reflects the post-strip state.
      try {
        const threadKeys = await threadKeysInFolders(account.id, changedFolders);
        await runGtdTransitions(mgr, account, threadKeys);
      } catch (err) {
        console.warn(`GTD transitions error ${logAccount(account)}:`, err.message);
      }
      mgr.broadcast({ type: 'gtd_sections_updated', accountId: account.id }, account.user_id);
    }
  } catch (err) {
    console.warn(`GTD tick error ${logAccount(account)}:`, err.message);
  }
}

// Choose the INBOX message ids to run GTD transitions over after a sync batch completes.
//   newInboxIds — the id of every row this sync newly inserted into INBOX, collected REGARDLESS
//     of read state. An inbound reply that arrived already \Seen (read on another device before
//     this sync landed) must still clear its thread's Watch/Delegated label, yet such a row never
//     enters the unread-gated `newMessages` notification list — so that list cannot be reused as
//     the GTD candidate set. Read state is deliberately not consulted here.
//   deletedIds — ids the block-list / inbox rules genuinely DELETED (expunged / dropped) from
//     INBOX; those threads lost this arrival entirely, so they are excluded. A rule-MOVED reply
//     is NOT in this set — its row still lives (in another folder) and its thread must still be
//     re-evaluated, so it stays a candidate. Rules only ever run on the unread subset, so a read
//     row is never among these ids.
// Extracted (like insertCopiedSibling) so the candidate selection is unit-testable without
// standing up the full syncMessages fetch loop.
export function selectGtdReevalIds(newInboxIds, deletedIds) {
  const removed = deletedIds instanceof Set ? deletedIds : new Set(deletedIds || []);
  return newInboxIds.filter((id) => !removed.has(id));
}

export function providerProfile(account) {
  const host = (account.imap_host || '').toLowerCase();
  if (host.includes('.gmail.com') || host.includes('.googlemail.com')) return PROVIDERS.google;
  if (host.includes('.yahoo.com') || host.includes('.ymail.com')) return PROVIDERS.yahoo;
  if (host.includes('.icloud.com') || host.includes('.apple.com') || host.includes('.me.com')) return PROVIDERS.apple;
  if (host.includes('.outlook.com') || host.includes('office365.com') || host.includes('.hotmail.com') || host.includes('.live.com') || (account.oauth_provider === 'microsoft')) return PROVIDERS.microsoft;
  if (host.includes('purelymail.com')) return PROVIDERS.purelymail;
  return PROVIDERS.generic;
}

export function effectiveSyncIntervalMs(account, requestedMs) {
  const profile = providerProfile(account);
  if (profile.maxSyncIntervalMs) return Math.min(requestedMs, profile.maxSyncIntervalMs);
  return requestedMs;
}

// Delay before each successive account connect at startup, to keep the initial burst under a
// provider's per-IP connection rate limit. The base is per-provider (wide for connection-
// sensitive providers like PurelyMail, 200ms otherwise) and scales up with how many accounts
// are being connected — so a large fleet paces slower — capped at 2x so startup stays bounded.
// This is proactive pacing; the reactive connectCooldownMs backoff still handles a provider
// that refuses despite the spacing. (#218)
export function connectStaggerFor(profile, accountCount) {
  const base = profile?.connectStaggerMs ?? 200;
  const factor = Math.min(1 + Math.max(accountCount, 0) / 25, 2);
  return Math.round(base * factor);
}

// Per-account connection pool for body fetches — avoids TLS handshake on every click
const connectionPools = new Map(); // accountId -> { clients: [], waiting: [] }
const POOL_SIZE = 2;

// When a message moves folders (same Message-ID, new UID), refresh metadata too —
// otherwise a draft→sent relocate can leave subject/addresses stale forever.
const RELOCATE_MESSAGE_SQL = `
  UPDATE messages SET
    folder = $1::text,
    uid = $2::bigint,
    is_deleted = false,
    subject = CASE
      WHEN $5::text IS NOT NULL AND $5::text <> '' AND $5::text <> '(no subject)'
      THEN $5::text ELSE messages.subject END,
    from_name = COALESCE(NULLIF($6::text, ''), messages.from_name),
    from_email = COALESCE(NULLIF($7::text, ''), messages.from_email),
    to_addresses = CASE
      WHEN $8::jsonb::text IS NOT NULL AND $8::jsonb::text <> '[]'
      THEN $8::jsonb ELSE messages.to_addresses END,
    cc_addresses = CASE
      WHEN $9::jsonb::text IS NOT NULL AND $9::jsonb::text <> '[]'
      THEN $9::jsonb ELSE messages.cc_addresses END,
    reply_to = COALESCE(NULLIF(messages.reply_to::text, '[]'), $10::text)::jsonb,
    date = $11::timestamptz
  WHERE account_id = $3::uuid
    AND message_id = $4::text
    AND (folder != $1::text OR uid != $2::bigint)
    AND 1 = (SELECT COUNT(*) FROM messages WHERE account_id = $3::uuid AND message_id = $4::text)
    AND COALESCE((SELECT special_use FROM folders WHERE account_id = $3::uuid AND path = $1::text), '') NOT IN ('\\All', '\\Important')`;

function relocateMessageParams(folder, parsed, accountId, msgId) {
  return [
    folder, parsed.uid, accountId, msgId,
    sanitizeStr(parsed.subject),
    sanitizeStr(parsed.fromName),
    sanitizeStr(parsed.fromEmail),
    JSON.stringify(parsed.to),
    JSON.stringify(parsed.cc),
    JSON.stringify(parsed.replyTo || []),
    safeDate(parsed.date),
  ];
}

// GTD-aware relocate: GTD label folders are exempt from relocation because a labeled message
// intentionally lives as sibling rows in several folders, and relocating in place would
// collapse them and ping-pong the message. Appends the sibling-exemption guard (empty, so
// behavior is unchanged when GTD is off) plus RETURNING, so the sync and backfill relocate
// call sites share one implementation and both inherit the exemption. See gtdRelocateGuard.
// gtdFolders is [] when GTD is disabled for the account.
function relocateMessageQuery(folder, parsed, accountId, msgId, gtdFolders) {
  const guard = gtdRelocateGuard(gtdFolders, 12);
  return {
    sql: `${RELOCATE_MESSAGE_SQL}${guard.clause}\n  RETURNING id`,
    params: [...relocateMessageParams(folder, parsed, accountId, msgId), ...guard.params],
  };
}

// Strip null bytes that PostgreSQL's UTF-8 encoding rejects (some emails contain them)
function sanitizeStr(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/\0/g, '');
}

// Parse RFC 5322 References header into an ordered array of angle-bracketed Message-IDs.
function parseReferences(refHeader) {
  if (!refHeader) return [];
  return refHeader.match(/<[^>]+>/g) || [];
}

// Strip common reply/forward prefixes (Re:, FW:, AW:, SV:, …) from a subject,
// handling multiple nested levels, and return the lowercase core.
const SUBJECT_PREFIX_RE = /^(?:re|fw|fwd|aw|sv|vs|tr|wg|ant|antw|ref|rif|ynt|odp|vb|atb)\s*:\s*/i;
function normalizeSubject(subject) {
  if (!subject) return '';
  let s = subject.trim();
  let prev;
  do {
    prev = s;
    s = s.replace(SUBJECT_PREFIX_RE, '').trim();
  } while (s !== prev);
  return s.toLowerCase();
}

// Compute the thread_id for an incoming message.
// Primary: RFC 5322 References / In-Reply-To header chain.
// Fallback: subject normalization when headers are absent (e.g. Outlook RE: replies).
async function computeThreadId(accountId, messageId, inReplyTo, references, subject) {
  if (!messageId) return null;

  const refIds = parseReferences(references);
  const candidates = [...refIds];
  if (inReplyTo && !candidates.includes(inReplyTo)) candidates.push(inReplyTo);

  if (candidates.length > 0) {
    // Fetch all candidates in one query instead of N sequential lookups.
    // Priority: RFC 5322 root (candidates[0]) > newest ancestor (candidates[last]).
    const rows = await query(
      `SELECT message_id, thread_id FROM messages
       WHERE account_id = $1 AND message_id = ANY($2) AND thread_id IS NOT NULL`,
      [accountId, candidates]
    );

    if (rows.rows.length > 0) {
      const found = new Map(rows.rows.map(r => [r.message_id, r.thread_id]));
      // Prefer the thread root (first Reference per RFC 5322).
      if (found.has(candidates[0])) return found.get(candidates[0]);
      // Otherwise use the most recent ancestor present in the DB (newest→oldest).
      for (let i = candidates.length - 1; i >= 0; i--) {
        if (found.has(candidates[i])) return found.get(candidates[i]);
      }
    }

    // Ancestor referenced but not yet in DB — use the root as a provisional thread_id.
    // When it arrives its thread_id will equal its own message_id, so threads converge.
    // Don't fall through to subject fallback; the header chain takes priority.
    return candidates[0] || messageId;
  }

  // No RFC 5322 threading headers — fall back to subject normalization.
  // Looks for the earliest message in the same account with the same normalized subject
  // within the past 90 days and joins that thread.
  const normalized = normalizeSubject(subject);
  if (normalized) {
    const subjectRow = await query(
      `SELECT thread_id FROM messages
       WHERE account_id = $1
         AND is_deleted = false
         AND message_id IS DISTINCT FROM $2
         AND thread_id IS NOT NULL
         AND normalized_subject = $3
         AND date > NOW() - INTERVAL '90 days'
       ORDER BY date ASC
       LIMIT 1`,
      [accountId, messageId, normalized]
    );
    if (subjectRow.rows.length > 0) return subjectRow.rows[0].thread_id;
  }

  return messageId;
}

// Ensure OAuth token is fresh before connecting
async function ensureFreshToken(account) {
  if (account.oauth_provider !== 'microsoft') return account;
  if (!account.oauth_token_expiry) return account;
  const expiry = new Date(account.oauth_token_expiry);
  const now = new Date();
  // Refresh if token expires within 5 minutes
  if (expiry - now < 5 * 60 * 1000) {
    console.log(`Refreshing Microsoft token for ${logAccount(account)}`);
    try {
      account = await refreshMicrosoftToken(account);
    } catch (err) {
      console.error(`Token refresh failed for ${logAccount(account)}:`, err.message);
    }
  }
  return account;
}

// resolved: { host, servername } from resolveForConnection() — pins the IP so the
// actual TCP connection uses the address we validated, not a later DNS lookup.
// policy: result of getConnectionPolicy() — gates TLS verification override.
export function makeClientCfg(account, resolved, { enableIdle = false, policy = {} } = {}) {
  if (!policy.allowInsecureTls && !account.imap_tls) {
    throw new Error('Plain-text IMAP is not allowed: admin must enable "Allow insecure TLS"');
  }
  const skipTls = policy.allowInsecureTls && !!account.imap_skip_tls_verify;
  const tlsOpts = { rejectUnauthorized: !skipTls };
  // Set servername so TLS SNI and cert verification use the original hostname even
  // though the socket connects directly to the pinned IP address.
  if (resolved.servername) tlsOpts.servername = resolved.servername;
  const cfg = {
    host: resolved.host,
    port: account.imap_port,
    secure: account.imap_tls,
    auth: { user: account.auth_user, pass: decrypt(account.auth_pass) },
    logger: false,
    tls: tlsOpts,
    // Prevent IMAP commands from hanging forever on half-open TCP connections.
    // Without this, a silently-dead connection causes every sync call to wait
    // indefinitely — the refresh button spins forever and auto-poll stops working.
    commandTimeout: 30000,
  };
  // Auto-IDLE: ImapFlow re-enters IDLE automatically between commands so the
  // server can push EXISTS notifications immediately when new mail arrives.
  // Only enable on sync connections (not pool/backfill/snippet clients) to
  // avoid interfering with body-fetch pipelines.
  if (enableIdle) cfg.maxIdleTime = 25 * 60 * 1000;
  // OAuth2 XOAUTH2 for Gmail and Microsoft
  if ((account.oauth_provider === 'google' || account.oauth_provider === 'microsoft')
      && account.oauth_access_token) {
    cfg.auth = {
      user: account.auth_user || account.email_address,
      accessToken: decrypt(account.oauth_access_token),
    };
  }
  return cfg;
}

function drainWaiters(pool) {
  while (pool.waiters.length > 0) {
    const free = pool.clients.find(c => !pool.inUse.has(c));
    if (!free) break;
    const entry = pool.waiters.shift();
    clearTimeout(entry.timer);
    pool.inUse.add(free);
    entry.resolve(free);
  }
}

async function acquirePooledClient(account) {
  const id = account.id;
  if (!connectionPools.has(id)) {
    connectionPools.set(id, { clients: [], inUse: new Set(), waiters: [] });
  }
  const pool = connectionPools.get(id);

  // Find an idle client
  const idle = pool.clients.find(c => !pool.inUse.has(c));
  if (idle) {
    pool.inUse.add(idle);
    return idle;
  }

  // Grow pool if under limit — refresh token before creating a new connection
  if (pool.clients.length < POOL_SIZE) {
    const freshAccount = await ensureFreshToken(account);
    const { resolved, policy } = await resolveAccountHost(freshAccount);
    const client = new ImapFlow(makeClientCfg(freshAccount, resolved, { policy }));
    await Promise.race([
      client.connect(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('IMAP connection timeout (30s)')), 30000)
      ),
    ]);
    // Remove from pool immediately when the server closes the socket, then
    // wake any waiters so they can claim another idle connection if one exists.
    client.on('close', () => {
      const p = connectionPools.get(id);
      if (p) {
        p.clients = p.clients.filter(c => c !== client);
        p.inUse.delete(client);
        drainWaiters(p);
      }
    });
    client.on('error', (err) => {
      console.error(`IMAP pool error for account ${id}:`, err.message);
    });
    pool.clients.push(client);
    pool.inUse.add(client);
    return client;
  }

  // Pool full — queue a waiter; on 10s timeout fall back to a temporary client
  return new Promise((resolve, reject) => {
    const entry = { resolve, reject, timer: null };
    entry.timer = setTimeout(async () => {
      pool.waiters = pool.waiters.filter(w => w !== entry);
      try {
        const freshAccount = await ensureFreshToken(account);
        const { resolved, policy } = await resolveAccountHost(freshAccount);
        const tmp = new ImapFlow(makeClientCfg(freshAccount, resolved, { policy }));
        tmp.on('error', (err) => {
          console.error(`IMAP temp client error for account ${account.id}:`, err.message);
        });
        await Promise.race([
          tmp.connect(),
          new Promise((_, rej) =>
            setTimeout(() => rej(new Error('IMAP connection timeout (30s)')), 30000)
          ),
        ]);
        resolve(tmp);
      } catch (err) {
        reject(err);
      }
    }, 10000);
    pool.waiters.push(entry);
  });
}

function releasePooledClient(account, client) {
  const pool = connectionPools.get(account.id);
  if (!pool) { client.logout().catch(() => {}); return; }
  pool.inUse.delete(client);
  // If this client isn't in our pool (was a temp or already evicted on error),
  // log it out. logout() is async — must use .catch() not try/catch.
  if (!pool.clients.includes(client)) {
    client.logout().catch(() => {});
  } else {
    drainWaiters(pool);
  }
}

function evictPool(accountId) {
  const pool = connectionPools.get(accountId);
  if (!pool) return;
  for (const c of pool.clients) { c.logout().catch(() => {}); }
  const evictErr = new Error('IMAP pool evicted');
  for (const entry of pool.waiters) { clearTimeout(entry.timer); entry.reject(evictErr); }
  connectionPools.delete(accountId);
}

async function withFreshClient(account, fn) {
  const client = await acquirePooledClient(account);
  try {
    return await fn(client);
  } catch (err) {
    // On error, evict this client from pool so next call gets a fresh one.
    // Do not logout here — releasePooledClient in finally detects the client is
    // no longer in pool.clients and calls logout exactly once.
    // drainWaiters here so any queued caller gets an idle slot immediately rather
    // than waiting the full 10-second overflow timeout.
    const pool = connectionPools.get(account.id);
    if (pool) {
      pool.inUse.delete(client);
      pool.clients = pool.clients.filter(c => c !== client);
      drainWaiters(pool);
    }
    throw err;
  } finally {
    releasePooledClient(account, client);
  }
}

// Like withFreshClient, but bypasses the pool entirely: it opens a BRAND-NEW IMAP login,
// runs fn(client), and tears it down. Used as the body-fetch retry path. When a pooled
// connection returns nothing for a recently-arrived UID (the PurelyMail "frozen view"
// symptom, where every existing session — persistent or pooled — shares a stale mailbox
// snapshot), only a fresh login reliably sees the message. A pool retry could instead
// grab a second frozen connection and return a blank body, so the retry must be genuinely
// fresh. Not pooled itself — a body fetch is user-initiated and infrequent, so the
// one-off login cost is acceptable for guaranteed correctness.
async function withFreshLogin(account, fn) {
  const fresh = await ensureFreshToken(account);
  const { resolved, policy } = await resolveAccountHost(fresh);
  const client = new ImapFlow(makeClientCfg(fresh, resolved, { policy }));
  client.on('error', () => {}); // avoid unhandled 'error' on abrupt close
  try {
    await Promise.race([
      client.connect(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('IMAP connection timeout (30s)')), 30000)
      ),
    ]);
    return await fn(client);
  } finally {
    // close() (not logout()): destroys the socket and aborts a still-pending connect()
    // left running by the race timeout, so a slow login can't leak a session.
    try { client.close(); } catch { /* already closed */ }
  }
}

// Create a mailbox idempotently and report its REAL server path. The name is handed to
// imapflow as an array (split on the '/' the GTD config uses for nesting) so imapflow
// joins the segments with the account's hierarchy delimiter: ['Work', 'Todo'] becomes
// 'INBOX.Work.Todo' on a '.'-delimited Dovecot/Courier server and 'Work/Todo' on a flat
// one (Gmail, modern Fastmail) — no delimiter guessing or hand-joining a hardcoded '/'
// here. The personal-namespace prefix is applied unconditionally by imapflow's
// normalizePath either way (array or bare string); the array form's only job is
// delimiter-correct joining for multi-segment/custom names. imapflow's CREATE treats
// ALREADYEXISTS (RFC 5530) as { created:false } with
// the normalized path rather than throwing, so an already-present folder (including one
// that differs only by case on a case-insensitive server) is reported as "not created
// now" with its real path; a server that instead rejects a duplicate with a plain NO
// ("mailbox already exists") is caught by the responseText/serverResponseCode check below
// and likewise reported as already-there. Any other failure propagates. Returns
// { path, created }. Extracted (like
// insertCopiedSibling) so the namespace / already-exists matrix is unit-testable with a
// mock client and no live pool.
// resolvePath (default off) makes the already-exists branches resolve the server's real
// casing via a LIST. Only the /folders/ensure route sets it — it PERSISTS the returned path,
// so wrong casing there is durable; classify/snooze discard the path and skip the extra LIST.
export async function ensureMailbox(client, path, { resolvePath = false } = {}) {
  const requested = String(path);
  // A flat-namespace server (personal-namespace delimiter null/empty) cannot represent a
  // nested path: imapflow joins the segments with delimiter||'' and would silently turn
  // "Projects/Todo" into "ProjectsTodo". Fail loudly so the ensure route reports it per
  // folder. Only guard when the namespace is known to be flat; an unfetched namespace
  // (undefined — e.g. a bare test client) is left to imapflow.
  if (requested.includes('/') && client.namespace && !client.namespace.delimiter) {
    throw new Error('server does not support folder hierarchy');
  }
  try {
    const res = await client.mailboxCreate(requested.split('/'));
    if (res?.created === true) return { path: res.path || requested, created: true };
    // Already exists (imapflow caught ALREADYEXISTS): res.path is the requested casing.
    const known = res?.path || requested;
    return { path: resolvePath ? await resolveServerFolderCasing(client, known) : known, created: false };
  } catch (err) {
    // imapflow throws with err.message fixed to the generic 'Command failed' (see
    // lib/imap-flow.js's NO/BAD tagged-response handling); the server's actual text lands
    // in err.responseText and, when the server sends an RFC 5530 response code, the parsed
    // code lands in err.serverResponseCode (set by lib/tools.js's enhanceCommandError). Check
    // those first; fall back to err.message for non-imapflow error shapes (e.g. in tests).
    const code = (err.serverResponseCode || '').toLowerCase();
    const text = (err.responseText || err.message || '').toLowerCase();
    const alreadyExists = code === 'alreadyexists' || text.includes('alreadyexists') || text.includes('already exists');
    if (!alreadyExists) {
      throw err;
    }
    // A plain-NO already-exists carries no server path, so the casing lookup can only match
    // from the bare requested name — enough for a flat case-insensitive server, but a prefixed
    // server's real path (INBOX.Todo) won't match and falls back to the input.
    return { path: resolvePath ? await resolveServerFolderCasing(client, requested) : requested, created: false };
  }
}

// Resolve the server's REAL casing for a mailbox that already exists, by case-insensitive
// lookup against the folder LIST. On a case-insensitive server "TODO" can already exist when
// "Todo" was requested; imapflow's already-exists result echoes the REQUESTED casing, which,
// if persisted (planGtdFolderPersist), never case-matches the synced rows' folder value and
// silently zeroes the state. Best-effort: any list failure (or a client without list) falls
// back to the caller's known path — never throws.
async function resolveServerFolderCasing(client, knownPath) {
  if (typeof client.list !== 'function') return knownPath;
  try {
    const wanted = knownPath.toLowerCase();
    const boxes = await client.list();
    const match = (Array.isArray(boxes) ? boxes : []).find(b => (b?.path || '').toLowerCase() === wanted);
    return match?.path || knownPath;
  } catch {
    return knownPath;
  }
}

export class ImapManager {
  constructor(wss) {
    this.wss = wss;
    this.connections = new Map();   // accountId -> ImapFlow (persistent sync connection)
    this.syncIntervals = new Map();
    this.gtdSyncIntervals = new Map(); // accountId -> timer for the periodic GTD label-folder tick
    this.backfillRunning = new Set(); // `${accountId}:${folder}` — prevent duplicate folder backfills
    this.backfillAllRunning = new Set(); // accountId — prevent concurrent full backfill sequences
    this._backfillSem = createKeyedSemaphore(BACKFILL_MAX_PER_HOST); // cap concurrent backfills per provider host
    this._connectCooldown = new Map(); // accountId -> { until: ms, failures: number } after connection refusals
    this.onDemandSyncing = new Set(); // `${accountId}:${folder}` — prevent duplicate on-demand syncs
    this.syncingAccounts = new Set(); // prevent overlapping interval syncs
    this.syncStartedAt = new Map();   // accountId -> ms when the current sync tick began (hung-sync detection)
    this.syncThrottleSkips = new Map(); // accountId -> remaining ticks to skip when throttled
    this.connectingAccounts = new Set(); // prevent concurrent connectAccount calls for same account
    this.userSyncIntervalMs = new Map(); // userId -> interval ms (user-configurable)
    this.snippetIndexerRunning = new Set(); // accountId — prevent duplicate snippet-index runs
    this.snippetBackoff = new Map();        // accountId -> { failures, until } circuit breaker
    this.lastUserActivity = new Map();      // accountId -> ms timestamp of last live body fetch
    this.syncTickCount = new Map(); // accountId -> successful sync ticks (for reconcile scheduling)
    this.lastSyncOkAt = new Map(); // accountId -> ms timestamp of last successful sync tick (staleness detection)
    this._flagDebounceTimers   = new Map(); // accountId -> debounce timer for flag-change syncs
    this._expungeDebounceTimers = new Map(); // accountId -> debounce timer for expunge reconciles
    this._pendingFlagSync = new Set(); // accountId — flag sync was skipped because a full sync was running; drain after sync
    // accountId -> Map<`${messageId}:${flag}`, { messageId, flag, attempts }>: local read/star
    // changes whose IMAP push failed and must be retried until the server confirms them.
    this._pendingFlagPush = new Map();
    // Tracks UIDs that are actively being moved by inboxRules so reconcileDeletes
    // does not delete the DB row if an EXPUNGE arrives before the DB update completes,
    // or if the server is non-UIDPLUS and the DB temporarily holds a stale UID.
    // Keys are "${accountId}:${folder}:${uid}" strings.
    this._pendingMoveUids = new Map(); // "acct:folder:uid" -> active guard count (ref-counted)
    this._stalenessCheckRunning = false; // re-entrancy guard for the staleness-probe cycle

    // Health check: every 90 seconds, find any enabled IMAP accounts that have no
    // active connection and no in-progress connect attempt, and reconnect them.
    // This recovers accounts that fail the startup connection silently (e.g. a slow
    // IMAP server that times out on the first attempt) without waiting for a manual sync.
    this._healthCheckTimer = setInterval(async () => {
      try {
        const result = await query(
          "SELECT id, email_address FROM email_accounts WHERE enabled = true AND protocol = 'imap'"
        );
        for (const row of result.rows) {
          if (!this.connections.has(row.id) && !this.connectingAccounts.has(row.id)) {
            // Respect the connection-refusal cooldown — connectAccount would bail anyway, so
            // skip early to avoid a needless credential fetch and a misleading log line.
            const cd = this._connectCooldown.get(row.id);
            if (cd && Date.now() < cd.until) continue;
            // Only fetch full credentials when a reconnect is actually needed
            const full = await query('SELECT * FROM email_accounts WHERE id = $1', [row.id]);
            const account = full.rows[0];
            if (!account) continue;
            console.log(`Health check: reconnecting ${logAccount(account)} (not connected)`);
            this.connectAccount(account).catch(err =>
              console.error(`Health check reconnect failed for ${logAccount(account)}:`, err.message)
            );
          } else if (this.connections.has(row.id)) {
            // Observability: a connected account whose sync ticks have silently stalled
            // (stale/half-open connection) passes the presence check above and is never
            // reconnected. Warn so the condition is diagnosable from logs. Auto-recovery
            // is intentionally NOT done here yet — confirm the mechanism first.
            const last = this.lastSyncOkAt.get(row.id);
            if (last && Date.now() - last > STALE_SYNC_WARN_MS) {
              const mins = Math.round((Date.now() - last) / 60000);
              console.warn(`Health check: ${logAccount(row)} connected but no successful sync in ${mins}m — possible stale connection`);
            }
          }
        }
      } catch (err) {
        console.error('Health check error:', err.message);
      }
    }, 90000); // 90 seconds — fast enough to catch startup failures, slow enough not to spam

    // Snippet-backfill scheduler: periodically resume snippet indexing for connected
    // accounts that still have a backlog, so a large account (>10k missing snippets)
    // keeps draining without waiting for a reconnect/restart. startSnippetIndexer caps
    // each run and self-guards against concurrent runs, so this is a safe nudge.
    this._snippetSchedulerTimer = setInterval(async () => {
      try {
        for (const accountId of this.connections.keys()) {
          if (this.snippetIndexerRunning.has(accountId)) continue;
          const bo = this.snippetBackoff.get(accountId);
          if (bo && Date.now() < bo.until) continue;
          const backlog = await query(
            "SELECT 1 FROM messages WHERE account_id = $1 AND (snippet IS NULL OR snippet = '') LIMIT 1",
            [accountId]
          );
          if (!backlog.rows.length) continue;
          const acct = await query('SELECT * FROM email_accounts WHERE id = $1', [accountId]);
          if (!acct.rows.length) continue;
          this.startSnippetIndexer(acct.rows[0]).catch(err =>
            console.warn(`Scheduled snippet indexer failed for account ${accountId}:`, err.message)
          );
        }
      } catch (err) {
        console.error('Snippet scheduler error:', err.message);
      }
    }, 10 * 60 * 1000); // every 10 minutes

    // Active staleness check. A long-lived IDLE connection can go "deaf": commands keep
    // succeeding but the server stops reflecting new mail on it, so sync ticks complete
    // without seeing arrivals (observed as ~8–60 min delays on an otherwise-healthy
    // account). IDLE re-entry does NOT clear it — and, critically, neither does a reused
    // POOL connection: with some servers (e.g. PurelyMail) every existing session shares
    // the same frozen mailbox view, so only a BRAND-NEW LOGIN reliably sees the missed
    // mail. So each cycle we open a genuinely fresh ImapFlow connection per account (the
    // key fix over the earlier pooled probe, which shared the frozen view and could not
    // see the missed mail), ask the server via UID SEARCH whether it holds any UID ABOVE
    // our highest synced UID, and if so evict the persistent connection (which also
    // unhangs a stuck sync on it) plus the body-fetch pool, then reconnect. The probe is
    // an independent login, so it runs even while a sync is in flight — including a HUNG
    // half-open sync, which is the very case that needs recovery. To avoid churning a
    // genuinely HEALTHY in-flight sync (one about to commit the mail it is fetching), the
    // eviction defers only when a sync started within the last SYNC_HUNG_MS. It is a
    // UID-watermark test (not a message-count comparison) so old never-synced messages
    // (a backfill gap) don't cause endless reconnect-churn.
    this._stalenessCheckTimer = setInterval(async () => {
      // Re-entrancy guard: the per-account probes below do blocking network I/O
      // sequentially, so a slow cycle (many accounts, or one on a degraded provider)
      // can outlast STALENESS_CHECK_MS. Without this, setInterval would launch a second
      // concurrent cycle, multiplying simultaneous fresh logins per account and pushing
      // connection-limited providers (e.g. iCloud) over their session limit.
      if (this._stalenessCheckRunning) return;
      this._stalenessCheckRunning = true;
      try {
        for (const accountId of [...this.connections.keys()]) {
          // Skip ONLY when a reconnect is already in flight — that path owns recovery.
          // We deliberately do NOT skip accounts that are mid-sync: the probe below is a
          // genuinely independent fresh login, so it runs safely alongside a sync — and a
          // HUNG sync (half-open connection, pinning the sync lock for the full 55s) is
          // exactly when the persistent connection is deaf and we most need to act. The
          // earlier "skip busy accounts" guard disabled recovery during precisely that
          // window, leaving only the slow timeout-then-reconnect self-heal.
          if (this.connectingAccounts.has(accountId)) continue;

          // Capture the exact connection object we are judging. If it is replaced (a
          // reconnect completes) between here and the eviction decision below, we must
          // NOT evict its healthy successor.
          const observed = this.connections.get(accountId);
          if (!observed) continue;

          try {
            const acct = await query('SELECT * FROM email_accounts WHERE id = $1', [accountId]);
            const account = acct.rows[0];
            if (!account) continue;
            // Our highest synced INBOX UID — the watermark for "have we seen the newest mail".
            const { rows: [w] } = await query(
              "SELECT MAX(uid)::bigint AS maxuid FROM messages WHERE account_id = $1 AND folder = 'INBOX'",
              [accountId]
            );
            const maxUid = w.maxuid ? Number(w.maxuid) : 0;
            if (!maxUid) continue; // nothing synced yet — backfill owns initial population

            let missed = 0;
            let probe = null;
            try {
              // Genuinely fresh login — NOT withFreshClient/pool, which can share the
              // frozen mailbox view. Token refresh and host/DNS resolution are bounded
              // (raceTimeout) so a hang in either can't wedge the sequential loop and, via
              // the re-entrancy guard, silently freeze the check for ALL accounts. The
              // probe socket is created only AFTER those succeed, so the finally below
              // always has a real client to close (no post-timeout connection can escape).
              const fresh = await raceTimeout(ensureFreshToken(account), 15000, 'Staleness token refresh');
              const { resolved, policy } = await raceTimeout(resolveAccountHost(fresh), 15000, 'Staleness host resolve');
              probe = new ImapFlow(makeClientCfg(fresh, resolved, { policy }));
              probe.on('error', () => {}); // avoid unhandled 'error' on abrupt close
              missed = await Promise.race([
                (async () => {
                  await probe.connect();
                  const lock = await probe.getMailboxLock('INBOX');
                  try {
                    // Filter guards the IMAP `n:*` quirk: when n exceeds the highest UID
                    // the server returns that highest UID, which is NOT above maxUid. Cap to
                    // the newest 200 — enough to prove a miss without a huge FETCH on a deep gap.
                    const above = await probe.search({ uid: `${maxUid + 1}:*` }, { uid: true });
                    const candidates = (above || []).filter(u => u > maxUid).slice(-200);
                    if (candidates.length === 0) return 0;
                    // A raw UID above the watermark is NOT proof of missed mail. Two benign
                    // cases (both documented on these accounts) would otherwise force endless
                    // reconnects of a HEALTHY connection:
                    //  - phantom UIDs the server lists but FETCH never returns (seen on iCloud):
                    //    can never be stored, so the watermark can never reach them → infinite loop.
                    //  - Message-ID dedup: a self-sent / mailing-list copy that also exists in
                    //    Sent/Archive is stored under that folder (its INBOX row was relocated by
                    //    Message-ID), so our INBOX watermark sits below the live server max even
                    //    though we HAVE the message.
                    // Confirm genuine misses: FETCH the candidates' envelopes; drop any that
                    // won't FETCH (phantom) and any whose Message-ID we already store in ANY
                    // folder (dedup). Only a fetchable message we don't already have is "missed".
                    const fetched = [];
                    for await (const m of probe.fetch(candidates.join(','), { uid: true, envelope: true }, { uid: true })) {
                      const raw = m.envelope?.messageId;
                      fetched.push(raw ? raw.replace(/[<>]/g, '').trim() : null);
                    }
                    if (fetched.length === 0) return 0; // every candidate was a phantom
                    const withMid = fetched.filter(Boolean);
                    let have = new Set();
                    if (withMid.length) {
                      // message_id is stored inconsistently (some rows keep the angle
                      // brackets, some don't) — query both forms and normalise on compare.
                      const forms = [];
                      for (const id of withMid) forms.push(id, `<${id}>`);
                      const { rows } = await query(
                        'SELECT message_id FROM messages WHERE account_id = $1 AND message_id = ANY($2::text[])',
                        [accountId, forms]
                      );
                      have = new Set(rows.map(r => r.message_id.replace(/[<>]/g, '').trim()));
                    }
                    // Fetchable + (no Message-ID, or one we don't already store) = genuinely missed.
                    return fetched.filter(mid => !(mid && have.has(mid))).length;
                  } finally { lock.release(); }
                })(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Staleness probe timeout (25s)')), 25000)),
              ]);
            } finally {
              // close() (not logout()) — destroys the socket AND aborts a still-pending
              // connect() left running by the race timeout, so a slow login can't leak an
              // authenticated session that lingers on a connection-limited server.
              if (probe) { try { probe.close(); } catch { /* already closed */ } }
            }

            if (missed === 0) continue;

            // The server holds mail above our watermark. Decide whether it's safe to tear
            // down the persistent connection:
            //  - a reconnect started, or the connection was swapped out from under us while
            //    we probed → defer; the successor owns recovery.
            if (this.connectingAccounts.has(accountId)) continue;
            if (this.connections.get(accountId) !== observed) continue;
            //  - a sync that started only moments ago may be a HEALTHY tick fetching exactly
            //    this mail and about to commit — don't churn it. A sync running longer than
            //    SYNC_HUNG_MS has hung on a half-open connection (normal syncs finish in
            //    seconds), which is exactly what must be evicted.
            const wasSyncing = this.syncingAccounts.has(accountId);
            if (wasSyncing) {
              // Fail closed: only evict a syncing account when we can PROVE the sync is hung
              // (a recorded start time older than SYNC_HUNG_MS). If the start time is missing
              // (e.g. a code path that took the sync lock without recording one) or recent,
              // treat it as a healthy in-flight tick and defer.
              const startedAt = this.syncStartedAt.get(accountId);
              if (!startedAt || Date.now() - startedAt < SYNC_HUNG_MS) continue;
            }

            console.warn(`Staleness check: ${logAccount(account)} server has ${missed} INBOX message(s) above synced UID ${maxUid} — persistent connection ${wasSyncing ? 'hung mid-sync' : 'missed mail'}, forcing reconnect`);
            this.connections.delete(accountId);
            // close() (not logout()): logout() sends a LOGOUT command that itself hangs on a
            // half-open socket, so it would NOT promptly unhang a stuck sync. close() destroys
            // the socket immediately, forcing the hung sync command to reject at once so its
            // _syncTick reaches finally and releases the sync lock before the reconnect below.
            try { observed.close(); } catch { /* already closed */ }
            // The body-fetch pool shares the same frozen/half-open fate as the deaf
            // persistent connection (same account, same server session state), so drop it
            // too. Otherwise the next body fetch hangs on a stale pooled connection until
            // its 30s command timeout before retrying — the "preview hangs then eventually
            // loads" symptom after a late-notification reconnect.
            evictPool(accountId);

            // Reconnect + catch up. If a sync was hung, the close() above makes it error and
            // release the sync lock in ~a second; _syncTick would no-op while that lock is
            // still held, so give it a brief beat first. If nothing was syncing, reconnect now.
            const reconnect = () => this._syncTick(account).catch(err =>
              console.error(`Staleness reconnect sync failed for ${logAccount(account)}:`, extractImapError(err)));
            if (wasSyncing) setTimeout(reconnect, 3000);
            else reconnect();
          } catch (err) {
            console.warn(`Staleness check error for ${accountId}:`, err.message);
          }
        }
      } finally {
        this._stalenessCheckRunning = false;
      }
    }, STALENESS_CHECK_MS);

    // Durable flag-push reconciler: re-push any read/star change whose IMAP write failed,
    // until the server confirms it. Runs below the 30s local-wins window so its per-cycle
    // marker re-bump keeps a pull from reverting the change while the retry is outstanding.
    this._flagPushReconcilerTimer = setInterval(() => {
      if (this._flagPushRunning) return;
      this._flagPushRunning = true;
      this._reconcileFlagPushes()
        .catch(err => console.error('Flag-push reconciler error:', err.message))
        .finally(() => { this._flagPushRunning = false; });
    }, FLAG_PUSH_RECONCILE_MS);
  }

  // Record a local read/star change whose immediate IMAP push failed so the reconciler
  // re-pushes it until the server confirms. Keyed by message+flag; a repeat toggle updates
  // the intended `value` and preserves the attempt count. The reconciler pushes and
  // re-asserts THIS value — never a re-read of the row, which a concurrent flag-pull could
  // have reverted (that re-read was a silent-loss bug).
  _enqueueFlagPush(accountId, messageId, flag, value) {
    if (!accountId || !messageId) return;
    let ops = this._pendingFlagPush.get(accountId);
    if (!ops) { ops = new Map(); this._pendingFlagPush.set(accountId, ops); }
    const key = `${messageId}:${flag}`;
    const existing = ops.get(key);
    ops.set(key, { messageId, flag, value: !!value, attempts: existing ? existing.attempts : 0 });
  }

  // A later push of the SAME message+flag succeeded — drop any queued op so the reconciler
  // can't re-assert/re-push a now-stale value (e.g. mark-read failed, then mark-unread
  // succeeded: the queued read=true must not resurrect).
  _resolveFlagPush(accountId, messageId, flag) {
    const ops = this._pendingFlagPush.get(accountId);
    if (!ops) return;
    const key = `${messageId}:${flag}`;
    // Mark resolved as well as delete: a reconciler cycle may already hold this op object in
    // its snapshot, parked on an await — the flag lets it bail before clobbering the newer value.
    const op = ops.get(key);
    if (op) op.resolved = true;
    ops.delete(key);
    if (ops.size === 0) this._pendingFlagPush.delete(accountId);
  }

  // Re-bump the *_changed_at marker for every pending message up-front, before any
  // (possibly slow) setFlag, so the 30s "local wins" window can't lapse mid-cycle and let
  // a concurrent pull revert an unconfirmed change.
  async _rebumpFlagMarkers(ops) {
    const readIds = [];
    const starIds = [];
    for (const op of ops.values()) {
      (op.flag === '\\Seen' ? readIds : starIds).push(op.messageId);
    }
    if (readIds.length) {
      await query('UPDATE messages SET read_changed_at = NOW() WHERE id = ANY($1::uuid[])', [readIds]).catch(() => {});
    }
    if (starIds.length) {
      await query('UPDATE messages SET star_changed_at = NOW() WHERE id = ANY($1::uuid[])', [starIds]).catch(() => {});
    }
  }

  // Clear the marker for a message+flag once the server has confirmed (or we give up), so a
  // subsequent flag-sync pull resumes reflecting the server for that message.
  async _clearFlagMarker(messageId, flag) {
    const col = flag === '\\Seen' ? 'read_changed_at' : 'star_changed_at';
    // col is a fixed internal literal (not user input) — safe to interpolate.
    await query(`UPDATE messages SET ${col} = NULL WHERE id = $1`, [messageId]).catch(() => {});
  }

  async _reconcileFlagPushes() {
    for (const [accountId, ops] of this._pendingFlagPush) {
      if (ops.size === 0) { this._pendingFlagPush.delete(accountId); continue; }

      // Hold the local-wins window for all pending messages this cycle regardless of
      // whether we can push right now.
      await this._rebumpFlagMarkers(ops);

      // Only attempt pushes while the account has a live connection; otherwise keep the
      // ops queued (markers already re-bumped) and wait for reconnect. Not counted as an
      // attempt, so an outage doesn't burn the give-up budget.
      if (!this.connections.has(accountId)) continue;

      const acct = await query('SELECT * FROM email_accounts WHERE id = $1', [accountId]);
      const account = acct.rows[0];
      if (!account) { this._pendingFlagPush.delete(accountId); continue; }

      let processed = 0;
      for (const [key, op] of [...ops]) {
        if (processed >= FLAG_PUSH_PER_CYCLE) break; // rest wait for the next cycle
        if (!ops.has(key)) continue; // resolved by a concurrent successful push mid-cycle
        processed++;
        // Re-read only uid/folder (a move changes them) + existence — NOT the flag value,
        // which we own via op.value. A concurrent pull may have reverted the row, so
        // re-assert our intended value locally (with a fresh marker) before pushing the
        // same value, so a slow cycle can never let the change be silently lost.
        const { rows: [msg] } = await query(
          'SELECT uid, folder FROM messages WHERE id = $1',
          [op.messageId]
        );
        if (!msg) { ops.delete(key); continue; } // message gone — nothing to push
        // A concurrent successful push may have resolved this op during the await above —
        // don't re-assert/re-push a now-stale value over the newer one.
        if (op.resolved) continue;
        if (op.flag === '\\Seen') {
          await query('UPDATE messages SET is_read = $1, read_changed_at = NOW() WHERE id = $2', [op.value, op.messageId]).catch(() => {});
        } else {
          await query('UPDATE messages SET is_starred = $1, star_changed_at = NOW() WHERE id = $2', [op.value, op.messageId]).catch(() => {});
        }
        try {
          await this.setFlag(account, msg.uid, msg.folder, op.flag, op.value);
          // If a newer value was pushed elsewhere while our setFlag was in flight, leave its
          // marker in place and let the pull reconcile, rather than clearing to our stale push.
          if (!op.resolved) await this._clearFlagMarker(op.messageId, op.flag); // confirmed on server
          ops.delete(key);
        } catch (err) {
          op.attempts += 1;
          if (op.attempts >= FLAG_PUSH_MAX_ATTEMPTS) {
            console.warn(`Flag-push giving up after ${op.attempts} attempts (${op.flag} msg=${op.messageId}): ${extractImapError(err)}`);
            await this._clearFlagMarker(op.messageId, op.flag); // honest revert to server truth
            ops.delete(key);
          }
          // else keep queued; marker + value re-asserted above so nothing is lost before retry
        }
      }
      if (ops.size === 0) this._pendingFlagPush.delete(accountId);
    }
  }

  // Attach the three IDLE event listeners shared by both the initial connect path
  // and the in-_syncTick reconnect path. Centralised here so a fix in one place
  // automatically covers both code paths.
  _attachIdleListeners(client, account) {
    client.on('exists', ({ count, prevCount } = {}) => {
      if ((count ?? 0) <= (prevCount ?? 0)) return;
      // Push an optimistic delta to the frontend immediately so the unread badge
      // updates without waiting for the full IMAP fetch + DB insert cycle.
      // Guard on typeof prevCount: during initial mailbox select ImapFlow may
      // emit exists with prevCount=undefined, which would produce a wrong delta.
      if (typeof count === 'number' && typeof prevCount === 'number') {
        this.broadcast(
          { type: 'exists_hint', accountId: account.id, delta: count - prevCount },
          account.user_id
        );
      }
      if (this.syncingAccounts.has(account.id)) return;
      console.log(`IMAP IDLE: new mail for ${logAccount(account)} (${prevCount} → ${count})`);
      this._syncTick(account).catch(err =>
        console.warn(`IDLE-triggered sync error for ${logAccount(account)}:`, err.message)
      );
    });
    // Flag changes (e.g. read/unread from another client) arrive as unsolicited
    // FETCH responses during IDLE. Debounce to coalesce rapid bulk changes
    // (e.g. "mark all read") into a single lightweight flags-only fetch.
    client.on('flags', () => {
      const existing = this._flagDebounceTimers.get(account.id);
      if (existing) clearTimeout(existing);
      this._flagDebounceTimers.set(account.id, setTimeout(() => {
        this._flagDebounceTimers.delete(account.id);
        console.log(`IMAP IDLE: flag change for ${logAccount(account)}, syncing flags`);
        this._syncFlagsForRange(account).catch(err =>
          console.warn(`Flag-triggered sync error for ${logAccount(account)}:`, err.message)
        );
      }, 500));
    });
    // Expunge events fire when a message is permanently deleted or moved on
    // another client. Debounce bulk operations (e.g. emptying trash sends many
    // EXPUNGE responses in rapid succession) then reconcile to remove the
    // deleted messages from the local DB.
    client.on('expunge', () => {
      const existing = this._expungeDebounceTimers.get(account.id);
      if (existing) clearTimeout(existing);
      this._expungeDebounceTimers.set(account.id, setTimeout(() => {
        this._expungeDebounceTimers.delete(account.id);
        console.log(`IMAP IDLE: expunge for ${logAccount(account)}, reconciling`);
        this.reconcileDeletes(account).catch(err =>
          console.warn(`Expunge-triggered reconcile error for ${logAccount(account)}:`, err.message)
        );
      }, 1500));
    });
  }

  async connectAccount(account) {
    // Back off if this account is in a connection-refusal cooldown. Retrying a provider that
    // is rejecting connections (per-IP/per-account limit, temporary lock) every health-check
    // tick is exactly what escalates to IP bans / account locks. The cooldown is cleared the
    // moment a connect succeeds (below), so a transient refusal recovers on its own.
    const cd = this._connectCooldown.get(account.id);
    if (cd && Date.now() < cd.until) {
      logger.debug(`connectAccount: ${logAccount(account)} cooling down ${Math.round((cd.until - Date.now()) / 1000)}s after ${cd.failures} refusal(s)`);
      return false;
    }

    // Guard against concurrent connect calls for the same account.
    // This happens when startup and a WebSocket connection both call connectAllForUser
    // before the first connectAccount completes — without this, both would connect the
    // same account in parallel, leaving one interval/client permanently orphaned.
    if (this.connectingAccounts.has(account.id)) {
      console.log(`Already connecting ${logAccount(account)}, skipping duplicate`);
      return false;
    }
    this.connectingAccounts.add(account.id);
    console.log(`Connecting ${logAccount(account)} (${account.imap_host}:${account.imap_port})…`);

    // Always clean up any existing connection and interval first.
    // Previously this only ran when a connection existed, which left orphaned
    // intervals running whenever the connection died between reconnect attempts.
    await this.disconnectAccount(account.id);

    // Refresh OAuth token if needed before connecting
    account = await ensureFreshToken(account);
    const { resolved, policy } = await resolveAccountHost(account);
    let client;
    try {
      client = new ImapFlow(makeClientCfg(account, resolved, { enableIdle: providerProfile(account).usesIdle !== false, policy }));
      // Race the connect against a 30-second timeout.
      // client.connect() has no built-in connection timeout — on slow or unresponsive
      // IMAP servers (e.g. purelymail.com during cold starts) it can hang indefinitely,
      // silently blocking all further retries because connectingAccounts still holds the lock.
      await Promise.race([
        client.connect(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('IMAP connection timeout (30s)')), 30000)
        ),
      ]);

      // Remove from active connections the moment the server closes the socket.
      // Without this, a cleanly-closed connection lingers in this.connections and
      // every subsequent sync call either hangs (half-open TCP) or throws immediately.
      client.on('close', () => {
        if (this.connections.get(account.id) === client) {
          this.connections.delete(account.id);
          console.log(`IMAP connection closed for ${logAccount(account)}`);
        }
      });
      // Prevent unhandled 'error' events from crashing the Node.js process.
      // ImapFlow emits 'error' on socket timeouts and other transport-level failures;
      // without this listener Node throws on unhandled EventEmitter errors.
      client.on('error', (err) => {
        console.error(`IMAP error for ${logAccount(account)}:`, err.message);
      });
      this._attachIdleListeners(client, account);
      this.connections.set(account.id, client);
      await query('UPDATE email_accounts SET sync_error = NULL WHERE id = $1', [account.id]);

      // Initial sync is non-fatal — throttling or temporary IMAP errors here should
      // not prevent the account from being marked connected. The 60-second interval
      // will retry the sync on the next tick.
      try {
        await raceTimeout(this.syncFolders(account, client), 20000, 'Initial folder sync');
        // noBodyParts=true: consistent with the periodic sync — envelope/flags/uid only.
        // Fetching body parts on initial connect stalls on slow servers (purelymail et al).
        if (providerProfile(account).freshInboxSync) {
          await this._syncInboxWithFreshLogin(account);
        } else {
          await raceTimeout(
            this.syncMessages(account, client, 'INBOX', 20, false, true),
            40000,
            'Initial message sync',
          );
        }
      } catch (syncErr) {
        console.warn(`Initial sync skipped for ${logAccount(account)}: ${extractImapError(syncErr)}`);
      }

      // Pre-warm one pool connection immediately so the first email click doesn't
      // incur a cold TLS handshake. Fire-and-forget — errors are non-fatal. Skip it for
      // providers whose body fetches bypass the pool anyway (preferFreshBodyFetch, e.g.
      // PurelyMail): there it only opens an unused connection on a connection-sensitive
      // server during the startup backfill window, which is exactly the pressure we're
      // trying to reduce.
      if (!providerProfile(account).preferFreshBodyFetch) {
        setImmediate(() => {
          acquirePooledClient(account)
            .then(c => releasePooledClient(account, c))
            .catch(err => console.warn(`Pool pre-warm failed for ${logAccount(account)}:`, err.message));
        });
      }

      // Backfill uses its OWN connection so it doesn't block the sync connection.
      // backfillAllFolders runs INBOX first, then all other known folders sequentially.
      if (await this._shouldAutoBackfillOnConnect(account)) {
        this.backfillAllFolders(account).catch(err =>
          console.error(`Backfill error for ${logAccount(account)}:`, err.message)
        );
      } else {
        logger.debug(`Backfill deferred on connect for ${logAccount(account)} — account already has cached mail`);
      }

      const intervalMs = this.userSyncIntervalMs.get(account.user_id) || 60000;
      this._startSyncInterval(account, intervalMs);
      // Only gtd_enabled accounts arm a GTD tick — a non-GTD account starts no extra
      // timer at all, so the whole tick stays inert when nobody uses GTD. (Enabling GTD
      // on a live account takes effect on its next reconnect.)
      if (account.gtd_enabled) this._startGtdSyncInterval(account);

      this._connectCooldown.delete(account.id); // healthy again — clear any refusal cooldown
      console.log(`Connected account: ${logAccount(account)}`);
      this.broadcast({ type: 'account_connected', accountId: account.id }, account.user_id);
      return true;
    } catch (err) {
      const detail = extractImapError(err);
      console.error(`Failed to connect ${logAccount(account)}:`, detail);
      // On a connection-refusal/throttle, back this account off with growing delay so we
      // stop hammering a provider that's at its limit. Other errors don't set a cooldown —
      // the health check retries them normally.
      if (isConnectionRefusal(detail)) this._noteConnectionRefusal(account);
      await query('UPDATE email_accounts SET sync_error = $1 WHERE id = $2', [detail, account.id]);
      this.broadcast({ type: 'account_error', accountId: account.id, error: detail }, account.user_id);
      return false;
    } finally {
      // Always release the in-progress lock so future attempts (e.g. manual reconnect) can proceed
      this.connectingAccounts.delete(account.id);
    }
  }

  async disconnectAccount(accountId) {
    const timer = this.syncIntervals.get(accountId);
    // clearTimeout works for both setTimeout and setInterval Timeout objects in Node.js
    if (timer) { clearTimeout(timer); this.syncIntervals.delete(accountId); }
    const gtdTimer = this.gtdSyncIntervals.get(accountId);
    if (gtdTimer) { clearTimeout(gtdTimer); this.gtdSyncIntervals.delete(accountId); }
    const client = this.connections.get(accountId);
    if (client) {
      try { await client.logout(); } catch { /* already disconnected */ }
      this.connections.delete(accountId);
    }
    this.syncThrottleSkips.delete(accountId);
    this.syncTickCount.delete(accountId);
    this.lastSyncOkAt.delete(accountId);
    this._pendingFlagSync.delete(accountId);
    const flagTimer = this._flagDebounceTimers.get(accountId);
    if (flagTimer) { clearTimeout(flagTimer); this._flagDebounceTimers.delete(accountId); }
    const expungeTimer = this._expungeDebounceTimers.get(accountId);
    if (expungeTimer) { clearTimeout(expungeTimer); this._expungeDebounceTimers.delete(accountId); }
    evictPool(accountId);
  }

  async disconnectUser(userId) {
    try {
      const result = await query(
        "SELECT id FROM email_accounts WHERE user_id = $1 AND protocol = 'imap'",
        [userId]
      );
      await Promise.all(result.rows.map(a => this.disconnectAccount(a.id)));
    } catch (err) {
      console.error(`disconnectUser error for user ${userId}:`, err.message);
    }
  }

  // Arm/extend an account's connection-refusal backoff. Shared by connectAccount, the
  // interval reconnect, AND the fresh-login sync path so all three back off identically
  // instead of hammering a provider that's at its connection limit. Returns the delay in ms.
  _noteConnectionRefusal(account) {
    const failures = (this._connectCooldown.get(account.id)?.failures || 0) + 1;
    const ms = connectCooldownMs(failures);
    this._connectCooldown.set(account.id, { until: Date.now() + ms, failures });
    console.warn(`Connection refused for ${logAccount(account)} — backing off ${Math.round(ms / 1000)}s (refusal #${failures})`);
    return ms;
  }

  async _syncInboxWithFreshLogin(account) {
    let client = null;
    try {
      const fresh = await raceTimeout(ensureFreshToken(account), 15000, 'Fresh sync token refresh');
      const { resolved, policy } = await raceTimeout(resolveAccountHost(fresh), 15000, 'Fresh sync host resolve');
      client = new ImapFlow(makeClientCfg(fresh, resolved, { policy }));
      client.on('error', () => {}); // close() below intentionally aborts timed-out sockets
      await raceTimeout(client.connect(), 30000, 'Fresh sync connect');
      // syncMessages' own CONDSTORE modseq check is the "did anything change?" gate: it returns
      // cheaply when HIGHESTMODSEQ is unchanged, and runs the delta fetch on ANY change. We used
      // to pre-gate on a UID-watermark search here, but that only detected NEW mail — a flag
      // change (read/star on another device) has no new UID, so it was skipped entirely and the
      // desktop stayed stale until a manual refresh. modseq bumps on flag changes too, so
      // deferring the decision to syncMessages catches them.
      return await raceTimeout(
        this.syncMessages(account, client, 'INBOX', 20, false, true),
        55000,
        'Fresh sync wall-clock',
      );
    } finally {
      if (client) { try { client.close(); } catch { /* already closed */ } }
    }
  }

  async _shouldAutoBackfillOnConnect(account) {
    const profile = providerProfile(account);
    if (profile.autoBackfillExistingOnConnect !== false) return true;
    const existing = await query('SELECT 1 FROM messages WHERE account_id = $1 LIMIT 1', [account.id]);
    return existing.rows.length === 0;
  }

  // Extracted sync tick — runs on every interval tick for an account.
  async _syncTick(account) {
    const skips = this.syncThrottleSkips.get(account.id) || 0;
    if (skips > 0) {
      this.syncThrottleSkips.set(account.id, skips - 1);
      return;
    }
    if (this.syncingAccounts.has(account.id)) return;
    this.syncingAccounts.add(account.id);
    this.syncStartedAt.set(account.id, Date.now());
    let activeClient = null;
    let usedFreshSyncClient = false;
    let syncResult;
    try {
      activeClient = this.connections.get(account.id);
      // syncAccount tracks the freshest account data available — updated to freshAccount
      // on reconnect so that IDLE listeners, provider detection, and flag syncs all use
      // current credentials and config rather than the stale closure-captured object.
      let syncAccount = account;
      if (!activeClient) {
        // Respect the connection-refusal cooldown — the 60s sync interval must NOT hammer a
        // provider that's rejecting connections just because the socket dropped. connectAccount
        // and the health check honor the same cooldown; this closes the interval bypass.
        const cd = this._connectCooldown.get(account.id);
        if (cd && Date.now() < cd.until) return;
        // Participate in the same lock as connectAccount()/health-check so a
        // concurrent reconnect can't create a second client that overwrites and
        // orphans this one (which would leak the IMAP connection + IDLE listeners).
        if (this.connectingAccounts.has(account.id)) return; // another path is reconnecting; skip this tick
        this.connectingAccounts.add(account.id);
        console.log(`Reconnecting ${logAccount(account)}...`);
        // Kept outside the race so a timeout can force-close a half-open client.
        let pendingClient = null;
        try {
          // One overall timeout guards the ENTIRE reconnect. The DB query, token refresh
          // and host resolution below are otherwise un-timeout-guarded; a hang in any of
          // them would never reach the finally, leaving connectingAccounts set — which
          // silently freezes both future sync ticks (the skip guard above) and the health
          // check (it skips accounts mid-connect) for this account until the await
          // eventually resolves. 40s covers a slow connect (~30s) plus the setup steps.
          const reconnected = await Promise.race([
            (async () => {
              const accountResult = await query('SELECT * FROM email_accounts WHERE id = $1', [account.id]);
              // Bail if the account was deleted OR disabled since this reconnect was queued.
              // The staleness check schedules a reconnect via setTimeout that disconnectAccount
              // cannot cancel, so a user disabling a stuck account must not be silently revived.
              if (!accountResult.rows.length || !accountResult.rows[0].enabled) return null;
              const freshAccount = await ensureFreshToken(accountResult.rows[0]);
              const { resolved, policy } = await resolveAccountHost(freshAccount);
              pendingClient = new ImapFlow(makeClientCfg(freshAccount, resolved, { enableIdle: providerProfile(freshAccount).usesIdle !== false, policy }));
              await pendingClient.connect();
              return { client: pendingClient, account: freshAccount };
            })(),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('Reconnect timeout (40s)')), 40000)
            ),
          ]);
          if (!reconnected) return; // account deleted mid-reconnect
          activeClient = reconnected.client;
          syncAccount = reconnected.account;
          activeClient.on('close', () => {
            if (this.connections.get(account.id) === activeClient) {
              this.connections.delete(account.id);
            }
          });
          activeClient.on('error', (err) => {
            console.error(`IMAP error for ${logAccount(syncAccount)}:`, err.message);
          });
          this._attachIdleListeners(activeClient, syncAccount);
          this.connections.set(account.id, activeClient);
          // Mirror connectAccount's success cleanup: clear the refusal backoff so the next
          // failure starts fresh, and clear the stale sync_error the UI is still showing.
          this._connectCooldown.delete(account.id);
          await query('UPDATE email_accounts SET sync_error = NULL WHERE id = $1', [account.id]);
          console.log(`Reconnected ${logAccount(syncAccount)}`);
        } catch (reconnErr) {
          const detail = extractImapError(reconnErr);
          // Back off on a connection-refusal so the interval stops hammering — mirrors connectAccount.
          if (isConnectionRefusal(detail)) this._noteConnectionRefusal(account);
          console.error(`Reconnect failed for ${logAccount(account)}:`, detail);
          // Force-close a client left mid-connect when the timeout fired so it doesn't
          // linger as an orphaned socket.
          if (pendingClient) pendingClient.logout().catch(() => {});
          return;
        } finally {
          this.connectingAccounts.delete(account.id);
        }
      }
      // Honor the connection-refusal cooldown on the sync path itself, not just on reconnect.
      // freshInboxSync providers (PurelyMail) keep the persistent connection open and sync via
      // a brand-new login every tick, so a refused fresh login never passes through the
      // reconnect gate above — without this check the 10s poll would keep hammering a provider
      // that's rejecting logins. Cleared on any healthy sync (below) and on a good reconnect.
      const syncCd = this._connectCooldown.get(account.id);
      if (syncCd && Date.now() < syncCd.until) return;
      // noBodyParts=true: envelope/flags/uid only — avoids slow servers timing out on body fetches.
      // PurelyMail's long-lived sessions can go "deaf" while a brand-new login sees current
      // mail; use a fresh login for the periodic backstop so missed IDLE events are caught on
      // the user's sync interval instead of waiting for the 3-minute staleness probe.
      if (providerProfile(syncAccount).freshInboxSync) {
        usedFreshSyncClient = true;
        syncResult = await this._syncInboxWithFreshLogin(syncAccount);
      } else {
        // Wall-clock timeout guards against half-open TCP sockets that never trigger commandTimeout.
        syncResult = await Promise.race([
          this.syncMessages(syncAccount, activeClient, 'INBOX', 20, false, true),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Sync wall-clock timeout (55s)')), 55000)
          ),
        ]);
      }
      // Mark a successful sync tick — the health check uses this to spot a connected
      // account whose syncs have silently stalled (stale/half-open connection).
      this.lastSyncOkAt.set(account.id, Date.now());
      // Healthy again — clear any refusal backoff so the failure count resets and a later
      // refusal starts from the base delay rather than a still-escalated one. No-op when unset.
      this._connectCooldown.delete(account.id);
      if ((syncResult?.insertedCount || 0) > 0 && !syncResult?.broadcastedNewMessages) {
        this.broadcast({ type: 'sync_complete', accountId: account.id }, account.user_id);
      }

      const ticks = (this.syncTickCount.get(account.id) || 0) + 1;
      this.syncTickCount.set(account.id, ticks);

      // Some providers (e.g. Google) don't push flag changes via IDLE — poll on the
      // provider's configured cadence. Others (Dovecot, iCloud) push via `flags`,
      // but if a flag event fired while this sync was running it was deferred into
      // _pendingFlagSync rather than dropped — drain it now.
      const hasPending = this._pendingFlagSync.has(account.id);
      const syncProfile = providerProfile(syncAccount);
      const flagPollEvery = Math.max(1, Number(syncProfile.flagPollEveryTicks) || 1);
      if ((!syncProfile.pushesFlags && ticks % flagPollEvery === 0) || hasPending) {
        this._pendingFlagSync.delete(account.id);
        setImmediate(() => {
          this._syncFlagsForRange(syncAccount).catch(err =>
            console.warn(`Post-sync flags error for ${logAccount(syncAccount)}:`, err.message)
          );
        });
      }

      // Reconcile remote deletes every 10 successful ticks (~10 min at 60 s interval).
      // Uses a pooled connection so it never blocks the sync client.
      if (ticks % 10 === 0) {
        setImmediate(() => {
          this.reconcileDeletes(syncAccount).catch(err =>
            console.error(`Reconcile error for ${logAccount(syncAccount)}:`, err.message)
          );
        });
      }
    } catch (err) {
      const detail = extractImapError(err);
      console.error(`Sync error for ${logAccount(account)}:`, detail);
      if (detail.includes('THROTTLED') || detail.includes('throttl')) {
        this.syncThrottleSkips.set(account.id, 4);
      }
      // A refusal on the sync path (notably the fresh-login poll, which never reaches the
      // reconnect gate) must arm the same backoff the connect paths use — otherwise the poll
      // keeps hammering a provider that's refusing logins. Honored by the check above next tick.
      if (isConnectionRefusal(detail)) this._noteConnectionRefusal(account);
      // Identity-guard: the staleness check may have deleted this connection out from
      // under a hung sync, and a fresh reconnect (health check / another tick) may already
      // occupy the map slot. Only tear down the client THIS tick owned — never a healthy
      // successor connection.
      const dead = this.connections.get(account.id);
      if (!usedFreshSyncClient && dead && dead === activeClient) {
        this.connections.delete(account.id);
        dead.logout().catch(() => {});
      }
    } finally {
      this.syncingAccounts.delete(account.id);
      this.syncStartedAt.delete(account.id);
    }
  }

  // Bulk-apply is_read/is_starred from a fetched {uid, isRead, isStarred}[] onto existing rows
  // in `folder`. Preserves the 30-second optimistic-change guard so a just-made local read/star
  // isn't clobbered by a stale server value, and only touches rows whose flags actually differ.
  // Returns the number of rows changed. Shared by _syncFlagsForRange and the delta flag scan so
  // the flag-conflict logic lives in exactly one place.
  async _applyFlagUpdates(account, folder, flagsToUpdate) {
    if (!flagsToUpdate.length) return 0;
    const uids    = flagsToUpdate.map(f => f.uid);
    const reads   = flagsToUpdate.map(f => f.isRead);
    const starred = flagsToUpdate.map(f => f.isStarred);
    const result = await query(`
      UPDATE messages SET
        is_read = CASE
          WHEN messages.read_changed_at IS NOT NULL
               AND NOW() - messages.read_changed_at < interval '30 seconds'
          THEN messages.is_read
          ELSE updates.is_read
        END,
        is_starred = CASE
          WHEN messages.star_changed_at IS NOT NULL
               AND NOW() - messages.star_changed_at < interval '30 seconds'
          THEN messages.is_starred
          ELSE updates.is_starred
        END
      FROM (
        SELECT unnest($1::bigint[])  AS uid,
               unnest($2::boolean[]) AS is_read,
               unnest($3::boolean[]) AS is_starred
      ) AS updates
      WHERE messages.account_id = $4
        AND messages.folder = $5
        AND messages.uid = updates.uid
        AND (
          (
            messages.star_changed_at IS NULL
            OR NOW() - messages.star_changed_at >= interval '30 seconds'
          ) AND messages.is_starred != updates.is_starred
          OR (
            messages.read_changed_at IS NULL
            OR NOW() - messages.read_changed_at >= interval '30 seconds'
          ) AND messages.is_read != updates.is_read
        )`,
      [uids, reads, starred, account.id, folder]
    );
    return result.rowCount;
  }

  // Lightweight flag-only sync: fetch uid+flags for the last 200 messages in INBOX
  // and bulk-update is_read / is_starred in the DB.
  //
  // Uses a POOL connection (not the sync connection) so it never contends with
  // the persistent sync client or disrupts its IDLE cycle.
  //
  // Called in two paths:
  //   1. IMAP IDLE `flags` event — debounced 500 ms (covers Dovecot, iCloud, PurelyMail)
  //   2. After every _syncTick for Gmail — Gmail does not push flag changes via IDLE
  async _syncFlagsForRange(account) {
    // If a full sync is running, queue this for after the sync completes rather than
    // dropping it. Phase 2 only covers the last 20 messages; IDLE flag events for
    // messages 21-200 would be silently lost without this.
    if (this.syncingAccounts.has(account.id)) {
      this._pendingFlagSync.add(account.id);
      return;
    }

    try {
      await withFreshClient(account, async (client) => {
        const lock = await client.getMailboxLock('INBOX');
        try {
          const mailbox = client.mailbox;
          if (!mailbox || !mailbox.exists) return;

          const seqCount = 200;
          const fetchRange = mailbox.exists > seqCount
            ? `${mailbox.exists - seqCount + 1}:${mailbox.exists}`
            : '1:*';

          const flagsToUpdate = [];
          for await (const msg of client.fetch(fetchRange, { uid: true, flags: true })) {
            flagsToUpdate.push({
              uid: msg.uid,
              isRead: msg.flags.has('\\Seen'),
              isStarred: msg.flags.has('\\Flagged'),
            });
          }

          if (flagsToUpdate.length === 0) return;

          const changed = await this._applyFlagUpdates(account, 'INBOX', flagsToUpdate);
          if (changed > 0) {
            console.log(`Flag sync: ${changed} flag change(s) for ${logAccount(account)}, broadcasting`);
            this.broadcast({ type: 'flags_synced', accountId: account.id }, account.user_id);
            // A read/star flip on an INBOX row changes GTD-relevant state (section thread-unread
            // counts, the Inbox pill badge, two-way GTD entry star). This reactive/poll flag path is a
            // mutation the periodic GTD tick — which syncs only the label folders, never INBOX —
            // won't otherwise surface, so refresh GTD section data like the other mutation paths. Gated:
            // inert for non-GTD accounts (cached config). See emitGtdSectionsRefreshIfEnabled.
            await emitGtdSectionsRefreshIfEnabled(this, account, changed);
          }
        } finally {
          lock.release();
        }
      });
    } catch (err) {
      console.warn(`Flag range sync error for ${logAccount(account)}:`, err.message);
    }
  }

  _startSyncInterval(account, ms) {
    ms = effectiveSyncIntervalMs(account, ms);
    // Stagger the first tick by a random offset within [0, min(ms, 30s)] so that
    // many accounts starting simultaneously (e.g. after a container restart) don't
    // all hit their mail servers at the same instant.
    const jitter = Math.floor(Math.random() * Math.min(ms, 30000));
    const t = setTimeout(() => {
      if (!this.syncIntervals.has(account.id)) return; // disconnected during jitter window
      this._syncTick(account);
      const interval = setInterval(() => this._syncTick(account), ms);
      this.syncIntervals.set(account.id, interval);
    }, jitter);
    this.syncIntervals.set(account.id, t);
  }

  // Arm the periodic GTD label-folder tick for a gtd_enabled account. Mirrors
  // _startSyncInterval (jittered first fire, then a steady interval) and shares the same
  // disconnect teardown. Only ever called for gtd_enabled accounts, so nothing schedules
  // when GTD is off.
  _startGtdSyncInterval(account) {
    const jitter = Math.floor(Math.random() * Math.min(GTD_SYNC_INTERVAL_MS, 30000));
    const t = setTimeout(() => {
      if (!this.gtdSyncIntervals.has(account.id)) return; // disconnected during jitter window
      runGtdSyncTick(this, account);
      const interval = setInterval(() => runGtdSyncTick(this, account), GTD_SYNC_INTERVAL_MS);
      this.gtdSyncIntervals.set(account.id, interval);
    }, jitter);
    this.gtdSyncIntervals.set(account.id, t);
  }

  // Cheap change fingerprint for one folder's rows. Advances when a row is inserted,
  // removed, moved in/out, or flipped read/unread — enough to decide whether a GTD tick
  // changed anything worth telling GTD section clients about. SUM(uid) catches same-count membership
  // churn (one in, one out) that COUNT alone would miss.
  async _gtdFolderFingerprint(accountId, folder) {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS n,
              COUNT(*) FILTER (WHERE NOT is_read)::int AS unread,
              COALESCE(SUM(uid), 0)::text AS uidsum,
              COALESCE(MAX(uid), 0)::text AS maxuid
       FROM messages
       WHERE account_id = $1 AND folder = $2 AND is_deleted = false`,
      [accountId, folder]
    );
    const r = rows[0] || {};
    return `${r.n}:${r.unread}:${r.uidsum}:${r.maxuid}`;
  }

  // One label folder's pooled-connection sync for a GTD tick — pulled out of the tick loop
  // (like _gtdFolderFingerprint) so runGtdSyncTick can mock this away in tests instead of
  // exercising a live IMAP pool. Behavior is unchanged from the tick's former inline call.
  async _gtdSyncFolder(account, folder) {
    return withFreshClient(account, (client) =>
      this.syncMessages(account, client, folder, 100, false, true));
  }

  // Called when a user changes their sync interval preference — replaces running
  // intervals for all their active accounts without disconnecting.
  async updateSyncIntervalForUser(userId, newMs) {
    this.userSyncIntervalMs.set(userId, newMs);
    const result = await query(
      "SELECT * FROM email_accounts WHERE user_id = $1 AND enabled = true AND protocol = 'imap'",
      [userId]
    );
    for (const acc of result.rows) {
      if (this.syncIntervals.has(acc.id)) {
        clearTimeout(this.syncIntervals.get(acc.id));
        this.syncIntervals.delete(acc.id);
        this._startSyncInterval(acc, newMs);
      }
    }
  }

  async syncFolders(account, client) {
    try {
      const mailboxes = await client.list();
      for (const mb of mailboxes) {
        await query(`
          INSERT INTO folders (account_id, path, name, delimiter, special_use)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (account_id, path) DO UPDATE
          SET name = $3, special_use = $5, updated_at = NOW()
        `, [account.id, mb.path, mb.name, mb.delimiter, mb.specialUse || null]);
      }
      // Many IMAP servers omit INBOX from LIST responses (it is implicit per RFC 3501).
      // Without a row in folders, subfolders like INBOX/Work have no parent in the map
      // and fall to the sidebar root instead of nesting correctly.
      if (!mailboxes.some(mb => mb.path === 'INBOX')) {
        const delimiter = mailboxes[0]?.delimiter || '/';
        await query(`
          INSERT INTO folders (account_id, path, name, delimiter, special_use)
          VALUES ($1, 'INBOX', 'INBOX', $2, NULL)
          ON CONFLICT (account_id, path) DO NOTHING
        `, [account.id, delimiter]);
      }
    } catch (err) {
      console.error(`Folder sync error for ${logAccount(account)}:`, err.message);
    }
  }

  // prefetchBody: fetch and cache message bodies during sync.
  // Set to false for the initial connect sync to avoid stalling on slow IMAP servers
  // (e.g. purelymail.com times out fetching 8 body parts × 50 messages).
  // Periodic interval syncs set this to true so bodies get cached incrementally.
  //
  // Gmail is treated specially: body parts are never fetched during sync because Gmail
  // throttles heavily on BODY[] requests.  Messages still appear in the list (metadata
  // comes from ENVELOPE); snippets and bodies are populated by the backfill instead.
  // noBodyParts: skip ALL body part fetches (uid/flags/envelope/bodyStructure only).
  // Used for the periodic sync interval so slow servers like purelymail.com don't time out
  // fetching 3+ body parts × 50 messages.  Snippets come from backfill or on-demand fetches.
  async syncMessages(account, client, folder = 'INBOX', limit = 50, prefetchBody = true, noBodyParts = false) {
    const provider = providerProfile(account);

    try {
      const lock = await client.getMailboxLock(folder);
      try {
        const mailbox = client.mailbox;
        if (!mailbox || mailbox.exists === 0) return { insertedCount: 0, broadcastedNewMessages: false };

        // UIDVALIDITY check — detects server-side mailbox rebuilds (migration, restore).
        // If UIDVALIDITY changed, all stored UIDs for this folder are invalid; purge them
        // and let backfill re-populate from the new UID epoch.
        const currentValidity = mailbox.uidValidity ? Number(mailbox.uidValidity) : null;
        // CONDSTORE HIGHESTMODSEQ read at SELECT time (M). ImapFlow auto-enables CONDSTORE on
        // connect, so this is populated on any server that supports it and null otherwise —
        // in which case delta sync transparently falls back to the full UID/sequence phases.
        // Kept as a BigInt (or null); never coerced to a JS Number (modseq can exceed 2^53).
        const serverModseq = mailbox.highestModseq ?? null;
        let storedModseq = null;        // decimal string from the DB, or null (no baseline yet)
        let uidValidityChanged = false; // true resets the modseq baseline (epoch changed)
        if (currentValidity) {
          const foldRow = await query(
            'SELECT uid_validity, highest_modseq FROM folders WHERE account_id = $1 AND path = $2',
            [account.id, folder]
          );
          const storedValidity = foldRow.rows[0]?.uid_validity ? Number(foldRow.rows[0].uid_validity) : null;
          storedModseq = foldRow.rows[0]?.highest_modseq ?? null;
          if (storedValidity !== null && storedValidity !== currentValidity) {
            uidValidityChanged = true;
            console.warn(`UIDVALIDITY changed for ${logAccount(account)}/${folder}: ${storedValidity} → ${currentValidity}. Purging stale messages and re-backfilling.`);
            const purged = await query('DELETE FROM messages WHERE account_id = $1 AND folder = $2', [account.id, folder]);
            // The stored modseq belongs to the OLD UIDVALIDITY epoch and is no longer
            // comparable — clear it so the next sync re-seeds cleanly from the new epoch.
            await query('UPDATE folders SET highest_modseq = NULL WHERE account_id = $1 AND path = $2', [account.id, folder]);
            storedModseq = null;
            // A UIDVALIDITY purge drops every row for this folder — including any GTD thread's copy
            // here — so refresh GTD section data like the other sync-delete paths. Backfill re-populates
            // below; the emit just avoids a stale gap. See emitGtdSectionsRefreshOnDelete.
            await emitGtdSectionsRefreshOnDelete(this, account, purged.rowCount);
            // Route through the per-host backfill cap too: a provider-side mailbox rebuild
            // can reset UIDVALIDITY across many accounts/folders at once, which would
            // otherwise flood connections on exactly the many-account-per-provider setup the
            // cap protects. Acquire at the call site (not inside backfillMessages) —
            // backfillAllFolders already holds the slot while calling it per folder, so an
            // internal acquire would self-deadlock at the limit.
            const reindexHost = (account.imap_host || '').toLowerCase();
            setImmediate(async () => {
              await this._backfillSem.acquire(reindexHost);
              try {
                await this.backfillMessages(account, folder);
              } catch (err) {
                console.error(`Post-UIDVALIDITY backfill error for ${logAccount(account)}/${folder}:`, err.message);
              } finally {
                this._backfillSem.release(reindexHost);
              }
            });
          }
        }

        // mailbox.unseen from IMAP SELECT is the sequence number of the first unseen
        // message, NOT the count of unread messages.  Compute the real count from the
        // messages table instead — accurate post-backfill and never inflated.
        const { rows: [ucRow] } = await query(
          `SELECT COUNT(*) FILTER (WHERE is_read = false) AS n FROM messages WHERE account_id = $1 AND folder = $2`,
          [account.id, folder]
        );
        const dbUnreadCount = parseInt(ucRow.n || 0);
        await query(`
          INSERT INTO folders (account_id, path, name, total_count, unread_count, uid_validity)
          VALUES ($1, $2, $2, $3, $4, $5)
          ON CONFLICT (account_id, path) DO UPDATE
          SET total_count = $3, unread_count = $4, uid_validity = COALESCE($5, folders.uid_validity), updated_at = NOW()
        `, [account.id, folder, mailbox.exists, dbUnreadCount, currentValidity]);

        // Omit body parts for providers that throttle BODY[] fetches, and when
        // noBodyParts is set. Envelope/flags/uid/bodyStructure always fetched.
        const fetchQuery = {
          uid: true, flags: true, envelope: true,
          bodyStructure: true,
          size: true,
          internalDate: true,
          headers: true,
        };
        if (provider.fetchBody && !noBodyParts) {
          fetchQuery.bodyParts = BODY_PREFETCH_PARTS;
        }

        // Highest UID we already have in DB for this account/folder — used as the
        // watermark for Phase 1 new-message detection.
        const { rows: [{ max_uid }] } = await query(
          'SELECT COALESCE(MAX(uid), 0) as max_uid FROM messages WHERE account_id = $1 AND folder = $2',
          [account.id, folder]
        );
        const maxKnownUid = Number(max_uid);

        let newMessages = [];
        let insertedCount = 0;
        let broadcastedNewMessages = false;

        // GTD re-evaluation candidates: the id of every row this sync newly inserts into INBOX,
        // read or unread. Kept separate from `newMessages` (which is unread-only for
        // notifications) because an inbound reply already \Seen on another device must still
        // clear its thread's Watch/Delegated label. `gtdDeletedIds` collects only the ids the
        // block-list / inbox rules genuinely DELETED (expunged / dropped) from INBOX, so they can
        // be excluded below; a rule-MOVED reply is intentionally kept — its thread still needs
        // re-evaluating even though the reply was filed elsewhere.
        const gtdNewInboxIds = [];
        const gtdDeletedIds = new Set();

        // Designated GTD folder paths for this account (empty when GTD is off).
        // Loaded once per sync — the config is cached — so the relocate guard
        // keeps a GTD-labeled message's sibling rows instead of collapsing them
        // onto whichever folder synced last. See relocateMessageQuery / gtdRelocateGuard.
        const gtdFolderPaths = [...(await getGtdFolderSet(account.id))];

        // Insert/update a single fetched message and track it as new if appropriate.
        // Called from both Phase 1 and Phase 2; ON CONFLICT handles deduplication so
        // a message processed in both phases is never double-counted.
        const processMsg = async (msg) => {
          try {
            const parsed = await parseMessage(msg);
            enrichParsedMetadata(parsed, {
              accountEmail: account.email_address,
              accountName: account.name,
              senderName: account.sender_name,
              folderPath: folder,
              sentFolderPath: account.folder_mappings?.sent,
            });
            if (!parsed.uid) {
              console.warn(`Message sync skipped: IMAP FETCH returned no UID for ${account.email}/${folder}`);
              return;
            }
            let safeHtml = null, text = null, atts = [];
            if (prefetchBody && provider.fetchBody) {
              const body = extractBodyFromMsg(msg);
              safeHtml = body.html ? sanitizeEmail(body.html) : null;
              text = body.text;
              atts = body.attachments;
            }
            const msgId = sanitizeStr(parsed.messageId);
            const inReplyTo = sanitizeStr(parsed.inReplyTo);
            const refs = sanitizeStr(parsed.references);
            const threadId = await computeThreadId(account.id, msgId, inReplyTo, refs, sanitizeStr(parsed.subject));

            // If a row with this message_id already exists for this account at a
            // different (folder, uid), it was moved. Relocate it in-place rather
            // than inserting a duplicate. The COUNT=1 guard prevents incorrectly
            // merging Gmail's virtual-folder copies (same message_id in INBOX and
            // [Gmail]/All Mail simultaneously).
            if (msgId) {
              const { sql: relocateSql, params: relocateParams } =
                relocateMessageQuery(folder, parsed, account.id, msgId, gtdFolderPaths);
              const relocated = await query(relocateSql, relocateParams);
              if (relocated.rows.length > 0) return;
            }

            let msgCategory = null;
            if (account.categorization_enabled || await getGlobalCategorizationEnabled(account.user_id)) {
              try {
                const socialDomains = await loadSocialDomains(account.user_id);
                msgCategory = classifyMessage(parsed.parsedHeaders, parsed.fromEmail, socialDomains);
                if (msgCategory === 'primary') msgCategory = null;
              } catch { /* non-fatal — leave category NULL */ }
            }

            const result = await query(`
              INSERT INTO messages (
                account_id, uid, folder, message_id, subject,
                from_name, from_email, to_addresses, cc_addresses,
                reply_to, in_reply_to,
                date, snippet, is_read, is_starred, has_attachments, flags,
                body_html, body_text, attachments,
                thread_references, thread_id, is_bulk, category,
                list_unsubscribe, list_unsubscribe_post
              ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
              ON CONFLICT (account_id, uid, folder) DO UPDATE
              SET subject = CASE
                    WHEN EXCLUDED.subject IS NOT NULL
                         AND EXCLUDED.subject != ''
                         AND EXCLUDED.subject != '(no subject)'
                    THEN EXCLUDED.subject
                    ELSE messages.subject
                  END,
                  from_name = COALESCE(NULLIF(EXCLUDED.from_name, ''), messages.from_name),
                  from_email = COALESCE(NULLIF(EXCLUDED.from_email, ''), messages.from_email),
                  to_addresses = CASE
                    WHEN EXCLUDED.to_addresses::text IS NOT NULL AND EXCLUDED.to_addresses::text <> '[]'
                    THEN EXCLUDED.to_addresses
                    ELSE messages.to_addresses
                  END,
                  cc_addresses = CASE
                    WHEN EXCLUDED.cc_addresses::text IS NOT NULL AND EXCLUDED.cc_addresses::text <> '[]'
                    THEN EXCLUDED.cc_addresses
                    ELSE messages.cc_addresses
                  END,
                  reply_to = COALESCE(NULLIF(messages.reply_to::text, '[]'), EXCLUDED.reply_to::text)::jsonb,
                  in_reply_to = COALESCE(messages.in_reply_to, EXCLUDED.in_reply_to),
                  snippet = CASE WHEN EXCLUDED.snippet != '' THEN EXCLUDED.snippet
                                 ELSE messages.snippet END,
                  is_read = CASE
                    WHEN messages.read_changed_at IS NOT NULL
                         AND NOW() - messages.read_changed_at < interval '30 seconds'
                    THEN messages.is_read
                    ELSE EXCLUDED.is_read
                  END,
                  is_starred = CASE
                    WHEN messages.star_changed_at IS NOT NULL
                         AND NOW() - messages.star_changed_at < interval '30 seconds'
                    THEN messages.is_starred
                    ELSE EXCLUDED.is_starred
                  END,
                  flags = $17,
                  body_html = COALESCE(messages.body_html, EXCLUDED.body_html),
                  body_text = COALESCE(messages.body_text, EXCLUDED.body_text),
                  attachments = COALESCE(messages.attachments::text, EXCLUDED.attachments::text)::jsonb,
                  thread_references = COALESCE(messages.thread_references, EXCLUDED.thread_references),
                  thread_id = COALESCE(messages.thread_id, EXCLUDED.thread_id),
                  is_bulk = COALESCE(messages.is_bulk, EXCLUDED.is_bulk),
                  category = COALESCE(messages.category, EXCLUDED.category),
                  list_unsubscribe = COALESCE(messages.list_unsubscribe, EXCLUDED.list_unsubscribe),
                  list_unsubscribe_post = COALESCE(messages.list_unsubscribe_post, EXCLUDED.list_unsubscribe_post)
              RETURNING id, (xmax = 0) as is_new
            `, [
              account.id, parsed.uid, folder,
              msgId, sanitizeStr(parsed.subject),
              sanitizeStr(parsed.fromName), sanitizeStr(parsed.fromEmail),
              JSON.stringify(parsed.to), JSON.stringify(parsed.cc),
              JSON.stringify(parsed.replyTo || []), inReplyTo,
              safeDate(parsed.date), sanitizeStr(parsed.snippet),
              parsed.isRead, parsed.isStarred,
              parsed.hasAttachments, JSON.stringify(parsed.flags),
              sanitizeStr(safeHtml), sanitizeStr(text), JSON.stringify(atts || []),
              refs, threadId, parsed.isBulk ?? null, msgCategory,
              sanitizeStr(decodeMimeWords(parsed.parsedHeaders?.['list-unsubscribe'] ?? null)),
              sanitizeStr(decodeMimeWords(parsed.parsedHeaders?.['list-unsubscribe-post'] ?? null)),
            ]);
            if (result.rows[0]?.is_new) {
              insertedCount++;
              // GTD candidate: any newly-inserted INBOX row, read OR unread (read state is not a
              // gate here — see selectGtdReevalIds). The unread-only push below still drives
              // notifications. Gated on gtd_enabled so a non-GTD account builds nothing extra.
              if (folder === 'INBOX' && account.gtd_enabled) {
                gtdNewInboxIds.push(result.rows[0].id);
              }
              if (!parsed.isRead) {
                newMessages.push({ ...parsed, id: result.rows[0].id, accountId: account.id, folder });
              }
            }
            // Propagate resolved thread_id to any earlier messages that used this
            // message as a provisional thread root (out-of-order delivery / sync).
            if (threadId && threadId !== msgId) {
              await query(
                `UPDATE messages SET thread_id = $1
                 WHERE account_id = $2 AND thread_id = $3 AND message_id != $3`,
                [threadId, account.id, msgId]
              );
            }
          } catch (parseErr) {
            console.error('Message sync parse error:', parseErr.message);
          }
        };

        // Fetch strategy. CRITICAL: new-mail detection is the UID-watermark phase below, which
        // ALWAYS runs and never depends on the CONDSTORE modseq. The modseq only gates the more
        // expensive flag-change scan. This is deliberate — a modseq that is stale or has wrongly
        // advanced must NEVER cause missed mail. New mail always carries a UID above everything
        // we already hold, so the UID watermark catches it regardless of what the modseq says.
        const plan = planModseqSync({ storedModseq, serverModseq, uidValidityChanged });

        // ── New-mail phase — ALWAYS runs (modseq-independent safety net). Fetches only UIDs
        // above the highest we already have — usually just the newest message, then a no-op
        // upsert. Skipped only on first sync (maxKnownUid=0), where backfill owns population.
        if (maxKnownUid > 0) {
          try {
            for await (const msg of client.fetch(`${maxKnownUid + 1}:*`, fetchQuery, { uid: true })) {
              await processMsg(msg);
            }
          } catch (err) {
            if (!extractImapError(err).toLowerCase().includes('invalid messageset')) throw err;
            // UID range became stale due to concurrent expunge between SELECT and FETCH.
            // Non-fatal — next sync will catch up.
            console.warn(`New-mail sync skipped for ${logAccount(account)}/${folder}: stale UID range after concurrent expunge`);
          }
        }

        // ── Flag/metadata-change scan — the expensive part, gated by modseq. Covers changes to
        // EXISTING messages (read/star on another device), which the UID phase above cannot see.
        // Bounded by FLAG_SCAN_TIMEOUT_MS: if a throttled connection makes it crawl, we DEFER it
        // (flagScanComplete=false) and skip advancing the watermark, so it retries next tick with
        // nothing lost — rather than burning the whole-sync budget and forcing a reconnect.
        let flagScanComplete = true;
        if (plan === 'delta') {
          // Flag-only scan. The only thing that changes on an EXISTING message is its flags
          // (read/star) — new mail is the UID phase's job — so fetch just uid+flags over a recent
          // UID window and bulk-apply. Deliberately lightweight: iCloud advertises CONDSTORE (so
          // we land here) but IGNORES changedSince and returns the WHOLE window; with uid+flags
          // that is a cheap fetch + one bulk UPDATE (~a second) instead of thousands of full-
          // envelope fetches and upserts. changedSince still trims the set on servers that honor
          // it (PurelyMail, Gmail). A tiny mailbox clamps to 1:* anyway.
          const deltaLow = Math.max(1, maxKnownUid - DELTA_SCAN_UID_WINDOW + 1);
          const deltaStartedAt = Date.now();
          const flagsToUpdate = [];
          try {
            const scan = (async () => {
              for await (const msg of client.fetch(`${deltaLow}:*`, { uid: true, flags: true }, { uid: true, changedSince: BigInt(storedModseq) })) {
                flagsToUpdate.push({ uid: msg.uid, isRead: msg.flags.has('\\Seen'), isStarred: msg.flags.has('\\Flagged') });
              }
            })();
            // If the timeout wins the race, the fetch keeps running until ImapFlow's commandTimeout
            // aborts it — swallow that late rejection so it isn't an unhandled rejection.
            scan.catch(() => {});
            const outcome = await Promise.race([
              scan,
              new Promise(res => setTimeout(() => res(FLAG_SCAN_TIMED_OUT), FLAG_SCAN_TIMEOUT_MS)),
            ]);
            if (outcome === FLAG_SCAN_TIMED_OUT) {
              flagScanComplete = false;
              console.warn(`Delta flag scan deferred for ${logAccount(account)}/${folder}: over ${FLAG_SCAN_TIMEOUT_MS}ms (provider throttling) — retrying next tick`);
            }
          } catch (err) {
            if (!extractImapError(err).toLowerCase().includes('invalid messageset')) throw err;
            // Range became stale mid-scan — defer the watermark so the next sync retries.
            flagScanComplete = false;
            console.warn(`Delta flag scan skipped for ${logAccount(account)}/${folder}: stale range after concurrent expunge`);
          }
          // Apply ONLY on a complete scan: a deferred scan's list is still being mutated by the
          // abandoned background fetch (reading it would race) and its watermark isn't advanced,
          // so the next tick redoes it. A flag change has no new_messages event of its own, so a
          // flags_synced nudge lets a read-elsewhere reflect live instead of staying stale.
          if (flagScanComplete) {
            const changed = await this._applyFlagUpdates(account, folder, flagsToUpdate);
            logger.debug(`Delta flag scan OK for ${logAccount(account)}/${folder}: ${flagsToUpdate.length} fetched, ${changed} changed in ${Date.now() - deltaStartedAt}ms (uid>=${deltaLow}), modseq ${storedModseq}->${serverModseq}`);
            if (changed > 0) {
              this.broadcast({ type: 'flags_synced', accountId: account.id }, account.user_id);
              // Externally-changed flags on a GTD-designated folder's rows now flow through this new
              // delta path (per-folder flag deltas). A read/star flip on a label-folder OR INBOX copy
              // is GTD-relevant, so refresh GTD section data like the other mutation paths rather than waiting
              // for the next tick. Gated: inert for non-GTD accounts. See emitGtdSectionsRefreshIfEnabled.
              await emitGtdSectionsRefreshIfEnabled(this, account, changed);
            }
          }
        } else if (plan === 'full') {
          // No usable modseq baseline (first sync, UIDVALIDITY reset, or a server without
          // CONDSTORE): scan recent messages by sequence for flag changes. Re-read exists from
          // the live connection — ImapFlow may have decremented it if an EXPUNGE arrived during
          // the UID phase, making a range captured at SELECT time stale. The watermark is seeded
          // below so subsequent syncs can go delta.
          const liveExists = client.mailbox?.exists ?? 0;
          const phase2Range = liveExists > limit
            ? `${liveExists - limit + 1}:${liveExists}` : '1:*';
          try {
            const scan = (async () => {
              for await (const msg of client.fetch(phase2Range, fetchQuery)) {
                await processMsg(msg);
              }
            })();
            scan.catch(() => {}); // see the delta branch — swallow a post-timeout late rejection
            const outcome = await Promise.race([
              scan,
              new Promise(res => setTimeout(() => res(FLAG_SCAN_TIMED_OUT), FLAG_SCAN_TIMEOUT_MS)),
            ]);
            if (outcome === FLAG_SCAN_TIMED_OUT) {
              flagScanComplete = false;
              console.warn(`Sequence flag scan deferred for ${logAccount(account)}/${folder}: over ${FLAG_SCAN_TIMEOUT_MS}ms (provider throttling) — retrying next tick`);
            }
          } catch (err) {
            if (!extractImapError(err).toLowerCase().includes('invalid messageset')) throw err;
            // Sequence range became stale mid-scan — defer the watermark; next sync retries.
            flagScanComplete = false;
            console.warn(`Message sync sequence scan skipped for ${logAccount(account)}/${folder}: stale sequence range after concurrent expunge`);
          }
        }
        // plan === 'unchanged': modseq confirms no flag/new changes so the flag scan is skipped;
        // the UID new-mail phase above still ran as the safety net.

        // Advance the CONDSTORE watermark ONLY after a COMPLETE flag scan (not deferred by the
        // timeout, not aborted mid-range), storing the value read at SELECT time (M). Mail arriving
        // mid-scan has modseq > M and is re-caught next tick — over-fetching is harmless, but
        // advancing past an incomplete scan would drop those flag changes. Skipped when nothing
        // changed (already equal) and on a UIDVALIDITY reset (reseed from the new epoch instead).
        if (serverModseq != null && !uidValidityChanged && plan !== 'unchanged' && flagScanComplete) {
          await query(
            'UPDATE folders SET highest_modseq = $1 WHERE account_id = $2 AND path = $3',
            [serverModseq.toString(), account.id, folder]
          );
        }

        if (newMessages.length > 0) {
          // mutedIds: messages that had a mark_read rule applied and stayed in INBOX.
          // Push and client-side sound/toast are skipped for these so mark_read rules
          // don't still alert the user about mail they chose to auto-silence.
          let mutedIds = new Set();
          if (folder === 'INBOX') {
            // Snapshot the unread candidates before the block-list / rules run, so the GTD
            // re-eval below can exclude any they move out of INBOX. Only needed when GTD is on.
            const gtdUnreadBefore = account.gtd_enabled ? newMessages.map(m => m.id) : null;
            try {
              newMessages = await applyBlockList(newMessages, account, this);
            } catch (err) {
              console.error('blockList error:', err.message);
            }
            try {
              const rulesResult = await applyInboxRules(newMessages, account, this);
              newMessages = rulesResult.remaining;
              mutedIds = rulesResult.mutedIds;
            } catch (err) {
              console.error('inboxRules error:', err.message);
            }
            // Any unread candidate no longer in `newMessages` was moved out of / deleted from
            // INBOX by the block-list or a rule. Only genuinely-DELETED ones are excluded from
            // the GTD re-eval: a rule that merely MOVED an inbound reply (its row still lives,
            // in another folder) must still re-evaluate the thread so a self-reply's Watch/
            // Delegated label clears. Distinguish the two by a single is_deleted probe over the
            // removed ids — a moved row survives (is_deleted = false), a deleted one does not.
            if (gtdUnreadBefore) {
              const survivingIds = new Set(newMessages.map(m => m.id));
              const removedIds = gtdUnreadBefore.filter(id => !survivingIds.has(id));
              if (removedIds.length) {
                const alive = await query(
                  'SELECT id FROM messages WHERE id = ANY($1::uuid[]) AND is_deleted = false',
                  [removedIds]
                );
                const aliveIds = new Set(alive.rows.map(r => r.id));
                for (const id of removedIds) {
                  if (!aliveIds.has(id)) gtdDeletedIds.add(id);
                }
              }
            }
          }
          // alertMessages: remaining messages not silenced by a mark_read rule.
          const alertMessages = newMessages.filter(m => !mutedIds.has(m.id));
          const alertCount = alertMessages.length;
          if (newMessages.length > 0) this.broadcast({
            type: 'new_messages', accountId: account.id,
            folder, messages: newMessages.slice(-5), count: newMessages.length,
            alertMessages: alertMessages.slice(-5), alertCount,
          }, account.user_id);
          if (newMessages.length > 0) broadcastedNewMessages = true;
          // Web Push — INBOX only, alert-eligible messages only. Non-inbox folder syncs
          // (Archive, Spam, on-demand) can surface old or filtered messages; sending push
          // for them or for mark_read-silenced messages would be misleading.
          // Fire-and-forget: push errors are non-fatal.
          if (folder === 'INBOX' && alertMessages.length > 0) {
            const latest = alertMessages[alertMessages.length - 1];
            const basePayload = {
              title: latest.fromName || latest.fromEmail || 'New mail',
              body: alertCount === 1
                ? (latest.subject || '(no subject)')
                : `${alertCount} new messages`,
              icon: '/icon-512.png',
              // Deep-link the notification to the latest message (the notification's
              // tag collapses arrivals into one card representing `latest`). Guarded:
              // fall back to the inbox if the id is somehow absent.
              url: latest.id ? `/?m=${latest.id}` : '/',
            };
            // Try to include the total unread count for the home screen badge.
            // If the query fails for any reason, send the push without it so
            // notifications are never silently dropped.
            query(
              `SELECT COUNT(*)::int AS total FROM messages m
               JOIN email_accounts a ON a.id = m.account_id
               WHERE a.user_id = $1 AND a.enabled = true AND m.folder = 'INBOX' AND m.is_read = false AND m.is_deleted = false`,
              [account.user_id]
            ).then(r => {
              sendPushToUser(account.user_id, { ...basePayload, unreadCount: r.rows[0]?.total ?? 0 })
                .catch(err => console.warn('Push notification error:', err.message));
            }).catch(() => {
              sendPushToUser(account.user_id, basePayload)
                .catch(err => console.warn('Push notification error:', err.message));
            });
          }
          // Pre-warm the body cache for newly arrived messages so clicking one
          // immediately after receipt doesn't require a live IMAP fetch.
          // Only do this for small batches (periodic new mail, not initial bulk sync),
          // and let provider profiles cap or disable the work when BODY[] is sensitive.
          const prefetchProfile = providerProfile(account);
          if (newMessages.length <= 5 && prefetchProfile.prefetchNewBodies !== false) {
            const warmLimit = Math.max(1, Number(prefetchProfile.prefetchNewBodiesLimit) || newMessages.length);
            const msgsToCache = newMessages.slice(-warmLimit);
            setImmediate(() => {
              this.prefetchNewMessageBodies(account, msgsToCache)
                .catch(err => console.warn(`Body prefetch error for ${logAccount(account)}:`, err.message));
            });
          }

          // Auto-learn senders from new inbound mail (fire-and-forget).
          // Only runs for INBOX; skips bulk and robot senders.
          if (folder === 'INBOX') {
            const inboundSenders = newMessages.filter(m =>
              m.fromEmail &&
              (m.isBulk !== true) &&
              !/^(noreply|no-reply|donotreply|mailer-daemon|notifications?|bounce[^@]*)@/i.test(m.fromEmail)
            );
            if (inboundSenders.length) {
              setImmediate(() => {
                this.upsertAutoContacts(account.user_id, inboundSenders)
                  .catch(err => console.warn(`Auto-contact error for ${logAccount(account)}:`, err.message));
              });
            }
          }
        }

        // GTD transitions: re-evaluate every newly-arrived INBOX thread, independent of the
        // unread notification path above — an inbound reply that arrived already \Seen (read
        // on another device) never enters `newMessages`, so it must be picked up from the
        // read-inclusive candidate set. Excludes rows the block-list / rules moved or deleted.
        // Runs even when `newMessages` is empty (all arrivals were already read). Gated on
        // gtd_enabled so a non-GTD account issues zero extra queries.
        if (folder === 'INBOX' && account.gtd_enabled) {
          const gtdIds = selectGtdReevalIds(gtdNewInboxIds, gtdDeletedIds);
          if (gtdIds.length > 0) {
            try {
              const threadKeys = await threadKeysForMessageIds(account.id, gtdIds);
              await runGtdTransitions(this, account, threadKeys);
            } catch (err) {
              console.error('gtdTransitions error:', err.message);
            }
          }
        }
        await query('UPDATE email_accounts SET last_sync = NOW() WHERE id = $1', [account.id]);
        return { insertedCount, broadcastedNewMessages };
      } finally {
        lock.release();
      }
    } catch (err) {
      console.error(`Message sync error for ${logAccount(account)}/${folder}:`, extractImapError(err));
      throw err;
    }
  }

  // Backfill uses its own dedicated connection — never touches the sync connection or pool.
  //
  // Design:
  //   1. SEARCH ALL → get every UID on the server in one command (stable; UIDs don't change
  //      when messages are deleted, unlike sequence numbers which shift).
  //   2. SELECT uid FROM messages → get UIDs we already have in DB.
  //   3. Diff → fetch only truly missing UIDs, newest-first so recent mail is available
  //      quickly even on a fresh account with tens of thousands of messages.
  //   4. For non-Gmail providers also store body_html/body_text during backfill so
  //      clicking an old email never needs a live IMAP round-trip.
  async backfillMessages(account, folder = 'INBOX') {
    const backfillKey = `${account.id}:${folder}`;
    if (this.backfillRunning.has(backfillKey)) return;
    this.backfillRunning.add(backfillKey);

    // Spread into a local copy so per-run mutations (e.g. batchSize reduction on rate-limit)
    // don't permanently modify the shared PROVIDERS singleton for other accounts.
    const cfg = { ...providerProfile(account) };

    // Designated GTD folder paths for this account (empty when GTD is off).
    // Loaded once per backfill — the config is cached — so the relocate guard
    // keeps GTD-labeled messages' sibling rows. See relocateMessageQuery / gtdRelocateGuard.
    const gtdFolderPaths = [...(await getGtdFolderSet(account.id))];

    // Dedicated connection managed here — completely independent of the shared pool
    // so backfilling never blocks the user from opening emails.
    let bfClient = null;
    let batchesOnConn = 0;

    const openBfClient = async () => {
      // Always clean up any existing client before creating a new one
      if (bfClient) { try { await bfClient.logout(); } catch { /* already disconnected */ } bfClient = null; }
      const row = (await query('SELECT * FROM email_accounts WHERE id = $1', [account.id])).rows[0];
      // Re-check enabled here: a backfill can sit queued behind the per-host semaphore, and
      // the user may disable the account while it waits. disconnectAccount doesn't cancel a
      // queued backfill, so without this a disabled account would still get a fresh connection.
      if (!row || !row.enabled) throw new Error('Account deleted or disabled');
      const fresh = await ensureFreshToken(row);
      const { resolved, policy } = await resolveAccountHost(fresh);
      const newClient = new ImapFlow(makeClientCfg(fresh, resolved, { policy }));
      newClient.on('error', (err) => {
        console.error(`Backfill IMAP error for ${logAccount(account)}:`, err.message);
      });
      await Promise.race([
        newClient.connect(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('IMAP connection timeout (30s)')), 30000)
        ),
      ]); // if this throws, bfClient stays null
      bfClient = newClient;
      batchesOnConn = 0;
    };

    try {
      // DB-only pre-check: if this folder has a stored uid_validity (meaning a
      // previous backfill connected and verified it) and the DB message count is
      // at least as large as the cached folder total, skip opening a connection.
      // syncMessages handles new arrivals via IDLE and the periodic sync interval;
      // backfill is only needed for historical gaps and first-time population.
      // A false skip is self-correcting: the next reconnect or explicit sync will
      // re-evaluate, and syncMessages independently checks UIDVALIDITY changes.
      const folderMeta = await query(
        'SELECT uid_validity, total_count FROM folders WHERE account_id = $1 AND path = $2',
        [account.id, folder]
      );
      const meta = folderMeta.rows[0];
      if (meta?.uid_validity && meta.total_count > 0) {
        const countRow = await query(
          'SELECT COUNT(*) AS n FROM messages WHERE account_id = $1 AND folder = $2 AND is_deleted = false',
          [account.id, folder]
        );
        if (Number(countRow.rows[0].n) >= Number(meta.total_count)) {
          logger.debug(`Backfill skipped for ${logAccount(account)}/${folder} — DB pre-check: ${countRow.rows[0].n} msgs ≥ cached total ${meta.total_count}`);
          return;
        }
      }

      console.log(`Starting backfill for ${logAccount(account)}/${folder} (batch=${cfg.batchSize}, delay=${cfg.batchDelay}ms, fetchBody=${cfg.fetchBody})`);
      await openBfClient();

      // Step 1 — ask the server for every UID in the mailbox.
      // UID SEARCH ALL is a single lightweight command that returns a flat list of
      // integers — no message data transferred, even for 50 000-message mailboxes.
      let serverUids;
      {
        const lock = await bfClient.getMailboxLock(folder);
        try {
          const totalExists = bfClient.mailbox?.exists || 0;
          if (totalExists === 0) {
            logger.debug(`Backfill ${logAccount(account)}: mailbox empty`);
            await query(
              'UPDATE folders SET total_count = 0, unread_count = 0 WHERE account_id = $1 AND path = $2',
              [account.id, folder]
            ).catch(() => {});
            return;
          }
          serverUids = await bfClient.search({ all: true }, { uid: true });

          // UIDVALIDITY check — if this backfill connection sees a different epoch than
          // what is stored, purge stale rows so the diff below re-fetches everything.
          const currentValidity = bfClient.mailbox?.uidValidity ? Number(bfClient.mailbox.uidValidity) : null;
          if (currentValidity) {
            const foldRow = await query(
              'SELECT uid_validity FROM folders WHERE account_id = $1 AND path = $2',
              [account.id, folder]
            );
            const storedValidity = foldRow.rows[0]?.uid_validity ? Number(foldRow.rows[0].uid_validity) : null;
            if (storedValidity !== null && storedValidity !== currentValidity) {
              console.warn(`Backfill: UIDVALIDITY changed for ${logAccount(account)}/${folder}: ${storedValidity} → ${currentValidity}. Purging stale messages.`);
              const purged = await query('DELETE FROM messages WHERE account_id = $1 AND folder = $2', [account.id, folder]);
              // Same GTD section-data staleness gap as the syncMessages purge path.
              await emitGtdSectionsRefreshOnDelete(this, account, purged.rowCount);
            }
            // Always keep stored validity current
            await query(
              'UPDATE folders SET uid_validity = $1 WHERE account_id = $2 AND path = $3',
              [currentValidity, account.id, folder]
            );
          }
        } finally {
          lock.release();
        }
      }

      const serverTotal = serverUids.length;

      // Early-exit check using max UID rather than row count.
      // Row-count comparison is unreliable: mailflow retains deleted messages in the DB
      // so dbCount can exceed serverTotal even when new messages have arrived with
      // higher UIDs.  Comparing the highest UID we have against the server's highest
      // UID is correct because IMAP UIDs are monotonically increasing — if our max
      // matches the server's max, there is nothing new to fetch.
      const dbSummaryResult = await query(
        'SELECT COUNT(*) as count, COALESCE(MAX(uid), 0) as max_uid FROM messages WHERE account_id = $1 AND folder = $2 AND is_deleted = false',
        [account.id, folder]
      );
      const dbCount = parseInt(dbSummaryResult.rows[0].count);
      const maxDbUid = Number(dbSummaryResult.rows[0].max_uid);
      // serverUids from UID SEARCH ALL are in ascending order per IMAP RFC 3501
      const maxServerUid = serverUids.length > 0 ? serverUids[serverUids.length - 1] : 0;

      // Both conditions must hold: we have the newest message (max UID matches) AND
      // we have at least as many messages as the server.  Checking only max UID is
      // insufficient — syncMessages always fetches the most-recent N messages, so
      // maxDbUid == maxServerUid even when thousands of older messages are missing.
      if (maxServerUid > 0 && maxDbUid >= maxServerUid && dbCount >= serverTotal) {
        console.log(`Backfill already complete for ${logAccount(account)}: maxDbUid=${maxDbUid}, maxServerUid=${maxServerUid}, dbCount=${dbCount}`);
        return;
      }

      // Step 2 — load UIDs we already have so we can diff precisely.
      // Even for 47 000 messages this query is fast (uid is indexed) and the
      // resulting Set uses ~4 MB of memory at most.
      // IMPORTANT: node-postgres returns BIGINT columns as strings, but ImapFlow
      // returns UIDs as JavaScript numbers. Convert to Number so the Set.has()
      // comparison works correctly. IMAP UIDs are 32-bit unsigned integers so
      // they are always within JavaScript's safe integer range (< 2^53).
      const existingRows = await query(
        'SELECT uid FROM messages WHERE account_id = $1 AND folder = $2',
        [account.id, folder]
      );
      const existingUids = new Set(existingRows.rows.map(r => Number(r.uid)));

      // Step 3 — compute missing UIDs, newest-first so recent mail is accessible fast.
      const missingUids = serverUids
        .filter(uid => !existingUids.has(uid))
        .sort((a, b) => b - a);

      if (missingUids.length === 0) {
        console.log(`Backfill ${logAccount(account)}: no missing UIDs (${dbCount} in DB vs ${serverTotal} on server — within tolerance)`);
        // Still reconcile folder counts — they may be stale if a previous backfill was interrupted.
        await query(
          `UPDATE folders
           SET total_count  = (SELECT COUNT(*)                                FROM messages m WHERE m.account_id = $1 AND m.folder = $2),
               unread_count = (SELECT COUNT(*) FILTER (WHERE is_read = false)  FROM messages m WHERE m.account_id = $1 AND m.folder = $2)
           WHERE account_id = $1 AND path = $2`,
          [account.id, folder]
        ).catch(() => {});
        return;
      }

      console.log(`Backfill ${logAccount(account)}: ${missingUids.length} missing of ${serverTotal} (${dbCount} already in DB)`);
      this.broadcast({
        type: 'backfill_progress', accountId: account.id,
        synced: dbCount, total: serverTotal,
      }, account.user_id);

      // Step 4 — fetch missing UIDs in batches using UID FETCH (stable, regardless of
      // concurrent deletions).  For non-Gmail providers also fetch and cache the full
      // message body so opening old emails doesn't need a live IMAP connection.
      // For Gmail (cfg.fetchBody=false): skip ALL body parts to avoid IMAP throttling.
      // Messages still appear in the list via envelope metadata; bodies load on-demand.
      const bodyParts = cfg.fetchBody ? BODY_PREFETCH_PARTS : [];
      let consecutiveErrors = 0;
      let i = 0;
      // Count rows this backfill actually wrote (inserts + relocations) so GTD section data can be
      // refreshed once at completion when the account is gtd_enabled — the tick's fingerprint
      // can't see rows backfill already wrote (before==after). See emitGtdSectionsRefreshIfEnabled.
      let backfilledRows = 0;

      while (i < missingUids.length) {
        // Stop immediately if the account was deleted while backfilling
        const accountCheck = await query('SELECT id FROM email_accounts WHERE id = $1', [account.id]);
        if (!accountCheck.rows.length) {
          console.log(`Backfill stopping — account ${logAccount(account)} was deleted`);
          return;
        }

        // Periodically reconnect to keep connections fresh and pick up refreshed OAuth tokens
        if (batchesOnConn >= cfg.batchesPerConn) {
          try { await openBfClient(); }
          catch (reconnErr) {
            console.error(`Backfill reconnect failed for ${logAccount(account)}:`, reconnErr.message);
            await new Promise(r => setTimeout(r, cfg.errorDelay));
            continue; // retry same batch after delay
          }
        }

        const batch = missingUids.slice(i, i + cfg.batchSize);
        // Comma-separated UID list — e.g. "1234,5678,9012"
        const uidSet = batch.join(',');

        try {
          const lock = await bfClient.getMailboxLock(folder);
          try {
            // Third arg { uid: true } issues UID FETCH instead of sequence FETCH.
            // bodyParts omitted for Gmail (empty array) — metadata only, no throttling.
            const bfQuery = {
              uid: true, flags: true, envelope: true,
              bodyStructure: true, size: true,
              internalDate: true,
              headers: true,
            };
            if (bodyParts.length > 0) bfQuery.bodyParts = bodyParts;

            for await (const msg of bfClient.fetch(uidSet, bfQuery, { uid: true })) {
              try {
                const parsed = await parseMessage(msg);
                enrichParsedMetadata(parsed, {
                  accountEmail: account.email_address,
                  accountName: account.name,
                  senderName: account.sender_name,
                  folderPath: folder,
                  sentFolderPath: account.folder_mappings?.sent,
                });
                if (!parsed.uid) {
                  console.warn(`Backfill skipped: IMAP FETCH returned no UID for ${account.email}/${folder}`);
                  continue;
                }
                let safeHtml = null, bodyText = null, atts = [];

                if (cfg.fetchBody) {
                  const body = extractBodyFromMsg(msg);
                  safeHtml = body.html ? sanitizeEmail(body.html) : null;
                  bodyText = body.text;
                  atts = body.attachments;
                }

                const bfMsgId    = sanitizeStr(parsed.messageId);
                const bfReplyTo  = sanitizeStr(parsed.inReplyTo);
                const bfRefs     = sanitizeStr(parsed.references);
                const bfThreadId = await computeThreadId(account.id, bfMsgId, bfReplyTo, bfRefs, sanitizeStr(parsed.subject));

                if (bfMsgId) {
                  const { sql: relocateSql, params: relocateParams } =
                    relocateMessageQuery(folder, parsed, account.id, bfMsgId, gtdFolderPaths);
                  const relocated = await query(relocateSql, relocateParams);
                  if (relocated.rows.length > 0) { backfilledRows += relocated.rows.length; continue; }
                }

                let bfCategory = null;
                if (account.categorization_enabled || await getGlobalCategorizationEnabled(account.user_id)) {
                  try {
                    const socialDomains = await loadSocialDomains(account.user_id);
                    bfCategory = classifyMessage(parsed.parsedHeaders, parsed.fromEmail, socialDomains);
                    if (bfCategory === 'primary') bfCategory = null;
                  } catch { /* non-fatal */ }
                }

                await query(`
                  INSERT INTO messages (
                    account_id, uid, folder, message_id, subject,
                    from_name, from_email, to_addresses, cc_addresses,
                    reply_to, in_reply_to,
                    date, snippet, is_read, is_starred, has_attachments, flags,
                    body_html, body_text, attachments,
                    thread_references, thread_id, is_bulk, category,
                    list_unsubscribe, list_unsubscribe_post
                  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
                  ON CONFLICT (account_id, uid, folder) DO UPDATE
                  SET subject = CASE
                        WHEN EXCLUDED.subject IS NOT NULL
                             AND EXCLUDED.subject != ''
                             AND EXCLUDED.subject != '(no subject)'
                        THEN EXCLUDED.subject
                        ELSE messages.subject
                      END,
                      from_name = COALESCE(NULLIF(EXCLUDED.from_name, ''), messages.from_name),
                      from_email = COALESCE(NULLIF(EXCLUDED.from_email, ''), messages.from_email),
                      to_addresses = CASE
                        WHEN EXCLUDED.to_addresses::text IS NOT NULL AND EXCLUDED.to_addresses::text <> '[]'
                        THEN EXCLUDED.to_addresses
                        ELSE messages.to_addresses
                      END,
                      cc_addresses = CASE
                        WHEN EXCLUDED.cc_addresses::text IS NOT NULL AND EXCLUDED.cc_addresses::text <> '[]'
                        THEN EXCLUDED.cc_addresses
                        ELSE messages.cc_addresses
                      END,
                      reply_to = COALESCE(NULLIF(messages.reply_to::text, '[]'), EXCLUDED.reply_to::text)::jsonb,
                      in_reply_to = COALESCE(messages.in_reply_to, EXCLUDED.in_reply_to),
                      snippet = CASE WHEN EXCLUDED.snippet != '' THEN EXCLUDED.snippet
                                     ELSE messages.snippet END,
                      is_read = CASE
                        WHEN messages.read_changed_at IS NOT NULL
                             AND NOW() - messages.read_changed_at < interval '30 seconds'
                        THEN messages.is_read
                        ELSE EXCLUDED.is_read
                      END,
                      is_starred = CASE
                        WHEN messages.star_changed_at IS NOT NULL
                             AND NOW() - messages.star_changed_at < interval '30 seconds'
                        THEN messages.is_starred
                        ELSE EXCLUDED.is_starred
                      END,
                      flags = EXCLUDED.flags,
                      body_html = COALESCE(messages.body_html, EXCLUDED.body_html),
                      body_text = COALESCE(messages.body_text, EXCLUDED.body_text),
                      attachments = COALESCE(messages.attachments::text, EXCLUDED.attachments::text)::jsonb,
                      thread_references = COALESCE(messages.thread_references, EXCLUDED.thread_references),
                      thread_id = COALESCE(messages.thread_id, EXCLUDED.thread_id),
                      is_bulk = COALESCE(messages.is_bulk, EXCLUDED.is_bulk),
                      category = COALESCE(messages.category, EXCLUDED.category),
                      list_unsubscribe = COALESCE(messages.list_unsubscribe, EXCLUDED.list_unsubscribe),
                      list_unsubscribe_post = COALESCE(messages.list_unsubscribe_post, EXCLUDED.list_unsubscribe_post)
                `, [
                  account.id, parsed.uid, folder,
                  bfMsgId, sanitizeStr(parsed.subject),
                  sanitizeStr(parsed.fromName), sanitizeStr(parsed.fromEmail),
                  JSON.stringify(parsed.to), JSON.stringify(parsed.cc),
                  JSON.stringify(parsed.replyTo || []), bfReplyTo,
                  safeDate(parsed.date), sanitizeStr(parsed.snippet),
                  parsed.isRead, parsed.isStarred,
                  parsed.hasAttachments, JSON.stringify(parsed.flags),
                  sanitizeStr(safeHtml), sanitizeStr(bodyText), JSON.stringify(atts || []),
                  bfRefs, bfThreadId, parsed.isBulk ?? null, bfCategory,
                  sanitizeStr(decodeMimeWords(parsed.parsedHeaders?.['list-unsubscribe'] ?? null)),
                  sanitizeStr(decodeMimeWords(parsed.parsedHeaders?.['list-unsubscribe-post'] ?? null)),
                ]);
                backfilledRows++;
                if (bfThreadId && bfThreadId !== bfMsgId) {
                  await query(
                    `UPDATE messages SET thread_id = $1
                     WHERE account_id = $2 AND thread_id = $3 AND message_id != $3`,
                    [bfThreadId, account.id, bfMsgId]
                  );
                }
              } catch (parseErr) {
                console.error('Backfill parse error:', parseErr.message);
              }
            }
          } finally {
            lock.release();
          }

          i += batch.length;
          batchesOnConn++;
          consecutiveErrors = 0;

          // Log progress every 10 batches to avoid log spam
          if (batchesOnConn % 10 === 1 || i >= missingUids.length) {
            console.log(`Backfill ${logAccount(account)}: ${i}/${missingUids.length} missing fetched`);
            this.broadcast({
              type: 'backfill_progress', accountId: account.id,
              synced: dbCount + i, total: serverTotal,
            }, account.user_id);
          }

          await new Promise(r => setTimeout(r, cfg.batchDelay));

        } catch (err) {
          consecutiveErrors++;
          const detail = extractImapError(err);
          // Discard the broken connection — openBfClient will reconnect next iteration
          if (bfClient) { try { await bfClient.logout(); } catch { /* already disconnected */ } bfClient = null; }
          batchesOnConn = cfg.batchesPerConn; // force reconnect

          if (consecutiveErrors >= 3) {
            // Persistent failures — halve the batch size to reduce load on the server
            // rather than skipping messages entirely (which would leave permanent gaps).
            const oldSize = cfg.batchSize;
            cfg.batchSize = Math.max(10, Math.floor(cfg.batchSize / 2));
            console.warn(`Backfill reducing batch size for ${logAccount(account)}: ${oldSize} → ${cfg.batchSize} after 3 failures (${detail})`);
            consecutiveErrors = 0;
            await new Promise(r => setTimeout(r, cfg.batchDelay));
          } else {
            const wait = cfg.errorDelay * Math.min(consecutiveErrors, 6);
            console.error(`Backfill batch error for ${logAccount(account)}: ${detail} — retry ${consecutiveErrors}/3 after ${wait}ms`);
            await new Promise(r => setTimeout(r, wait));
            // Do NOT advance i — retry the same batch
          }
        }
      }

      console.log(`Backfill complete for ${logAccount(account)}/${folder}`);
      // Backfill inserts rows directly without going through adjustFolderCounts,
      // so folder counters would stay at 0 without this reconciliation step.
      await query(
        `UPDATE folders
         SET total_count  = (SELECT COUNT(*)                                FROM messages m WHERE m.account_id = $1 AND m.folder = $2),
             unread_count = (SELECT COUNT(*) FILTER (WHERE is_read = false)  FROM messages m WHERE m.account_id = $1 AND m.folder = $2)
         WHERE account_id = $1 AND path = $2`,
        [account.id, folder]
      ).catch(err => console.error(`Folder count update after backfill failed for ${logAccount(account)}/${folder}:`, err.message));
      this.broadcast({ type: 'backfill_complete', accountId: account.id }, account.user_id);
      // Backfill wrote rows the GTD tick's fingerprint can't detect (before==after); if this
      // folder is a designated GTD folder and any row changed, nudge GTD section clients. One emit per
      // affected folder (backfillAllFolders loops here); the client debounces. Gated cheaply
      // on gtd_enabled + changedCount>0 only.
      await emitGtdSectionsRefreshIfEnabled(this, account, backfilledRows);
    } catch (err) {
      console.error(`Backfill failed for ${logAccount(account)}/${folder}:`, err.message);
    } finally {
      if (bfClient) { try { await bfClient.logout(); } catch { /* already disconnected */ } }
      this.backfillRunning.delete(backfillKey);
    }
  }

  // Insert auto-discovered contacts for inbound senders that don't already have a contact record.
  // Existing contacts (manual or sent-to) are never modified; is_auto=true entries are never
  // downgraded by this path.
  async upsertAutoContacts(userId, messages) {
    try {
      const abResult = await query(
        `INSERT INTO address_books (user_id, name) VALUES ($1, 'Personal')
         ON CONFLICT (user_id, name) DO UPDATE SET updated_at = NOW()
         RETURNING id`,
        [userId]
      );
      const addressBookId = abResult.rows[0].id;

      const upsertResults = await Promise.allSettled(
        messages
          .filter(msg => msg.fromEmail)
          .map(msg => {
            const primaryEmail = msg.fromEmail.toLowerCase();
            const displayName  = (msg.fromName || '').trim() || primaryEmail;
            const uid          = randomUUID();
            const emails       = JSON.stringify([{ value: primaryEmail, type: 'other', primary: true }]);
            const vcard        = generateVCard({ uid, displayName, emails: [{ value: primaryEmail, type: 'other', primary: true }] });
            return query(`
              INSERT INTO contacts (
                address_book_id, user_id, uid, vcard, etag,
                display_name, primary_email, emails, is_auto
              )
              VALUES ($1, $2, $3, $4, md5($4), $5, $6, $7::jsonb, true)
              ON CONFLICT (address_book_id, primary_email) WHERE primary_email IS NOT NULL DO NOTHING
            `, [addressBookId, userId, uid, vcard, displayName, primaryEmail, emails]);
          })
      );
      const inserted = upsertResults.filter(r => r.status === 'fulfilled' && r.value?.rowCount > 0).length;

      // Bump sync_token only when new contacts were actually added so CardDAV
      // clients that use getctag/sync-token pick up newly discovered senders.
      if (inserted > 0) {
        await query(
          'UPDATE address_books SET sync_token = gen_random_uuid()::text, updated_at = NOW() WHERE id = $1',
          [addressBookId]
        );
      }
    } catch (err) {
      console.warn(`upsertAutoContacts error for user ${userId}:`, err.message);
    }
  }

  // Fetch headers-only from IMAP for messages that have is_bulk IS NULL and update them.
  // Called at the end of backfillAllFolders so a manual reindex evaluates existing mail.
  async refreshBulkFlags(account) {
    const nullResult = await query(
      `SELECT id, uid, folder FROM messages
       WHERE account_id = $1 AND is_bulk IS NULL AND is_deleted = false
       ORDER BY folder, uid DESC
       LIMIT 5000`,
      [account.id]
    );
    if (nullResult.rows.length === 0) return;

    const byFolder = new Map();
    for (const { id, uid, folder } of nullResult.rows) {
      if (!byFolder.has(folder)) byFolder.set(folder, []);
      byFolder.get(folder).push({ id, uid: Number(uid) });
    }

    console.log(`Bulk flag refresh: ${nullResult.rows.length} unevaluated messages for ${logAccount(account)}`);

    for (const [folder, msgs] of byFolder) {
      let client = null;
      try {
        const row = (await query('SELECT * FROM email_accounts WHERE id = $1', [account.id])).rows[0];
        if (!row) return;
        const fresh = await ensureFreshToken(row);
        const { resolved, policy } = await resolveAccountHost(fresh);
        client = new ImapFlow(makeClientCfg(fresh, resolved, { policy }));
        client.on('error', () => {});
        await Promise.race([
          client.connect(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('IMAP timeout (30s)')), 30000)),
        ]);

        const uidToId = new Map(msgs.map(m => [m.uid, m.id]));
        const updates = [];

        const lock = await client.getMailboxLock(folder);
        try {
          const uidSet = msgs.map(m => m.uid).join(',');
          for await (const msg of client.fetch(uidSet, {
            uid: true,
            headers: ['list-unsubscribe', 'list-id', 'list-post', 'precedence'],
          }, { uid: true })) {
            const dbId = uidToId.get(msg.uid);
            if (dbId == null) continue;
            const h = parseHeadersInput(msg.headers);
            updates.push({ id: dbId, isBulk: detectBulkFromParsedHeaders(h) });
          }
        } finally {
          lock.release();
        }

        if (updates.length > 0) {
          await query(
            `UPDATE messages SET is_bulk = v.is_bulk
             FROM (SELECT unnest($1::uuid[]) AS id, unnest($2::boolean[]) AS is_bulk) AS v
             WHERE messages.id = v.id`,
            [updates.map(u => u.id), updates.map(u => u.isBulk)]
          );
        }
        console.log(`Bulk flag refresh: ${updates.length}/${msgs.length} updated in ${folder} for ${logAccount(account)}`);
      } catch (err) {
        console.warn(`Bulk flag refresh error for ${logAccount(account)}/${folder}: ${err.message}`);
      } finally {
        if (client) { try { await client.logout(); } catch { /* ignore */ } }
      }
    }
  }

  // Runs backfillMessages for every folder: INBOX first, then all others sequentially.
  // Skips provider-specific duplicate-view folders (e.g. Gmail's All Mail, Starred, Important)
  // to avoid storing tens of thousands of duplicate message rows.
  async backfillAllFolders(account) {
    if (this.backfillAllRunning.has(account.id)) return;
    this.backfillAllRunning.add(account.id);
    const host = (account.imap_host || '').toLowerCase();
    // Broadcast start BEFORE waiting on the per-host semaphore so a queued reindex shows as
    // "in progress" in the admin UI instead of looking idle while it waits for a slot. The
    // matching backfill_all_complete always fires from the finally, so the pair stays balanced.
    this.broadcast({ type: 'backfill_all_start', accountId: account.id }, account.user_id);
    let slotHeld = false;
    try {
      // Cap concurrent backfills per provider host: a user with many accounts on one
      // provider would otherwise open a backfill connection for every account at once,
      // tripping connection limits. This only queues the background catch-up — live sync
      // (IDLE + the periodic interval) is unaffected and keeps flowing while queued.
      await this._backfillSem.acquire(host);
      slotHeld = true;
      const { skipFolderPatterns, skipFolderNames } = providerProfile(account);

      // INBOX first — highest priority, existing behaviour
      await this.backfillMessages(account, 'INBOX');

      // Then all other known folders (discovered at connect time by syncFolders)
      const folderResult = await query(
        "SELECT path FROM folders WHERE account_id = $1 AND path != 'INBOX' ORDER BY path",
        [account.id]
      );

      for (const { path } of folderResult.rows) {
        const pathLower = path.toLowerCase();
        if (skipFolderPatterns.some(pat => pathLower.includes(pat))) continue;
        if (skipFolderNames.includes(pathLower)) continue;
        await this.backfillMessages(account, path).catch(err =>
          console.warn(`Backfill skipped ${logAccount(account)}/${path}: ${err.message}`)
        );
      }

    } finally {
      if (slotHeld) this._backfillSem.release(host); // free the per-host slot for the next account
      this.backfillAllRunning.delete(account.id);
      this.broadcast({ type: 'backfill_all_complete', accountId: account.id }, account.user_id);
      // Both run as background jobs after the complete signal — neither should block the UI.
      this.refreshBulkFlags(account).catch(err =>
        console.warn(`Bulk flag refresh failed for ${logAccount(account)}:`, err.message)
      );
      this.startSnippetIndexer(account).catch(err =>
        console.error(`Snippet indexer failed for ${logAccount(account)}:`, err.message)
      );
    }
  }

  // Called by the body-fetch route whenever a user opens a message that required a live
  // IMAP fetch. The timestamp is used by background jobs to back off during active sessions.
  noteUserActivity(accountId) {
    this.lastUserActivity.set(accountId, Date.now());
  }

  // Background job that fetches text snippets for messages that were backfilled without
  // body parts (the common case — backfill runs metadata-only for speed). Runs per-account
  // after backfill completes, and also at connect time for existing accounts.
  // Skipped for providers that throttle body fetches too aggressively to run at scale.
  // Processes most-recent messages first so the most useful results are indexed quickly.
  async startSnippetIndexer(account) {
    const cfg = providerProfile(account);
    if (!cfg.snippetIndex) return;

    if (this.snippetIndexerRunning.has(account.id)) return;
    // Honor the circuit breaker for every caller (scheduler, post-connect, post-sync)
    // so a persistently-failing account is not retried on each reconnect either.
    const backoff = this.snippetBackoff.get(account.id);
    if (backoff && Date.now() < backoff.until) return;
    this.snippetIndexerRunning.add(account.id);

    // Rate limit: conservative batches so this doesn't affect normal usage.
    // Cap per run so a large account doesn't occupy an IMAP connection indefinitely;
    // the indexer resumes from where it left off on the next server startup.
    const batchSize = 50;
    const batchDelay = Math.max(cfg.batchDelay, 2000); // at least 2s between batches
    const MAX_BATCHES_PER_RUN = 200; // 10,000 messages max per session

    let siClient = null;
    // Hoisted so the finally can distinguish a productive run from one that failed
    // without indexing anything (the case that should trip the circuit breaker).
    let batchCount = 0;
    let failed = false;
    let refused = false; // provider refused a connection (at its per-account limit) — back off hard
    try {
      // Check if there's anything to index before opening a connection
      const countResult = await query(
        "SELECT count(*) FROM messages WHERE account_id = $1 AND (snippet IS NULL OR snippet = '')",
        [account.id]
      );
      const totalMissing = parseInt(countResult.rows[0].count);
      if (totalMissing === 0) return;

      logger.debug(`Snippet indexer: ${logAccount(account)} has ${totalMissing} messages without snippets`);

      const openClient = async () => {
        if (siClient) { try { await siClient.logout(); } catch { /* already disconnected */ } siClient = null; }
        const row = (await query('SELECT * FROM email_accounts WHERE id = $1', [account.id])).rows[0];
        if (!row) throw new Error('Account deleted');
        const fresh = await ensureFreshToken(row);
        const { resolved, policy } = await resolveAccountHost(fresh);
        const c = new ImapFlow(makeClientCfg(fresh, resolved, { policy }));
        c.on('error', err => console.error(`Snippet indexer IMAP error ${logAccount(account)}:`, err.message));
        await Promise.race([
          c.connect(),
          new Promise((_, rej) => setTimeout(() => rej(new Error('Connection timeout')), 30000)),
        ]);
        siClient = c;
      };

      await openClient();

      // Get distinct folders that have unindexed messages
      const foldersResult = await query(
        `SELECT folder, count(*) as cnt FROM messages
         WHERE account_id = $1 AND (snippet IS NULL OR snippet = '')
         GROUP BY folder ORDER BY cnt DESC`,
        [account.id]
      );

      let consecutiveErrors = 0;
      for (const { folder } of foldersResult.rows) {
        let done = false;
        while (!done) {
          // Stop if account was deleted
          const alive = await query('SELECT id FROM email_accounts WHERE id = $1', [account.id]);
          if (!alive.rows.length) return;

          // Reconnect periodically to keep the connection fresh
          if (batchCount > 0 && batchCount % 20 === 0) {
            await openClient().catch(err => {
              console.error(`Snippet indexer reconnect failed: ${err.message}`);
            });
          }

          if (batchCount >= MAX_BATCHES_PER_RUN) {
            const remaining = await query(
              "SELECT count(*) FROM messages WHERE account_id = $1 AND (snippet IS NULL OR snippet = '')",
              [account.id]
            );
            console.log(`Snippet indexer paused for ${logAccount(account)} after ${batchCount} batches — ${remaining.rows[0].count} remaining, will resume on next startup`);
            return;
          }

          const batchResult = await query(
            `SELECT uid FROM messages
             WHERE account_id = $1 AND folder = $2 AND (snippet IS NULL OR snippet = '')
             ORDER BY date DESC LIMIT $3`,
            [account.id, folder, batchSize]
          );
          if (!batchResult.rows.length) { done = true; break; }

          const uids = batchResult.rows.map(r => r.uid);
          try {
            const lock = await siClient.getMailboxLock(folder);
            try {
              for await (const msg of siClient.fetch(uids.join(','), {
                uid: true, envelope: true, bodyStructure: true,
                bodyParts: ['1', '1.1', '1.2'],
              }, { uid: true })) {
                try {
                  const parsed = await parseMessage(msg);
                  if (parsed.snippet) {
                    await query(
                      `UPDATE messages SET snippet = $1
                       WHERE account_id = $2 AND uid = $3 AND folder = $4
                         AND (snippet IS NULL OR snippet = '')`,
                      [sanitizeStr(parsed.snippet), account.id, msg.uid, folder]
                    );
                  }
                } catch { /* skip snippet on parse/update failure */ }
              }
            } finally {
              lock.release();
            }
            batchCount++;
            consecutiveErrors = 0;
          } catch (err) {
            consecutiveErrors++;
            console.error(`Snippet indexer batch error ${logAccount(account)}/${folder}:`, err.message);
            // Connection refusal = the provider is at its per-account connection limit (iCloud
            // especially, right after a startup backfill burst). Reopening a fresh connection to
            // retry would only pile on more pressure and can starve the live sync/IDLE connection
            // — the exact failure that lets new mail slip through. Stop this run and back off hard
            // instead; the 10-minute scheduler resumes the backlog once the provider is calm.
            if (isConnectionRefusal(err.message)) {
              failed = true;
              refused = true;
              console.log(`Snippet indexer backing off ${logAccount(account)} — provider refusing connections (at limit)`);
              return;
            }
            await new Promise(r => setTimeout(r, cfg.errorDelay));
            if (consecutiveErrors >= 3) {
              failed = true;
              console.log(`Snippet indexer aborting for ${logAccount(account)} after ${consecutiveErrors} consecutive errors — will resume on next startup`);
              return;
            }
            await openClient();
          }

          // Pause longer when the user is actively opening messages so background
          // IMAP traffic doesn't compete with click-time body fetches.
          const quietFor = Date.now() - (this.lastUserActivity.get(account.id) || 0);
          const extraDelay = quietFor < QUIET_WINDOW_MS ? QUIET_WINDOW_MS - quietFor : 0;
          await new Promise(r => setTimeout(r, batchDelay + extraDelay));
        }
      }

      console.log(`Snippet indexer complete for ${logAccount(account)} (${batchCount} batches)`);
    } catch (err) {
      failed = true;
      console.error(`Snippet indexer error ${logAccount(account)}:`, err.message);
    } finally {
      if (siClient) { try { await siClient.logout(); } catch { /* already disconnected */ } }
      this.snippetIndexerRunning.delete(account.id);
      // Circuit breaker: a run that failed without indexing a single batch (e.g. iCloud
      // refusing the extra connection at its per-account limit) backs off exponentially
      // so the scheduler stops reopening competing IMAP connections that slow live body
      // fetches. Any progress — or a clean/no-work finish — clears the backoff.
      // Back off when the run made no progress, OR when the provider refused a connection at
      // its limit even if some batches got through — in the refusal case, continuing to reopen
      // connections on the 10-minute cadence keeps competing with the live sync during exactly
      // the window when new mail must not be missed.
      if (refused || (failed && batchCount === 0)) {
        const failures = (this.snippetBackoff.get(account.id)?.failures || 0) + 1;
        const delay = Math.min(SNIPPET_BACKOFF_BASE_MS * 2 ** (failures - 1), SNIPPET_BACKOFF_MAX_MS);
        this.snippetBackoff.set(account.id, { failures, until: Date.now() + delay });
        console.log(`Snippet indexer backing off ${logAccount(account)} for ${Math.round(delay / 60000)}m (failure #${failures})`);
      } else {
        this.snippetBackoff.delete(account.id);
      }
    }
  }

  async appendToFolder(account, folder, rawMessage, flags = ['\\Seen']) {
    let uid = null;
    await withFreshClient(account, async (client) => {
      const result = await client.append(folder, rawMessage, flags);
      if (result === false) throw new Error('IMAP append returned false — server did not confirm message was stored');
      if (result && typeof result.uid === 'number') uid = result.uid;
    });
    console.log(`Appended to IMAP ${logAccount(account)}/${folder} uid=${uid}`);
    return { uid, folder };
  }

  async appendToSent(account, folder, rawMessage) {
    return this.appendToFolder(account, folder, rawMessage, ['\\Seen']);
  }

  // Persist authoritative Sent metadata right after SMTP/APPEND so a later IMAP sync
  // with an incomplete ENVELOPE (common for multipart/related inline-image mail) cannot
  // wipe subject/from/to.
  async upsertSentMessageRecord(account, folder, uid, {
    messageId,
    subject,
    fromName,
    fromEmail,
    to = [],
    cc = [],
    snippet = '',
    date = new Date(),
  }) {
    if (!uid || !folder) return;
    const msgId = sanitizeStr(messageId);
    const threadId = msgId || null;
    await query(`
      INSERT INTO messages (
        account_id, uid, folder, message_id, subject,
        from_name, from_email, to_addresses, cc_addresses,
        date, snippet, is_read, is_starred, has_attachments, flags, thread_id
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,true,false,false,'[]',$12)
      ON CONFLICT (account_id, uid, folder) DO UPDATE SET
        message_id = COALESCE(EXCLUDED.message_id, messages.message_id),
        subject = CASE
          WHEN EXCLUDED.subject IS NOT NULL AND EXCLUDED.subject <> '' AND EXCLUDED.subject <> '(no subject)'
          THEN EXCLUDED.subject ELSE messages.subject END,
        from_name = COALESCE(NULLIF(EXCLUDED.from_name, ''), messages.from_name),
        from_email = COALESCE(NULLIF(EXCLUDED.from_email, ''), messages.from_email),
        to_addresses = CASE
          WHEN EXCLUDED.to_addresses::text IS NOT NULL AND EXCLUDED.to_addresses::text <> '[]'
          THEN EXCLUDED.to_addresses ELSE messages.to_addresses END,
        cc_addresses = CASE
          WHEN EXCLUDED.cc_addresses::text IS NOT NULL AND EXCLUDED.cc_addresses::text <> '[]'
          THEN EXCLUDED.cc_addresses ELSE messages.cc_addresses END,
        date = EXCLUDED.date,
        snippet = CASE WHEN EXCLUDED.snippet <> '' THEN EXCLUDED.snippet ELSE messages.snippet END,
        is_read = true,
        thread_id = COALESCE(messages.thread_id, EXCLUDED.thread_id)
    `, [
      account.id, uid, folder, msgId,
      sanitizeStr(subject || '(no subject)'),
      sanitizeStr(fromName || ''), sanitizeStr(fromEmail || ''),
      JSON.stringify(to), JSON.stringify(cc),
      safeDate(date), sanitizeStr(snippet || ''), threadId,
    ]);
  }

  async findUidByMessageId(account, folder, messageId) {
    if (!messageId || !folder) return null;
    const mid = String(messageId).replace(/[<>]/g, '').trim();
    if (!mid) return null;
    return withFreshClient(account, async (client) => {
      const lock = await client.getMailboxLock(folder);
      try {
        const uids = await client.search({ header: ['Message-ID', mid] }, { uid: true });
        if (!uids?.length) return null;
        return uids[uids.length - 1];
      } finally {
        lock.release();
      }
    });
  }

  // Syncs the most recent messages in a specific folder on demand.
  // Called when the user navigates to a folder that has no local messages yet.
  // Uses a pooled connection — does NOT touch the main sync connection.
  async syncFolderOnDemand(account, folder) {
    const key = `${account.id}:${folder}`;
    if (this.onDemandSyncing.has(key)) {
      console.log(`syncFolderOnDemand skipped (already running): ${logAccount(account)}/${folder}`);
      return;
    }
    this.onDemandSyncing.add(key);
    console.log(`syncFolderOnDemand start: ${logAccount(account)}/${folder}`);
    try {
      await withFreshClient(account, async (client) => {
        await this.syncMessages(account, client, folder, 100, false, true);
      });
      console.log(`syncFolderOnDemand done: ${logAccount(account)}/${folder}`);
      // sync_complete fires mailflow:refresh in the frontend, reloading the message list
      this.broadcast({ type: 'sync_complete', accountId: account.id }, account.user_id);
    } catch (err) {
      console.error(`On-demand sync error ${logAccount(account)}/${folder}:`, err.message);
    } finally {
      this.onDemandSyncing.delete(key);
    }
  }

  // Pre-fetch and cache the body for newly arrived messages immediately after sync.
  // Called in the background (via setImmediate) so it doesn't block the sync path.
  // By the time the user clicks the email (typically 2–10s later), the body is already
  // in the DB and the click returns instantly without a live IMAP round-trip.
  async prefetchNewMessageBodies(account, messages) {
    for (const msg of messages) {
      try {
        // Skip if body already cached (concurrent click may have triggered this too)
        const existing = await query(
          'SELECT id FROM messages WHERE id = $1 AND (body_html IS NOT NULL OR body_text IS NOT NULL)',
          [msg.id]
        );
        if (existing.rows.length) continue;

        const { html, text, attachments } = await this.fetchMessageBody(
          account, msg.uid, msg.folder || 'INBOX'
        );
        const safeHtml = html ? sanitizeEmail(html) : null;
        if (safeHtml || text) {
          const snip = snippetFromBody(text, safeHtml || html);
          await query(
            `UPDATE messages
             SET body_html = $1, body_text = $2, attachments = $3,
                 snippet = CASE WHEN $5 != '' THEN $5 ELSE snippet END
             WHERE id = $4`,
            [sanitizeStr(safeHtml), sanitizeStr(text), JSON.stringify(attachments || []), msg.id, sanitizeStr(snip)]
          );
        }
      } catch (err) {
        console.warn(`Body prefetch failed for uid ${msg.uid}:`, err.message);
      }
    }
  }

  // Background body prefetch for messages currently visible in a folder.
  // Called after GET /messages responds so the user gets a fast first impression
  // without waiting for this work. Respects the quiet window — pauses between
  // messages when the user is actively clicking so live fetches stay snappy.
  // Skipped for providers that throttle background body fetching (e.g. Gmail).
  async prefetchFolderBodies(accountId, messageIds) {
    if (!messageIds.length) return;

    const accountResult = await query('SELECT * FROM email_accounts WHERE id = $1', [accountId]);
    if (!accountResult.rows.length) return;
    const account = accountResult.rows[0];
    if (!providerProfile(account).snippetIndex) return;

    const uncachedResult = await query(
      `SELECT id, uid, folder FROM messages
       WHERE id = ANY($1::uuid[]) AND body_html IS NULL AND body_text IS NULL`,
      [messageIds]
    );
    if (!uncachedResult.rows.length) return;

    for (const msg of uncachedResult.rows) {
      const quietFor = Date.now() - (this.lastUserActivity.get(accountId) || 0);
      if (quietFor < QUIET_WINDOW_MS) {
        await new Promise(r => setTimeout(r, QUIET_WINDOW_MS - quietFor));
      }

      try {
        const existing = await query(
          'SELECT id FROM messages WHERE id = $1 AND (body_html IS NOT NULL OR body_text IS NOT NULL)',
          [msg.id]
        );
        if (existing.rows.length) continue;

        const { html, text, attachments } = await this.fetchMessageBody(account, msg.uid, msg.folder);
        const safeHtml = html ? sanitizeEmail(html) : null;
        if (safeHtml || text) {
          const snip = snippetFromBody(text, safeHtml || html);
          await query(
            `UPDATE messages
             SET body_html = $1, body_text = $2, attachments = $3,
                 snippet = CASE WHEN $5 != '' THEN $5 ELSE snippet END
             WHERE id = $4`,
            [sanitizeStr(safeHtml), sanitizeStr(text), JSON.stringify(attachments || []), msg.id, sanitizeStr(snip)]
          );
        }
      } catch (err) {
        console.warn(`Folder body prefetch failed for uid ${msg.uid}:`, err.message);
      }
    }
  }

  // Uses a fresh connection to avoid lock contention with sync connection.
  // Auto-retries once on transient connection errors (stale pool connection, NAT
  // timeout, half-open TCP, etc.) so a single click is enough in all common cases.
  async fetchMessageBody(account, uid, folder) {
    // Inner fetch — called up to twice. `acquire` selects how the connection is obtained:
    // the first attempt uses the pool (withFreshClient); the retry uses a genuinely fresh
    // login (withFreshLogin) so a frozen/half-open pooled connection can't hang or return
    // a blank body for recently-arrived mail.
    const doFetch = (acquire) => acquire(account, async (client) => {
      let html = null;
      let text = null;
      let attachments;
      // Always address by UID string with uid:true option — direct UID FETCH avoids
      // the two-step SEARCH+FETCH path that object-range syntax triggers, which can
      // silently return nothing on stale connections or when a server-side search
      // quota is hit.
      const uidStr = String(uid);

      const lock = await client.getMailboxLock(folder);
      try {
        let structure = null;
        const prefetched = new Map(); // part number -> Buffer

        if (!providerProfile(account).speculativeFetch) {
          // Known to reject speculative part requests (e.g. Gmail, Yahoo) —
          // go straight to two-step to avoid a guaranteed server error.
          for await (const msg of client.fetch(uidStr, { uid: true, bodyStructure: true }, { uid: true })) {
            structure = msg.bodyStructure;
          }
        } else {
          // Try one round-trip: structure + common part numbers together.
          // Most servers silently return absent parts as empty, but fall back to
          // two-step for any unknown provider that rejects speculative requests.
          try {
            for await (const msg of client.fetch(
              uidStr,
              { uid: true, bodyStructure: true, bodyParts: BODY_PREFETCH_PARTS },
              { uid: true }
            )) {
              structure = msg.bodyStructure;
              if (msg.bodyParts) {
                for (const [k, v] of msg.bodyParts) {
                  if (v != null && v.length > 0) prefetched.set(k, v);
                }
              }
            }
          } catch {
            structure = null;
            prefetched.clear();
            for await (const msg of client.fetch(uidStr, { uid: true, bodyStructure: true }, { uid: true })) {
              structure = msg.bodyStructure;
            }
          }
        }

        if (!structure) {
          // Throw a transient error so the outer retry logic gets a fresh connection
          // before giving up — an empty UID FETCH response often means a stale or
          // half-open pool connection, not a missing message.
          throw new Error('Command failed');
        }

        const results = { textParts: [], attachments: [], inlineImages: [] };
        walkStructure(structure, results);

        // Handle single-part root node (no childNodes, type is the content type)
        if (results.textParts.length === 0) {
          const rootType = (structure.type || '').toLowerCase();
          results.textParts.push({
            part: structure.part || '1',
            type: (rootType === 'text/html' || rootType === 'text/plain' || rootType === 'application/xhtml+xml') ? 'text/html' : 'text/plain',
            encoding: structure.encoding || '',
            charset: structure.parameters?.charset || 'utf-8',
          });
        }

        attachments = results.attachments;

        // Fetch any text/image parts not already obtained from the speculative fetch
        const inlineImages = results.inlineImages || [];
        const needed = [
          ...new Set([
            ...results.textParts.map(p => p.part),
            ...inlineImages.map(p => p.part),
          ])
        ].filter(p => !prefetched.has(p));

        if (needed.length > 0) {
          // Batched fetch for parts not already available.
          for await (const msg of client.fetch(uidStr, { uid: true, bodyParts: needed }, { uid: true })) {
            if (msg.bodyParts) {
              for (const [k, v] of msg.bodyParts) {
                if (v != null) prefetched.set(k, v);
              }
            }
          }

          // Per-part individual retry for any text/image part that came back missing or
          // zero-length from the batched fetch.  Some IMAP servers (confirmed on
          // purelymail.com) return a 0-byte literal for non-empty parts when one sibling
          // part in the same FETCH command happens to be empty — the batched
          // BODY[1] BODY[2] response is malformed, but BODY[2] alone works correctly.
          const individualParts = [...results.textParts, ...(results.inlineImages || [])];
          for (const part of individualParts) {
            const existing = prefetched.get(part.part);
            if (existing && existing.length > 0) continue; // already have content
            try {
              for await (const msg of client.fetch(uidStr, { uid: true, bodyParts: [part.part] }, { uid: true })) {
                const v = msg.bodyParts?.get(part.part);
                if (v && v.length > 0) prefetched.set(part.part, v);
              }
            } catch { /* don't let a single part failure block others */ }
          }
        }

        for (const part of results.textParts) {
          const buf = prefetched.get(part.part);
          if (!buf) continue;
          const decoded = decodeBody(buf, part.encoding, part.charset);
          if (part.type === 'text/html' && !html) html = decoded;
          else if (part.type === 'text/plain' && !text) text = decoded;
        }

        // Step 3: replace cid: references in HTML with data: URIs so inline
        // images render inside the sandboxed srcdoc iframe
        if (html && inlineImages.length > 0) {
          for (const img of inlineImages) {
            if (!img.cid) continue;
            const buf = prefetched.get(img.part);
            if (!buf) continue;
            const enc = (img.encoding || '').toLowerCase();
            const b64 = enc === 'base64'
              ? buf.toString('ascii').replace(/\s/g, '')
              : buf.toString('base64');
            const dataUri = `data:${img.type};base64,${b64}`;
            // cid: refs appear with and without angle brackets — match both.
            // e.g.  src="cid:abc123"  and  src="cid:<abc123>"
            const escapedCid = img.cid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            html = html.replace(new RegExp(`cid:<?${escapedCid}>?`, 'gi'), dataUri);
          }
        }
      } finally {
        lock.release();
      }

      // Some malformed emails include NUL bytes that PostgreSQL rejects in text
      // columns. Strip them once here so all callers are safe.
      return { html: sanitizeStr(html), text: sanitizeStr(text), attachments };
    });

    // Providers flagged preferFreshBodyFetch (e.g. PurelyMail) skip the shared pool on the
    // FIRST attempt too: a brand-new login avoids both contending with flag writes on the
    // size-2 pool and inheriting a frozen/half-open pooled session view that would hang the
    // fetch until its command timeout. Other providers keep pool-first for TLS reuse.
    const firstAcquire = providerProfile(account).preferFreshBodyFetch ? withFreshLogin : withFreshClient;
    try {
      return await doFetch(firstAcquire);
    } catch (firstErr) {
      const detail = extractImapError(firstErr);
      // Retry once on any transient connection-level error (dead pool connection,
      // half-open TCP, NAT expiry, commandTimeout, socket reset, or an empty UID FETCH
      // from a frozen mailbox view). withFreshClient already evicted the bad pooled
      // connection; the retry then goes through a BRAND-NEW login (withFreshLogin) rather
      // than the pool, so a second frozen/dead pooled connection can't hang or blank it.
      // Server-side rejections (auth, permission, unknown mailbox) fail again and propagate.
      const isTransient = (
        detail === 'Command failed' ||
        /Command canceled/i.test(detail) ||
        /ECONNRESET/.test(detail) ||
        /socket hang up/i.test(detail) ||
        /ETIMEDOUT/.test(detail) ||
        /timed out/i.test(detail) ||
        /EPIPE/.test(detail)
      );
      if (isTransient) {
        try {
          return await doFetch(withFreshLogin);
        } catch (retryErr) {
          const retryDetail = extractImapError(retryErr);
          // 'Command failed' on the retry means the UID FETCH returned nothing both
          // times — the message may not exist on the server (deleted, UID mismatch).
          // Return null gracefully rather than surfacing a confusing error to the UI.
          if (retryDetail === 'Command failed') {
            console.warn(`fetchMessageBody: uid=${uid} folder=${folder} account=${logAccount(account)} — no body after retry; message may be missing on server`);
            return { html: null, text: null, attachments: [] };
          }
          const wrapped = new Error(retryDetail);
          wrapped.imapError = true;
          throw wrapped;
        }
      }
      const wrapped = new Error(detail);
      wrapped.imapError = true;
      throw wrapped;
    }
  }

  async fetchHeaders(account, uid, folder) {
    return withFreshClient(account, async (client) => {
      const lock = await client.getMailboxLock(folder);
      try {
        const uidStr = String(uid);
        let headers = '';

        for await (const msg of client.fetch(uidStr, { uid: true, headers: true }, { uid: true })) {
          if (msg.headers) headers = headersToRawString(msg.headers);
        }

        // Some providers return an empty HEADER.FIELDS response — fall back to the
        // leading bytes of the raw message, which always include the header block.
        if (!headers.trim()) {
          for await (const msg of client.fetch(uidStr, { uid: true, source: { start: 0, maxLength: 65536 } }, { uid: true })) {
            if (msg.source) {
              const raw = Buffer.isBuffer(msg.source) ? msg.source.toString('utf8') : String(msg.source);
              const sep = raw.search(/\r?\n\r?\n/);
              headers = sep >= 0 ? raw.slice(0, sep) : raw;
              break;
            }
          }
        }

        return headers;
      } finally {
        lock.release();
      }
    });
  }

  async fetchAttachment(account, uid, folder, partNum) {
    return withFreshClient(account, async (client) => {
      const lock = await client.getMailboxLock(folder);
      try {
        let buffer = null;
        const uidStr = String(uid);

        for await (const msg of client.fetch(uidStr, { uid: true, bodyStructure: true, bodyParts: [partNum] }, { uid: true })) {
          let encoding = 'base64';
          if (msg.bodyStructure) {
            const r = { textParts: [], attachments: [] };
            walkStructure(msg.bodyStructure, r);
            const att = r.attachments.find(a => a.part === partNum);
            if (att) encoding = att.encoding;
          }
          const buf = msg.bodyParts?.get(partNum);
          if (buf) {
            buffer = decodeAttachmentBuffer(buf, encoding);
          }
        }
        return buffer;
      } finally {
        lock.release();
      }
    });
  }

  // Fetch multiple attachment parts in a single IMAP round trip.
  // parts: array of { part, encoding } (metadata from messages.attachments).
  // Returns Map<partNum, Buffer> — missing or empty parts are omitted.
  async fetchMultipleAttachments(account, uid, folder, parts) {
    return withFreshClient(account, async (client) => {
      const lock = await client.getMailboxLock(folder);
      try {
        const uidStr = String(uid);
        const partNums = parts.map(p => p.part);
        const buffers = new Map();

        for await (const msg of client.fetch(
          uidStr,
          { uid: true, bodyStructure: true, bodyParts: partNums },
          { uid: true }
        )) {
          // Build a live encoding map from BODYSTRUCTURE (more reliable than stored metadata)
          const liveEncodings = new Map();
          if (msg.bodyStructure) {
            const r = { textParts: [], attachments: [] };
            walkStructure(msg.bodyStructure, r);
            for (const att of r.attachments) liveEncodings.set(att.part, att.encoding);
          }

          if (msg.bodyParts) {
            for (const [partNum, buf] of msg.bodyParts) {
              if (!buf || buf.length === 0) continue;
              const inputPart = parts.find(p => p.part === partNum);
              const encoding = liveEncodings.get(partNum) || inputPart?.encoding || 'base64';
              buffers.set(partNum, decodeAttachmentBuffer(buf, encoding));
            }
          }
        }

        return buffers;
      } finally {
        lock.release();
      }
    });
  }

  async setFlag(account, uid, folder, flag, value) {
    console.log(`setFlag: uid=${uid} folder=${folder} flag=${flag} value=${value}`);
    // Up to 2 attempts. ImapFlow returns false when the server did NOT apply the flag —
    // typically a stale/half-open pooled connection whose SELECT view is missing the UID.
    // Throwing on false makes withFreshClient evict that client from the pool, so the
    // retry acquires a fresh connection (this is exactly why marking a message
    // individually a moment later succeeds). Re-applying a flag is idempotent, so the
    // retry is safe. Surfacing the final failure keeps callers such as bulk-read from
    // reporting success while the DB read/flag state silently drifts from the server —
    // which a later flag-sync would then revert, leaving the message unexpectedly unread.
    let lastErr = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await withFreshClient(account, async (client) => {
          const lock = await client.getMailboxLock(folder);
          try {
            const flagResult = value
              ? await client.messageFlagsAdd(String(uid), [flag], { uid: true })
              : await client.messageFlagsRemove(String(uid), [flag], { uid: true });
            if (flagResult === false) {
              throw new Error(`server did not apply ${flag}=${value} for uid=${uid} (no matching message)`);
            }
            logger.debug(`setFlag success: uid=${uid} ${flag}=${value}`);
          } finally {
            lock.release();
          }
        });
        return; // applied
      } catch (err) {
        lastErr = err;
        if (attempt < 2) await new Promise(r => setTimeout(r, 400));
      }
    }
    console.error(`setFlag failed after retry: uid=${uid} ${flag}=${value}:`, lastErr?.message);
    throw lastErr;
  }

  async createFolder(account, path) {
    return withFreshClient(account, async (client) => {
      await client.mailboxCreate(path);
    });
  }

  // Ensure a mailbox exists, returning { path, created }: `path` is the real server path
  // the mailbox has under this account's personal namespace (e.g. 'INBOX.Todo' on a
  // prefixed server), `created` is true only when THIS call made it. The "create missing
  // folders" action reports both so the settings UI can show the real path and whether it
  // pre-existed. Namespace/delimiter/already-exists handling lives in ensureMailbox.
  async ensureFolder(account, path, opts = {}) {
    return withFreshClient(account, (client) => ensureMailbox(client, path, opts));
  }

  async moveMessageGetNewUid(account, uid, fromFolder, toFolder) {
    let newUid = null;
    try {
      await withFreshClient(account, async (client) => {
        const lock = await client.getMailboxLock(fromFolder);
        try {
          const result = await client.messageMove(String(uid), toFolder, { uid: true });
          if (result === false) throw new Error('messageMove returned false — server did not confirm move');
          if (result?.uidMap) {
            newUid = result.uidMap.get(Number(uid)) || null;
          }
        } finally {
          lock.release();
        }
      });
    } catch (err) {
      console.error(`moveMessageGetNewUid failed: uid=${uid}:`, err.message);
      throw err;
    }
    return newUid;
  }

  async deleteFolder(account, path) {
    return withFreshClient(account, async (client) => {
      // If the pool connection has this folder selected, switch to INBOX first
      if ((client.mailbox?.path || '').toLowerCase() === path.toLowerCase()) {
        const lock = await client.getMailboxLock('INBOX');
        lock.release();
      }
      await client.mailboxDelete(path);
    });
  }

  async renameFolder(account, oldPath, newPath) {
    return withFreshClient(account, async (client) => {
      await client.mailboxRename(oldPath, newPath);
    });
  }

  async emptyFolder(account, folder) {
    return withFreshClient(account, async (client) => {
      const lock = await client.getMailboxLock(folder);
      try {
        if (!client.mailbox || client.mailbox.exists === 0) return;
        const deleted = await client.messageDelete('1:*', { uid: false });
        if (deleted === false) throw new Error('messageDelete returned false — server did not confirm deletion');
      } catch (err) {
        const msg = (err.message || '').toLowerCase();
        // Non-fatal if folder is already empty or server reports no messages
        if (!msg.includes('no messages') && !msg.includes('empty') && !msg.includes('nothing')) throw err;
      } finally {
        lock.release();
      }
    });
  }

  async markAllReadImap(account, folder) {
    return withFreshClient(account, async (client) => {
      const lock = await client.getMailboxLock(folder);
      try {
        if (!client.mailbox || client.mailbox.exists === 0) return;
        const result = await client.messageFlagsAdd('1:*', ['\\Seen'], { uid: false });
        if (result === false) console.warn(`markAllReadImap: messageFlagsAdd returned false for ${folder} — server may not have applied flags`);
      } catch (err) {
        console.warn(`markAllRead IMAP warning for ${folder}:`, err.message);
        // Non-fatal — DB is already updated
      } finally {
        lock.release();
      }
    });
  }

  async moveMessage(account, uid, fromFolder, toFolder) {
    let newUid = null;
    try {
      await withFreshClient(account, async (client) => {
        const lock = await client.getMailboxLock(fromFolder);
        try {
          const result = await client.messageMove(String(uid), toFolder, { uid: true });
          if (result === false) throw new Error('messageMove returned false — server did not confirm move');
          if (result?.uidMap) newUid = result.uidMap.get(Number(uid)) || null;
        } finally {
          lock.release();
        }
      });
    } catch (err) {
      console.error(`moveMessage failed: uid=${uid}:`, err.message);
      throw err;
    }
    return newUid;
  }

  async permanentDeleteMessage(account, uid, folder) {
    await withFreshClient(account, async (client) => {
      const lock = await client.getMailboxLock(folder);
      try {
        const result = await client.messageDelete(String(uid), { uid: true });
        if (result === false) throw new Error('messageDelete returned false — server did not confirm deletion');
      } finally {
        lock.release();
      }
    });
  }

  // Add a GTD label = COPY the message into the label folder, keeping the source copy.
  // Mirrors moveMessage's connection acquisition, folder lock, and error discipline,
  // but uses COPY (not MOVE) so the source row stays put and the label becomes a
  // sibling row. On UIDPLUS the copyuid is known, so the destination sibling is
  // inserted immediately (label shows without waiting for a sync). Without UIDPLUS the
  // destination UID is unknown, so we pull the folder and let the next sync ingest the
  // copy as a sibling (the GTD relocate exemption keeps it from collapsing onto the
  // source) — the same non-UIDPLUS reliance the move path has. No _guardMoveUid is
  // needed: COPY leaves the source in place, so nothing looks like an orphan mid-flight.
  async copyMessage(accountId, uid, fromFolder, toFolder) {
    const accountResult = await query('SELECT * FROM email_accounts WHERE id = $1', [accountId]);
    const account = accountResult.rows[0];
    if (!account) throw new Error(`copyMessage: account ${accountId} not found`);

    let newUid = null;
    try {
      await withFreshClient(account, async (client) => {
        const lock = await client.getMailboxLock(fromFolder);
        try {
          const result = await client.messageCopy(String(uid), toFolder, { uid: true });
          if (result === false) throw new Error('messageCopy returned false — server did not confirm copy');
          if (result?.uidMap) newUid = result.uidMap.get(Number(uid)) || null;
        } finally {
          lock.release();
        }
      });
    } catch (err) {
      console.error(`copyMessage failed: uid=${uid}:`, err.message);
      throw err;
    }

    // A classify action changed this account's label folders — tell GTD section clients. Emitted at
    // the manager level so every caller of copyMessage inherits it. Safe on both paths:
    // it carries no row and doesn't assume the sibling row exists yet (it won't on the
    // non-UIDPLUS path, where the row is deferred to the destination sync below).
    this.broadcast({ type: 'gtd_sections_updated', accountId }, account.user_id);

    if (newUid == null) {
      emitAfterDeferredCopySync(this, account, toFolder, uid, fromFolder);
      return null;
    }

    await insertCopiedSibling(accountId, uid, fromFolder, toFolder, newUid);
    return newUid;
  }

  // Remove a single GTD label = delete ONE folder's copy of the message, leaving the
  // other sibling rows intact. IMAP delete/expunge mechanics reuse permanentDeleteMessage
  // (which locks the folder and deletes that uid); the DB delete is scoped to that one
  // folder's row. If the IMAP delete throws, the DB row is left in place so the two
  // never silently diverge.
  async removeMessageCopy(accountId, uid, folder) {
    const accountResult = await query('SELECT * FROM email_accounts WHERE id = $1', [accountId]);
    const account = accountResult.rows[0];
    if (!account) throw new Error(`removeMessageCopy: account ${accountId} not found`);

    await this.permanentDeleteMessage(account, uid, folder);
    const result = await deleteMessageCopyRow(accountId, uid, folder);
    // Removing a label copy changes GTD section data — same manager-level emit as copy.
    this.broadcast({ type: 'gtd_sections_updated', accountId }, account.user_id);
    return result;
  }

  // Move a batch of UIDs from one folder to another in a single IMAP command.
  // Returns { uidMap, succeeded, failed } where succeeded/failed are subsets of
  // the input uids array.
  //
  // When the server returns a uidMap (UIDPLUS), use it directly.
  // When no uidMap is returned (no UIDPLUS), attempt UID reconciliation via
  // destination UIDNEXT so the DB can store the correct new UIDs.
  // On command failure, verifies via UID SEARCH and confirms destination arrival
  // before trusting the source-absence result.
  async bulkMoveMessages(account, uids, fromFolder, toFolder) {
    if (!uids.length) return { uidMap: new Map(), succeeded: [], failed: [] };
    let destUidNextBefore = null;

    // Capture UIDNEXT on a dedicated connection so a STATUS failure (e.g. toFolder
    // is the currently selected mailbox on a pooled connection) cannot corrupt the
    // connection used for the actual move.
    try {
      const status = await withFreshClient(account, async (client) => {
        return await client.status(toFolder, { uidNext: true });
      });
      destUidNextBefore = status?.uidNext ?? null;
    } catch (statusErr) {
      console.warn(`bulkMoveMessages STATUS ${toFolder} failed (${statusErr.message}) — reconciliation skipped`);
    }

    try {
      const serverUidMap = await withFreshClient(account, async (client) => {
        const lock = await client.getMailboxLock(fromFolder);
        try {
          const result = await client.messageMove(uids.map(String), toFolder, { uid: true });
          if (result === false) throw new Error('bulk messageMove returned false — server did not confirm move');
          return result?.uidMap?.size ? result.uidMap : null;
        } finally {
          lock.release();
        }
      });

      if (serverUidMap) {
        return { uidMap: serverUidMap, succeeded: uids, failed: [] };
      }

      // Move succeeded but server returned no uidMap (no UIDPLUS).
      // Try to recover new UIDs via UIDNEXT scan so the DB stays accurate.
      const uidMap = await this._reconcileMovedUids(account, uids, toFolder, destUidNextBefore);
      return { uidMap, succeeded: uids, failed: [] };

    } catch (err) {
      console.warn(`bulkMoveMessages ${fromFolder} → ${toFolder}: batch failed (${err.message}), verifying via UID SEARCH`);
      try {
        const remaining = await withFreshClient(account, async (client) => {
          const lock = await client.getMailboxLock(fromFolder);
          try {
            return await client.search({ uid: uids.join(',') }, { uid: true });
          } finally {
            lock.release();
          }
        });
        const remainingSet = new Set(remaining.map(Number));
        const succeeded = uids.filter(uid => !remainingSet.has(Number(uid)));
        const failed    = uids.filter(uid =>  remainingSet.has(Number(uid)));

        if (!succeeded.length) {
          return { uidMap: new Map(), succeeded: [], failed: uids };
        }

        // Confirm that messages gone from source actually landed in destination
        // before treating source-absence as proof of success.
        if (destUidNextBefore !== null) {
          try {
            const destNewUids = await withFreshClient(account, async (client) => {
              const lock = await client.getMailboxLock(toFolder);
              try {
                return await client.search({ uid: `${destUidNextBefore}:*` }, { uid: true });
              } finally {
                lock.release();
              }
            });
            if (destNewUids.length < succeeded.length) {
              console.warn(`bulkMoveMessages fallback: ${succeeded.length} UIDs gone from source but only ${destNewUids.length} new UIDs in destination — treating all as failed`);
              return { uidMap: new Map(), succeeded: [], failed: uids };
            }
            // Destination count confirms the move; build uidMap if counts match exactly.
            const uidMap = new Map();
            if (destNewUids.length === succeeded.length) {
              // IMAP MOVE assigns destination UIDs in ascending source-UID order, so BOTH
              // sides must be sorted before zipping. `succeeded` is in arbitrary input
              // order (not UID order), so zipping it against the sorted destination UIDs
              // as-is would map each message to the wrong new UID.
              const sortedSrc = succeeded.map(Number).sort((a, b) => a - b);
              const sortedNew = [...destNewUids].sort((a, b) => a - b);
              sortedSrc.forEach((uid, i) => uidMap.set(uid, sortedNew[i]));
            }
            console.log(`bulkMoveMessages: ${succeeded.length}/${uids.length} confirmed moved via UID SEARCH + dest verification`);
            return { uidMap, succeeded, failed };
          } catch (destErr) {
            console.warn(`bulkMoveMessages: destination verification failed (${destErr.message}) — trusting source-absence`);
          }
        }

        if (succeeded.length) {
          console.log(`bulkMoveMessages: ${succeeded.length}/${uids.length} messages confirmed moved via UID SEARCH`);
        }
        return { uidMap: new Map(), succeeded, failed };
      } catch (searchErr) {
        console.error(`bulkMoveMessages: UID SEARCH verification failed: ${searchErr.message}`);
        return { uidMap: new Map(), succeeded: [], failed: uids };
      }
    }
  }

  // After a successful move that returned no uidMap, scan the destination folder
  // for UIDs >= destUidNextBefore and assign them to source UIDs in sorted order.
  // Only commits the mapping when the count matches exactly (conservative).
  async _reconcileMovedUids(account, sourceUids, toFolder, destUidNextBefore) {
    if (destUidNextBefore === null) return new Map();
    try {
      const newUids = await withFreshClient(account, async (client) => {
        const lock = await client.getMailboxLock(toFolder);
        try {
          return await client.search({ uid: `${destUidNextBefore}:*` }, { uid: true });
        } finally {
          lock.release();
        }
      });
      if (newUids.length !== sourceUids.length) {
        console.warn(`bulkMoveMessages reconcile: expected ${sourceUids.length} new UIDs in ${toFolder}, found ${newUids.length} — skipping UID update (will reconcile on next sync)`);
        return new Map();
      }
      // IMAP MOVE assigns destination UIDs in ascending source-UID order, so sort BOTH
      // sides before zipping — sourceUids is in arbitrary input order.
      const sortedSrc = sourceUids.map(Number).sort((a, b) => a - b);
      const sortedNew = [...newUids].sort((a, b) => a - b);
      const uidMap = new Map();
      sortedSrc.forEach((uid, i) => uidMap.set(uid, sortedNew[i]));
      console.log(`bulkMoveMessages: reconciled ${uidMap.size} UIDs via destination UIDNEXT scan`);
      return uidMap;
    } catch (err) {
      console.warn(`bulkMoveMessages: UID reconciliation failed (${err.message}) — UIDs will be updated on next sync`);
      return new Map();
    }
  }

  // Permanently delete a batch of UIDs already in the given folder (two-step:
  // flag \Deleted + expunge) in a single IMAP command sequence.
  // Returns { succeeded, failed } — subsets of the input uids array.
  //
  // With UIDPLUS: UID EXPUNGE targets only the specified UIDs — safe.
  // Without UIDPLUS: plain EXPUNGE removes ALL \Deleted messages in the mailbox.
  // To prevent collateral damage, we temporarily unflag any other \Deleted messages
  // before expunging, then restore them in a finally block.
  async bulkPermanentDelete(account, uids, folder) {
    if (!uids.length) return { succeeded: [], failed: [] };
    try {
      await withFreshClient(account, async (client) => {
        const lock = await client.getMailboxLock(folder);
        try {
          const hasUidPlus = client.capabilities?.has('UIDPLUS');
          if (hasUidPlus) {
            const result = await client.messageDelete(uids.map(String).join(','), { uid: true });
            if (result === false) throw new Error('bulk messageDelete returned false — server did not confirm deletion');
          } else {
            // No UIDPLUS: protect other \Deleted messages from the broad EXPUNGE.
            const ourSet = new Set(uids.map(Number));
            const allDeleted = await client.search({ deleted: true }, { uid: true });
            const othersDeleted = allDeleted.filter(uid => !ourSet.has(uid));
            if (othersDeleted.length > 0) {
              await client.messageFlagsRemove(othersDeleted.join(','), ['\\Deleted'], { uid: true });
            }
            try {
              const result = await client.messageDelete(uids.map(String).join(','), { uid: true });
              if (result === false) throw new Error('bulk messageDelete returned false — server did not confirm deletion');
            } finally {
              if (othersDeleted.length > 0) {
                await client.messageFlagsAdd(othersDeleted.join(','), ['\\Deleted'], { uid: true });
              }
            }
          }
        } finally {
          lock.release();
        }
      });
      return { succeeded: uids, failed: [] };
    } catch (err) {
      console.warn(`bulkPermanentDelete ${folder}: batch failed (${err.message}), verifying via UID SEARCH`);
      try {
        const remaining = await withFreshClient(account, async (client) => {
          const lock = await client.getMailboxLock(folder);
          try {
            return await client.search({ uid: uids.join(',') }, { uid: true });
          } finally {
            lock.release();
          }
        });
        const remainingSet = new Set(remaining.map(Number));
        const succeeded = uids.filter(uid => !remainingSet.has(Number(uid)));
        const failed    = uids.filter(uid =>  remainingSet.has(Number(uid)));
        if (succeeded.length) {
          console.log(`bulkPermanentDelete: ${succeeded.length}/${uids.length} messages confirmed deleted via UID SEARCH`);
        }
        return { succeeded, failed };
      } catch (searchErr) {
        console.error(`bulkPermanentDelete: UID SEARCH verification failed: ${searchErr.message}`);
        return { succeeded: [], failed: uids };
      }
    }
  }

  async syncNow(userId, accountId = null) {
    const result = await query(
      'SELECT * FROM email_accounts WHERE user_id = $1 AND enabled = true AND protocol = $2',
      [userId, 'imap']
    );
    const accounts = accountId
      ? result.rows.filter(a => a.id === accountId)
      : result.rows;

    await Promise.all(accounts.map(async (account) => {
      // Guard against overlapping syncs — interval sync may already be running
      if (this.syncingAccounts.has(account.id)) {
        console.log(`syncNow: ${logAccount(account)} already syncing, skipping`);
        return;
      }
      const client = this.connections.get(account.id);
      if (!client) {
        console.log(`syncNow: ${logAccount(account)} not connected, reconnecting`);
        await this.connectAccount(account);
        return;
      }
      this.syncingAccounts.add(account.id);
      this.syncStartedAt.set(account.id, Date.now());
      let usedFreshSyncClient = false;
      try {
        // noBodyParts=true: metadata-only, same as the periodic interval sync.
        // Bodies are cached on first open; fetching them here would slow manual refresh.
        // For freshInboxSync providers (PurelyMail) the persistent connection can be "deaf"
        // to new mail, so a manual refresh must use a brand-new login too — otherwise the
        // button is less reliable than the automatic poll it's meant to shortcut.
        if (providerProfile(account).freshInboxSync) {
          usedFreshSyncClient = true;
          await this._syncInboxWithFreshLogin(account);
        } else {
          await this.syncMessages(account, client, 'INBOX', 20, false, true);
        }
        console.log(`syncNow complete: ${logAccount(account)}`);
      } catch (err) {
        console.error(`syncNow error for ${logAccount(account)}:`, err.message);
        // Identity-guard: if this manual refresh hung and the staleness check meanwhile
        // reconnected a fresh client into the map slot, tear down ONLY the client this
        // syncNow used — never the healthy successor. Skip teardown entirely when the error
        // came from a fresh login (its own connection), not the persistent one.
        if (!usedFreshSyncClient) {
          const conn = this.connections.get(account.id);
          if (conn && conn === client) {
            try { await conn.logout(); } catch { /* already disconnected */ }
            this.connections.delete(account.id);
          }
        }
      } finally {
        this.syncingAccounts.delete(account.id);
        this.syncStartedAt.delete(account.id);
      }
    }));

    this.broadcast({ type: 'sync_complete', accountId: accountId || null }, userId);
  }

  startSnoozeWatcher() {
    this._snoozeWakeupRunning = false;
    this._snoozeWatcherTimer = setInterval(() => {
      if (this._snoozeWakeupRunning) return;
      this._snoozeWakeupRunning = true;
      this._runSnoozeWakeup()
        .catch(err => console.error('Snooze wakeup error:', err.message))
        .finally(() => { this._snoozeWakeupRunning = false; });
    }, 60_000);
  }

  async _runSnoozeWakeup() {
    // Find snoozed messages whose snooze_until has passed and which are still in
    // the snoozed folder (joined via stable Message-ID header).
    const due = await query(`
      SELECT sm.id AS snooze_id, sm.user_id, sm.account_id,
             sm.message_id_header, sm.original_folder, sm.snoozed_folder, m.uid, m.is_read
      FROM snoozed_messages sm
      JOIN messages m ON m.account_id = sm.account_id
                     AND m.message_id = sm.message_id_header
                     AND m.folder = sm.snoozed_folder
                     AND m.is_deleted = false
      WHERE sm.snooze_until <= NOW()
    `);

    for (const row of due.rows) {
      try {
        const accountResult = await query('SELECT * FROM email_accounts WHERE id = $1', [row.account_id]);
        if (!accountResult.rows.length) continue;
        const account = accountResult.rows[0];

        // Guard source UID before the IMAP move so reconcileDeletes cannot delete
        // the DB row if an EXPUNGE arrives from the Snoozed folder while the move
        // is in flight.
        this._guardMoveUid(row.account_id, row.snoozed_folder, row.uid);
        let newUid;
        try {
          // Move back to original folder
          newUid = await this.moveMessageGetNewUid(
            account, row.uid, row.snoozed_folder, row.original_folder
          );

          // Mark as unread so the user notices it
          if (newUid) {
            await this.setFlag(account, newUid, row.original_folder, '\\Seen', false);
          } else if (row.message_id_header) {
            // No UIDPLUS — server moved the message but returned no UID map.
            // Search the destination folder by Message-ID to locate and unflag \Seen.
            try {
              await withFreshClient(account, async (client) => {
                const lock = await client.getMailboxLock(row.original_folder);
                try {
                  const uids = await client.search({ header: ['Message-ID', row.message_id_header] }, { uid: true });
                  if (uids.length > 0) {
                    const r = await client.messageFlagsRemove(String(uids[0]), ['\\Seen'], { uid: true });
                    if (r === false) console.warn(`Snooze wakeup: messageFlagsRemove returned false for ${row.original_folder}`);
                  } else {
                    console.warn(`Snooze wakeup: could not find message in ${row.original_folder} to mark unread (Message-ID: ${row.message_id_header})`);
                  }
                } finally {
                  lock.release();
                }
              });
            } catch (err) {
              console.warn(`Snooze wakeup: could not mark message unread on server (no UIDPLUS): ${err.message}`);
            }
          }

          // Update DB: change folder, mark unread, and update UID if the move returned one.
          if (newUid != null) {
            await query(
              'UPDATE messages SET folder = $1, is_read = false, read_changed_at = NOW(), uid = $4 WHERE account_id = $2 AND message_id = $3 AND folder = $5',
              [row.original_folder, row.account_id, row.message_id_header, newUid, row.snoozed_folder]
            );
          } else {
            // Non-UIDPLUS: DB holds the stale source UID at the destination. Guard it so
            // reconcileDeletes does not treat it as an orphan before the next sync corrects it.
            this._guardMoveUid(row.account_id, row.original_folder, row.uid);
            await query(
              'UPDATE messages SET folder = $1, is_read = false, read_changed_at = NOW() WHERE account_id = $2 AND message_id = $3 AND folder = $4',
              [row.original_folder, row.account_id, row.message_id_header, row.snoozed_folder]
            );
            setTimeout(() => this._unguardMoveUid(row.account_id, row.original_folder, row.uid), 10_000);
          }
        } finally {
          this._unguardMoveUid(row.account_id, row.snoozed_folder, row.uid);
        }

        // Remove snooze record
        await query('DELETE FROM snoozed_messages WHERE id = $1', [row.snooze_id]);

        // Update folder counts: message leaves Snoozed and re-enters original_folder as unread.
        // row.is_read reflects the read state in the Snoozed folder before the move.
        adjustFolderCounts(row.account_id, row.snoozed_folder, -1, row.is_read ? 0 : -1);
        adjustFolderCounts(row.account_id, row.original_folder, 1, 1); // always +1 unread on wakeup

        // Notify the user's open clients so the message reappears
        this.broadcast({ type: 'snooze_wakeup', accountId: row.account_id }, row.user_id);

        console.log(`Snooze wakeup: message ${row.message_id_header} restored to ${row.original_folder}`);
      } catch (err) {
        console.error(`Snooze wakeup failed for snooze_id ${row.snooze_id}:`, err.message);
      }
    }

    // Clean up orphaned snooze records whose message has left the snoozed folder
    // (e.g. user manually moved it out) and are at least 5 minutes past due.
    await query(`
      DELETE FROM snoozed_messages sm
      WHERE sm.snooze_until <= NOW() - INTERVAL '5 minutes'
        AND NOT EXISTS (
          SELECT 1 FROM messages m
          WHERE m.account_id = sm.account_id
            AND m.message_id = sm.message_id_header
            AND m.folder = sm.snoozed_folder
            AND m.is_deleted = false
        )
    `);
  }

  broadcast(data, userId = null) {
    const msg = JSON.stringify(data);
    this.wss.clients.forEach(ws => {
      if (ws.readyState === 1 && (!userId || ws.userId === userId)) {
        try { ws.send(msg); } catch (err) {
          console.error('WebSocket broadcast send error:', err.message);
        }
      }
    });
  }

  // Guard a specific (accountId, folder, uid) triple so reconcileDeletes skips it.
  // Ref-counted so overlapping guards on the same triple (e.g. a bulk move holding it
  // for the whole batch while an inbox-rule move guards the same message) compose: an
  // unguard only frees the triple once the LAST holder releases it, so one operation
  // cannot strip another's in-flight protection.
  _guardMoveUid(accountId, folder, uid) {
    const key = `${accountId}:${folder}:${uid}`;
    this._pendingMoveUids.set(key, (this._pendingMoveUids.get(key) || 0) + 1);
  }

  _unguardMoveUid(accountId, folder, uid) {
    const key = `${accountId}:${folder}:${uid}`;
    const n = (this._pendingMoveUids.get(key) || 0) - 1;
    if (n > 0) this._pendingMoveUids.set(key, n);
    else this._pendingMoveUids.delete(key);
  }

  _isMoveUidGuarded(accountId, folder, uid) {
    return this._pendingMoveUids.has(`${accountId}:${folder}:${uid}`);
  }

  // Compare the server's UID set for every folder that has local messages against our DB
  // and hard-delete rows whose UIDs no longer exist on the server (deleted by another
  // client). Phase 1: collect all server UID sets via one pool connection (IMAP-only, no
  // DB writes). Phase 2: diff and delete outside the IMAP connection so a DB error never
  // evicts a healthy pool client.
  async reconcileDeletes(account) {
    // Captured before the Phase 1 snapshot. Any row inserted or re-synced after this
    // instant (new IDLE mail, a bulk-move reinsert) is NOT in the snapshot yet, so it
    // would look like an orphan. Excluding rows synced at/after the cutoff closes that
    // TOCTOU window without an extra IMAP round-trip. synced_at defaults to now() on
    // every insert; null-synced legacy rows are treated as old and stay eligible.
    const reconcileStartedAt = new Date();
    const folderResult = await query(
      'SELECT DISTINCT folder FROM messages WHERE account_id = $1',
      [account.id]
    );
    if (!folderResult.rows.length) return;

    const folders = folderResult.rows.map(r => r.folder);

    // Phase 1 — fetch server UID sets for each folder (IMAP only, inside withFreshClient).
    const serverUidsByFolder = new Map(); // folder -> Set<number>
    try {
      await withFreshClient(account, async (client) => {
        for (const folder of folders) {
          let serverUids;
          try {
            const lock = await client.getMailboxLock(folder);
            try {
              serverUids = await client.search({ all: true }, { uid: true });
            } finally {
              lock.release();
            }
          } catch (err) {
            // Folder may no longer exist on server or be temporarily inaccessible — skip it.
            console.warn(`Reconcile: could not open ${logAccount(account)}/${folder}: ${extractImapError(err)}`);
            continue;
          }
          serverUidsByFolder.set(folder, new Set(serverUids));
        }
      });
    } catch (err) {
      console.warn(`Reconcile connection error for ${logAccount(account)}: ${extractImapError(err)}`);
      return;
    }

    // Phase 2 — diff each folder's server UIDs against the DB and delete orphans.
    // Runs outside withFreshClient so DB errors never cause unnecessary pool eviction.
    let deletedCount = 0;
    for (const [folder, serverUidSet] of serverUidsByFolder) {
      const dbResult = await query(
        'SELECT uid FROM messages WHERE account_id = $1 AND folder = $2 AND (synced_at IS NULL OR synced_at < $3)',
        [account.id, folder, reconcileStartedAt]
      );
      const orphanUids = dbResult.rows
        .map(r => Number(r.uid))
        .filter(uid => !serverUidSet.has(uid) && !this._isMoveUidGuarded(account.id, folder, uid));

      if (orphanUids.length === 0) continue;

      console.log(`Reconcile: removing ${orphanUids.length} server-deleted message(s) from ${logAccount(account)}/${folder}`);
      // Re-assert the cutoff in the DELETE: a row updated to a fresh synced_at between
      // the SELECT above and here (e.g. a concurrent bulk-move reinsert) is spared.
      await query(
        'DELETE FROM messages WHERE account_id = $1 AND folder = $2 AND uid = ANY($3::bigint[]) AND (synced_at IS NULL OR synced_at < $4)',
        [account.id, folder, orphanUids, reconcileStartedAt]
      );
      // Resync cached folder counts from actual row data — reconcile deletes rows
      // without going through adjustFolderCounts, so counts would otherwise drift.
      await query(
        `UPDATE folders f
         SET total_count  = (SELECT COUNT(*)              FROM messages m WHERE m.account_id = $1 AND m.folder = $2),
             unread_count = (SELECT COUNT(*) FILTER (WHERE m.is_read = false)
                                             FROM messages m WHERE m.account_id = $1 AND m.folder = $2)
         WHERE f.account_id = $1 AND f.path = $2`,
        [account.id, folder]
      );
      deletedCount += orphanUids.length;
    }

    if (deletedCount > 0) {
      this.broadcast({ type: 'sync_complete', accountId: account.id }, account.user_id);
      // Reconcile just removed server-deleted rows across one or more folders. If any was a GTD
      // thread's INBOX (or label) copy GTD section data is now stale — this covers threads archived or
      // deleted by an external mail client, which nothing else here would refresh. Cheap gate.
      await emitGtdSectionsRefreshOnDelete(this, account, deletedCount);
    }
  }

  async connectAllForUser(userId) {
    // Load the user's preferred sync interval before starting any account intervals.
    // Without this, a user who set e.g. 30 s would silently revert to 60 s after
    // a container restart until they next change the setting.
    try {
      const prefResult = await query('SELECT preferences FROM users WHERE id = $1', [userId]);
      const prefs = prefResult.rows[0]?.preferences || {};
      const sec = parseInt(prefs.syncInterval);
      if (sec >= 15 && sec <= 120) {
        this.userSyncIntervalMs.set(userId, sec * 1000);
      }
    } catch (err) {
      console.warn(`Failed to load sync preference for user ${userId}:`, err.message);
    }

    const result = await query(
      'SELECT * FROM email_accounts WHERE user_id = $1 AND enabled = true AND protocol = $2',
      [userId, 'imap']
    );
    // Space out initial connects to stay under per-IP connection rate limits — wider for strict
    // providers (PurelyMail) and scaled by account count, so a large fleet doesn't storm the
    // server and trip an IP ban / account lock. (#218)
    // Skip accounts already connected OR mid-connect (e.g. via the health check).
    const eligible = result.rows.filter(a =>
      !this.connections.has(a.id) && !this.connectingAccounts.has(a.id));
    if (eligible.length) {
      const staggers = eligible.map(a => connectStaggerFor(providerProfile(a), eligible.length));
      const min = Math.min(...staggers), max = Math.max(...staggers);
      const totalMs = staggers.reduce((sum, v) => sum + v, 0);
      const range = min === max ? `${min}ms` : `${min}-${max}ms`;
      // Soak diagnostic (#218): shows the pacing at a glance so you don't have to infer it
      // from the gaps between the per-account "Connecting …" lines.
      console.log(`Auto-connecting ${eligible.length} account(s): connect stagger ${range}, ~${Math.round(totalMs / 1000)}s total spread`);
      let delay = 0;
      for (let i = 0; i < eligible.length; i++) {
        const account = eligible[i];
        setTimeout(
          () => this.connectAccount(account).catch(err =>
            console.error(`Auto-connect failed for ${logAccount(account)}:`, err.message)
          ),
          delay,
        );
        delay += staggers[i];
      }
    }
  }
}
