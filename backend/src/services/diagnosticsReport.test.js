import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./redis.js', () => ({ redisClient: { ping: vi.fn().mockResolvedValue('PONG') } }));
vi.mock('./aiProvider.js', () => ({ loadAiConfig: vi.fn().mockResolvedValue({ enabled: true, provider: 'api-key' }) }));
vi.mock('../plugins/activation.js', () => ({ getActivatedPlugins: vi.fn().mockResolvedValue(new Set(['gtd'])) }));
vi.mock('./diagnosticsRing.js', () => ({
  getWarningsRaw: vi.fn(() => [
    { code: 'imap_error', accountId: 'acct-1', count: 3, lastT: Date.now() - 5000 },
    { code: 'staleness_error', accountId: null, count: 1, lastT: Date.now() - 1000 },
    { code: 'imap_error', accountId: 'other-user-acct', count: 9, lastT: Date.now() },
  ]),
  getConnectionStats: vi.fn(() => ({ wsConnects: 4, wsDisconnects: 3, currentSockets: 1, broadcastCounts: { new_messages: 6 } })),
  getSyncSignalsRaw: vi.fn(() => [
    { sig: 'ghost_rows_served', accountId: 'acct-1', count: 4, lastT: Date.now() - 2000, sumMag: 7, maxMag: 3 },
    { sig: 'uidvalidity_change', accountId: 'other-user-acct', count: 2, lastT: Date.now(), sumMag: 0, maxMag: 0 },
  ]),
}));

import { hashRef, folderLabel, categorizeSyncError, deriveProvider, scrubReport, buildServerReport } from './diagnosticsReport.js';
import { query } from './db.js';

describe('deriveProvider', () => {
  it('prefers the OAuth provider, else maps known hosts, else generic imap (never the raw host)', () => {
    expect(deriveProvider('imap.gmail.com', 'google')).toBe('google');
    expect(deriveProvider('imap.gmail.com', null)).toBe('gmail');
    expect(deriveProvider('imap.mail.me.com', null)).toBe('icloud');
    expect(deriveProvider('outlook.office365.com', null)).toBe('outlook');
    expect(deriveProvider('imap.purelymail.com', null)).toBe('purelymail');
    expect(deriveProvider('mail.my-company.example', null)).toBe('imap'); // custom domain -> generic
    expect(deriveProvider('', null)).toBe('unknown');
  });
});

describe('hashRef', () => {
  it('is deterministic per salt, varies by salt, and does not leak the id', () => {
    const id = '836d509c-bdd1-47b5-a47e-d9489cb1565b';
    expect(hashRef(id, 'saltA')).toBe(hashRef(id, 'saltA'));
    expect(hashRef(id, 'saltA')).not.toBe(hashRef(id, 'saltB')); // non-correlatable across reports
    expect(hashRef(id, 'saltA')).toMatch(/^[0-9a-f]{8}$/);
    expect(hashRef(id, 'saltA')).not.toContain(id.slice(0, 6));
  });
});

describe('folderLabel', () => {
  it('passes standard/gmail/special-use names, hashes custom names', () => {
    expect(folderLabel('INBOX', null, 's')).toBe('INBOX');
    expect(folderLabel('[Gmail]/Spam', null, 's')).toBe('[Gmail]/Spam');
    expect(folderLabel('Receipts', '\\Archive', 's')).toBe('Receipts'); // special-use passthrough
    const label = folderLabel('Client X Invoices', null, 's');
    expect(label).toMatch(/^custom:[0-9a-f]{8}$/);
    expect(label).not.toContain('Client');
  });
});

describe('categorizeSyncError', () => {
  it('maps raw errors to non-identifying categories', () => {
    expect(categorizeSyncError(null)).toBe('none');
    expect(categorizeSyncError('Invalid credentials for user@x.com')).toBe('auth');
    expect(categorizeSyncError('Socket timeout')).toBe('timeout');
    expect(categorizeSyncError('getaddrinfo EAI_AGAIN imap.x.com')).toBe('dns');
    expect(categorizeSyncError('certificate has expired')).toBe('tls');
    expect(categorizeSyncError('ECONNREFUSED 1.2.3.4:993')).toBe('connection');
    expect(categorizeSyncError('weird provider glitch')).toBe('other');
  });

  it('categorizes the IMAP auth-stage texts extractImapError now reports (#433/#429)', () => {
    // Before the extractor fix every one of these was stored as 'Command failed' -> 'other'.
    expect(categorizeSyncError('Command failed')).toBe('other');
    expect(categorizeSyncError('[AUTHENTICATIONFAILED] Invalid credentials (Failure) (oauth status 400)')).toBe('auth');
    expect(categorizeSyncError('AUTHENTICATE failed.')).toBe('auth');
    expect(categorizeSyncError('Authentication failed')).toBe('auth');
    expect(categorizeSyncError('[LIMIT] Too many simultaneous connections')).toBe('connection');
    // Yahoo names the refused command, so "LOGIN" must not turn a provider limit into an auth error.
    expect(categorizeSyncError('[LIMIT] LOGIN Rate limit hit.')).toBe('connection');
    expect(categorizeSyncError('[UNAVAILABLE] LOGIN failure. Server error')).toBe('connection');
  });
});

describe('scrubReport (safety net)', () => {
  it('redacts emails/IPs/JWTs/hex/token strings, keeps clean values, counts hits', () => {
    const { scrubbed, counters } = scrubReport({
      a: 'user@example.com', b: '10.0.0.5', c: 'eyJhbGc.eyJzdWI.sig',
      d: 'a'.repeat(40), e: 'sk-abc123', clean: 'INBOX', n: 3, arr: ['plain', 'nested@x.io'],
    });
    expect(scrubbed.a).toBe('[redacted]');
    expect(scrubbed.b).toBe('[redacted]');
    expect(scrubbed.c).toBe('[redacted]');
    expect(scrubbed.d).toBe('[redacted]');
    expect(scrubbed.e).toBe('[redacted]');
    expect(scrubbed.arr[1]).toBe('[redacted]');
    expect(scrubbed.clean).toBe('INBOX');
    expect(scrubbed.n).toBe(3);
    expect(counters.hitsRedacted).toBeGreaterThanOrEqual(6);
  });
});

describe('buildServerReport', () => {
  beforeEach(() => query.mockReset());

  it('produces a hashed, PII-free, user-scoped report from the allowlist', async () => {
    query.mockImplementation((sql) => {
      if (/FROM email_accounts WHERE user_id/.test(sql)) {
        return Promise.resolve({ rows: [
          { id: 'acct-1', protocol: 'imap', oauth_provider: null, imap_host: 'imap.gmail.com', enabled: true, include_in_unified_inbox: true, last_sync: new Date(Date.now() - 42000).toISOString(), sync_error: null },
          { id: 'acct-2', protocol: 'imap', oauth_provider: null, imap_host: 'mail.my-company.example', enabled: true, include_in_unified_inbox: false, last_sync: null, sync_error: 'Invalid credentials for bob@corp.com' },
        ] });
      }
      if (/FROM folders f JOIN/.test(sql)) {
        return Promise.resolve({ rows: [
          { account_id: 'acct-1', name: 'INBOX', special_use: null, total_count: 1200, unread_count: 3 },
          { account_id: 'acct-1', name: 'Client X Invoices', special_use: null, total_count: 40, unread_count: 0 },
          { account_id: 'acct-2', name: 'INBOX', special_use: null, total_count: 10, unread_count: 2 },
        ] });
      }
      if (/FROM messages m/.test(sql)) {
        // INBOX-only unread, mirroring GET /api/mail/unread-counts
        return Promise.resolve({ rows: [
          { account_id: 'acct-1', count: 3 },
          { account_id: 'acct-2', count: 2 },
        ] });
      }
      return Promise.resolve({ rows: [{ '?column?': 1 }] }); // SELECT 1 health
    });

    const report = await buildServerReport('user-9', 'deadbeefdeadbeef');
    const json = JSON.stringify(report);

    // scoped: every account query filtered by the requesting user
    const acctCalls = query.mock.calls.filter(c => /email_accounts WHERE user_id/.test(c[0]));
    expect(acctCalls.length).toBeGreaterThan(0);
    expect(acctCalls.every(c => c[1]?.[0] === 'user-9')).toBe(true);

    // no raw ids, emails, custom folder names, or account hosts leak
    expect(json).not.toContain('acct-1');
    expect(json).not.toContain('Client X Invoices');
    expect(json).not.toContain('my-company');
    expect(json).not.toMatch(/@/);

    // hashed, categorized fields; provider derived from host, host itself excluded
    expect(report.accounts[0].ref).toMatch(/^[0-9a-f]{8}$/);
    expect(report.accounts[0].provider).toBe('gmail');
    expect(report.accounts[1].provider).toBe('imap');
    expect(report.accounts[1].authType).toBe('password');
    expect(report.accounts[1].syncErrorCategory).toBe('auth');

    // custom folder hashed, standard passed through
    const labels = report.folders.map(f => f.name);
    expect(labels).toContain('INBOX');
    expect(labels.some(l => l.startsWith('custom:'))).toBe(true);

    // unified unread total excludes the opted-out account (acct-2)
    expect(report.counts.unreadTotal).toBe(3);
    expect(report.config.plugins).toEqual({ gtd: 'enabled' });
    expect(report.config.aiEnabled).toBe(true);
    expect(report.server.redisOk).toBe(true);

    // warnings: only this user's account warning + the global one; other-user filtered out
    const imapWarnings = report.warnings.filter(w => w.code === 'imap_error');
    expect(imapWarnings.length).toBe(1);
    expect(imapWarnings[0].accountRef).toMatch(/^[0-9a-f]{8}$/);
    expect(report.warnings.some(w => w.code === 'staleness_error' && !w.accountRef)).toBe(true);
    expect(json).not.toContain('other-user-acct');
    // sync signals: this user's ghost-rows signal kept (hashed, with magnitude); the
    // other user's uidvalidity_change filtered out.
    expect(report.syncSignals.length).toBe(1);
    expect(report.syncSignals[0].signal).toBe('ghost_rows_served');
    expect(report.syncSignals[0].accountRef).toMatch(/^[0-9a-f]{8}$/);
    expect(report.syncSignals[0].count).toBe(4);
    expect(report.syncSignals[0].totalMagnitude).toBe(7);
    expect(report.syncSignals.some(s => s.signal === 'uidvalidity_change')).toBe(false);
    // connection stats present
    expect(report.connection.broadcastCounts.new_messages).toBe(6);
    expect(report.connection.wsConnects).toBe(4);
  });
});

// ── unread must match the badge, not the sum of every folder ────────────────────────────────

describe('buildServerReport — unread counts INBOX only', () => {
  beforeEach(() => query.mockReset());

  it('ignores Spam/Junk unread, so the report agrees with the app badge', async () => {
    query.mockImplementation((sql) => {
      if (/FROM email_accounts WHERE user_id/.test(sql)) {
        return Promise.resolve({ rows: [
          { id: 'acct-1', protocol: 'imap', oauth_provider: null, imap_host: 'imap.gmail.com', enabled: true, include_in_unified_inbox: true, last_sync: new Date().toISOString(), sync_error: null },
        ] });
      }
      if (/FROM folders f JOIN/.test(sql)) {
        // The real-world shape that exposed the bug: everything unread sits in Spam.
        return Promise.resolve({ rows: [
          { account_id: 'acct-1', name: 'INBOX', special_use: null, total_count: 697, unread_count: 0 },
          { account_id: 'acct-1', name: 'Spam', special_use: '\\Junk', total_count: 16, unread_count: 16 },
        ] });
      }
      if (/FROM messages m/.test(sql)) return Promise.resolve({ rows: [] }); // no unread INBOX rows
      return Promise.resolve({ rows: [{ '?column?': 1 }] });
    });

    const report = await buildServerReport('user-9', 'deadbeefdeadbeef');
    expect(report.counts.unreadTotal).toBe(0);
    expect(report.accounts[0].unread).toBe(0);
    // ...but the Spam backlog is still visible per-folder, which is the diagnostic value.
    const spam = report.folders.find(f => f.name === 'Spam');
    expect(spam.unread).toBe(16);
  });

  it('scopes the unread query to the requesting user and to INBOX', async () => {
    query.mockResolvedValue({ rows: [] });
    await buildServerReport('user-9', 'deadbeefdeadbeef');
    const unreadCall = query.mock.calls.find(c => /FROM messages m/.test(c[0]));
    expect(unreadCall).toBeTruthy();
    expect(unreadCall[0]).toMatch(/a\.user_id = \$1/);
    expect(unreadCall[0]).toMatch(/m\.folder = 'INBOX'/);
    expect(unreadCall[0]).toMatch(/is_read = false/);
    expect(unreadCall[1]).toEqual(['user-9']);
  });
});
