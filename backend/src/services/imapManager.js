import { ImapFlow } from 'imapflow';
import { query } from './db.js';
import { parseMessage, buildSnippetFromHtml } from './messageParser.js';
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


// Shorthand for log lines — keeps domain visible while masking the local part.
const logAccount = (account) => redactEmail(account?.email_address || '');

// Resolves the IMAP host for an account, applying server-level connection policy.
// Returns { resolved, policy } so callers can pass policy to makeClientCfg.
const resolveAccountHost = async (account) => {
  const policy = await getConnectionPolicy();
  const resolved = await resolveForConnection(account.imap_host, { allowPrivate: policy.allowPrivateHosts });
  return { resolved, policy };
};

// Body parts that cover ~99% of real-world email structures (used for full body caching)
const BODY_PREFETCH_PARTS = ['1', '1.1', '1.2', '2', '2.1', '2.2', '1.1.1', '1.2.1'];

// How long (ms) user must be idle before background IMAP jobs (snippet indexer, folder
// body prefetch) resume after a live body fetch. Keeps click-time fetches snappy by
// deprioritising background traffic whenever the user is actively reading mail.
const QUIET_WINDOW_MS = 8000;

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
// pushesFlags:         server pushes flag changes via IDLE; false = poll every sync tick.
// snippetIndex:        run the background snippet indexer after backfill.
//                      Disabled for providers that throttle body fetches too aggressively.
// skipFolderPatterns:  folder path substrings to skip during backfill (label-view dedup).
// skipFolderNames:     exact folder paths to skip (non-selectable namespace containers).
// batchSize/Delay/errorDelay/batchesPerConn: backfill rate-limit tuning.
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
  generic: {
    batchSize: 100, batchDelay: 1500, errorDelay: 15000, batchesPerConn: 15,
    fetchBody: false,
    pushesFlags: true,
    snippetIndex: true,
    speculativeFetch: true,
    skipFolderPatterns: [],
    skipFolderNames: [],
  },
};

export function providerProfile(account) {
  const host = (account.imap_host || '').toLowerCase();
  if (host.includes('.gmail.com') || host.includes('.googlemail.com')) return PROVIDERS.google;
  if (host.includes('.yahoo.com') || host.includes('.ymail.com')) return PROVIDERS.yahoo;
  if (host.includes('.icloud.com') || host.includes('.apple.com') || host.includes('.me.com')) return PROVIDERS.apple;
  if (host.includes('.outlook.com') || host.includes('office365.com') || host.includes('.hotmail.com') || host.includes('.live.com') || (account.oauth_provider === 'microsoft')) return PROVIDERS.microsoft;
  return PROVIDERS.generic;
}

// Per-account connection pool for body fetches — avoids TLS handshake on every click
const connectionPools = new Map(); // accountId -> { clients: [], waiting: [] }
const POOL_SIZE = 2;

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

export class ImapManager {
  constructor(wss) {
    this.wss = wss;
    this.connections = new Map();   // accountId -> ImapFlow (persistent sync connection)
    this.syncIntervals = new Map();
    this.backfillRunning = new Set(); // `${accountId}:${folder}` — prevent duplicate folder backfills
    this.backfillAllRunning = new Set(); // accountId — prevent concurrent full backfill sequences
    this.onDemandSyncing = new Set(); // `${accountId}:${folder}` — prevent duplicate on-demand syncs
    this.syncingAccounts = new Set(); // prevent overlapping interval syncs
    this.syncThrottleSkips = new Map(); // accountId -> remaining ticks to skip when throttled
    this.connectingAccounts = new Set(); // prevent concurrent connectAccount calls for same account
    this.userSyncIntervalMs = new Map(); // userId -> interval ms (user-configurable)
    this.snippetIndexerRunning = new Set(); // accountId — prevent duplicate snippet-index runs
    this.lastUserActivity = new Map();      // accountId -> ms timestamp of last live body fetch
    this.syncTickCount = new Map(); // accountId -> successful sync ticks (for reconcile scheduling)
    this._flagDebounceTimers   = new Map(); // accountId -> debounce timer for flag-change syncs
    this._expungeDebounceTimers = new Map(); // accountId -> debounce timer for expunge reconciles
    this._pendingFlagSync = new Set(); // accountId — flag sync was skipped because a full sync was running; drain after sync
    // Tracks UIDs that are actively being moved by inboxRules so reconcileDeletes
    // does not delete the DB row if an EXPUNGE arrives before the DB update completes,
    // or if the server is non-UIDPLUS and the DB temporarily holds a stale UID.
    // Keys are "${accountId}:${folder}:${uid}" strings.
    this._pendingMoveUids = new Set();

    // Health check: every 90 seconds, find any enabled IMAP accounts that have no
    // active connection and no in-progress connect attempt, and reconnect them.
    // This recovers accounts that fail the startup connection silently (e.g. a slow
    // IMAP server that times out on the first attempt) without waiting for a manual sync.
    this._healthCheckTimer = setInterval(async () => {
      try {
        const result = await query(
          "SELECT id FROM email_accounts WHERE enabled = true AND protocol = 'imap'"
        );
        for (const row of result.rows) {
          if (!this.connections.has(row.id) && !this.connectingAccounts.has(row.id)) {
            // Only fetch full credentials when a reconnect is actually needed
            const full = await query('SELECT * FROM email_accounts WHERE id = $1', [row.id]);
            const account = full.rows[0];
            if (!account) continue;
            console.log(`Health check: reconnecting ${logAccount(account)} (not connected)`);
            this.connectAccount(account).catch(err =>
              console.error(`Health check reconnect failed for ${logAccount(account)}:`, err.message)
            );
          }
        }
      } catch (err) {
        console.error('Health check error:', err.message);
      }
    }, 90000); // 90 seconds — fast enough to catch startup failures, slow enough not to spam
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
      client = new ImapFlow(makeClientCfg(account, resolved, { enableIdle: true, policy }));
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
        await this.syncFolders(account, client);
        // noBodyParts=true: consistent with the periodic sync — envelope/flags/uid only.
        // Fetching body parts on initial connect stalls on slow servers (purelymail et al).
        await this.syncMessages(account, client, 'INBOX', 20, false, true);
      } catch (syncErr) {
        console.warn(`Initial sync skipped for ${logAccount(account)}: ${extractImapError(syncErr)}`);
      }

      // Pre-warm one pool connection immediately so the first email click doesn't
      // incur a cold TLS handshake. Fire-and-forget — errors are non-fatal.
      setImmediate(() => {
        acquirePooledClient(account)
          .then(c => releasePooledClient(account, c))
          .catch(err => console.warn(`Pool pre-warm failed for ${logAccount(account)}:`, err.message));
      });

      // Backfill uses its OWN connection so it doesn't block the sync connection.
      // backfillAllFolders runs INBOX first, then all other known folders sequentially.
      this.backfillAllFolders(account).catch(err =>
        console.error(`Backfill error for ${logAccount(account)}:`, err.message)
      );

      const intervalMs = this.userSyncIntervalMs.get(account.user_id) || 60000;
      this._startSyncInterval(account, intervalMs);

      console.log(`Connected account: ${logAccount(account)}`);
      this.broadcast({ type: 'account_connected', accountId: account.id }, account.user_id);
      return true;
    } catch (err) {
      const detail = extractImapError(err);
      console.error(`Failed to connect ${logAccount(account)}:`, detail);
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
    const client = this.connections.get(accountId);
    if (client) {
      try { await client.logout(); } catch { /* already disconnected */ }
      this.connections.delete(accountId);
    }
    this.syncThrottleSkips.delete(accountId);
    this.syncTickCount.delete(accountId);
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

  // Extracted sync tick — runs on every interval tick for an account.
  async _syncTick(account) {
    const skips = this.syncThrottleSkips.get(account.id) || 0;
    if (skips > 0) {
      this.syncThrottleSkips.set(account.id, skips - 1);
      return;
    }
    if (this.syncingAccounts.has(account.id)) return;
    this.syncingAccounts.add(account.id);
    try {
      let activeClient = this.connections.get(account.id);
      // syncAccount tracks the freshest account data available — updated to freshAccount
      // on reconnect so that IDLE listeners, provider detection, and flag syncs all use
      // current credentials and config rather than the stale closure-captured object.
      let syncAccount = account;
      if (!activeClient) {
        console.log(`Reconnecting ${logAccount(account)}...`);
        try {
          const accountResult = await query('SELECT * FROM email_accounts WHERE id = $1', [account.id]);
          if (!accountResult.rows.length) return;
          const freshAccount = await ensureFreshToken(accountResult.rows[0]);
          syncAccount = freshAccount;
          const { resolved, policy } = await resolveAccountHost(freshAccount);
          activeClient = new ImapFlow(makeClientCfg(freshAccount, resolved, { enableIdle: true, policy }));
          await Promise.race([
            activeClient.connect(),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('IMAP connection timeout (30s)')), 30000)
            ),
          ]);
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
          console.log(`Reconnected ${logAccount(syncAccount)}`);
        } catch (reconnErr) {
          console.error(`Reconnect failed for ${logAccount(account)}:`, reconnErr.message);
          return;
        }
      }
      // noBodyParts=true: envelope/flags/uid only — avoids slow servers timing out on body fetches.
      // Wall-clock timeout guards against half-open TCP sockets that never trigger commandTimeout.
      await Promise.race([
        this.syncMessages(syncAccount, activeClient, 'INBOX', 20, false, true),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Sync wall-clock timeout (55s)')), 55000)
        ),
      ]);
      this.broadcast({ type: 'sync_complete', accountId: account.id }, account.user_id);

      // Some providers (e.g. Google) don't push flag changes via IDLE — poll every tick.
      // Others (Dovecot, iCloud, PurelyMail) push via the `flags` IDLE event,
      // but if a flag event fired while this sync was running it was deferred into
      // _pendingFlagSync rather than dropped — drain it now.
      const hasPending = this._pendingFlagSync.has(account.id);
      if (!providerProfile(syncAccount).pushesFlags || hasPending) {
        this._pendingFlagSync.delete(account.id);
        setImmediate(() => {
          this._syncFlagsForRange(syncAccount).catch(err =>
            console.warn(`Post-sync flags error for ${logAccount(syncAccount)}:`, err.message)
          );
        });
      }

      // Reconcile remote deletes every 10 successful ticks (~10 min at 60 s interval).
      // Uses a pooled connection so it never blocks the sync client.
      const ticks = (this.syncTickCount.get(account.id) || 0) + 1;
      this.syncTickCount.set(account.id, ticks);
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
      const dead = this.connections.get(account.id);
      if (dead) {
        this.connections.delete(account.id);
        dead.logout().catch(() => {});
      }
    } finally {
      this.syncingAccounts.delete(account.id);
    }
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
              AND messages.folder = 'INBOX'
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
            [uids, reads, starred, account.id]
          );

          if (result.rowCount > 0) {
            console.log(`Flag sync: ${result.rowCount} flag change(s) for ${logAccount(account)}, broadcasting`);
            this.broadcast({ type: 'flags_synced', accountId: account.id }, account.user_id);
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
        if (!mailbox || mailbox.exists === 0) return;

        // UIDVALIDITY check — detects server-side mailbox rebuilds (migration, restore).
        // If UIDVALIDITY changed, all stored UIDs for this folder are invalid; purge them
        // and let backfill re-populate from the new UID epoch.
        const currentValidity = mailbox.uidValidity ? Number(mailbox.uidValidity) : null;
        if (currentValidity) {
          const foldRow = await query(
            'SELECT uid_validity FROM folders WHERE account_id = $1 AND path = $2',
            [account.id, folder]
          );
          const storedValidity = foldRow.rows[0]?.uid_validity ? Number(foldRow.rows[0].uid_validity) : null;
          if (storedValidity !== null && storedValidity !== currentValidity) {
            console.warn(`UIDVALIDITY changed for ${logAccount(account)}/${folder}: ${storedValidity} → ${currentValidity}. Purging stale messages and re-backfilling.`);
            await query('DELETE FROM messages WHERE account_id = $1 AND folder = $2', [account.id, folder]);
            setImmediate(() => {
              this.backfillMessages(account, folder).catch(err =>
                console.error(`Post-UIDVALIDITY backfill error for ${logAccount(account)}/${folder}:`, err.message)
              );
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

        const fetchRange = mailbox.exists > limit
          ? `${mailbox.exists - limit + 1}:${mailbox.exists}` : '1:*';

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

        // Insert/update a single fetched message and track it as new if appropriate.
        // Called from both Phase 1 and Phase 2; ON CONFLICT handles deduplication so
        // a message processed in both phases is never double-counted.
        const processMsg = async (msg) => {
          try {
            const parsed = await parseMessage(msg);
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
              const relocated = await query(`
                UPDATE messages SET folder = $1, uid = $2, is_deleted = false
                WHERE account_id = $3
                  AND message_id = $4
                  AND (folder != $1 OR uid != $2)
                  AND 1 = (SELECT COUNT(*) FROM messages WHERE account_id = $3 AND message_id = $4)
                  AND COALESCE((SELECT special_use FROM folders WHERE account_id = $3 AND path = $1), '') NOT IN ('\\All', '\\Important')
                RETURNING id
              `, [folder, parsed.uid, account.id, msgId]);
              if (relocated.rows.length > 0) return;
            }

            const result = await query(`
              INSERT INTO messages (
                account_id, uid, folder, message_id, subject,
                from_name, from_email, to_addresses, cc_addresses,
                reply_to, in_reply_to,
                date, snippet, is_read, is_starred, has_attachments, flags,
                body_html, body_text, attachments,
                thread_references, thread_id
              ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
              ON CONFLICT (account_id, uid, folder) DO UPDATE
              SET from_name = $6, from_email = $7,
                  to_addresses = $8, cc_addresses = $9,
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
                  thread_id = COALESCE(messages.thread_id, EXCLUDED.thread_id)
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
              refs, threadId,
            ]);
            if (result.rows[0]?.is_new && !parsed.isRead) {
              newMessages.push({ ...parsed, id: result.rows[0].id, accountId: account.id, folder });
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

        // Phase 1 — UID-watermark fetch: guaranteed to find ALL messages that arrived
        // since the last sync, regardless of how many there are.  The sequence-range
        // approach below is limited to `limit` messages and would silently miss older
        // arrivals in the batch when more than `limit` messages arrive between ticks.
        // Skipped on first sync (maxKnownUid=0) because backfill owns initial population.
        if (maxKnownUid > 0) {
          for await (const msg of client.fetch(`${maxKnownUid + 1}:*`, fetchQuery, { uid: true })) {
            await processMsg(msg);
          }
        }

        // Phase 2 — Sequence-range fetch: syncs flag changes (is_read, is_starred) for
        // recent messages, and handles the first-sync case (maxKnownUid=0).
        // Messages already inserted by Phase 1 are processed again here but the
        // ON CONFLICT DO UPDATE is idempotent and xmax=0 prevents double-notification.
        for await (const msg of client.fetch(fetchRange, fetchQuery)) {
          await processMsg(msg);
        }

        if (newMessages.length > 0) {
          // mutedIds: messages that had a mark_read rule applied and stayed in INBOX.
          // Push and client-side sound/toast are skipped for these so mark_read rules
          // don't still alert the user about mail they chose to auto-silence.
          let mutedIds = new Set();
          if (folder === 'INBOX') {
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
          }
          // alertMessages: remaining messages not silenced by a mark_read rule.
          const alertMessages = newMessages.filter(m => !mutedIds.has(m.id));
          const alertCount = alertMessages.length;
          if (newMessages.length > 0) this.broadcast({
            type: 'new_messages', accountId: account.id,
            folder, messages: newMessages.slice(-5), count: newMessages.length,
            alertMessages: alertMessages.slice(-5), alertCount,
          }, account.user_id);
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
              url: '/',
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
          // Only do this for small batches (periodic new mail, not initial bulk sync).
          if (newMessages.length <= 5) {
            const msgsToCache = newMessages.slice();
            setImmediate(() => {
              this.prefetchNewMessageBodies(account, msgsToCache)
                .catch(err => console.warn(`Body prefetch error for ${logAccount(account)}:`, err.message));
            });
          }
        }
        await query('UPDATE email_accounts SET last_sync = NOW() WHERE id = $1', [account.id]);
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

    const cfg = providerProfile(account);

    // Dedicated connection managed here — completely independent of the shared pool
    // so backfilling never blocks the user from opening emails.
    let bfClient = null;
    let batchesOnConn = 0;

    const openBfClient = async () => {
      // Always clean up any existing client before creating a new one
      if (bfClient) { try { await bfClient.logout(); } catch { /* already disconnected */ } bfClient = null; }
      const row = (await query('SELECT * FROM email_accounts WHERE id = $1', [account.id])).rows[0];
      if (!row) throw new Error('Account deleted');
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
              await query('DELETE FROM messages WHERE account_id = $1 AND folder = $2', [account.id, folder]);
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
                  const relocated = await query(`
                    UPDATE messages SET folder = $1, uid = $2, is_deleted = false
                    WHERE account_id = $3
                      AND message_id = $4
                      AND (folder != $1 OR uid != $2)
                      AND 1 = (SELECT COUNT(*) FROM messages WHERE account_id = $3 AND message_id = $4)
                      AND COALESCE((SELECT special_use FROM folders WHERE account_id = $3 AND path = $1), '') NOT IN ('\\All', '\\Important')
                    RETURNING id
                  `, [folder, parsed.uid, account.id, bfMsgId]);
                  if (relocated.rows.length > 0) continue;
                }

                await query(`
                  INSERT INTO messages (
                    account_id, uid, folder, message_id, subject,
                    from_name, from_email, to_addresses, cc_addresses,
                    reply_to, in_reply_to,
                    date, snippet, is_read, is_starred, has_attachments, flags,
                    body_html, body_text, attachments,
                    thread_references, thread_id
                  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
                  ON CONFLICT (account_id, uid, folder) DO UPDATE
                  SET from_name = $6, from_email = $7,
                      to_addresses = $8, cc_addresses = $9,
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
                      thread_id = COALESCE(messages.thread_id, EXCLUDED.thread_id)
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
                  bfRefs, bfThreadId,
                ]);
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
    } catch (err) {
      console.error(`Backfill failed for ${logAccount(account)}/${folder}:`, err.message);
    } finally {
      if (bfClient) { try { await bfClient.logout(); } catch { /* already disconnected */ } }
      this.backfillRunning.delete(backfillKey);
    }
  }

  // Runs backfillMessages for every folder: INBOX first, then all others sequentially.
  // Skips provider-specific duplicate-view folders (e.g. Gmail's All Mail, Starred, Important)
  // to avoid storing tens of thousands of duplicate message rows.
  async backfillAllFolders(account) {
    if (this.backfillAllRunning.has(account.id)) return;
    this.backfillAllRunning.add(account.id);
    this.broadcast({ type: 'backfill_all_start', accountId: account.id }, account.user_id);
    try {
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
      this.backfillAllRunning.delete(account.id);
      this.broadcast({ type: 'backfill_all_complete', accountId: account.id }, account.user_id);
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
    this.snippetIndexerRunning.add(account.id);

    // Rate limit: conservative batches so this doesn't affect normal usage.
    // Cap per run so a large account doesn't occupy an IMAP connection indefinitely;
    // the indexer resumes from where it left off on the next server startup.
    const batchSize = 50;
    const batchDelay = Math.max(cfg.batchDelay, 2000); // at least 2s between batches
    const MAX_BATCHES_PER_RUN = 200; // 10,000 messages max per session

    let siClient = null;
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

      let batchCount = 0;
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
            await new Promise(r => setTimeout(r, cfg.errorDelay));
            if (consecutiveErrors >= 3) {
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
      console.error(`Snippet indexer error ${logAccount(account)}:`, err.message);
    } finally {
      if (siClient) { try { await siClient.logout(); } catch { /* already disconnected */ } }
      this.snippetIndexerRunning.delete(account.id);
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
    await this.appendToFolder(account, folder, rawMessage, ['\\Seen']);
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
          // Build a snippet for the list preview.
          let snip = '';
          if (text) {
            snip = text.replace(/\s+/g, ' ').trim().substring(0, 200);
          } else if (safeHtml || html) {
            // Prefer sanitized HTML — it has comments and template markers already
            // removed by sanitizeEmail(), so the snippet is cleaner.
            snip = buildSnippetFromHtml(safeHtml || html);
          }
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
          let snip = '';
          if (text) {
            snip = text.replace(/\s+/g, ' ').trim().substring(0, 200);
          } else if (safeHtml || html) {
            snip = buildSnippetFromHtml(safeHtml || html);
          }
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
    // Inner fetch — called up to twice (once for stale-connection retry)
    const doFetch = () => withFreshClient(account, async (client) => {
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

    try {
      return await doFetch();
    } catch (firstErr) {
      const detail = extractImapError(firstErr);
      // Retry once on any transient connection-level error (dead pool connection,
      // half-open TCP, NAT expiry, commandTimeout, socket reset, etc.).
      // withFreshClient already evicted the bad connection, so the retry gets a
      // truly fresh one.  Server-side rejections (auth, permission, unknown mailbox)
      // will fail again on retry and propagate to the caller.
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
          return await doFetch();
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
        let headers = '';
        for await (const msg of client.fetch(String(uid), { uid: true, headers: true }, { uid: true })) {
          if (msg.headers) {
            headers = msg.headers.toString();
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
    try {
      await withFreshClient(account, async (client) => {
        const lock = await client.getMailboxLock(folder);
        try {
          let flagResult;
          if (value) {
            flagResult = await client.messageFlagsAdd(String(uid), [flag], { uid: true });
          } else {
            flagResult = await client.messageFlagsRemove(String(uid), [flag], { uid: true });
          }
          if (flagResult === false) {
            console.warn(`setFlag: ImapFlow returned false for uid=${uid} ${flag}=${value} — server may not have applied the flag`);
          } else {
            logger.debug(`setFlag success: uid=${uid} ${flag}=${value}`);
          }
        } finally {
          lock.release();
        }
      });
    } catch (err) {
      console.error(`setFlag failed: uid=${uid}:`, err.message);
      throw err;
    }
  }

  async createFolder(account, path) {
    return withFreshClient(account, async (client) => {
      await client.mailboxCreate(path);
    });
  }

  async ensureFolder(account, path) {
    return withFreshClient(account, async (client) => {
      try {
        await client.mailboxCreate(path);
      } catch (err) {
        const msg = (err.message || '').toLowerCase();
        if (!msg.includes('alreadyexists') && !msg.includes('already exists') && !msg.includes('exist')) {
          throw err;
        }
      }
    });
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
              const sortedNew = [...destNewUids].sort((a, b) => a - b);
              succeeded.forEach((uid, i) => uidMap.set(Number(uid), sortedNew[i]));
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
      const sortedNew = [...newUids].sort((a, b) => a - b);
      const uidMap = new Map();
      sourceUids.forEach((uid, i) => uidMap.set(Number(uid), sortedNew[i]));
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
      try {
        // noBodyParts=true: metadata-only, same as the periodic interval sync.
        // Bodies are cached on first open; fetching them here would slow manual refresh.
        await this.syncMessages(account, client, 'INBOX', 20, false, true);
        console.log(`syncNow complete: ${logAccount(account)}`);
      } catch (err) {
        console.error(`syncNow error for ${logAccount(account)}:`, err.message);
        this.connections.delete(account.id);
      } finally {
        this.syncingAccounts.delete(account.id);
      }
    }));

    this.broadcast({ type: 'sync_complete', accountId: accountId || null }, userId);
  }

  startSnoozeWatcher() {
    this._snoozeWakeupRunning = false;
    setInterval(() => {
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
              'UPDATE messages SET folder = $1, is_read = false, read_changed_at = NOW(), uid = $4 WHERE account_id = $2 AND message_id = $3',
              [row.original_folder, row.account_id, row.message_id_header, newUid]
            );
          } else {
            // Non-UIDPLUS: DB holds the stale source UID at the destination. Guard it so
            // reconcileDeletes does not treat it as an orphan before the next sync corrects it.
            this._guardMoveUid(row.account_id, row.original_folder, row.uid);
            await query(
              'UPDATE messages SET folder = $1, is_read = false, read_changed_at = NOW() WHERE account_id = $2 AND message_id = $3',
              [row.original_folder, row.account_id, row.message_id_header]
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
      if (ws.readyState === 1 && (!userId || ws.userId === userId)) ws.send(msg);
    });
  }

  // Compare the server's UID set against our DB for every folder that has local messages,
  // and hard-delete any rows whose UIDs no longer exist on the server (deleted by another
  // IMAP client). Uses a single pooled connection cycling through each folder so it never
  // contends with the persistent sync client.
  // Compare the server's UID set for every folder that has local messages against our DB
  // and hard-delete rows whose UIDs no longer exist on the server (deleted by another client).
  // Phase 1: collect all server UID sets via one pool connection (IMAP-only, no DB writes).
  // Phase 2: diff and delete outside the IMAP connection so a DB error never evicts a
  // healthy pool client.
  // Guard a specific (accountId, folder, uid) triple so reconcileDeletes skips it.
  // Called by applyAction in inboxRules before initiating an IMAP move.
  _guardMoveUid(accountId, folder, uid) {
    this._pendingMoveUids.add(`${accountId}:${folder}:${uid}`);
  }

  _unguardMoveUid(accountId, folder, uid) {
    this._pendingMoveUids.delete(`${accountId}:${folder}:${uid}`);
  }

  _isMoveUidGuarded(accountId, folder, uid) {
    return this._pendingMoveUids.has(`${accountId}:${folder}:${uid}`);
  }

  async reconcileDeletes(account) {
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
    let hadChanges = false;
    for (const [folder, serverUidSet] of serverUidsByFolder) {
      const dbResult = await query(
        'SELECT uid FROM messages WHERE account_id = $1 AND folder = $2',
        [account.id, folder]
      );
      const orphanUids = dbResult.rows
        .map(r => Number(r.uid))
        .filter(uid => !serverUidSet.has(uid) && !this._isMoveUidGuarded(account.id, folder, uid));

      if (orphanUids.length === 0) continue;

      console.log(`Reconcile: removing ${orphanUids.length} server-deleted message(s) from ${logAccount(account)}/${folder}`);
      await query(
        'DELETE FROM messages WHERE account_id = $1 AND folder = $2 AND uid = ANY($3::bigint[])',
        [account.id, folder, orphanUids]
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
      hadChanges = true;
    }

    if (hadChanges) {
      this.broadcast({ type: 'sync_complete', accountId: account.id }, account.user_id);
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
    let delay = 0;
    for (const account of result.rows) {
      // Skip if already connected OR already in the process of connecting (e.g. health check)
      if (this.connections.has(account.id) || this.connectingAccounts.has(account.id)) continue;
      setTimeout(
        () => this.connectAccount(account).catch(err =>
          console.error(`Auto-connect failed for ${logAccount(account)}:`, err.message)
        ),
        delay,
      );
      delay += 200;
    }
  }
}
