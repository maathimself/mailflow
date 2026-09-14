// Sanitized diagnostics report builder (server side).
//
// Principle: ALLOWLIST, never redact. This module assembles a report from an
// explicit set of vetted, non-identifying fields — never by dumping rows and
// stripping. `scrubReport` is a second safety net, not the primary defense.
//
// Account/folder ids become opaque per-report hashes (salted with a random salt
// the caller supplies and we never store), so a report is correlatable within
// itself but not identifiable or cross-referenceable between reports.

import crypto from 'crypto';
import { readFileSync } from 'fs';
import { query } from './db.js';
import { redisClient } from './redis.js';
import { loadAiConfig } from './aiProvider.js';
import { getActivatedPlugins } from '../plugins/activation.js';
import { getWarningsRaw, getConnectionStats, getSyncSignalsRaw } from './diagnosticsRing.js';
import { getPerformanceSnapshot } from './performanceMetrics.js';

const packageMeta = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'));
const BACKEND_VERSION = (process.env.APP_VERSION || packageMeta.version || '0.0.0').replace(/^v[.]?/, '');

// Salted, truncated hash. Same (id, salt) -> same ref within one report; a
// different salt (i.e. a different report) -> a different ref. Not reversible.
export function hashRef(id, salt) {
  return crypto.createHash('sha256').update(`${salt}:${id}`).digest('hex').slice(0, 8);
}

// Standard IMAP folder names are safe to show; custom (user-named) folders are
// hashed so a folder like "Client X Invoices" never leaks.
const STANDARD_FOLDERS = new Set([
  'INBOX', 'Sent', 'Drafts', 'Trash', 'Junk', 'Spam', 'Archive', 'Snoozed', 'Outbox',
  'Deleted Items', 'Deleted Messages', 'Junk E-Mail', 'Sent Items', 'Sent Messages', 'Notes', 'Starred',
]);

export function folderLabel(name, specialUse, salt) {
  if (!name) return `custom:${hashRef('(unnamed)', salt)}`;
  if (STANDARD_FOLDERS.has(name)) return name;
  if (name.startsWith('[Gmail]/') || name.startsWith('[Google Mail]/')) return name;
  if (specialUse) return name; // special-use folders (\Sent, \Junk, …) are standard
  return `custom:${hashRef(name, salt)}`;
}

// Coarse, non-identifying service label. Prefers the configured OAuth provider;
// otherwise maps well-known IMAP hosts to a service name. The raw host is never
// included (a custom-domain host would be identifying) — unknown hosts collapse
// to the generic "imap".
export function deriveProvider(imapHost, oauthProvider) {
  if (oauthProvider) return oauthProvider;
  const h = String(imapHost || '').toLowerCase();
  if (!h) return 'unknown';
  if (/google|gmail/.test(h)) return 'gmail';
  if (/mail\.me\.com|icloud/.test(h)) return 'icloud';
  if (/outlook|office365|hotmail|live\.com/.test(h)) return 'outlook';
  if (/yahoo/.test(h)) return 'yahoo';
  if (/fastmail|messagingengine/.test(h)) return 'fastmail';
  if (/purelymail/.test(h)) return 'purelymail';
  if (/\bzoho\b/.test(h)) return 'zoho';
  if (/proton/.test(h)) return 'proton';
  return 'imap';
}

// Map a raw sync_error string to a non-identifying category enum.
export function categorizeSyncError(err) {
  if (!err) return 'none';
  const s = String(err).toLowerCase();
  // Provider limits first: servers name the refused command ("[LIMIT] LOGIN Rate limit hit.").
  if (/^\[(limit|unavailable|inuse)\]|rate.?limit/.test(s)) return 'connection';
  if (/auth|login|password|credential|invalid.*(user|pass)|xoauth|token|535|534/.test(s)) return 'auth';
  if (/timeout|timed out|etimedout/.test(s)) return 'timeout';
  if (/enotfound|getaddrinfo|eai_again|\bdns\b/.test(s)) return 'dns';
  if (/tls|ssl|certificate|\bcert\b|self.signed/.test(s)) return 'tls';
  if (/econnrefused|econnreset|socket|network|ehostunreach|connect/.test(s)) return 'connection';
  return 'other';
}

// PII safety net. Applied to the fully-assembled report; on a normal instance the
// allowlist has already excluded everything, so these should never fire.
const PII_PATTERNS = [
  /[\w.+-]+@[\w-]+\.[\w.-]+/,                     // email address
  /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/,       // IPv4
  /\beyJ[\w-]+\.[\w-]+\.[\w-]+/,                  // JWT
  /\b[A-Fa-f0-9]{32,}\b/,                         // long hex (keys/tokens)
  /(ghp_|gho_|sk-|xoxb-|Bearer\s+\S)/i,           // token prefixes
];

export function scrubReport(obj) {
  const counters = { fieldsDropped: 0, hitsRedacted: 0 };
  const walk = (v) => {
    if (typeof v === 'string') {
      if (PII_PATTERNS.some(re => re.test(v))) { counters.hitsRedacted += 1; return '[redacted]'; }
      return v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, val] of Object.entries(v)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  return { scrubbed: walk(obj), counters };
}

// Assemble the server-owned sections of the report, scoped to one user.
export async function buildServerReport(userId, salt) {
  const accRes = await query(
    `SELECT id, protocol, oauth_provider, imap_host, enabled, include_in_unified_inbox, last_sync, sync_error
     FROM email_accounts WHERE user_id = $1 ORDER BY sort_order NULLS LAST, created_at`,
    [userId],
  );
  const folRes = await query(
    `SELECT f.account_id, f.name, f.special_use, f.total_count, f.unread_count
     FROM folders f JOIN email_accounts a ON a.id = f.account_id
     WHERE a.user_id = $1`,
    [userId],
  );

  // Unread must mirror what the user actually sees in the badge, which counts INBOX only
  // (see GET /api/mail/unread-counts in routes/mail.js). Summing every folder's unread_count
  // instead made a mailbox whose only unread sat in Spam/Junk report a non-zero total while
  // the app showed zero — the report contradicting the UI it exists to explain. Per-folder
  // unread is still reported in `folders` below, so Spam/Junk remain visible.
  const unreadRes = await query(
    `SELECT m.account_id, COUNT(*)::int AS count
       FROM messages m
       JOIN email_accounts a ON a.id = m.account_id
      WHERE a.user_id = $1 AND a.enabled = true
        AND m.folder = 'INBOX' AND m.is_read = false AND m.is_deleted = false
      GROUP BY m.account_id`,
    [userId],
  );
  const inboxUnreadByAcct = new Map(unreadRes.rows.map(r => [r.account_id, Number(r.count) || 0]));

  const foldersByAcct = new Map();
  for (const f of folRes.rows) {
    if (!foldersByAcct.has(f.account_id)) foldersByAcct.set(f.account_id, []);
    foldersByAcct.get(f.account_id).push(f);
  }

  const now = Date.now();
  const accounts = [];
  const folders = [];
  const unreadByAccountRef = {};
  let unreadTotal = 0;

  for (const a of accRes.rows) {
    const ref = hashRef(a.id, salt);
    const accFolders = foldersByAcct.get(a.id) || [];
    const unread = inboxUnreadByAcct.get(a.id) || 0;
    const inUnified = a.include_in_unified_inbox !== false;
    accounts.push({
      ref,
      provider: deriveProvider(a.imap_host, a.oauth_provider),
      authType: a.oauth_provider ? 'oauth' : 'password',
      enabled: a.enabled !== false,
      inUnifiedInbox: inUnified,
      unread,
      folderCount: accFolders.length,
      lastSyncAgeSeconds: a.last_sync ? Math.round((now - new Date(a.last_sync).getTime()) / 1000) : null,
      syncErrorCategory: categorizeSyncError(a.sync_error),
    });
    if (inUnified) unreadTotal += unread;
    unreadByAccountRef[ref] = unread;
    for (const f of accFolders) {
      folders.push({
        accountRef: ref,
        name: folderLabel(f.name, f.special_use, salt),
        total: f.total_count || 0,
        unread: f.unread_count || 0,
      });
    }
  }

  let aiEnabled = false;
  let aiProvider = null;
  try {
    const ai = await loadAiConfig();
    if (ai) { aiEnabled = ai.enabled === true; aiProvider = ai.provider || null; }
  } catch { /* config unreadable — leave defaults */ }

  let plugins = {};
  try {
    const activated = await getActivatedPlugins(userId);
    plugins = Object.fromEntries([...activated].map(p => [p, 'enabled']));
  } catch { /* leave empty */ }

  let dbOk = true;
  try { await query('SELECT 1'); } catch { dbOk = false; }
  let redisOk = true;
  try { await redisClient.ping(); } catch { redisOk = false; }

  // Recent categorized warnings, scoped to this user's accounts (account-less
  // server warnings are global). Account ids are hashed with the report salt.
  const userAccountIds = new Set(accRes.rows.map(a => a.id));
  const warnings = getWarningsRaw()
    .filter(w => !w.accountId || userAccountIds.has(w.accountId))
    .map(w => ({
      code: w.code,
      ...(w.accountId ? { accountRef: hashRef(w.accountId, salt) } : {}),
      count: w.count,
      lastSeenAgeSeconds: Math.round((Date.now() - w.lastT) / 1000),
    }));

  // Sync-consistency signals (Phase 1 reliability instrumentation), scoped to this
  // user's accounts and hashed. Magnitudes are counts (e.g. ghost rows in a response,
  // messages missed above the synced UID), never message content.
  const syncSignals = getSyncSignalsRaw()
    .filter(s => !s.accountId || userAccountIds.has(s.accountId))
    .map(s => ({
      signal: s.sig,
      ...(s.accountId ? { accountRef: hashRef(s.accountId, salt) } : {}),
      count: s.count,
      ...(s.sumMag ? { totalMagnitude: s.sumMag, maxMagnitude: s.maxMag } : {}),
      lastSeenAgeSeconds: Math.round((Date.now() - s.lastT) / 1000),
    }));

  return {
    versions: { backend: BACKEND_VERSION, gitSha: process.env.BUILD_SHA || 'dev' },
    server: { uptimeSeconds: Math.round(process.uptime()), dbOk, redisOk },
    accounts,
    folders,
    counts: { unreadTotal, unreadByAccountRef },
    warnings,
    syncSignals,
    connection: getConnectionStats(),
    performance: getPerformanceSnapshot(),
    config: { aiEnabled, aiProvider, plugins },
  };
}
