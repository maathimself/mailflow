import { ImapFlow } from 'imapflow';
import { query } from './db.js';
import { parseMessage } from './messageParser.js';
import { refreshMicrosoftToken } from '../routes/oauth.js';
import { sanitizeEmail } from './emailSanitizer.js';
import { decrypt } from './encryption.js';


// Body parts that cover ~99% of real-world email structures (used for full body caching)
const BODY_PREFETCH_PARTS = ['1', '1.1', '1.2', '2', '2.1', '2.2', '1.1.1', '1.2.1'];

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
    try { rawBytes = Buffer.from(b64, 'base64'); } catch (_) { rawBytes = buf; }
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
  } catch (_) {
    return rawBytes.toString('utf8'); // unknown charset — best effort
  }
}

function walkStructure(node, results) {
  if (!node) return;
  const type = (node.type || '').toLowerCase();
  if (node.childNodes && node.childNodes.length > 0) {
    for (const child of node.childNodes) walkStructure(child, results);
    return;
  }
  const disposition = (node.disposition || '').toLowerCase();
  const filename = node.dispositionParameters?.filename || node.parameters?.name || null;
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

// Per-provider backfill rate-limit config.
// batchSize:      messages fetched per IMAP FETCH command
// batchDelay:     ms to wait between batches (on success)
// errorDelay:     base ms to wait after a failed batch (multiplied by error count)
// batchesPerConn: reconnect after this many successful batches (keeps connections fresh)
// fetchBody:      if true, store body_html/body_text during backfill so opening
//                 old emails is instant (no live IMAP fetch needed).
//                 Disabled for Gmail — too throttled to sustain body fetches at scale.
function backfillConfig(account) {
  const host = (account.imap_host || '').toLowerCase();
  if (host.includes('gmail') || host.includes('google')) {
    // Metadata-only (no body parts) — Gmail only throttles BODY[] content fetches,
    // not envelope/flags/uid/bodyStructure.  Large batches + short delay lets us
    // backfill 30 000+ messages in ~2 minutes instead of 12+ hours.
    return { batchSize: 500, batchDelay: 2000, errorDelay: 30000, batchesPerConn: 10, fetchBody: false };
  }
  if (host.includes('icloud') || host.includes('apple') || host.includes('me.com')) {
    // iCloud is permissive — large batches, short delay.
    // Metadata-only: bodies load on-demand and are cached permanently in the DB,
    // so the first open is the only slow one.  Getting all messages visible quickly
    // is more valuable than pre-caching bodies for 27 000+ messages.
    return { batchSize: 200, batchDelay: 1000, errorDelay: 10000, batchesPerConn: 20, fetchBody: false };
  }
  // Generic/unknown providers (e.g. Purelymail) — metadata-only so backfill is fast.
  // Bodies load on-demand via fetchMessageBody() and are cached in DB after first open.
  return { batchSize: 100, batchDelay: 1500, errorDelay: 15000, batchesPerConn: 15, fetchBody: false };
}

// Per-account connection pool for body fetches — avoids TLS handshake on every click
const connectionPools = new Map(); // accountId -> { clients: [], waiting: [] }
const POOL_SIZE = 2;

// Strip null bytes that PostgreSQL's UTF-8 encoding rejects (some emails contain them)
function sanitizeStr(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/\0/g, '');
}

// Ensure OAuth token is fresh before connecting
async function ensureFreshToken(account) {
  if (account.oauth_provider !== 'microsoft') return account;
  if (!account.oauth_token_expiry) return account;
  const expiry = new Date(account.oauth_token_expiry);
  const now = new Date();
  // Refresh if token expires within 5 minutes
  if (expiry - now < 5 * 60 * 1000) {
    console.log(`Refreshing Microsoft token for ${account.email_address}`);
    try {
      account = await refreshMicrosoftToken(account);
    } catch (err) {
      console.error(`Token refresh failed for ${account.email_address}:`, err.message);
    }
  }
  return account;
}

function makeClientCfg(account) {
  const cfg = {
    host: account.imap_host,
    port: account.imap_port,
    secure: account.imap_tls,
    auth: { user: account.auth_user, pass: decrypt(account.auth_pass) },
    logger: false,
    tls: { rejectUnauthorized: !account.imap_skip_tls_verify },
    // Prevent IMAP commands from hanging forever on half-open TCP connections.
    // Without this, a silently-dead connection causes every sync call to wait
    // indefinitely — the refresh button spins forever and auto-poll stops working.
    commandTimeout: 30000,
  };
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

async function acquirePooledClient(account) {
  const id = account.id;
  if (!connectionPools.has(id)) {
    connectionPools.set(id, { clients: [], inUse: new Set() });
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
    const client = new ImapFlow(makeClientCfg(freshAccount));
    await Promise.race([
      client.connect(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('IMAP connection timeout (30s)')), 30000)
      ),
    ]);
    // Remove from pool immediately when the server closes the socket
    client.on('close', () => {
      const p = connectionPools.get(id);
      if (p) {
        p.clients = p.clients.filter(c => c !== client);
        p.inUse.delete(client);
      }
    });
    client.on('error', (err) => {
      console.error(`IMAP pool error for account ${id}:`, err.message);
    });
    pool.clients.push(client);
    pool.inUse.add(client);
    return client;
  }

  // Pool full — wait for one to become free (poll every 100ms, max 10s)
  for (let i = 0; i < 100; i++) {
    await new Promise(r => setTimeout(r, 100));
    const free = pool.clients.find(c => !pool.inUse.has(c));
    if (free) { pool.inUse.add(free); return free; }
  }

  // Timeout — create a temporary client outside the pool
  const freshAccount = await ensureFreshToken(account);
  const tmp = new ImapFlow(makeClientCfg(freshAccount));
  tmp.on('error', (err) => {
    console.error(`IMAP temp client error for account ${account.id}:`, err.message);
  });
  await Promise.race([
    tmp.connect(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('IMAP connection timeout (30s)')), 30000)
    ),
  ]);
  return tmp; // caller must logout this one
}

function releasePooledClient(account, client) {
  const pool = connectionPools.get(account.id);
  if (!pool) { try { client.logout(); } catch (_) {} return; }
  pool.inUse.delete(client);
  // If this client isn't in our pool (was a temp), log it out
  if (!pool.clients.includes(client)) {
    try { client.logout(); } catch (_) {}
  }
}

function evictPool(accountId) {
  const pool = connectionPools.get(accountId);
  if (!pool) return;
  for (const c of pool.clients) { try { c.logout(); } catch (_) {} }
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
    const pool = connectionPools.get(account.id);
    if (pool) {
      pool.inUse.delete(client);
      pool.clients = pool.clients.filter(c => c !== client);
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
    this.syncTickCount = new Map(); // accountId -> successful sync ticks (for reconcile scheduling)

    // Health check: every 90 seconds, find any enabled IMAP accounts that have no
    // active connection and no in-progress connect attempt, and reconnect them.
    // This recovers accounts that fail the startup connection silently (e.g. a slow
    // IMAP server that times out on the first attempt) without waiting for a manual sync.
    setInterval(async () => {
      try {
        const result = await query(
          "SELECT * FROM email_accounts WHERE enabled = true AND protocol = 'imap'"
        );
        for (const account of result.rows) {
          if (!this.connections.has(account.id) && !this.connectingAccounts.has(account.id)) {
            console.log(`Health check: reconnecting ${account.email_address} (not connected)`);
            this.connectAccount(account).catch(err =>
              console.error(`Health check reconnect failed for ${account.email_address}:`, err.message)
            );
          }
        }
      } catch (err) {
        console.error('Health check error:', err.message);
      }
    }, 90000); // 90 seconds — fast enough to catch startup failures, slow enough not to spam
  }

  async connectAccount(account) {
    // Guard against concurrent connect calls for the same account.
    // This happens when startup and a WebSocket connection both call connectAllForUser
    // before the first connectAccount completes — without this, both would connect the
    // same account in parallel, leaving one interval/client permanently orphaned.
    if (this.connectingAccounts.has(account.id)) {
      console.log(`Already connecting ${account.email_address}, skipping duplicate`);
      return false;
    }
    this.connectingAccounts.add(account.id);
    console.log(`Connecting ${account.email_address} (${account.imap_host}:${account.imap_port})…`);

    // Always clean up any existing connection and interval first.
    // Previously this only ran when a connection existed, which left orphaned
    // intervals running whenever the connection died between reconnect attempts.
    await this.disconnectAccount(account.id);

    // Refresh OAuth token if needed before connecting
    account = await ensureFreshToken(account);
    const client = new ImapFlow(makeClientCfg(account));
    try {
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
          console.log(`IMAP connection closed for ${account.email_address}`);
        }
      });
      // Prevent unhandled 'error' events from crashing the Node.js process.
      // ImapFlow emits 'error' on socket timeouts and other transport-level failures;
      // without this listener Node throws on unhandled EventEmitter errors.
      client.on('error', (err) => {
        console.error(`IMAP error for ${account.email_address}:`, err.message);
      });

      this.connections.set(account.id, client);
      await query('UPDATE email_accounts SET sync_error = NULL WHERE id = $1', [account.id]);

      // Initial sync is non-fatal — throttling or temporary IMAP errors here should
      // not prevent the account from being marked connected. The 60-second interval
      // will retry the sync on the next tick.
      try {
        await this.syncFolders(account, client);
        // noBodyParts=true: consistent with the periodic sync — envelope/flags/uid only.
        // Fetching body parts on initial connect stalls on slow servers (purelymail et al).
        await this.syncMessages(account, client, 'INBOX', 50, false, true);
      } catch (syncErr) {
        console.warn(`Initial sync skipped for ${account.email_address}: ${extractImapError(syncErr)}`);
      }

      // Pre-warm one pool connection immediately so the first email click doesn't
      // incur a cold TLS handshake. Fire-and-forget — errors are non-fatal.
      setImmediate(() => {
        acquirePooledClient(account)
          .then(c => releasePooledClient(account, c))
          .catch(err => console.warn(`Pool pre-warm failed for ${account.email_address}:`, err.message));
      });

      // Backfill uses its OWN connection so it doesn't block the sync connection.
      // backfillAllFolders runs INBOX first, then all other known folders sequentially.
      this.backfillAllFolders(account).catch(err =>
        console.error(`Backfill error for ${account.email_address}:`, err.message)
      );

      const intervalMs = this.userSyncIntervalMs.get(account.user_id) || 60000;
      this._startSyncInterval(account, intervalMs);

      console.log(`Connected account: ${account.email_address}`);
      this.broadcast({ type: 'account_connected', accountId: account.id }, account.user_id);
      return true;
    } catch (err) {
      const detail = extractImapError(err);
      console.error(`Failed to connect ${account.email_address}:`, detail);
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
      try { await client.logout(); } catch (_) {}
      this.connections.delete(accountId);
    }
    this.syncThrottleSkips.delete(accountId);
    this.syncTickCount.delete(accountId);
    evictPool(accountId);
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
      if (!activeClient) {
        console.log(`Reconnecting ${account.email_address}...`);
        try {
          const accountResult = await query('SELECT * FROM email_accounts WHERE id = $1', [account.id]);
          if (!accountResult.rows.length) return;
          const freshAccount = await ensureFreshToken(accountResult.rows[0]);
          activeClient = new ImapFlow(makeClientCfg(freshAccount));
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
            console.error(`IMAP error for ${account.email_address}:`, err.message);
          });
          this.connections.set(account.id, activeClient);
          console.log(`Reconnected ${account.email_address}`);
        } catch (reconnErr) {
          console.error(`Reconnect failed for ${account.email_address}:`, reconnErr.message);
          return;
        }
      }
      // noBodyParts=true: envelope/flags/uid only — avoids slow servers timing out on body fetches.
      // Wall-clock timeout guards against half-open TCP sockets that never trigger commandTimeout.
      await Promise.race([
        this.syncMessages(account, activeClient, 'INBOX', 50, false, true),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Sync wall-clock timeout (55s)')), 55000)
        ),
      ]);
      this.broadcast({ type: 'sync_complete', accountId: account.id }, account.user_id);

      // Reconcile remote deletes every 10 successful ticks (~10 min at 60 s interval).
      // Uses a pooled connection so it never blocks the sync client.
      const ticks = (this.syncTickCount.get(account.id) || 0) + 1;
      this.syncTickCount.set(account.id, ticks);
      if (ticks % 10 === 0) {
        setImmediate(() => {
          this.reconcileDeletes(account).catch(err =>
            console.error(`Reconcile error for ${account.email_address}:`, err.message)
          );
        });
      }
    } catch (err) {
      const detail = extractImapError(err);
      console.error(`Sync error for ${account.email_address}:`, detail);
      if (detail.includes('THROTTLED') || detail.includes('throttl')) {
        this.syncThrottleSkips.set(account.id, 4);
      }
      const dead = this.connections.get(account.id);
      if (dead) {
        this.connections.delete(account.id);
        try { dead.logout(); } catch (_) {}
      }
    } finally {
      this.syncingAccounts.delete(account.id);
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
      console.error(`Folder sync error for ${account.email_address}:`, err.message);
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
    const isGmail = (account.imap_host || '').toLowerCase().includes('imap.gmail.com') ||
                    (account.imap_host || '').toLowerCase().includes('imap.googlemail.com');

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
            console.warn(`UIDVALIDITY changed for ${account.email_address}/${folder}: ${storedValidity} → ${currentValidity}. Purging stale messages and re-backfilling.`);
            await query('DELETE FROM messages WHERE account_id = $1 AND folder = $2', [account.id, folder]);
            setImmediate(() => {
              this.backfillMessages(account, folder).catch(err =>
                console.error(`Post-UIDVALIDITY backfill error for ${account.email_address}/${folder}:`, err.message)
              );
            });
          }
        }

        await query(`
          INSERT INTO folders (account_id, path, name, total_count, unread_count, uid_validity)
          VALUES ($1, $2, $2, $3, $4, $5)
          ON CONFLICT (account_id, path) DO UPDATE
          SET total_count = $3, unread_count = $4, uid_validity = COALESCE($5, folders.uid_validity), updated_at = NOW()
        `, [account.id, folder, mailbox.exists, mailbox.unseen || 0, currentValidity]);

        const fetchRange = mailbox.exists > limit
          ? `${mailbox.exists - limit + 1}:${mailbox.exists}` : '1:*';

        // For Gmail: omit body parts entirely to avoid triggering IMAP throttling.
        // We still get uid/flags/envelope (subject, from, date) and bodyStructure
        // (needed for hasAttachments).  Snippets/bodies come from backfill.
        const fetchQuery = {
          uid: true, flags: true, envelope: true,
          bodyStructure: true,
          size: true,
          internalDate: true,
        };
        if (!isGmail && !noBodyParts) {
          fetchQuery.bodyParts = BODY_PREFETCH_PARTS;
        }

        // Highest UID we already have in DB for this account/folder — used as the
        // watermark for Phase 1 new-message detection.
        const { rows: [{ max_uid }] } = await query(
          'SELECT COALESCE(MAX(uid), 0) as max_uid FROM messages WHERE account_id = $1 AND folder = $2',
          [account.id, folder]
        );
        const maxKnownUid = Number(max_uid);

        const newMessages = [];

        // Insert/update a single fetched message and track it as new if appropriate.
        // Called from both Phase 1 and Phase 2; ON CONFLICT handles deduplication so
        // a message processed in both phases is never double-counted.
        const processMsg = async (msg) => {
          try {
            const parsed = await parseMessage(msg);
            let safeHtml = null, text = null, atts = [];
            if (prefetchBody && !isGmail) {
              const body = extractBodyFromMsg(msg);
              safeHtml = body.html ? sanitizeEmail(body.html) : null;
              text = body.text;
              atts = body.attachments;
            }
            const result = await query(`
              INSERT INTO messages (
                account_id, uid, folder, message_id, subject,
                from_name, from_email, to_addresses, cc_addresses,
                reply_to, in_reply_to,
                date, snippet, is_read, is_starred, has_attachments, flags,
                body_html, body_text, attachments
              ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
              ON CONFLICT (account_id, uid, folder) DO UPDATE
              SET from_name = $6, from_email = $7,
                  to_addresses = $8, cc_addresses = $9,
                  reply_to = COALESCE(NULLIF(messages.reply_to::text, '[]'), EXCLUDED.reply_to::text)::jsonb,
                  in_reply_to = COALESCE(messages.in_reply_to, EXCLUDED.in_reply_to),
                  snippet = CASE WHEN EXCLUDED.snippet != '' THEN EXCLUDED.snippet
                                 ELSE messages.snippet END,
                  is_read = $14, is_starred = $15, flags = $17,
                  body_html = COALESCE(messages.body_html, EXCLUDED.body_html),
                  body_text = COALESCE(messages.body_text, EXCLUDED.body_text),
                  attachments = COALESCE(messages.attachments::text, EXCLUDED.attachments::text)::jsonb
              RETURNING id, (xmax = 0) as is_new
            `, [
              account.id, parsed.uid, folder,
              sanitizeStr(parsed.messageId), sanitizeStr(parsed.subject),
              sanitizeStr(parsed.fromName), sanitizeStr(parsed.fromEmail),
              JSON.stringify(parsed.to), JSON.stringify(parsed.cc),
              JSON.stringify(parsed.replyTo || []), sanitizeStr(parsed.inReplyTo),
              safeDate(parsed.date), sanitizeStr(parsed.snippet),
              parsed.isRead, parsed.isStarred,
              parsed.hasAttachments, JSON.stringify(parsed.flags),
              sanitizeStr(safeHtml), sanitizeStr(text), JSON.stringify(atts || [])
            ]);
            if (result.rows[0]?.is_new && !parsed.isRead) {
              newMessages.push({ ...parsed, id: result.rows[0].id, accountId: account.id, folder });
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
          this.broadcast({
            type: 'new_messages', accountId: account.id,
            folder, messages: newMessages.slice(-5), count: newMessages.length
          }, account.user_id);
          // Pre-warm the body cache for newly arrived messages so clicking one
          // immediately after receipt doesn't require a live IMAP fetch.
          // Only do this for small batches (periodic new mail, not initial bulk sync).
          if (newMessages.length <= 5) {
            const msgsToCache = newMessages.slice();
            setImmediate(() => {
              this.prefetchNewMessageBodies(account, msgsToCache)
                .catch(err => console.warn(`Body prefetch error for ${account.email_address}:`, err.message));
            });
          }
        }
        await query('UPDATE email_accounts SET last_sync = NOW() WHERE id = $1', [account.id]);
      } finally {
        lock.release();
      }
    } catch (err) {
      console.error(`Message sync error for ${account.email_address}/${folder}:`, extractImapError(err));
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

    const cfg = backfillConfig(account);
    console.log(`Starting backfill for ${account.email_address} (batch=${cfg.batchSize}, delay=${cfg.batchDelay}ms, fetchBody=${cfg.fetchBody})`);

    // Dedicated connection managed here — completely independent of the shared pool
    // so backfilling never blocks the user from opening emails.
    let bfClient = null;
    let batchesOnConn = 0;

    const openBfClient = async () => {
      // Always clean up any existing client before creating a new one
      if (bfClient) { try { await bfClient.logout(); } catch (_) {} bfClient = null; }
      const row = (await query('SELECT * FROM email_accounts WHERE id = $1', [account.id])).rows[0];
      if (!row) throw new Error('Account deleted');
      const fresh = await ensureFreshToken(row);
      const newClient = new ImapFlow(makeClientCfg(fresh));
      newClient.on('error', (err) => {
        console.error(`Backfill IMAP error for ${account.email_address}:`, err.message);
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
            console.log(`Backfill ${account.email_address}: mailbox empty`);
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
              console.warn(`Backfill: UIDVALIDITY changed for ${account.email_address}/${folder}: ${storedValidity} → ${currentValidity}. Purging stale messages.`);
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
        'SELECT COUNT(*) as count, COALESCE(MAX(uid), 0) as max_uid FROM messages WHERE account_id = $1 AND folder = $2',
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
        console.log(`Backfill already complete for ${account.email_address}: maxDbUid=${maxDbUid}, maxServerUid=${maxServerUid}, dbCount=${dbCount}`);
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
        console.log(`Backfill ${account.email_address}: no missing UIDs (${dbCount} in DB vs ${serverTotal} on server — within tolerance)`);
        return;
      }

      console.log(`Backfill ${account.email_address}: ${missingUids.length} missing of ${serverTotal} (${dbCount} already in DB)`);
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
          console.log(`Backfill stopping — account ${account.email_address} was deleted`);
          return;
        }

        // Periodically reconnect to keep connections fresh and pick up refreshed OAuth tokens
        if (batchesOnConn >= cfg.batchesPerConn) {
          try { await openBfClient(); }
          catch (reconnErr) {
            console.error(`Backfill reconnect failed for ${account.email_address}:`, reconnErr.message);
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

                await query(`
                  INSERT INTO messages (
                    account_id, uid, folder, message_id, subject,
                    from_name, from_email, to_addresses, cc_addresses,
                    reply_to, in_reply_to,
                    date, snippet, is_read, is_starred, has_attachments, flags,
                    body_html, body_text, attachments
                  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
                  ON CONFLICT (account_id, uid, folder) DO UPDATE
                  SET from_name = $6, from_email = $7,
                      to_addresses = $8, cc_addresses = $9,
                      reply_to = COALESCE(NULLIF(messages.reply_to::text, '[]'), EXCLUDED.reply_to::text)::jsonb,
                      in_reply_to = COALESCE(messages.in_reply_to, EXCLUDED.in_reply_to),
                      snippet = CASE WHEN EXCLUDED.snippet != '' THEN EXCLUDED.snippet
                                     ELSE messages.snippet END,
                      body_html = COALESCE(messages.body_html, EXCLUDED.body_html),
                      body_text = COALESCE(messages.body_text, EXCLUDED.body_text),
                      attachments = COALESCE(messages.attachments::text, EXCLUDED.attachments::text)::jsonb
                `, [
                  account.id, parsed.uid, folder,
                  sanitizeStr(parsed.messageId), sanitizeStr(parsed.subject),
                  sanitizeStr(parsed.fromName), sanitizeStr(parsed.fromEmail),
                  JSON.stringify(parsed.to), JSON.stringify(parsed.cc),
                  JSON.stringify(parsed.replyTo || []), sanitizeStr(parsed.inReplyTo),
                  safeDate(parsed.date), sanitizeStr(parsed.snippet),
                  parsed.isRead, parsed.isStarred,
                  parsed.hasAttachments, JSON.stringify(parsed.flags),
                  sanitizeStr(safeHtml), sanitizeStr(bodyText), JSON.stringify(atts || []),
                ]);
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
            console.log(`Backfill ${account.email_address}: ${i}/${missingUids.length} missing fetched`);
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
          if (bfClient) { try { await bfClient.logout(); } catch (_) {} bfClient = null; }
          batchesOnConn = cfg.batchesPerConn; // force reconnect

          if (consecutiveErrors >= 3) {
            // Persistent failures — halve the batch size to reduce load on the server
            // rather than skipping messages entirely (which would leave permanent gaps).
            const oldSize = cfg.batchSize;
            cfg.batchSize = Math.max(10, Math.floor(cfg.batchSize / 2));
            console.warn(`Backfill reducing batch size for ${account.email_address}: ${oldSize} → ${cfg.batchSize} after 3 failures (${detail})`);
            consecutiveErrors = 0;
            await new Promise(r => setTimeout(r, cfg.batchDelay));
          } else {
            const wait = cfg.errorDelay * Math.min(consecutiveErrors, 6);
            console.error(`Backfill batch error for ${account.email_address}: ${detail} — retry ${consecutiveErrors}/3 after ${wait}ms`);
            await new Promise(r => setTimeout(r, wait));
            // Do NOT advance i — retry the same batch
          }
        }
      }

      console.log(`Backfill complete for ${account.email_address}/${folder}`);
      this.broadcast({ type: 'backfill_complete', accountId: account.id }, account.user_id);
    } catch (err) {
      console.error(`Backfill failed for ${account.email_address}/${folder}:`, err.message);
    } finally {
      if (bfClient) { try { await bfClient.logout(); } catch (_) {} }
      this.backfillRunning.delete(backfillKey);
    }
  }

  // Runs backfillMessages for every folder: INBOX first, then all others sequentially.
  // Skips Gmail's duplicate-view folders (All Mail, Starred, Important) to avoid
  // storing tens of thousands of duplicate message rows.
  async backfillAllFolders(account) {
    if (this.backfillAllRunning.has(account.id)) return;
    this.backfillAllRunning.add(account.id);
    try {
      const isGmail = (account.imap_host || '').toLowerCase().includes('imap.gmail.com') ||
                      (account.imap_host || '').toLowerCase().includes('imap.googlemail.com');

      // INBOX first — highest priority, existing behaviour
      await this.backfillMessages(account, 'INBOX');

      // Then all other known folders (discovered at connect time by syncFolders)
      const folderResult = await query(
        "SELECT path FROM folders WHERE account_id = $1 AND path != 'INBOX' ORDER BY path",
        [account.id]
      );

      for (const { path } of folderResult.rows) {
        // Gmail: skip folders that are just label-views of messages already in other folders
        if (isGmail) {
          const p = path.toLowerCase();
          if (p.includes('all mail') || p.includes('[gmail]/starred') || p.includes('[gmail]/important')) {
            continue;
          }
        }
        await this.backfillMessages(account, path).catch(err =>
          console.warn(`Backfill skipped ${account.email_address}/${path}: ${err.message}`)
        );
      }
    } finally {
      this.backfillAllRunning.delete(account.id);
      this.startSnippetIndexer(account).catch(err =>
        console.error(`Snippet indexer failed for ${account.email_address}:`, err.message)
      );
    }
  }

  // Background job that fetches text snippets for messages that were backfilled without
  // body parts (the common case — backfill runs metadata-only for speed). Runs per-account
  // after backfill completes, and also at connect time for existing accounts.
  // Non-Gmail only: Gmail throttles BODY content fetches too aggressively to do this at scale.
  // Processes most-recent messages first so the most useful results are indexed quickly.
  async startSnippetIndexer(account) {
    const isGmail = (account.imap_host || '').toLowerCase().includes('gmail') ||
                    (account.imap_host || '').toLowerCase().includes('google');
    if (isGmail) return; // Skip — Gmail throttles body fetches heavily

    if (this.snippetIndexerRunning.has(account.id)) return;
    this.snippetIndexerRunning.add(account.id);

    // Rate limit: conservative batches so this doesn't affect normal usage.
    // Cap per run so a large account doesn't occupy an IMAP connection indefinitely;
    // the indexer resumes from where it left off on the next server startup.
    const cfg = backfillConfig(account);
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

      console.log(`Snippet indexer: ${account.email_address} has ${totalMissing} messages without snippets`);

      const openClient = async () => {
        if (siClient) { try { await siClient.logout(); } catch (_) {} siClient = null; }
        const row = (await query('SELECT * FROM email_accounts WHERE id = $1', [account.id])).rows[0];
        if (!row) throw new Error('Account deleted');
        const fresh = await ensureFreshToken(row);
        const c = new ImapFlow(makeClientCfg(fresh));
        c.on('error', err => console.error(`Snippet indexer IMAP error ${account.email_address}:`, err.message));
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
            console.log(`Snippet indexer paused for ${account.email_address} after ${batchCount} batches — ${remaining.rows[0].count} remaining, will resume on next startup`);
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
                } catch (_) {}
              }
            } finally {
              lock.release();
            }
            batchCount++;
          } catch (err) {
            console.error(`Snippet indexer batch error ${account.email_address}/${folder}:`, err.message);
            await new Promise(r => setTimeout(r, cfg.errorDelay));
          }

          await new Promise(r => setTimeout(r, batchDelay));
        }
      }

      console.log(`Snippet indexer complete for ${account.email_address} (${batchCount} batches)`);
    } catch (err) {
      console.error(`Snippet indexer error ${account.email_address}:`, err.message);
    } finally {
      if (siClient) { try { await siClient.logout(); } catch (_) {} }
      this.snippetIndexerRunning.delete(account.id);
    }
  }

  // Syncs the most recent messages in a specific folder on demand.
  // Called when the user navigates to a folder that has no local messages yet.
  // Uses a pooled connection — does NOT touch the main sync connection.
  async appendToSent(account, folder, rawMessage) {
    await withFreshClient(account, async (client) => {
      await client.append(folder, rawMessage, ['\\Seen']);
    });
    console.log(`Appended sent message to IMAP ${account.email_address}/${folder}`);
  }

  async syncFolderOnDemand(account, folder) {
    const key = `${account.id}:${folder}`;
    if (this.onDemandSyncing.has(key)) {
      console.log(`syncFolderOnDemand skipped (already running): ${account.email_address}/${folder}`);
      return;
    }
    this.onDemandSyncing.add(key);
    console.log(`syncFolderOnDemand start: ${account.email_address}/${folder}`);
    try {
      await withFreshClient(account, async (client) => {
        await this.syncMessages(account, client, folder, 100, false, true);
      });
      console.log(`syncFolderOnDemand done: ${account.email_address}/${folder}`);
      // sync_complete fires mailflow:refresh in the frontend, reloading the message list
      this.broadcast({ type: 'sync_complete', accountId: account.id }, account.user_id);
    } catch (err) {
      console.error(`On-demand sync error ${account.email_address}/${folder}:`, err.message);
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
          // Build a snippet for the list preview; strip HTML tags when only html is available
          let snip = '';
          if (text) {
            snip = text.replace(/\s+/g, ' ').trim().substring(0, 200);
          } else if (html) {
            snip = html
              .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
              .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
              .replace(/<[^>]+>/g, ' ')
              .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
              .replace(/\s+/g, ' ').trim().substring(0, 200);
          }
          await query(
            `UPDATE messages
             SET body_html = $1, body_text = $2, attachments = $3,
                 snippet = CASE WHEN snippet IS NULL OR snippet = '' THEN $5 ELSE snippet END
             WHERE id = $4`,
            [safeHtml, text, JSON.stringify(attachments || []), msg.id, snip]
          );
        }
      } catch (err) {
        console.warn(`Body prefetch failed for uid ${msg.uid}:`, err.message);
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
      let attachments = [];
      // Always address by UID string with uid:true option — direct UID FETCH avoids
      // the two-step SEARCH+FETCH path that object-range syntax triggers, which can
      // silently return nothing on stale connections or when a server-side search
      // quota is hit.
      const uidStr = String(uid);

      const lock = await client.getMailboxLock(folder);
      try {
        // Step 1: fetch bodyStructure only to discover the actual part layout.
        // Previously we speculatively pre-fetched common part numbers alongside the
        // structure, but Gmail returns a hard "Some messages could not be FETCHed
        // (Failure)" error if any requested part number doesn't exist in that specific
        // message. Fetching structure first and then only the real parts avoids this.
        let structure = null;
        const prefetched = new Map(); // part number -> Buffer

        for await (const msg of client.fetch(uidStr, { uid: true, bodyStructure: true }, { uid: true })) {
          structure = msg.bodyStructure;
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

        // Step 2: fetch text parts + any inline image parts in one round-trip
        const inlineImages = results.inlineImages || [];
        const needed = [
          ...new Set([
            ...results.textParts.map(p => p.part),
            ...inlineImages.map(p => p.part),
          ])
        ];
        if (needed.length > 0) {
          // Initial batched fetch — one round-trip for all needed parts.
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
            } catch (_) {} // don't let a single part failure block others
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

      return { html, text, attachments };
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
            console.warn(`fetchMessageBody: uid=${uid} folder=${folder} account=${account.email_address} — no body after retry; message may be missing on server`);
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
            buffer = encoding.toLowerCase() === 'base64'
              ? Buffer.from(buf.toString('utf8').replace(/\s/g, ''), 'base64')
              : buf;
          }
        }
        return buffer;
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
          if (value) {
            await client.messageFlagsAdd(String(uid), [flag], { uid: true });
          } else {
            await client.messageFlagsRemove(String(uid), [flag], { uid: true });
          }
          console.log(`setFlag success: uid=${uid} ${flag}=${value}`);
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
        await client.messageFlagsAdd('1:*', ['\\Deleted'], { uid: false });
        await client.messageExpunge('1:*', { uid: false });
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
        await client.messageFlagsAdd('1:*', ['\\Seen'], { uid: false });
      } catch (err) {
        console.warn(`markAllRead IMAP warning for ${folder}:`, err.message);
        // Non-fatal — DB is already updated
      } finally {
        lock.release();
      }
    });
  }

  async moveMessage(account, uid, fromFolder, toFolder) {
    try {
      await withFreshClient(account, async (client) => {
        const lock = await client.getMailboxLock(fromFolder);
        try {
          await client.messageMove(String(uid), toFolder, { uid: true });
        } finally {
          lock.release();
        }
      });
    } catch (err) {
      console.error(`moveMessage failed: uid=${uid}:`, err.message);
      throw err;
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
        console.log(`syncNow: ${account.email_address} already syncing, skipping`);
        return;
      }
      const client = this.connections.get(account.id);
      if (!client) {
        console.log(`syncNow: ${account.email_address} not connected, reconnecting`);
        await this.connectAccount(account);
        return;
      }
      this.syncingAccounts.add(account.id);
      try {
        // noBodyParts=true: metadata-only, same as the periodic interval sync.
        // Bodies are cached on first open; fetching them here would slow manual refresh.
        await this.syncMessages(account, client, 'INBOX', 50, false, true);
        console.log(`syncNow complete: ${account.email_address}`);
      } catch (err) {
        console.error(`syncNow error for ${account.email_address}:`, err.message);
        this.connections.delete(account.id);
      } finally {
        this.syncingAccounts.delete(account.id);
      }
    }));

    // Small delay to ensure DB writes are committed before frontend re-fetches
    await new Promise(r => setTimeout(r, 500));
    this.broadcast({ type: 'sync_complete', accountId: accountId || null }, userId);
  }

  broadcast(data, userId = null) {
    const msg = JSON.stringify(data);
    this.wss.clients.forEach(ws => {
      if (ws.readyState === 1 && (!userId || ws.userId === userId)) ws.send(msg);
    });
  }

  // Compare the server's INBOX UID set against our DB and hard-delete any rows
  // whose UIDs no longer exist on the server (deleted by another IMAP client).
  // Uses a pooled connection so it never contends with the persistent sync client.
  async reconcileDeletes(account) {
    const folder = 'INBOX';
    let serverUids;
    try {
      await withFreshClient(account, async (client) => {
        const lock = await client.getMailboxLock(folder);
        try {
          serverUids = await client.search({ all: true }, { uid: true });
        } finally {
          lock.release();
        }
      });
    } catch (err) {
      // Connection failure — skip this reconcile cycle silently
      console.warn(`Reconcile: could not fetch server UIDs for ${account.email_address}: ${extractImapError(err)}`);
      return;
    }

    const serverUidSet = new Set(serverUids);
    const dbResult = await query(
      'SELECT uid FROM messages WHERE account_id = $1 AND folder = $2',
      [account.id, folder]
    );
    const orphanUids = dbResult.rows
      .map(r => Number(r.uid))
      .filter(uid => !serverUidSet.has(uid));

    if (orphanUids.length === 0) return;

    console.log(`Reconcile: removing ${orphanUids.length} server-deleted message(s) from ${account.email_address}/${folder}`);
    await query(
      'DELETE FROM messages WHERE account_id = $1 AND folder = $2 AND uid = ANY($3::bigint[])',
      [account.id, folder, orphanUids]
    );
    this.broadcast({ type: 'sync_complete', accountId: account.id }, account.user_id);
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
    for (const account of result.rows) {
      // Skip if already connected OR already in the process of connecting (e.g. health check)
      if (this.connections.has(account.id) || this.connectingAccounts.has(account.id)) continue;
      this.connectAccount(account).catch(err =>
        console.error(`Auto-connect failed for ${account.email_address}:`, err.message)
      );
    }
  }
}
