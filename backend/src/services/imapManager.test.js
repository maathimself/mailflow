import { describe, it, expect, vi } from 'vitest';

vi.mock('imapflow', () => ({ ImapFlow: vi.fn() }));
vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./messageParser.js', () => ({ parseMessage: vi.fn(), buildSnippetFromHtml: vi.fn(), snippetFromBody: vi.fn(), decodeMimeWords: vi.fn(), detectBulkFromParsedHeaders: vi.fn(), parseRawHeaders: vi.fn() }));
vi.mock('../routes/oauth.js', () => ({ refreshMicrosoftToken: vi.fn() }));
vi.mock('./emailSanitizer.js', () => ({ sanitizeEmail: vi.fn() }));
vi.mock('./encryption.js', () => ({ decrypt: vi.fn() }));
vi.mock('./pushNotifications.js', () => ({ sendPushToUser: vi.fn() }));
vi.mock('../utils/redact.js', () => ({ redactEmail: vi.fn() }));
vi.mock('./hostValidation.js', () => ({ resolveForConnection: vi.fn() }));

import { providerProfile, makeClientCfg, createKeyedSemaphore, isConnectionRefusal, connectCooldownMs, effectiveSyncIntervalMs, planModseqSync } from './imapManager.js';

const account = (imap_host, oauth_provider = null) => ({ imap_host, oauth_provider });

const resolved = { host: '127.0.0.1', servername: null };
const baseAccount = { imap_host: '127.0.0.1', imap_port: 1143, imap_tls: true, imap_skip_tls_verify: false, auth_user: 'user', auth_pass: 'enc' };

// ── providerProfile — host detection ─────────────────────────────────────────

describe('providerProfile — host detection', () => {
  it.each([
    ['imap.gmail.com'],
    ['imap.googlemail.com'],
    ['smtp.gmail.com'],
  ])('detects google for %s', host => {
    expect(providerProfile(account(host)).pushesFlags).toBe(false);
    expect(providerProfile(account(host)).speculativeFetch).toBe(false);
    expect(providerProfile(account(host)).snippetIndex).toBe(false);
  });

  it.each([
    ['imap.mail.yahoo.com'],
    ['imap.ymail.com'],
    ['smtp.mail.yahoo.com'],
  ])('detects yahoo for %s', host => {
    expect(providerProfile(account(host)).speculativeFetch).toBe(false);
    expect(providerProfile(account(host)).pushesFlags).toBe(true);
    expect(providerProfile(account(host)).snippetIndex).toBe(true);
  });

  it.each([
    ['imap.mail.me.com'],
    ['imap.icloud.com'],
    ['imap.apple.com'],
  ])('detects apple for %s', host => {
    expect(providerProfile(account(host)).speculativeFetch).toBe(true);
    expect(providerProfile(account(host)).batchSize).toBe(200);
  });

  it.each([
    ['outlook.office365.com'],
    ['imap.hotmail.com'],
    ['imap.live.com'],
  ])('detects microsoft for %s', host => {
    expect(providerProfile(account(host)).speculativeFetch).toBe(true);
    expect(providerProfile(account(host)).pushesFlags).toBe(true);
  });

  it.each([
    ['imap.purelymail.com'],
    ['mail.purelymail.com'],
  ])('detects purelymail (conservative profile) for %s', host => {
    const p = providerProfile(account(host));
    // Conservative and poll-first: no broad background body prefetch/snippet indexing,
    // no speculative BODY[] fetch, and user body fetches bypass the pool — see
    // PROVIDERS.purelymail.
    expect(p.snippetIndex).toBe(false);
    expect(p.speculativeFetch).toBe(false);
    expect(p.preferFreshBodyFetch).toBe(true);
    expect(p.freshInboxSync).toBe(true);
    expect(p.freshInboxUidPoll).toBe(true);
    expect(p.autoBackfillExistingOnConnect).toBe(false);
    expect(p.usesIdle).toBe(false);
    expect(p.pushesFlags).toBe(false);
    expect(p.maxSyncIntervalMs).toBe(10000);
    expect(p.flagPollEveryTicks).toBe(6);
    expect(p.prefetchNewBodies).toBe(true);
    expect(p.prefetchNewBodiesLimit).toBe(1);
  });

  it.each([
    ['imap.fastmail.com'],
    ['imap.protonmail.com'],
  ])('falls back to generic for unknown host %s', host => {
    const p = providerProfile(account(host));
    expect(p.speculativeFetch).toBe(true);
    expect(p.pushesFlags).toBe(true);
    expect(p.snippetIndex).toBe(true);
  });

  it.each([
    ['acme.com'],
    ['olive.com'],
    ['snapple.com'],
    ['webgmail.ru'],
  ])('does not false-positive on %s', host => {
    expect(providerProfile(account(host))).toBe(providerProfile(account('generic.example.com')));
  });
});

// ── providerProfile — oauth_provider detection ────────────────────────────────

describe('providerProfile — oauth_provider fallback', () => {
  it('detects microsoft via oauth_provider (only supported OAuth flow)', () => {
    expect(providerProfile(account('', 'microsoft')).pushesFlags).toBe(true);
  });

  it('does not detect google via oauth_provider alone — host-based only', () => {
    expect(providerProfile(account('', 'google'))).toBe(providerProfile(account('generic.example.com')));
  });
});

// ── providerProfile — skipFolderPatterns ─────────────────────────────────────

describe('providerProfile — skipFolderPatterns', () => {
  it('google skips All Mail, Starred, Important', () => {
    const { skipFolderPatterns } = providerProfile(account('imap.gmail.com'));
    expect(skipFolderPatterns.some(p => '[Gmail]/All Mail'.toLowerCase().includes(p))).toBe(true);
    expect(skipFolderPatterns.some(p => '[Gmail]/Starred'.toLowerCase().includes(p))).toBe(true);
    expect(skipFolderPatterns.some(p => '[Gmail]/Important'.toLowerCase().includes(p))).toBe(true);
  });

  it('yahoo has no skip patterns', () => {
    expect(providerProfile(account('imap.mail.yahoo.com')).skipFolderPatterns).toHaveLength(0);
  });

  it('generic has no skip patterns', () => {
    // Use a genuinely-unknown host — purelymail.com now routes to its own profile.
    expect(providerProfile(account('imap.fastmail.com')).skipFolderPatterns).toHaveLength(0);
  });
});

// ── providerProfile — robustness ──────────────────────────────────────────────

describe('providerProfile — robustness', () => {
  it('handles null imap_host gracefully', () => {
    expect(() => providerProfile({ imap_host: null, oauth_provider: null })).not.toThrow();
  });

  it('handles missing fields gracefully', () => {
    expect(() => providerProfile({})).not.toThrow();
  });

  it('is case-insensitive for host matching', () => {
    expect(providerProfile(account('IMAP.GMAIL.COM')).pushesFlags).toBe(false);
  });
});

// ── makeClientCfg — TLS enforcement ──────────────────────────────────────────

describe('makeClientCfg — TLS enforcement', () => {
  it('throws for plain-text IMAP when allowInsecureTls is false', () => {
    expect(() =>
      makeClientCfg({ ...baseAccount, imap_tls: false }, resolved, { policy: { allowInsecureTls: false } })
    ).toThrow(/plain-text IMAP/i);
  });

  it('throws for plain-text IMAP when policy is empty (default)', () => {
    expect(() =>
      makeClientCfg({ ...baseAccount, imap_tls: false }, resolved)
    ).toThrow(/plain-text IMAP/i);
  });

  it('does not throw for plain-text IMAP when allowInsecureTls is true', () => {
    expect(() =>
      makeClientCfg({ ...baseAccount, imap_tls: false }, resolved, { policy: { allowInsecureTls: true } })
    ).not.toThrow();
  });

  it('does not throw for TLS IMAP regardless of allowInsecureTls', () => {
    expect(() =>
      makeClientCfg({ ...baseAccount, imap_tls: true }, resolved, { policy: { allowInsecureTls: false } })
    ).not.toThrow();
    expect(() =>
      makeClientCfg({ ...baseAccount, imap_tls: true }, resolved, { policy: { allowInsecureTls: true } })
    ).not.toThrow();
  });
});

// ── makeClientCfg — rejectUnauthorized ───────────────────────────────────────

describe('makeClientCfg — rejectUnauthorized', () => {
  it('sets rejectUnauthorized true by default (no policy)', () => {
    const cfg = makeClientCfg(baseAccount, resolved);
    expect(cfg.tls.rejectUnauthorized).toBe(true);
  });

  it('sets rejectUnauthorized true when allowInsecureTls is false even if skip_tls_verify is set', () => {
    const cfg = makeClientCfg(
      { ...baseAccount, imap_skip_tls_verify: true },
      resolved,
      { policy: { allowInsecureTls: false } }
    );
    expect(cfg.tls.rejectUnauthorized).toBe(true);
  });

  it('sets rejectUnauthorized false when allowInsecureTls is true and imap_skip_tls_verify is true', () => {
    const cfg = makeClientCfg(
      { ...baseAccount, imap_skip_tls_verify: true },
      resolved,
      { policy: { allowInsecureTls: true } }
    );
    expect(cfg.tls.rejectUnauthorized).toBe(false);
  });

  it('sets rejectUnauthorized true when allowInsecureTls is true but imap_skip_tls_verify is false', () => {
    const cfg = makeClientCfg(
      { ...baseAccount, imap_skip_tls_verify: false },
      resolved,
      { policy: { allowInsecureTls: true } }
    );
    expect(cfg.tls.rejectUnauthorized).toBe(true);
  });

  it('sets servername from resolved when present', () => {
    const cfg = makeClientCfg(baseAccount, { host: '142.250.80.46', servername: 'imap.gmail.com' });
    expect(cfg.tls.servername).toBe('imap.gmail.com');
  });

  it('does not set servername when resolved.servername is null', () => {
    const cfg = makeClientCfg(baseAccount, resolved);
    expect(cfg.tls.servername).toBeUndefined();
  });
});

// ── createKeyedSemaphore — per-host backfill concurrency cap ───────────────────

describe('createKeyedSemaphore', () => {
  it('runs up to `limit` holders per key concurrently', async () => {
    const sem = createKeyedSemaphore(2);
    await sem.acquire('h');
    await sem.acquire('h');
    expect(sem.activeCount('h')).toBe(2);
    expect(sem.waitingCount('h')).toBe(0);
  });

  it('queues acquirers beyond the limit until a release', async () => {
    const sem = createKeyedSemaphore(1);
    await sem.acquire('h');
    let entered = false;
    const p = sem.acquire('h').then(() => { entered = true; });
    await Promise.resolve();
    expect(sem.waitingCount('h')).toBe(1);
    expect(entered).toBe(false);
    sem.release('h');
    await p;
    expect(entered).toBe(true);
    expect(sem.waitingCount('h')).toBe(0);
    expect(sem.activeCount('h')).toBe(1);
  });

  it('hands slots to waiters in FIFO order', async () => {
    const sem = createKeyedSemaphore(1);
    await sem.acquire('h');
    const order = [];
    const a = sem.acquire('h').then(() => order.push('a'));
    const b = sem.acquire('h').then(() => order.push('b'));
    await Promise.resolve();
    sem.release('h');
    await a;
    sem.release('h');
    await b;
    expect(order).toEqual(['a', 'b']);
  });

  it('treats different keys independently', async () => {
    const sem = createKeyedSemaphore(1);
    await sem.acquire('h1');
    await sem.acquire('h2'); // different host — not blocked by h1 being full
    expect(sem.activeCount('h1')).toBe(1);
    expect(sem.activeCount('h2')).toBe(1);
  });

  it('cleans up the entry once fully released', async () => {
    const sem = createKeyedSemaphore(1);
    await sem.acquire('h');
    sem.release('h');
    expect(sem.activeCount('h')).toBe(0);
    expect(sem.waitingCount('h')).toBe(0);
  });

  it('release is a safe no-op for an unknown key', () => {
    const sem = createKeyedSemaphore(1);
    expect(() => sem.release('never-acquired')).not.toThrow();
  });
});

// ── connection-refusal cooldown ───────────────────────────────────────────────

describe('isConnectionRefusal', () => {
  it.each([
    'Connection not available',
    'Too many simultaneous connections',
    'Maximum number of connections exceeded',
    'Please try again later',
    'Account temporarily locked',
    'THROTTLED: too many requests',
    'rate limit exceeded',
  ])('flags a refusal: %s', (msg) => {
    expect(isConnectionRefusal(msg)).toBe(true);
  });

  it.each([
    ['Invalid credentials'],
    ['Mailbox does not exist'],
    ['ECONNRESET'],
    [''],
    [null],
    [undefined],
  ])('does not flag a non-refusal: %s', (msg) => {
    expect(isConnectionRefusal(msg)).toBe(false);
  });
});

describe('connectCooldownMs', () => {
  it('grows exponentially from 30s and caps at 15 min', () => {
    expect(connectCooldownMs(1)).toBe(30_000);
    expect(connectCooldownMs(2)).toBe(60_000);
    expect(connectCooldownMs(3)).toBe(120_000);
    expect(connectCooldownMs(4)).toBe(240_000);
    expect(connectCooldownMs(5)).toBe(480_000);
    expect(connectCooldownMs(6)).toBe(900_000); // 960k clamped to the 15-min cap
    expect(connectCooldownMs(20)).toBe(900_000);
  });

  it('treats 0 / negative failures as at least one', () => {
    expect(connectCooldownMs(0)).toBe(30_000);
    expect(connectCooldownMs(-3)).toBe(30_000);
  });
});

// ── effectiveSyncIntervalMs — provider interval clamp ─────────────────────────

describe('effectiveSyncIntervalMs', () => {
  it('clamps to the provider cap when the requested interval is longer', () => {
    // PurelyMail polls via fresh login (IDLE is unreliable) and caps at 10s.
    expect(effectiveSyncIntervalMs(account('imap.purelymail.com'), 60000)).toBe(10000);
  });

  it('leaves a faster-than-cap request untouched', () => {
    expect(effectiveSyncIntervalMs(account('imap.purelymail.com'), 5000)).toBe(5000);
  });

  it('passes the requested interval through for providers without a cap', () => {
    expect(effectiveSyncIntervalMs(account('imap.fastmail.com'), 60000)).toBe(60000);
    expect(effectiveSyncIntervalMs(account('imap.gmail.com'), 120000)).toBe(120000);
  });
});

// ── planModseqSync — CONDSTORE delta-sync strategy decision ────────────────────

describe('planModseqSync', () => {
  it('falls back to full sync when there is no stored baseline (first sync / seed)', () => {
    expect(planModseqSync({ storedModseq: null, serverModseq: '42', uidValidityChanged: false })).toBe('full');
  });

  it('falls back to full sync when the server has no modseq (no CONDSTORE)', () => {
    expect(planModseqSync({ storedModseq: '42', serverModseq: null, uidValidityChanged: false })).toBe('full');
    expect(planModseqSync({ storedModseq: null, serverModseq: null, uidValidityChanged: false })).toBe('full');
  });

  it('forces full sync on a UIDVALIDITY change even when the modseqs happen to match', () => {
    // modseq is only comparable within a UIDVALIDITY epoch — a matching value across a
    // reset must NOT be treated as "nothing changed".
    expect(planModseqSync({ storedModseq: '100', serverModseq: '100', uidValidityChanged: true })).toBe('full');
    expect(planModseqSync({ storedModseq: '100', serverModseq: '200', uidValidityChanged: true })).toBe('full');
  });

  it('returns "unchanged" when the stored watermark equals the server modseq', () => {
    expect(planModseqSync({ storedModseq: '500', serverModseq: '500', uidValidityChanged: false })).toBe('unchanged');
  });

  it('returns "delta" when the server modseq has advanced', () => {
    expect(planModseqSync({ storedModseq: '500', serverModseq: '501', uidValidityChanged: false })).toBe('delta');
  });

  it('accepts BigInt and string interchangeably (ImapFlow yields BigInt, pg yields string)', () => {
    expect(planModseqSync({ storedModseq: '77', serverModseq: 77n, uidValidityChanged: false })).toBe('unchanged');
    expect(planModseqSync({ storedModseq: 77n, serverModseq: '78', uidValidityChanged: false })).toBe('delta');
  });

  it('compares in BigInt so values above 2^53 stay exact (a JS Number would collapse them)', () => {
    // 9007199254740993 and ...992 are indistinguishable as JS Numbers (both round to 2^53).
    const a = '9007199254740992';
    const b = '9007199254740993';
    expect(Number(a) === Number(b)).toBe(true);            // the trap we must avoid
    expect(planModseqSync({ storedModseq: a, serverModseq: b, uidValidityChanged: false })).toBe('delta');
    expect(planModseqSync({ storedModseq: b, serverModseq: b, uidValidityChanged: false })).toBe('unchanged');
  });
});
