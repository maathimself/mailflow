import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('imapflow', () => ({ ImapFlow: vi.fn() }));
vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./messageParser.js', () => ({ parseMessage: vi.fn(), buildSnippetFromHtml: vi.fn(), snippetFromBody: vi.fn(), decodeMimeWords: vi.fn(), detectBulkFromParsedHeaders: vi.fn(), parseRawHeaders: vi.fn(), enrichParsedMetadata: vi.fn((parsed) => parsed) }));
vi.mock('../routes/oauth.js', () => ({ refreshMicrosoftToken: vi.fn(), refreshGoogleToken: vi.fn() }));
vi.mock('./emailSanitizer.js', () => ({ sanitizeEmail: vi.fn() }));
vi.mock('./encryption.js', () => ({ decrypt: vi.fn() }));
vi.mock('./aiProvider.js', () => ({ getAiStatus: vi.fn(), completeText: vi.fn() }));
vi.mock('./pushNotifications.js', () => ({ sendPushToUser: vi.fn() }));
vi.mock('../utils/redact.js', () => ({ redactEmail: vi.fn() }));
vi.mock('./hostValidation.js', () => ({ resolveForConnection: vi.fn(), createPinnedLookup: vi.fn() }));
vi.mock('./connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn() }));
vi.mock('./spamPipeline.js', () => ({ classifyAndTagMessage: vi.fn() }));
vi.mock('./mailAccess.js', () => ({ getAccountAddresses: vi.fn(async () => []) }));

import { ImapManager, MIN_SYNC_INTERVAL_MS, AUTO_IDLE_DELAY_MS, countMissingInboxCopies, fetchBackfillBatch, providerProfile, makeClientCfg, relocateExemptGuard, insertCopiedSibling, deleteMessageCopyRow, emitSectionsChanged, ensureMailbox, createKeyedSemaphore, isConnectionRefusal, connectCooldownMs, effectiveSyncIntervalMs, folderSyncDue, planModseqSync, connectStaggerFor, walkStructure, extractBodyFromMsg, bodyFallbackApplies, parsePersistentCap, resolvePersistentCap, persistentEligible, shouldRetryIPv4, classifyMoveBySearch, computeThreadId } from './imapManager.js';
import { pluginRegistry } from '../plugins/registry.js';
import { EventEmitter } from 'node:events';
import { ImapFlow } from 'imapflow';
import { query } from './db.js';
import { resolveForConnection } from './hostValidation.js';
import { getConnectionPolicy } from './connectionPolicy.js';
import { invalidateGtdConfigCache } from '../plugins/gtd/gtdConfig.js';
import { parseMessage } from './messageParser.js';
import { classifyAndTagMessage } from './spamPipeline.js';
import { getAccountAddresses } from './mailAccess.js';

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
  ])('detects purelymail (IDLE-based profile) for %s', host => {
    const p = providerProfile(account(host));
    // IDLE-first with an aggressive keepalive: one long-lived IDLE connection pushes new
    // mail, re-issued every 4 min so it never goes deaf; the periodic tick is a light
    // backstop. Body work stays conservative (no snippet indexing / speculative fetch,
    // user body fetches bypass the pool) — see PROVIDERS.purelymail.
    expect(p.snippetIndex).toBe(false);
    expect(p.speculativeFetch).toBe(false);
    expect(p.preferFreshBodyFetch).toBe(true);
    expect(p.freshInboxSync).toBe(false);
    expect(p.autoBackfillExistingOnConnect).toBe(false);
    expect(p.usesIdle).toBe(true);
    expect(p.idleKeepaliveMs).toBe(4 * 60 * 1000);
    expect(p.pushesFlags).toBe(false);
    expect(p.maxSyncIntervalMs).toBe(120000);
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

// ── relocateExemptGuard — move-detector exemption ────────────────────────────

describe('relocateExemptGuard — label folder relocate exemption', () => {
  it('is a no-op when no label plugin contributes folders', () => {
    const guard = relocateExemptGuard([], 5);
    expect(guard.clause).toBe('');
    expect(guard.params).toEqual([]);
  });

  it('binds the exempt folders as a single array param', () => {
    const guard = relocateExemptGuard(['Todo', 'Watch'], 5);
    expect(guard.params).toEqual([['Todo', 'Watch']]);
  });

  it('exempts both the target folder ($1) and the row current folder', () => {
    const { clause } = relocateExemptGuard(['Todo'], 5);
    // Target folder being synced ($1) must not be relocated INTO an exempt label folder…
    expect(clause).toContain('$1 <> ALL($5::text[])');
    // …and a row already living in an exempt label folder must not be relocated OUT of it.
    expect(clause).toContain('folder <> ALL($5::text[])');
  });

  it('uses the supplied positional bind index', () => {
    const { clause } = relocateExemptGuard(['Todo'], 7);
    expect(clause).toContain('$7::text[]');
    expect(clause).not.toContain('$5');
  });
});

// ── makeClientCfg — auto-IDLE arming ─────────────────────────────────────────
//
// Regression cover for the bug where IDLE never started on ANY account. ImapFlow arms IDLE
// only after autoIdleDelay of quiet; its default is 15000ms, which is exactly the fastest sync
// interval the settings UI offers. A 15s tick left the connection quiet for ~14.9s and cleared
// the arming timer ~100ms before it fired, so every provider silently degraded to polling.
// The first test is the one that matters: it fails if those two values are ever equal again.

describe('makeClientCfg — auto-IDLE arming', () => {
  it('arms IDLE strictly faster than the fastest possible sync tick', () => {
    // The invariant. If this fails, IDLE cannot start before the next tick interrupts it.
    expect(AUTO_IDLE_DELAY_MS).toBeLessThan(MIN_SYNC_INTERVAL_MS);
  });

  it('leaves enough delay not to inject IDLE between one sync\'s own commands', () => {
    // The opposite failure: too small a value means every command is followed by an IDLE the
    // next command must break, costing two extra round trips each time.
    expect(AUTO_IDLE_DELAY_MS).toBeGreaterThanOrEqual(1000);
  });

  it('sets autoIdleDelay whenever IDLE is enabled', () => {
    const cfg = makeClientCfg(baseAccount, resolved, { enableIdle: true });
    expect(cfg.autoIdleDelay).toBe(AUTO_IDLE_DELAY_MS);
  });

  it('does not set autoIdleDelay on non-IDLE connections (pool/backfill clients)', () => {
    const cfg = makeClientCfg(baseAccount, resolved, { enableIdle: false });
    expect(cfg.autoIdleDelay).toBeUndefined();
  });

  it('sets autoIdleDelay independently of idleKeepaliveMs', () => {
    // maxIdleTime governs how long an IDLE lasts; autoIdleDelay governs whether it starts.
    // Conflating the two is what let this bug survive the PurelyMail IDLE work.
    const cfg = makeClientCfg(baseAccount, resolved, { enableIdle: true, idleKeepaliveMs: 4 * 60 * 1000 });
    expect(cfg.maxIdleTime).toBe(4 * 60 * 1000);
    expect(cfg.autoIdleDelay).toBe(AUTO_IDLE_DELAY_MS);
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

  it('uses the original hostname with a pinned multi-address lookup', () => {
    const lookup = vi.fn();
    const cfg = makeClientCfg(baseAccount, {
      host: '203.0.113.1',
      servername: 'imap.example.com',
      addresses: ['203.0.113.1', '203.0.113.2'],
      lookup,
    });
    expect(cfg.host).toBe('imap.example.com');
    expect(cfg.tls.lookup).toBe(lookup);
    expect(cfg.tls.autoSelectFamily).toBe(true);
    expect(cfg.tls.autoSelectFamilyAttemptTimeout).toBe(1000);
  });
});

// ── copyMessage DB side — insertCopiedSibling ────────────────────────────────
// The IMAP COPY itself runs through withFreshClient (not unit-testable without a
// live pool), so the destination-sibling INSERT is extracted here and tested with
// the UID a UIDPLUS copyuid map would yield — same seam as gtdRelocateGuard in 1a.

const findCall = (frag) => query.mock.calls.find(([sql]) => sql.includes(frag));
const countAdjusts = () => query.mock.calls.filter(([sql]) => sql.includes('UPDATE folders'));

describe('insertCopiedSibling', () => {
  beforeEach(() => query.mockReset());

  it('inserts the destination sibling from the source row with the copied UID', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'row-new', is_read: true }] });
    query.mockResolvedValue({ rows: [] });

    await insertCopiedSibling('acct-1', 100, 'INBOX', 'Todo', 5001);

    const ins = findCall('INSERT INTO messages');
    expect(ins).toBeTruthy();
    // Content columns come from the source row; only uid ($4) and folder ($5) change.
    expect(ins[0]).toContain('FROM messages');
    expect(ins[0]).toContain('WHERE account_id = $1 AND folder = $2 AND uid = $3');
    // Idempotent against the next destination-folder sync.
    expect(ins[0]).toContain('ON CONFLICT (account_id, uid, folder) DO NOTHING');
    expect(ins[1]).toEqual(['acct-1', 'INBOX', 100, 5001, 'Todo']);
    // delivery_addresses is copied verbatim from the source row, same as list_unsubscribe.
    expect(ins[0]).toContain('delivery_addresses');
  });

  it('increments destination unread only when the copied message is unread', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'row-new', is_read: false }] });
    query.mockResolvedValue({ rows: [] });
    await insertCopiedSibling('acct-1', 100, 'INBOX', 'Todo', 5001);
    // total +1, unread +1 for an unread copy.
    expect(countAdjusts()[0][1]).toEqual([1, 1, 'acct-1', 'Todo']);
  });

  it('counts total but not unread for a read copy', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'row-new', is_read: true }] });
    query.mockResolvedValue({ rows: [] });
    await insertCopiedSibling('acct-1', 100, 'INBOX', 'Todo', 5001);
    expect(countAdjusts()[0][1]).toEqual([1, 0, 'acct-1', 'Todo']);
  });

  it('adjusts no counts when a prior sync already inserted the sibling (ON CONFLICT hit)', async () => {
    query.mockResolvedValueOnce({ rows: [] }); // DO NOTHING → no RETURNING row
    await insertCopiedSibling('acct-1', 100, 'INBOX', 'Todo', 5001);
    expect(countAdjusts()).toHaveLength(0);
  });
});

// ── removeMessageCopy DB side — deleteMessageCopyRow ─────────────────────────

describe('deleteMessageCopyRow', () => {
  beforeEach(() => query.mockReset());

  it('deletes exactly one folder copy, scoped by (account_id, uid, folder)', async () => {
    query.mockResolvedValueOnce({ rows: [{ is_read: true }] });
    query.mockResolvedValue({ rows: [] });

    await deleteMessageCopyRow('acct-1', 100, 'Todo');

    const del = findCall('DELETE FROM messages');
    expect(del[0]).toContain('WHERE account_id = $1 AND uid = $2 AND folder = $3');
    // Never keyed on message_id — sibling rows in other folders are left intact.
    expect(del[0]).not.toContain('message_id');
    expect(del[1]).toEqual(['acct-1', 100, 'Todo']);
  });

  it('decrements the folder count, dropping unread only if the removed copy was unread', async () => {
    query.mockResolvedValueOnce({ rows: [{ is_read: false }] });
    query.mockResolvedValue({ rows: [] });
    await deleteMessageCopyRow('acct-1', 100, 'Todo');
    expect(countAdjusts()[0][1]).toEqual([-1, -1, 'acct-1', 'Todo']);
  });

  it('adjusts no counts when the row was already gone', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await deleteMessageCopyRow('acct-1', 100, 'Todo');
    expect(countAdjusts()).toHaveLength(0);
  });
});


// ── ensureMailbox — provider-correct folder creation ─────────────────────────
// The namespace matrix (no-prefix + '/', 'INBOX.' + '.') is resolved INSIDE imapflow's
// normalizePath, which runs on mailboxCreate. So the unit here mocks mailboxCreate and
// asserts (a) we hand imapflow an ARRAY split on '/' — letting it join with the server
// delimiter and prepend the namespace prefix rather than us hand-joining — and (b) we
// surface imapflow's reported real path + created flag, treating already-exists (both the
// { created:false } return and a thrown "already exists") as success-not-created.

describe('ensureMailbox — namespace + already-exists matrix', () => {
  const clientReturning = (result) => ({ mailboxCreate: vi.fn().mockResolvedValue(result) });
  const clientThrowing = (err) => ({ mailboxCreate: vi.fn().mockRejectedValue(err) });

  it('flat server (no prefix, "/" delimiter): passes ["Todo"], surfaces the flat path as created', async () => {
    const client = clientReturning({ path: 'Todo', created: true });
    const res = await ensureMailbox(client, 'Todo');
    expect(client.mailboxCreate).toHaveBeenCalledWith(['Todo']);
    expect(res).toEqual({ path: 'Todo', created: true });
  });

  it('prefixed server ("INBOX." + "."): imapflow prefixes the array, we surface the real INBOX.Todo path', async () => {
    // imapflow's normalizePath turns ['Todo'] into 'INBOX.Todo' on a prefixed namespace
    // and returns it — we must report that, not the bare requested name.
    const client = clientReturning({ path: 'INBOX.Todo', created: true });
    const res = await ensureMailbox(client, 'Todo');
    expect(client.mailboxCreate).toHaveBeenCalledWith(['Todo']);
    expect(res).toEqual({ path: 'INBOX.Todo', created: true });
  });

  it('splits a nested name on "/" so imapflow joins with the server delimiter', async () => {
    const client = clientReturning({ path: 'INBOX.Work.Todo', created: true });
    const res = await ensureMailbox(client, 'Work/Todo');
    expect(client.mailboxCreate).toHaveBeenCalledWith(['Work', 'Todo']);
    expect(res).toEqual({ path: 'INBOX.Work.Todo', created: true });
  });

  it('already-exists via imapflow ALREADYEXISTS return: created=false with the real path', async () => {
    // imapflow catches ALREADYEXISTS and returns { created:false } + the normalized path
    // (covers a case-insensitive server reporting an existing "todo" for a requested "Todo").
    const client = clientReturning({ path: 'INBOX.todo', created: false });
    const res = await ensureMailbox(client, 'Todo');
    expect(res).toEqual({ path: 'INBOX.todo', created: false });
  });

  it('already-exists via a thrown NO with serverResponseCode ALREADYEXISTS: treated as created=false', async () => {
    // Real imapflow shape (lib/tools.js enhanceCommandError + lib/imap-flow.js NO/BAD
    // handling): err.message is always the generic 'Command failed'; the server's text
    // lands in err.responseText and the RFC 5530 code in err.serverResponseCode.
    const client = clientThrowing(
      Object.assign(new Error('Command failed'), {
        responseText: 'Mailbox already exists',
        serverResponseCode: 'ALREADYEXISTS',
      })
    );
    const res = await ensureMailbox(client, 'Todo');
    expect(res).toEqual({ path: 'Todo', created: false });
  });

  it('already-exists via a thrown NO with only responseText (non-RFC5530 server): treated as created=false', async () => {
    const client = clientThrowing(
      Object.assign(new Error('Command failed'), { responseText: 'Mailbox already exists' })
    );
    const res = await ensureMailbox(client, 'Watch');
    expect(res).toEqual({ path: 'Watch', created: false });
  });

  it('re-throws an unrelated failure with a realistic responseText/serverResponseCode shape', async () => {
    const client = clientThrowing(
      Object.assign(new Error('Command failed'), {
        responseText: 'Quota exceeded',
        serverResponseCode: 'OVERQUOTA',
      })
    );
    await expect(ensureMailbox(client, 'Todo')).rejects.toThrow('Command failed');
  });

  it('re-throws an unrelated failure (e.g. over quota) rather than swallowing it', async () => {
    const client = clientThrowing(new Error('Over quota'));
    await expect(ensureMailbox(client, 'Todo')).rejects.toThrow('Over quota');
  });

  it('falls back to the requested name when imapflow returns no path', async () => {
    const client = clientReturning(undefined);
    const res = await ensureMailbox(client, 'Reference');
    expect(res).toEqual({ path: 'Reference', created: false });
  });
});

// ── ensureMailbox — case-insensitive casing resolution ────────────────────────
// On a case-insensitive server an existing "TODO" satisfies a "Todo" CREATE, but imapflow's
// already-exists result echoes the REQUESTED casing. Persisting that (planGtdFolderPersist)
// never case-matches the synced rows' folder value. With resolvePath set (only /folders/ensure,
// which persists), the already-exists branches resolve the real casing from the folder LIST;
// classify/snooze leave it off so they skip the extra round-trip.
describe('ensureMailbox — case-insensitive casing resolution', () => {
  it('ALREADYEXISTS return + resolvePath: resolves the server casing from LIST', async () => {
    const client = {
      mailboxCreate: vi.fn().mockResolvedValue({ path: 'Todo', created: false }),
      list: vi.fn().mockResolvedValue([{ path: 'INBOX' }, { path: 'TODO' }]),
    };
    const res = await ensureMailbox(client, 'Todo', { resolvePath: true });
    expect(res).toEqual({ path: 'TODO', created: false });
    expect(client.list).toHaveBeenCalledTimes(1);
  });

  it('plain-NO throw + resolvePath: resolves the casing from the bare requested name', async () => {
    const client = {
      mailboxCreate: vi.fn().mockRejectedValue(
        Object.assign(new Error('Command failed'), { responseText: 'Mailbox already exists' })
      ),
      list: vi.fn().mockResolvedValue([{ path: 'TODO' }]),
    };
    const res = await ensureMailbox(client, 'Todo', { resolvePath: true });
    expect(res).toEqual({ path: 'TODO', created: false });
  });

  it('does NOT list without resolvePath — the hot classify path skips the round-trip', async () => {
    const client = {
      mailboxCreate: vi.fn().mockResolvedValue({ path: 'Todo', created: false }),
      list: vi.fn().mockResolvedValue([{ path: 'TODO' }]),
    };
    const res = await ensureMailbox(client, 'Todo');
    expect(res).toEqual({ path: 'Todo', created: false });
    expect(client.list).not.toHaveBeenCalled();
  });

  it('falls back to the known path when the LIST has no case-insensitive match', async () => {
    const client = {
      mailboxCreate: vi.fn().mockResolvedValue({ path: 'Todo', created: false }),
      list: vi.fn().mockResolvedValue([{ path: 'Inbox' }, { path: 'Sent' }]),
    };
    expect(await ensureMailbox(client, 'Todo', { resolvePath: true })).toEqual({ path: 'Todo', created: false });
  });

  it('never throws when the LIST itself fails — falls back to the input path', async () => {
    const client = {
      mailboxCreate: vi.fn().mockResolvedValue({ path: 'Todo', created: false }),
      list: vi.fn().mockRejectedValue(new Error('LIST failed')),
    };
    expect(await ensureMailbox(client, 'Todo', { resolvePath: true })).toEqual({ path: 'Todo', created: false });
  });

  it('a freshly-created folder never triggers a lookup, even with resolvePath', async () => {
    const client = {
      mailboxCreate: vi.fn().mockResolvedValue({ path: 'INBOX.Todo', created: true }),
      list: vi.fn(),
    };
    expect(await ensureMailbox(client, 'Todo', { resolvePath: true })).toEqual({ path: 'INBOX.Todo', created: true });
    expect(client.list).not.toHaveBeenCalled();
  });
});

// ── ensureMailbox — flat-namespace hierarchy guard ────────────────────────────
// A server whose personal-namespace delimiter is null cannot represent nesting: imapflow would
// join ['Projects','Todo'] with '' into "ProjectsTodo". Guard nested paths loudly, but only when
// the namespace is KNOWN to be flat (an unfetched namespace is left to imapflow).
describe('ensureMailbox — flat-namespace hierarchy guard', () => {
  it('throws a clear error for a nested path when the namespace delimiter is null', async () => {
    const client = { namespace: { prefix: '', delimiter: null }, mailboxCreate: vi.fn() };
    await expect(ensureMailbox(client, 'Projects/Todo')).rejects.toThrow(/hierarchy/i);
    expect(client.mailboxCreate).not.toHaveBeenCalled();
  });

  it('allows a single-segment name on a flat-namespace server', async () => {
    const client = { namespace: { prefix: '', delimiter: null }, mailboxCreate: vi.fn().mockResolvedValue({ path: 'Todo', created: true }) };
    expect(await ensureMailbox(client, 'Todo')).toEqual({ path: 'Todo', created: true });
  });

  it('allows a nested path when the server advertises a hierarchy delimiter', async () => {
    const client = { namespace: { prefix: 'INBOX.', delimiter: '.' }, mailboxCreate: vi.fn().mockResolvedValue({ path: 'INBOX.Work.Todo', created: true }) };
    const res = await ensureMailbox(client, 'Work/Todo');
    expect(client.mailboxCreate).toHaveBeenCalledWith(['Work', 'Todo']);
    expect(res).toEqual({ path: 'INBOX.Work.Todo', created: true });
  });

  it('does not guard a nested path when the namespace is unknown (bare client)', async () => {
    const client = { mailboxCreate: vi.fn().mockResolvedValue({ path: 'INBOX.Work.Todo', created: true }) };
    expect(await ensureMailbox(client, 'Work/Todo')).toEqual({ path: 'INBOX.Work.Todo', created: true });
  });
});

// ── emitSectionsChanged — generic label-feed refresh dispatch ─────────────────
// Core's generic notify: an ordinary mail mutation (delete/purge/backfill/flag flip) changed
// the messages table outside a label plugin's tick, so core dispatches the `sectionsChanged`
// hook and each active plugin decides whether to broadcast its own refresh. The wrapper's only
// job is the cheap changedCount gate + the dispatch; the GTD-specific enabled-gate + broadcast
// live in the plugin handler (see plugins/gtd/hooks.test.js). Here we assert the dispatch
// contract by spying on the registry.
describe('emitSectionsChanged', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('dispatches the sectionsChanged hook with the mutation context when rows changed', async () => {
    const spy = vi.spyOn(pluginRegistry, 'runHook').mockResolvedValue([]);
    const mgr = { broadcast: vi.fn() };
    const account = { id: 'acct-sc-on', user_id: 'user-1' };
    await emitSectionsChanged(mgr, account, 4);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('sectionsChanged', { mgr, account, changedCount: 4 });
  });

  it('never dispatches — no plugin work at all — when nothing changed', async () => {
    const spy = vi.spyOn(pluginRegistry, 'runHook').mockResolvedValue([]);
    await emitSectionsChanged({ broadcast: vi.fn() }, { id: 'acct-sc-zero', user_id: 'user-1' }, 0);
    expect(spy).not.toHaveBeenCalled();
  });
});

// ── _startPluginSyncTimers / _stopPluginSyncTimers — plugin background ticks ──
// The GTD label-folder tick is now a plugin-declared background task; core just arms/tears down
// a jittered timer per active plugin, keyed `${accountId}::${pluginId}`. These assert the generic
// scheduler: it honors sync.isActive, fires the tick, and tears down per-account independently.

describe('_startPluginSyncTimers / _stopPluginSyncTimers', () => {
  const makeMgr = () => { const m = Object.create(ImapManager.prototype); m.pluginSyncIntervals = new Map(); m.pluginFacade = { __facade: true }; return m; };
  let listSpy;

  beforeEach(() => { vi.useFakeTimers(); vi.spyOn(Math, 'random').mockReturnValue(0); });
  afterEach(() => { listSpy?.mockRestore(); vi.restoreAllMocks(); vi.useRealTimers(); });

  it('arms a jittered first fire then a steady interval for an active plugin tick', async () => {
    const tick = vi.fn().mockResolvedValue(undefined);
    listSpy = vi.spyOn(pluginRegistry, 'list').mockReturnValue([
      { id: 'fake', sync: { intervalMs: 1000, isActive: () => true, tick } },
    ]);
    const mgr = makeMgr();
    const account = { id: 'a1', user_id: 'u1', email_address: 'e@x' };
    await mgr._startPluginSyncTimers(account); // isActive is awaited before arming
    expect(tick).not.toHaveBeenCalled();     // still waiting on the (zeroed) jitter delay
    vi.advanceTimersByTime(1);               // jitter fires
    expect(tick).toHaveBeenCalledTimes(1);
    expect(tick).toHaveBeenCalledWith({ mgr: mgr.pluginFacade, account }); // facade, not the raw engine
    vi.advanceTimersByTime(1000);            // one steady interval later
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it('arms nothing for a plugin whose sync.isActive rejects the account', async () => {
    const tick = vi.fn();
    listSpy = vi.spyOn(pluginRegistry, 'list').mockReturnValue([
      { id: 'gated', sync: { intervalMs: 1000, isActive: (ctx) => ctx.account.on === true, tick } },
    ]);
    const mgr = makeMgr();
    await mgr._startPluginSyncTimers({ id: 'a2', on: false });
    expect(mgr.pluginSyncIntervals.size).toBe(0);
    vi.advanceTimersByTime(5000);
    expect(tick).not.toHaveBeenCalled();
  });

  it('ignores a plugin with no sync descriptor', async () => {
    listSpy = vi.spyOn(pluginRegistry, 'list').mockReturnValue([{ id: 'routeronly' }]);
    const mgr = makeMgr();
    await mgr._startPluginSyncTimers({ id: 'a3' });
    expect(mgr.pluginSyncIntervals.size).toBe(0);
  });

  it('tears down only the given account\'s timers', async () => {
    const tick = vi.fn();
    listSpy = vi.spyOn(pluginRegistry, 'list').mockReturnValue([
      { id: 'fake', sync: { intervalMs: 1000, isActive: () => true, tick } },
    ]);
    const mgr = makeMgr();
    await mgr._startPluginSyncTimers({ id: 'a1', user_id: 'u1' });
    await mgr._startPluginSyncTimers({ id: 'a2', user_id: 'u1' });
    expect(mgr.pluginSyncIntervals.size).toBe(2);
    mgr._stopPluginSyncTimers('a1');
    expect(mgr.pluginSyncIntervals.has('a1::fake')).toBe(false);
    expect(mgr.pluginSyncIntervals.has('a2::fake')).toBe(true);
    expect(mgr.pluginSyncIntervals.size).toBe(1);
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
    'Fresh sync connect timeout (30000ms)',
  ])('flags a refusal: %s', (msg) => {
    expect(isConnectionRefusal(msg)).toBe(true);
  });

  it.each([
    ['Invalid credentials'],
    ['Mailbox does not exist'],
    ['ECONNRESET'],
    // Mid-operation timeouts are NOT connection-limit signals — must stay retry-normal.
    ['Socket timeout'],
    ['Fresh sync wall-clock timeout (55000ms)'],
    [''],
    [null],
    [undefined],
  ])('does not flag a non-refusal: %s', (msg) => {
    expect(isConnectionRefusal(msg)).toBe(false);
  });
});

describe('parsePersistentCap', () => {
  it('parses a positive integer as the cap', () => {
    expect(parsePersistentCap('5')).toBe(5);
    expect(parsePersistentCap('1')).toBe(1);
  });
  it.each(['0', '-3', '', 'abc', null, undefined, ' '])('treats %s as unlimited', (raw) => {
    expect(parsePersistentCap(raw)).toBe(Infinity);
  });
});

describe('resolvePersistentCap', () => {
  it('is unlimited when neither env nor profile caps', () => {
    expect(resolvePersistentCap(Infinity, undefined)).toBe(Infinity);
  });
  it('uses whichever cap is set', () => {
    expect(resolvePersistentCap(Infinity, 4)).toBe(4);
    expect(resolvePersistentCap(6, undefined)).toBe(6);
  });
  it('takes the tighter of the two', () => {
    expect(resolvePersistentCap(10, 3)).toBe(3);
    expect(resolvePersistentCap(2, 8)).toBe(2);
  });
  it('ignores non-positive caps', () => {
    expect(resolvePersistentCap(0, 0)).toBe(Infinity);
  });
});

describe('persistentEligible', () => {
  const host = ['a', 'b', 'c', 'd']; // stable order (created_at, then id)
  it('is always eligible when the cap is unlimited or non-positive', () => {
    expect(persistentEligible(host, 'd', Infinity)).toBe(true);
    expect(persistentEligible(host, 'd', 0)).toBe(true);
  });
  it('keeps the first `cap` accounts persistent and demotes the rest', () => {
    expect(persistentEligible(host, 'a', 2)).toBe(true);
    expect(persistentEligible(host, 'b', 2)).toBe(true);
    expect(persistentEligible(host, 'c', 2)).toBe(false); // surplus → poll-only
    expect(persistentEligible(host, 'd', 2)).toBe(false);
  });
  it('fails safe to eligible for an account not in the host list', () => {
    expect(persistentEligible(host, 'zz', 2)).toBe(true);
  });
});

describe('shouldRetryIPv4', () => {
  const dual = ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'];
  it('retries IPv4-only on a timeout for a dual-stack host', () => {
    expect(shouldRetryIPv4('IMAP connect timeout (30000ms)', dual)).toBe(true);
    expect(shouldRetryIPv4('Reconnect timeout (40000ms)', dual)).toBe(true);
  });
  it('does not retry when the failure was not a timeout (auth/refusal/cert)', () => {
    expect(shouldRetryIPv4('Invalid credentials', dual)).toBe(false);
    expect(shouldRetryIPv4('Too many simultaneous connections', dual)).toBe(false);
    expect(shouldRetryIPv4('self signed certificate', dual)).toBe(false);
  });
  it('does not retry when the host is single-family (nothing to fall back to)', () => {
    expect(shouldRetryIPv4('connect timeout', ['93.184.216.34'])).toBe(false);            // v4-only
    expect(shouldRetryIPv4('connect timeout', ['2606:2800:220:1::1'])).toBe(false);       // v6-only
    expect(shouldRetryIPv4('connect timeout', [])).toBe(false);
    expect(shouldRetryIPv4('connect timeout', undefined)).toBe(false);
  });
  it('handles empty/nullish error messages', () => {
    expect(shouldRetryIPv4('', dual)).toBe(false);
    expect(shouldRetryIPv4(null, dual)).toBe(false);
  });
  it('does not retry when a provider refusal was seen during the attempt (#384)', () => {
    // A timeout on a dual-stack host would normally retry, but a refusal means back off instead.
    expect(shouldRetryIPv4('connect timeout', dual, true)).toBe(false);
    expect(shouldRetryIPv4('connect timeout', dual, false)).toBe(true);
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
    // PurelyMail uses IDLE for instant push; the periodic tick is only a ~2-min backstop cap.
    expect(effectiveSyncIntervalMs(account('imap.purelymail.com'), 300000)).toBe(120000);
  });

  it('leaves a faster-than-cap request untouched', () => {
    expect(effectiveSyncIntervalMs(account('imap.purelymail.com'), 5000)).toBe(5000);
  });

  it('passes the requested interval through for providers without a cap', () => {
    expect(effectiveSyncIntervalMs(account('imap.fastmail.com'), 60000)).toBe(60000);
    expect(effectiveSyncIntervalMs(account('imap.gmail.com'), 120000)).toBe(120000);
  });
});

// ── folderSyncDue — periodic folder-structure sync gate ──────────────────────

describe('folderSyncDue', () => {
  it('is due immediately when the account has never folder-synced', () => {
    expect(folderSyncDue(1800000, undefined, 5000000)).toBe(true);
  });

  it('is not due again within the interval', () => {
    expect(folderSyncDue(1800000, 5000000, 5000000 + 1799999)).toBe(false);
  });

  it('is due once the interval has elapsed', () => {
    expect(folderSyncDue(1800000, 5000000, 5000000 + 1800000)).toBe(true);
  });

  it('never fires when disabled (0 = never)', () => {
    expect(folderSyncDue(0, undefined, Number.MAX_SAFE_INTEGER)).toBe(false);
  });
});

// ── connectStaggerFor — initial connect pacing (#218) ─────────────────────────

describe('connectStaggerFor', () => {
  it('spaces a connection-sensitive provider (PurelyMail) wider than a lenient one (Gmail)', () => {
    const pm = providerProfile(account('imap.purelymail.com'));
    const gmail = providerProfile(account('imap.gmail.com'));
    expect(connectStaggerFor(pm, 1)).toBeGreaterThan(connectStaggerFor(gmail, 1));
  });

  it('widens the gap as account count grows, capped at 2x the base', () => {
    const pm = providerProfile(account('imap.purelymail.com'));
    expect(connectStaggerFor(pm, 100)).toBeGreaterThan(connectStaggerFor(pm, 1));
    expect(connectStaggerFor(pm, 100)).toBe(2400); // 1200 base x capped factor 2
  });

  it('defaults to a 200ms base for providers without an explicit stagger (Gmail)', () => {
    const gmail = providerProfile(account('imap.gmail.com'));
    expect(connectStaggerFor(gmail, 1)).toBe(208); // 200 x (1 + 1/25)
  });

  it('never drops below the base for an empty account list', () => {
    const pm = providerProfile(account('imap.purelymail.com'));
    expect(connectStaggerFor(pm, 0)).toBe(1200);
  });
});

// ── planModseqSync — CONDSTORE delta-sync strategy decision ────────────────────

describe('planModseqSync', () => {
  it('forces a full sync when the local cache is empty but a nonempty server has an equal modseq', () => {
    expect(planModseqSync({
      storedModseq: '100',
      serverModseq: '100',
      uidValidityChanged: false,
      maxKnownUid: 0,
      serverExists: 1,
    })).toBe('full');
  });

  it('forces a full sync when the local cache is empty and the server modseq advanced', () => {
    expect(planModseqSync({
      storedModseq: '100',
      serverModseq: '101',
      uidValidityChanged: false,
      maxKnownUid: 0,
      serverExists: 1,
    })).toBe('full');
  });

  it('leaves an empty local cache and empty server unchanged when the modseqs match', () => {
    expect(planModseqSync({
      storedModseq: '100',
      serverModseq: '100',
      uidValidityChanged: false,
      maxKnownUid: 0,
      serverExists: 0,
    })).toBe('unchanged');
  });

  it('retains the existing CONDSTORE plans when the local cache has a UID watermark', () => {
    const localState = { maxKnownUid: 50, serverExists: 50 };
    expect(planModseqSync({ ...localState, storedModseq: '100', serverModseq: '100', uidValidityChanged: false })).toBe('unchanged');
    expect(planModseqSync({ ...localState, storedModseq: '100', serverModseq: '101', uidValidityChanged: false })).toBe('delta');
    expect(planModseqSync({ ...localState, storedModseq: '100', serverModseq: '100', uidValidityChanged: true })).toBe('full');
    expect(planModseqSync({ ...localState, storedModseq: null, serverModseq: '100', uidValidityChanged: false })).toBe('full');
    expect(planModseqSync({ ...localState, storedModseq: '100', serverModseq: null, uidValidityChanged: false })).toBe('full');
  });

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

// ── syncMessages — empty-cache/modseq wiring ─────────────────────────────────

describe('syncMessages — empty local cache vs nonempty server (wiring)', () => {
  beforeEach(() => {
    query.mockReset();
    parseMessage.mockReset();
    ['acct-sync-empty-cache', 'acct-sync-watermark'].forEach(invalidateGtdConfigCache);
  });

  it('empty cache forces the full metadata scan', async () => {
    const account = {
      id: 'acct-sync-empty-cache',
      user_id: 'user-1',
      email_address: 'me@example.com',
      gtd_enabled: false,
      categorization_enabled: false,
      imap_host: 'imap.example.com',
    };
    const client = {
      getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
      mailbox: { exists: 1, uidValidity: 100, highestModseq: 500n },
      fetch: vi.fn(async function* () { yield { uid: 501 }; }),
    };
    query.mockImplementation((sql) => {
      if (sql.includes('SELECT uid_validity, highest_modseq FROM folders')) {
        return Promise.resolve({ rows: [{ uid_validity: 100, highest_modseq: '500' }] });
      }
      if (sql.includes('COUNT(*) FILTER (WHERE is_read = false)')) return Promise.resolve({ rows: [{ n: 0 }] });
      if (sql.includes('INSERT INTO folders')) return Promise.resolve({ rows: [] });
      if (sql.includes('COALESCE(MAX(uid), 0)')) return Promise.resolve({ rows: [{ max_uid: 0 }] });
      if (sql.includes('SELECT gtd_enabled, gtd_folders FROM email_accounts')) {
        return Promise.resolve({ rows: [{ gtd_enabled: false, gtd_folders: {} }] });
      }
      if (sql.includes("preferences->>'categorizationEnabled'")) return Promise.resolve({ rows: [{ val: false }] });
      if (sql.includes('INSERT INTO messages')) return Promise.resolve({ rows: [{ id: 'msg-1', is_new: true }] });
      if (sql.includes('UPDATE folders SET highest_modseq')) return Promise.resolve({ rows: [] });
      if (sql.includes('UPDATE email_accounts SET last_sync')) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] });
    });
    parseMessage.mockResolvedValue({
      uid: 501,
      messageId: null,
      subject: 'Watch first message',
      fromName: 'External',
      fromEmail: 'them@example.com',
      to: [],
      cc: [],
      replyTo: [],
      inReplyTo: null,
      references: null,
      date: new Date('2026-07-17T10:00:00Z'),
      snippet: 'hi',
      isRead: true,
      isStarred: false,
      hasAttachments: false,
      flags: ['\\Seen'],
      isBulk: false,
      parsedHeaders: {},
    });

    const result = await ImapManager.prototype.syncMessages.call({}, account, client, 'Watch', 50, false, true);

    expect(client.fetch).toHaveBeenCalledTimes(1);
    expect(client.fetch.mock.calls[0][0]).toBe('1:*');
    expect(client.fetch.mock.calls[0][1]).toEqual(expect.objectContaining({
      envelope: true,
      bodyStructure: true,
      flags: true,
      uid: true,
    }));
    expect(client.fetch.mock.calls[0][2]).toBeUndefined();
    const insertIndex = query.mock.calls.findIndex(([sql]) => sql.includes('INSERT INTO messages'));
    const modseqUpdateIndex = query.mock.calls.findIndex(([sql]) => sql.includes('UPDATE folders SET highest_modseq'));
    expect(insertIndex).toBeGreaterThanOrEqual(0);
    expect(modseqUpdateIndex).toBeGreaterThan(insertIndex);
    expect(result).toEqual(expect.objectContaining({ insertedCount: 1 }));
  });

  it('populated cache keeps the old UID-watermark behavior', async () => {
    const account = {
      id: 'acct-sync-watermark',
      user_id: 'user-1',
      email_address: 'me@example.com',
      gtd_enabled: false,
      categorization_enabled: false,
      imap_host: 'imap.example.com',
    };
    const client = {
      getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
      mailbox: { exists: 50, uidValidity: 100, highestModseq: 500n },
      fetch: vi.fn(async function* () {}),
    };
    query.mockImplementation((sql) => {
      if (sql.includes('SELECT uid_validity, highest_modseq FROM folders')) {
        return Promise.resolve({ rows: [{ uid_validity: 100, highest_modseq: '500' }] });
      }
      if (sql.includes('COUNT(*) FILTER (WHERE is_read = false)')) return Promise.resolve({ rows: [{ n: 0 }] });
      if (sql.includes('INSERT INTO folders')) return Promise.resolve({ rows: [] });
      if (sql.includes('COALESCE(MAX(uid), 0)')) return Promise.resolve({ rows: [{ max_uid: 50 }] });
      if (sql.includes('SELECT gtd_enabled, gtd_folders FROM email_accounts')) {
        return Promise.resolve({ rows: [{ gtd_enabled: false, gtd_folders: {} }] });
      }
      if (sql.includes('UPDATE email_accounts SET last_sync')) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] });
    });

    await ImapManager.prototype.syncMessages.call({}, account, client, 'Watch', 50, false, true);

    expect(client.fetch).toHaveBeenCalledTimes(1);
    expect(client.fetch).toHaveBeenCalledWith(
      '51:*',
      expect.objectContaining({ envelope: true, bodyStructure: true }),
      { uid: true }
    );
    expect(query.mock.calls.some(([sql]) => sql.includes('UPDATE folders SET highest_modseq'))).toBe(false);
  });

  it('hands a newly-inserted INBOX row to the inboxIngest hook when a plugin is active', async () => {
    // wire: an active inbox-ingest plugin makes syncMessages collect the new row's id and
    // dispatch runHook('inboxIngest', …). We spy the registry rather than register a real
    // plugin so the singleton stays clean for other suites.
    const hasActive = vi.spyOn(pluginRegistry, 'hasActiveAsync').mockImplementation(async (name) => name === 'inboxIngest');
    const runHook = vi.spyOn(pluginRegistry, 'runHook').mockResolvedValue([]);
    try {
      const account = {
        id: 'acct-ingest', user_id: 'user-1', email_address: 'me@example.com',
        gtd_enabled: true, categorization_enabled: false, imap_host: 'imap.example.com',
      };
      const client = {
        getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
        mailbox: { exists: 1, uidValidity: 100, highestModseq: 500n },
        fetch: vi.fn(async function* () { yield { uid: 501 }; }),
      };
      query.mockImplementation((sql) => {
        if (sql.includes('SELECT uid_validity, highest_modseq FROM folders')) {
          return Promise.resolve({ rows: [{ uid_validity: 100, highest_modseq: '500' }] });
        }
        if (sql.includes('COUNT(*) FILTER (WHERE is_read = false)')) return Promise.resolve({ rows: [{ n: 0 }] });
        if (sql.includes('INSERT INTO folders')) return Promise.resolve({ rows: [] });
        if (sql.includes('COALESCE(MAX(uid), 0)')) return Promise.resolve({ rows: [{ max_uid: 0 }] });
        if (sql.includes('SELECT gtd_enabled, gtd_folders FROM email_accounts')) {
          return Promise.resolve({ rows: [{ gtd_enabled: true, gtd_folders: {} }] });
        }
        if (sql.includes('INSERT INTO messages')) return Promise.resolve({ rows: [{ id: 'ingest-1', is_new: true }] });
        if (sql.includes('UPDATE folders SET highest_modseq')) return Promise.resolve({ rows: [] });
        if (sql.includes('UPDATE email_accounts SET last_sync')) return Promise.resolve({ rows: [] });
        return Promise.resolve({ rows: [] });
      });
      // Arrived already \Seen, so it never enters the unread notification list — it must still
      // reach inboxIngest via the read-inclusive candidate set.
      parseMessage.mockResolvedValue({
        uid: 501, messageId: '<in1@x>', subject: 'Reply', fromName: 'External', fromEmail: 'them@example.com',
        to: [], cc: [], replyTo: [], inReplyTo: null, references: null, date: new Date('2026-07-17T10:00:00Z'),
        snippet: 'hi', isRead: true, isStarred: false, hasAttachments: false, flags: ['\\Seen'], isBulk: false, parsedHeaders: {},
      });

      const mgr = { pluginFacade: { __facade: true } };
      await ImapManager.prototype.syncMessages.call(mgr, account, client, 'INBOX', 50, false, true);

      expect(hasActive).toHaveBeenCalledWith('inboxIngest', { account });
      // The hook receives the bounded facade, never the raw engine (`this`).
      expect(runHook).toHaveBeenCalledWith('inboxIngest', {
        mgr: mgr.pluginFacade, account, newInboxIds: ['ingest-1'], deletedIds: new Set(),
      });
    } finally {
      hasActive.mockRestore();
      runHook.mockRestore();
    }
  });

  it('does not dispatch inboxIngest when no ingest plugin is active', async () => {
    const hasActive = vi.spyOn(pluginRegistry, 'hasActiveAsync').mockResolvedValue(false);
    const runHook = vi.spyOn(pluginRegistry, 'runHook').mockResolvedValue([]);
    try {
      const account = {
        id: 'acct-no-ingest', user_id: 'user-1', email_address: 'me@example.com',
        gtd_enabled: false, categorization_enabled: false, imap_host: 'imap.example.com',
      };
      const client = {
        getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
        mailbox: { exists: 1, uidValidity: 100, highestModseq: 500n },
        fetch: vi.fn(async function* () { yield { uid: 501 }; }),
      };
      query.mockImplementation((sql) => {
        if (sql.includes('SELECT uid_validity, highest_modseq FROM folders')) return Promise.resolve({ rows: [{ uid_validity: 100, highest_modseq: '500' }] });
        if (sql.includes('COUNT(*) FILTER (WHERE is_read = false)')) return Promise.resolve({ rows: [{ n: 0 }] });
        if (sql.includes('COALESCE(MAX(uid), 0)')) return Promise.resolve({ rows: [{ max_uid: 0 }] });
        if (sql.includes('INSERT INTO messages')) return Promise.resolve({ rows: [{ id: 'x', is_new: true }] });
        return Promise.resolve({ rows: [] });
      });
      parseMessage.mockResolvedValue({
        uid: 501, messageId: '<in2@x>', subject: 'Reply', fromName: 'External', fromEmail: 'them@example.com',
        to: [], cc: [], replyTo: [], inReplyTo: null, references: null, date: new Date('2026-07-17T10:00:00Z'),
        snippet: 'hi', isRead: true, isStarred: false, hasAttachments: false, flags: ['\\Seen'], isBulk: false, parsedHeaders: {},
      });

      await ImapManager.prototype.syncMessages.call({}, account, client, 'INBOX', 50, false, true);
      expect(runHook).not.toHaveBeenCalledWith('inboxIngest', expect.anything());
    } finally {
      hasActive.mockRestore();
      runHook.mockRestore();
    }
  });
});

describe('syncMessages — unread_count recompute ordering (folder badge fix)', () => {
  it('recomputes folders.unread_count from rows AFTER inserting new messages', async () => {
    // The provisional unread_count written before the fetch left on-demand folders (e.g. Junk)
    // showing a stale badge until their next sync. syncMessages must recompute from actual rows
    // AFTER the INSERT so the cached count reflects the just-synced messages.
    const hasActive = vi.spyOn(pluginRegistry, 'hasActiveAsync').mockResolvedValue(false);
    const runHook = vi.spyOn(pluginRegistry, 'runHook').mockResolvedValue([]);
    try {
      const account = {
        id: 'acct-junk', user_id: 'user-1', email_address: 'me@example.com',
        gtd_enabled: false, categorization_enabled: false, imap_host: 'imap.example.com',
      };
      const client = {
        getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
        mailbox: { exists: 1, uidValidity: 100, highestModseq: 500n },
        fetch: vi.fn(async function* () { yield { uid: 501 }; }),
      };
      query.mockReset();
      query.mockImplementation((sql) => {
        if (sql.includes('SELECT uid_validity, highest_modseq FROM folders')) return Promise.resolve({ rows: [{ uid_validity: 100, highest_modseq: '500' }] });
        if (sql.includes('COUNT(*) FILTER (WHERE is_read = false)') && !sql.includes('UPDATE folders')) return Promise.resolve({ rows: [{ n: 0 }] });
        if (sql.includes('COALESCE(MAX(uid), 0)')) return Promise.resolve({ rows: [{ max_uid: 0 }] });
        if (sql.includes('INSERT INTO messages')) return Promise.resolve({ rows: [{ id: 'new-1', is_new: true }] });
        return Promise.resolve({ rows: [] });
      });
      parseMessage.mockReset();
      // Already-\Seen so the message doesn't enter the new-mail notification path (which needs a
      // broadcast stub); it is still INSERTed, which is all the ordering assertion needs.
      parseMessage.mockResolvedValue({
        uid: 501, messageId: '<n1@x>', subject: 'Spam', fromName: 'Sketchy', fromEmail: 's@x.com',
        to: [], cc: [], replyTo: [], inReplyTo: null, references: null, date: new Date('2026-08-20T10:00:00Z'),
        snippet: 'hi', isRead: true, isStarred: false, hasAttachments: false, flags: ['\\Seen'], isBulk: false, parsedHeaders: {},
      });

      await ImapManager.prototype.syncMessages.call({ pluginFacade: {} }, account, client, 'Junk', 100, false, true);

      const calls = query.mock.calls.map(c => c[0]);
      const insertIdx = calls.findIndex(sql => sql.includes('INSERT INTO messages'));
      const recomputeIdx = calls.findIndex(sql =>
        sql.includes('UPDATE folders') && sql.includes('unread_count = (SELECT COUNT(*) FILTER (WHERE m.is_read = false)'));
      expect(insertIdx).toBeGreaterThanOrEqual(0);
      expect(recomputeIdx).toBeGreaterThanOrEqual(0);
      expect(recomputeIdx).toBeGreaterThan(insertIdx);            // recompute strictly after insert
      expect(query.mock.calls[recomputeIdx][1]).toEqual(['acct-junk', 'Junk']); // scoped to this folder
    } finally {
      hasActive.mockRestore();
      runHook.mockRestore();
    }
  });
});

describe('_syncSpamFolder — periodic spam poll guards', () => {
  const account = { id: 'a1', user_id: 'u1', folder_mappings: null, imap_host: 'imap.example.com' };

  it('no-ops when the account has no resolvable spam folder', async () => {
    query.mockReset();
    query.mockResolvedValue({ rows: [] }); // resolveSpamFolder finds nothing
    const ctx = { onDemandSyncing: new Set(), broadcast: vi.fn(), syncMessages: vi.fn() };
    await ImapManager.prototype._syncSpamFolder.call(ctx, account);
    expect(ctx.syncMessages).not.toHaveBeenCalled();
    expect(ctx.broadcast).not.toHaveBeenCalled();
  });

  it('skips when an on-demand sync of that spam folder is already running (no collision)', async () => {
    query.mockReset();
    // resolveSpamFolder's special-use lookup (identified by its name-regex clause) yields "Junk".
    query.mockImplementation((sql) =>
      sql.includes('lower(name) ~') ? Promise.resolve({ rows: [{ path: 'Junk' }] }) : Promise.resolve({ rows: [] }));
    const ctx = { onDemandSyncing: new Set(['a1:Junk']), broadcast: vi.fn(), syncMessages: vi.fn() };
    await ImapManager.prototype._syncSpamFolder.call(ctx, account);
    expect(ctx.syncMessages).not.toHaveBeenCalled();
    expect(ctx.broadcast).not.toHaveBeenCalled();
    expect(ctx.onDemandSyncing.has('a1:Junk')).toBe(true); // guard left intact for the running sync
  });
});

describe('walkStructure attachment classification', () => {
  const walk = (node) => {
    const results = { textParts: [], attachments: [] };
    walkStructure(node, results);
    return results;
  };

  it('treats an attached HTML file as an attachment, not body text', () => {
    const results = walk({
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'text/plain', encoding: 'quoted-printable', parameters: { charset: 'utf-8' } },
        {
          part: '2', type: 'text/html', encoding: 'base64',
          disposition: 'attachment',
          dispositionParameters: { filename: 'report.html' },
          size: 2048,
        },
      ],
    });
    expect(results.textParts).toHaveLength(1);
    expect(results.textParts[0].type).toBe('text/plain');
    expect(results.attachments).toHaveLength(1);
    expect(results.attachments[0]).toMatchObject({
      part: '2', filename: 'report.html', type: 'text/html', encoding: 'base64',
    });
  });

  it('treats an attached text file as an attachment', () => {
    const results = walk({
      part: '2', type: 'text/plain', encoding: 'base64',
      disposition: 'attachment',
      dispositionParameters: { filename: 'server.log' },
    });
    expect(results.textParts).toHaveLength(0);
    expect(results.attachments).toHaveLength(1);
    expect(results.attachments[0].filename).toBe('server.log');
  });

  it('still treats undisposed HTML parts as the message body', () => {
    const results = walk({
      type: 'multipart/alternative',
      childNodes: [
        { part: '1', type: 'text/plain', encoding: '7bit' },
        { part: '2', type: 'text/html', encoding: 'quoted-printable' },
      ],
    });
    expect(results.textParts.map(p => p.type)).toEqual(['text/plain', 'text/html']);
    expect(results.attachments).toHaveLength(0);
  });

  it('attachment-disposed images are attachments; cid images stay inline', () => {
    const results = walk({
      type: 'multipart/related',
      childNodes: [
        { part: '1', type: 'text/html', encoding: '7bit' },
        { part: '2', type: 'image/png', encoding: 'base64', id: '<logo@x>' },
        {
          part: '3', type: 'image/jpeg', encoding: 'base64',
          disposition: 'attachment', dispositionParameters: { filename: 'photo.jpg' },
        },
      ],
    });
    expect(results.inlineImages).toHaveLength(1);
    expect(results.inlineImages[0].cid).toBe('logo@x');
    expect(results.attachments).toHaveLength(1);
    expect(results.attachments[0].filename).toBe('photo.jpg');
  });

  it('named non-text parts without a disposition are still attachments', () => {
    const results = walk({
      part: '2', type: 'application/pdf', encoding: 'base64',
      parameters: { name: 'invoice.pdf' },
    });
    expect(results.attachments).toHaveLength(1);
    expect(results.attachments[0].filename).toBe('invoice.pdf');
  });

  it('treats an inline-disposed named HTML file alongside a body as an attachment', () => {
    const results = walk({
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'text/html', encoding: 'quoted-printable' },
        {
          part: '2', type: 'text/html', encoding: 'base64', size: 4096,
          disposition: 'inline', dispositionParameters: { filename: 'report.html' },
        },
      ],
    });
    expect(results.textParts.map(p => p.part)).toEqual(['1']);
    expect(results.attachments).toHaveLength(1);
    expect(results.attachments[0]).toMatchObject({
      part: '2', filename: 'report.html', type: 'text/html', encoding: 'base64', size: 4096,
    });
  });

  it('treats an undisposed text part named via Content-Type as an attachment', () => {
    const results = walk({
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'text/plain', encoding: '7bit' },
        { part: '2', type: 'text/plain', encoding: '7bit', parameters: { name: 'server.log' } },
      ],
    });
    expect(results.textParts.map(p => p.part)).toEqual(['1']);
    expect(results.attachments.map(a => a.filename)).toEqual(['server.log']);
    expect(results.attachments[0].encoding).toBe('7bit');
  });

  it('keeps named text parts as body when no unnamed body part exists', () => {
    const results = walk({
      type: 'multipart/alternative',
      childNodes: [
        { part: '1', type: 'text/plain', encoding: '7bit', parameters: { name: 'body.txt' } },
        { part: '2', type: 'text/html', encoding: '7bit', parameters: { name: 'body.html' } },
      ],
    });
    expect(results.textParts.map(p => p.type)).toEqual(['text/plain', 'text/html']);
    expect(results.attachments).toHaveLength(0);
  });
});

describe('attachment-only messages have no body', () => {
  const zipRoot = {
    part: '1', type: 'application/zip', encoding: 'base64', size: 1024,
    disposition: 'attachment',
    dispositionParameters: { filename: 'google.com!example.com!1.zip' },
  };

  it('does not serve a single-part attachment root as the message text', () => {
    // A DMARC aggregate report: the whole message is one application/zip part.
    const msg = { bodyStructure: zipRoot, bodyParts: new Map([['1', Buffer.from('UEsDBBQ=')]]) };
    const body = extractBodyFromMsg(msg);
    expect(body.html).toBeNull();
    expect(body.text).toBeNull();
    expect(body.attachments.map(a => a.filename)).toEqual(['google.com!example.com!1.zip']);
  });

  it('does not fall back to the first part of a multipart holding only a file', () => {
    const results = { textParts: [], attachments: [] };
    walkStructure({ type: 'multipart/mixed', childNodes: [zipRoot] }, results);
    expect(results.textParts).toHaveLength(0);
    expect(bodyFallbackApplies(results)).toBe(false);
  });

  it('still promotes a bare unrecognized single part to text', () => {
    const msg = {
      bodyStructure: { part: '1', type: 'text/plain', encoding: '7bit', parameters: { charset: 'utf-8' } },
      bodyParts: new Map([['1', Buffer.from('hello')]]),
    };
    expect(extractBodyFromMsg(msg).text).toBe('hello');
    expect(bodyFallbackApplies({ textParts: [], attachments: [] })).toBe(true);
  });
});

describe('calendar-only messages', () => {
  const calendarRoot = {
    part: '1', type: 'text/calendar', encoding: '7bit',
    parameters: { charset: 'utf-8', method: 'REQUEST' },
  };
  const ics = 'BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nSUMMARY:Planning\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';

  it('collects a bare text/calendar root as a calendar part, not body text', () => {
    const results = { textParts: [], attachments: [] };
    walkStructure(calendarRoot, results);
    expect(results.textParts).toHaveLength(0);
    expect(results.calendarParts.map(p => p.part)).toEqual(['1']);
    expect(bodyFallbackApplies(results)).toBe(false);
  });

  it('does not store raw VCALENDAR source as the synced body', () => {
    const msg = { bodyStructure: calendarRoot, bodyParts: new Map([['1', Buffer.from(ics)]]) };
    const body = extractBodyFromMsg(msg);
    expect(body.text).toBeNull();
    expect(body.html).toBeNull();
  });

  it('keeps the html alternative of a multipart invite as its body', () => {
    const msg = {
      bodyStructure: {
        type: 'multipart/alternative',
        childNodes: [
          { part: '1', type: 'text/html', encoding: '7bit', parameters: { charset: 'utf-8' } },
          { ...calendarRoot, part: '2' },
        ],
      },
      bodyParts: new Map([['1', Buffer.from('<p>Invite</p>')], ['2', Buffer.from(ics)]]),
    };
    expect(extractBodyFromMsg(msg).html).toBe('<p>Invite</p>');
  });
});

// ── _shouldAutoBackfillOnConnect — auto-backfill gate (#354) ──────────────────
// The gate itself was always correct; #354 was the connect flow evaluating it
// AFTER the initial INBOX sync inserted rows. These lock the gate contract:
// providers without the flag always backfill; PurelyMail backfills only when the
// account is genuinely empty (which connectAccount now captures pre-sync).

describe('_shouldAutoBackfillOnConnect (#354)', () => {
  const gate = acct => ImapManager.prototype._shouldAutoBackfillOnConnect.call({}, acct);
  beforeEach(() => vi.clearAllMocks());

  it('always backfills a provider without autoBackfillExistingOnConnect:false, without a DB check', async () => {
    await expect(gate({ imap_host: 'mail.example.com', id: 'a1' })).resolves.toBe(true);
    expect(query).not.toHaveBeenCalled();
  });

  it('backfills a fresh PurelyMail account with no cached messages', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await expect(gate({ imap_host: 'imap.purelymail.com', id: 'a1' })).resolves.toBe(true);
  });

  it('skips backfill for a PurelyMail account that already has cached messages', async () => {
    query.mockResolvedValueOnce({ rows: [{ exists: 1 }] });
    await expect(gate({ imap_host: 'imap.purelymail.com', id: 'a1' })).resolves.toBe(false);
  });
});

// ── #360: 'error' listener attached before connect() ─────────────────────────
// An ImapFlow 'error' emitted during the connection handshake (e.g. a socket timeout,
// raised from a detached timer callback) with no listener is an unhandled EventEmitter
// error — Node throws and the whole process dies, taking every account down, not just the
// one connecting. connectAccount must therefore register its 'error' handler BEFORE it
// awaits connect(). This test locks in that ordering: it inspects listenerCount('error')
// at the exact moment connect() is invoked and confirms a handshake-time emission is
// absorbed rather than thrown.
describe("connectAccount attaches 'error' before connect (#360)", () => {
  beforeEach(() => vi.clearAllMocks());

  it('has an error listener at connect() time and absorbs a handshake error', async () => {
    let errorListenersAtConnect = -1;
    let emitThrew = false;

    ImapFlow.mockImplementation(function () {
      const client = new EventEmitter();
      client.connect = vi.fn(() => {
        errorListenersAtConnect = client.listenerCount('error');
        // Simulate a transport 'error' during the handshake. With the listener already
        // attached this is a logged no-op; without it, emit() throws synchronously —
        // which is exactly the process-killing #360 crash.
        try { client.emit('error', new Error('Socket timeout')); } catch { emitThrew = true; }
        return Promise.resolve();
      });
      client.logout = vi.fn(() => Promise.resolve());
      client.close = vi.fn();
      return client;
    });

    // PurelyMail host: preferFreshBodyFetch skips the pool pre-warm and its private
    // acquirePooledClient (which would build a second mock client), keeping this test to
    // the single connectAccount code path under test.
    getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: true, allowInsecureTls: true });
    resolveForConnection.mockResolvedValue({ host: '127.0.0.1', addresses: ['127.0.0.1'], servername: null });
    query.mockResolvedValue({ rows: [] });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const mgr = new ImapManager(null);
    clearInterval(mgr._healthCheckTimer);
    clearInterval(mgr._snippetSchedulerTimer);
    // Stub the post-connect fan-out — this test asserts only the listener-ordering
    // invariant, not folder/message sync behavior.
    mgr.disconnectAccount = vi.fn(() => Promise.resolve());
    mgr._attachIdleListeners = vi.fn();
    mgr.syncFolders = vi.fn(() => Promise.resolve());
    mgr.syncMessages = vi.fn(() => Promise.resolve());
    mgr._shouldAutoBackfillOnConnect = vi.fn(() => Promise.resolve(false));
    mgr.backfillAllFolders = vi.fn(() => Promise.resolve());
    mgr._startSyncInterval = vi.fn();
    mgr.broadcast = vi.fn();

    const acct = { id: 1, user_id: 1, imap_host: 'imap.purelymail.com', imap_port: 993, imap_tls: true, auth_user: 'u', auth_pass: 'enc' };
    const ok = await mgr.connectAccount(acct);

    expect(ok).toBe(true);
    expect(ImapFlow).toHaveBeenCalledTimes(1);
    expect(errorListenersAtConnect).toBeGreaterThanOrEqual(1);
    expect(emitThrew).toBe(false);
  });
});

describe('account error reporting: transient failures must not paint the account red', () => {
  const account = { id: 'acct-1', user_id: 'u1', email_address: 'a@example.com' };
  const ctx = () => ({ _syncErrorState: new Map(), _accountErrorStreak: new Map(), broadcast: vi.fn() });

  beforeEach(() => { query.mockReset(); query.mockResolvedValue({ rows: [] }); });

  it('says nothing on a single connection refusal', async () => {
    // The defect: a provider that refuses every few minutes and reconnects 45s later left the
    // account showing a connection error 10-15% of the time, permanently, for something the
    // user could do nothing about and that always healed itself.
    const self = ctx();
    await ImapManager.prototype._recordAccountError.call(self, account, 'Connection not available');
    expect(query).not.toHaveBeenCalled();
    expect(self.broadcast).not.toHaveBeenCalled();
  });

  it('reports once a refusal repeats, because that is a real outage', async () => {
    const self = ctx();
    await ImapManager.prototype._recordAccountError.call(self, account, 'Connection not available');
    await ImapManager.prototype._recordAccountError.call(self, account, 'Connection not available');
    expect(query).toHaveBeenCalledTimes(1);
    expect(self.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'account_error', accountId: 'acct-1' }), 'u1');
  });

  it('a success between refusals resets the run, so routine pushback never accumulates', async () => {
    // Without this an account that refuses once an hour would surface an error on the second
    // hour, having been perfectly healthy in between.
    const self = ctx();
    await ImapManager.prototype._recordAccountError.call(self, account, 'Connection not available');
    await ImapManager.prototype._clearAccountError.call(self, account);
    await ImapManager.prototype._recordAccountError.call(self, account, 'Connection not available');
    expect(self.broadcast).not.toHaveBeenCalled();
  });

  it('clearing resets the run even when nothing was ever surfaced', async () => {
    const self = ctx();
    await ImapManager.prototype._recordAccountError.call(self, account, 'Connection not available');
    expect(self._accountErrorStreak.get('acct-1')).toBe(1);
    await ImapManager.prototype._clearAccountError.call(self, account);
    expect(self._accountErrorStreak.has('acct-1')).toBe(false);
  });

  it.each([
    'Invalid credentials',
    'AUTHENTICATIONFAILED',
    'getaddrinfo ENOTFOUND imap.example.com',
    'certificate has expired',
  ])('reports %s immediately, because it will never heal on its own', async detail => {
    const self = ctx();
    await ImapManager.prototype._recordAccountError.call(self, account, detail);
    expect(self.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'account_error', error: detail }), 'u1');
  });

  it('still de-duplicates once an error has been surfaced', async () => {
    const self = ctx();
    for (let i = 0; i < 4; i++) {
      await ImapManager.prototype._recordAccountError.call(self, account, 'Connection not available');
    }
    expect(query).toHaveBeenCalledTimes(1);
    expect(self.broadcast).toHaveBeenCalledTimes(1);
  });

  it('a persistent outage surfaces within one retry, not never', async () => {
    // The deferral must not be able to swallow a genuine failure: every retry re-enters here.
    const self = ctx();
    let surfaced = 0;
    for (let attempt = 1; attempt <= 3; attempt++) {
      await ImapManager.prototype._recordAccountError.call(self, account, 'Connection not available');
      surfaced = self.broadcast.mock.calls.length;
      if (attempt === 1) expect(surfaced).toBe(0);
    }
    expect(surfaced).toBe(1);
  });
});

describe('reconcileDeletes folder source', () => {
  it('considers only folders the server still advertises', async () => {
    // Second line of defence for the same loop: a stranded message row must not be able to
    // resurrect a deleted mailbox as something to open.
    query.mockReset();
    query.mockResolvedValue({ rows: [] });
    await ImapManager.prototype.reconcileDeletes.call({}, { id: 'acct-1', email_address: 'a@example.com' });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('FROM folders f');
    expect(sql).toContain('f.path = m.folder');
    expect(params).toEqual(['acct-1']);
  });
});

describe('syncFolders pruning', () => {
  beforeEach(() => {
    query.mockReset();
    query.mockResolvedValue({ rows: [] });
  });

  const account = { id: 'acct-1', email_address: 'a@example.com' };

  it('deletes DB rows for folders missing from LIST (ghosts after external rename)', async () => {
    const client = {
      list: vi.fn().mockResolvedValue([
        { path: 'INBOX', name: 'INBOX', delimiter: '/' },
        { path: 'Projects-Renamed', name: 'Projects-Renamed', delimiter: '/' },
        { path: 'Projects-Renamed/Sub', name: 'Sub', delimiter: '/' },
      ]),
    };
    await ImapManager.prototype.syncFolders.call({}, account, client);

    const del = query.mock.calls.find(([sql]) => sql.includes('DELETE FROM folders'));
    expect(del).toBeTruthy();
    expect(del[0]).toContain("path != 'INBOX'");
    expect(del[1]).toEqual(['acct-1', ['INBOX', 'Projects-Renamed', 'Projects-Renamed/Sub']]);
  });

  it('never prunes on an empty LIST response', async () => {
    const client = { list: vi.fn().mockResolvedValue([]) };
    await ImapManager.prototype.syncFolders.call({}, account, client);
    expect(query.mock.calls.some(([sql]) => sql.includes('DELETE FROM folders'))).toBe(false);
  });

  it('drops the cached messages of a folder the server no longer has', async () => {
    // The self-sustaining loop this closes: pruning the folder row but stranding its message
    // rows left reconcileDeletes (which derives its folder list from messages) opening a
    // mailbox the server had deleted. That open failed every cycle, and because it failed it
    // could never learn the messages were gone, so the rows kept the error alive forever.
    query.mockImplementation(async sql => sql.includes('DELETE FROM folders')
      ? { rows: [{ path: 'Newsletter' }], rowCount: 1 } : { rows: [], rowCount: 0 });
    const client = { list: vi.fn().mockResolvedValue([{ path: 'INBOX', name: 'INBOX', delimiter: '/' }]) };
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await ImapManager.prototype.syncFolders.call({}, account, client);

    const del = query.mock.calls.find(([sql]) => sql.includes('DELETE FROM messages'));
    expect(del).toBeTruthy();
    expect(del[1]).toEqual(['acct-1', ['Newsletter']]);
  });

  it('touches no message rows when no folder was pruned', async () => {
    query.mockImplementation(async () => ({ rows: [], rowCount: 0 }));
    const client = { list: vi.fn().mockResolvedValue([{ path: 'INBOX', name: 'INBOX', delimiter: '/' }]) };
    await ImapManager.prototype.syncFolders.call({}, account, client);
    expect(query.mock.calls.some(([sql]) => sql.includes('DELETE FROM messages'))).toBe(false);
  });

  it('never deletes messages on an empty LIST, because nothing was pruned', async () => {
    const client = { list: vi.fn().mockResolvedValue([]) };
    await ImapManager.prototype.syncFolders.call({}, account, client);
    expect(query.mock.calls.some(([sql]) => sql.includes('DELETE FROM messages'))).toBe(false);
  });

  it('still upserts every listed folder before pruning', async () => {
    const client = {
      list: vi.fn().mockResolvedValue([
        { path: 'Archive', name: 'Archive', delimiter: '/', specialUse: '\\Archive' },
      ]),
    };
    await ImapManager.prototype.syncFolders.call({}, account, client);
    const inserts = query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO folders'));
    // The listed folder + the implicit INBOX row.
    expect(inserts.length).toBe(2);
    const del = query.mock.calls.find(([sql]) => sql.includes('DELETE FROM folders'));
    expect(del[1][1]).toEqual(['Archive']);
  });
});

// ── _deleteAllInFolder — chunked, throttle-tolerant empty ─────────────────────
describe('_deleteAllInFolder — chunked delete', () => {
  const run = (client, opts) =>
    ImapManager.prototype._deleteAllInFolder.call(ImapManager.prototype, client, 'Trash', { retryBackoffMs: 0, ...opts });

  it('deletes in UID-addressed chunks of chunkSize and returns the total', async () => {
    const uids = Array.from({ length: 1200 }, (_, i) => i + 1);
    const client = {
      search: vi.fn().mockResolvedValue(uids),
      messageDelete: vi.fn().mockResolvedValue(true),
    };
    const deleted = await run(client, { chunkSize: 500 });

    expect(deleted).toBe(1200);
    expect(client.search).toHaveBeenCalledWith({ all: true }, { uid: true });
    expect(client.messageDelete).toHaveBeenCalledTimes(3); // 500 + 500 + 200
    // Every call is UID-addressed, and the chunks together cover exactly all UIDs, in order.
    const seen = [];
    for (const [range, options] of client.messageDelete.mock.calls) {
      expect(options).toEqual({ uid: true });
      seen.push(...range.split(',').map(Number));
    }
    expect(seen).toEqual(uids);
  });

  it('is a no-op when the folder is already empty', async () => {
    const client = {
      search: vi.fn().mockResolvedValue([]),
      messageDelete: vi.fn(),
    };
    const deleted = await run(client);
    expect(deleted).toBe(0);
    expect(client.messageDelete).not.toHaveBeenCalled();
  });

  it('retries a chunk once after the server declines it, then succeeds', async () => {
    const client = {
      search: vi.fn().mockResolvedValue([1, 2, 3]),
      messageDelete: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true),
    };
    const deleted = await run(client);
    expect(deleted).toBe(3);
    expect(client.messageDelete).toHaveBeenCalledTimes(2); // one decline, one retry
  });

  it('throws with progress when a chunk keeps failing after the retry', async () => {
    const client = {
      search: vi.fn().mockResolvedValue([1, 2, 3]),
      messageDelete: vi.fn().mockResolvedValue(false),
    };
    await expect(run(client)).rejects.toThrow(/messageDelete could not be confirmed/);
    expect(client.messageDelete).toHaveBeenCalledTimes(2); // initial attempt + one retry
  });

  it('surfaces the underlying error if the retry attempt throws', async () => {
    const client = {
      search: vi.fn().mockResolvedValue([1, 2, 3]),
      messageDelete: vi.fn()
        .mockResolvedValueOnce(false)
        .mockRejectedValueOnce(new Error('Socket timeout')),
    };
    await expect(run(client)).rejects.toThrow(/Socket timeout/);
    expect(client.messageDelete).toHaveBeenCalledTimes(2);
  });
});

// ── _markSeenInFolder — chunked mark-all-read ────────────────────────────────
describe('_markSeenInFolder — chunked mark-all-read', () => {
  const run = (client, opts) =>
    ImapManager.prototype._markSeenInFolder.call(ImapManager.prototype, client, 'INBOX', { retryBackoffMs: 0, ...opts });

  it('adds \\Seen to UNSEEN messages in UID-addressed chunks', async () => {
    const uids = Array.from({ length: 1100 }, (_, i) => i + 1);
    const client = {
      search: vi.fn().mockResolvedValue(uids),
      messageFlagsAdd: vi.fn().mockResolvedValue(true),
    };
    const flagged = await run(client, { chunkSize: 500 });

    expect(flagged).toBe(1100);
    // Only unread messages are targeted, and the return is UID-addressed.
    expect(client.search).toHaveBeenCalledWith({ seen: false }, { uid: true });
    expect(client.messageFlagsAdd).toHaveBeenCalledTimes(3); // 500 + 500 + 100
    for (const [range, flags, options] of client.messageFlagsAdd.mock.calls) {
      expect(flags).toEqual(['\\Seen']);
      expect(options).toEqual({ uid: true });
      expect(range.split(',').length).toBeLessThanOrEqual(500);
    }
  });

  it('is a no-op when nothing is unread', async () => {
    const client = {
      search: vi.fn().mockResolvedValue([]),
      messageFlagsAdd: vi.fn(),
    };
    expect(await run(client)).toBe(0);
    expect(client.messageFlagsAdd).not.toHaveBeenCalled();
  });

  it('retries a chunk once, then throws with progress if it keeps failing', async () => {
    const client = {
      search: vi.fn().mockResolvedValue([1, 2, 3]),
      messageFlagsAdd: vi.fn().mockResolvedValue(false),
    };
    await expect(run(client)).rejects.toThrow(/messageFlagsAdd could not be confirmed/);
    expect(client.messageFlagsAdd).toHaveBeenCalledTimes(2);
  });
});

describe('classifyMoveBySearch (#407 empty-uidMap reconciliation)', () => {
  it('treats a non-array search result as "nothing confirmed", never as an empty source', () => {
    // imapflow's search() resolves undefined (no mailbox selected) or false (SEARCH failed)
    // rather than throwing. Reading either as an empty source would mean "every uid left the
    // folder", i.e. the whole batch moved successfully, which is the dangerous conclusion.
    for (const bad of [false, undefined, null]) {
      const r = classifyMoveBySearch([4, 5, 6], bad, 3);
      expect(r.succeeded).toEqual([]);
      expect(r.failed).toEqual([4, 5, 6]);
      expect(r.staleCount).toBeNull();
      expect(r.mappable).toBe(false);
    }
  });

  it('clean move: all left source, all arrived -> succeeded + mappable', () => {
    const r = classifyMoveBySearch([4, 5, 6], /*remaining*/ [], /*destArrived*/ 3);
    expect(r.succeeded).toEqual([4, 5, 6]);
    expect(r.failed).toEqual([]);
    expect(r.staleCount).toBe(0);
    expect(r.mappable).toBe(true);
  });

  it('stale UID in batch: fewer arrived than left -> ALL failed, no wrong-deletion', () => {
    // 2,3 were stale (moved away earlier), 4,5,6 really moved. All 5 are gone from source,
    // but only 3 arrived in the destination -> conservatively report all failed.
    const r = classifyMoveBySearch([2, 3, 4, 5, 6], /*remaining*/ [], /*destArrived*/ 3);
    expect(r.succeeded).toEqual([]);
    expect(r.failed).toEqual([2, 3, 4, 5, 6]);
    expect(r.staleCount).toBe(2);
    expect(r.mappable).toBe(false);
  });

  it('partial move failure: some still in source -> those are failed, the rest succeeded', () => {
    // 5,6 still in source (not moved), 4 moved and arrived.
    const r = classifyMoveBySearch([4, 5, 6], /*remaining*/ [5, 6], /*destArrived*/ 1);
    expect(r.succeeded).toEqual([4]);
    expect(r.failed).toEqual([5, 6]);
    expect(r.staleCount).toBe(0);
    expect(r.mappable).toBe(true);
  });

  it('nothing left the source -> all failed (move did not happen)', () => {
    const r = classifyMoveBySearch([7, 8], /*remaining*/ [7, 8], /*destArrived*/ 0);
    expect(r.succeeded).toEqual([]);
    expect(r.failed).toEqual([7, 8]);
    expect(r.staleCount).toBe(0);
  });

  it('destination not verifiable (null) -> trust source-absence, not mappable, stale unknown', () => {
    const r = classifyMoveBySearch([4, 5, 6], /*remaining*/ [], /*destArrived*/ null);
    expect(r.succeeded).toEqual([4, 5, 6]);
    expect(r.failed).toEqual([]);
    expect(r.staleCount).toBeNull();
    expect(r.mappable).toBe(false);
  });
});

// ── sync_error recording — every path that gives up records, every success clears ──────────

describe('_recordAccountError / _clearAccountError', () => {
  const acct = { id: 'a1', user_id: 'u1', email_address: 'x@example.com' };

  const mgr = () => {
    const m = new ImapManager(null);
    clearInterval(m._healthCheckTimer);
    clearInterval(m._snippetSchedulerTimer);
    m.broadcast = vi.fn();
    return m;
  };

  beforeEach(() => {
    query.mockReset();
    query.mockResolvedValue({ rows: [] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it('persists the error and broadcasts it once a recoverable failure repeats', async () => {
    const m = mgr();
    // A connect timeout is recoverable, so the first is deliberately held back: providers that
    // refuse and accept again moments later must not paint the account red. The second, after a
    // backoff has elapsed without success, is a real outage and has to reach the UI.
    await m._recordAccountError(acct, 'IMAP connect timeout (30000ms)');
    expect(query).not.toHaveBeenCalled();
    expect(m.broadcast).not.toHaveBeenCalled();
    await m._recordAccountError(acct, 'IMAP connect timeout (30000ms)');
    expect(query).toHaveBeenCalledWith(
      'UPDATE email_accounts SET sync_error = $1 WHERE id = $2',
      ['IMAP connect timeout (30000ms)', 'a1'],
    );
    expect(m.broadcast).toHaveBeenCalledWith(
      { type: 'account_error', accountId: 'a1', error: 'IMAP connect timeout (30000ms)' }, 'u1',
    );
  });

  it('does not rewrite an unchanged error — a host down for hours writes once', async () => {
    const m = mgr();
    for (let i = 0; i < 5; i++) await m._recordAccountError(acct, 'read ETIMEDOUT');
    expect(query).toHaveBeenCalledTimes(1);
    expect(m.broadcast).toHaveBeenCalledTimes(1);
  });

  it('writes again when the error text changes', async () => {
    const m = mgr();
    await m._recordAccountError(acct, 'read ETIMEDOUT');
    await m._recordAccountError(acct, 'Reconnect timeout (30000ms)');
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('clears a recorded error and tells the client', async () => {
    const m = mgr();
    await m._recordAccountError(acct, 'read ETIMEDOUT');
    m.broadcast.mockClear();
    await m._clearAccountError(acct);
    expect(query).toHaveBeenLastCalledWith(
      'UPDATE email_accounts SET sync_error = NULL WHERE id = $1', ['a1'],
    );
    expect(m.broadcast).toHaveBeenCalledWith({ type: 'account_connected', accountId: 'a1' }, 'u1');
  });

  it('writes through on the first clear after a restart, when the DB may hold a stale error', async () => {
    const m = mgr();
    await m._clearAccountError(acct);
    expect(query).toHaveBeenCalledTimes(1);
    // ...but stays silent: nothing was showing, so there is no transition to announce.
    expect(m.broadcast).not.toHaveBeenCalled();
  });

  it('skips the redundant UPDATE once known-clear — the sync tick must not write every 10s', async () => {
    const m = mgr();
    await m._clearAccountError(acct);
    query.mockClear();
    for (let i = 0; i < 10; i++) await m._clearAccountError(acct);
    expect(query).not.toHaveBeenCalled();
  });

  it('never throws when the DB write fails, and retries the write next time', async () => {
    const m = mgr();
    query.mockRejectedValueOnce(new Error('deadlock detected'));
    await expect(m._recordAccountError(acct, 'read ETIMEDOUT')).resolves.toBeUndefined();
    expect(m.broadcast).not.toHaveBeenCalled();
    query.mockResolvedValue({ rows: [] });
    await m._recordAccountError(acct, 'read ETIMEDOUT');
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('forgets cached state on disconnect so a re-added account writes through', async () => {
    const m = mgr();
    await m._clearAccountError(acct);
    await m.disconnectAccount('a1');
    query.mockClear();
    await m._clearAccountError(acct);
    expect(query).toHaveBeenCalledTimes(1);
  });
});

// ── last_sync is stamped on an empty mailbox too ────────────────────────────────────────────

describe('syncMessages — empty mailbox still stamps last_sync', () => {
  beforeEach(() => { query.mockReset(); query.mockResolvedValue({ rows: [] }); });

  const account = { id: 'acct-empty', user_id: 'user-1', email_address: 'new@example.com', imap_host: 'imap.example.com' };

  it('stamps last_sync when the server reports an empty mailbox', async () => {
    const client = {
      getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
      mailbox: { exists: 0 },
    };
    const result = await ImapManager.prototype.syncMessages.call({}, account, client, 'INBOX', 50, false, true);
    expect(result).toEqual({ insertedCount: 0, broadcastedNewMessages: false });
    const stamps = query.mock.calls.filter(c => /UPDATE email_accounts SET last_sync/.test(c[0]));
    expect(stamps).toHaveLength(1);
    expect(stamps[0][1]).toEqual(['acct-empty']);
  });

  it('invalidates a previous UID epoch even when the rebuilt mailbox is empty', async () => {
    query.mockImplementation(async sql => ({ rows: sql.includes('SELECT uid_validity') ? [{ uid_validity: '7' }] : [], rowCount: 0 }));
    const mgr = { _bgConnSem: createKeyedSemaphore(2), backfillMessages: vi.fn().mockResolvedValue() };
    const client = { getMailboxLock: async () => ({ release() {} }), mailbox: { exists: 0, uidValidity: 8n } };
    await ImapManager.prototype.syncMessages.call(mgr, account, client, 'INBOX', 50, false, true);
    await new Promise(resolve => setImmediate(resolve));
    const purge = query.mock.calls.findIndex(([sql]) => sql.startsWith('DELETE FROM messages'));
    const stamp = query.mock.calls.findIndex(([sql]) => sql.includes('uid_validity=COALESCE'));
    expect(purge).toBeGreaterThanOrEqual(0);
    expect(stamp).toBeGreaterThan(purge);
    expect(query.mock.calls[stamp][1]).toEqual([account.id, 'INBOX', 8]);
  });

  it('still releases the mailbox lock on the empty path', async () => {
    const release = vi.fn();
    const client = { getMailboxLock: vi.fn().mockResolvedValue({ release }), mailbox: { exists: 0 } };
    await ImapManager.prototype.syncMessages.call({}, account, client, 'INBOX', 50, false, true);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('does NOT stamp when the mailbox object is missing — unknown state, not a confirmed sync', async () => {
    const client = { getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }), mailbox: null };
    await expect(
      ImapManager.prototype.syncMessages.call({}, account, client, 'INBOX', 50, false, true)
    ).resolves.toEqual({ insertedCount: 0, broadcastedNewMessages: false });
    expect(query.mock.calls.filter(c => /UPDATE email_accounts SET last_sync/.test(c[0]))).toHaveLength(0);
  });
});

describe('hung IMAP transport recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    query.mockReset();
    query.mockResolvedValue({ rows: [] });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  const acct = { id: 'recovery', user_id: 'u1', imap_host: 'imap.example.com' };
  function setup() {
    const mgr = new ImapManager(null);
    for (const key of ['_healthCheckTimer', '_snippetSchedulerTimer', '_stalenessCheckTimer', '_flagPushReconcilerTimer']) clearInterval(mgr[key]);
    const client = { close: vi.fn(), logout: vi.fn(() => new Promise(() => {})) };
    mgr.connections.set(acct.id, client);
    return { mgr, client };
  }
  it('force-closes a timed-out sync and releases its guard', async () => {
    const { mgr, client } = setup();
    mgr.syncMessages = vi.fn(() => new Promise(() => {}));
    const tick = mgr._syncTick(acct);
    await vi.advanceTimersByTimeAsync(55000);
    await tick;
    expect(client.close).toHaveBeenCalledOnce();
    expect(client.logout).not.toHaveBeenCalled();
    expect(mgr.connections.has(acct.id)).toBe(false);
    expect(mgr.syncingAccounts.has(acct.id)).toBe(false);
  });
  it('does not close a replacement connection when an older sync times out', async () => {
    const { mgr, client } = setup();
    mgr.syncMessages = vi.fn(() => new Promise(() => {}));
    const tick = mgr._syncTick(acct);
    const successor = { close: vi.fn() };
    mgr.connections.set(acct.id, successor);
    await vi.advanceTimersByTimeAsync(55000);
    await tick;
    expect(successor.close).not.toHaveBeenCalled();
    expect(mgr.connections.get(acct.id)).toBe(successor);
    expect(client.logout).not.toHaveBeenCalled();
  });
  it('disconnect completes even when graceful logout would never settle', async () => {
    const { mgr, client } = setup();
    await mgr.disconnectAccount(acct.id);
    expect(client.close).toHaveBeenCalledOnce();
    expect(client.logout).not.toHaveBeenCalled();
    expect(mgr.connections.has(acct.id)).toBe(false);
  });
});

describe('staleness probe connection recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: true });
    resolveForConnection.mockResolvedValue({ host: '::1', addresses: ['::1', '127.0.0.1'] });
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  it('retries a stalled dual-stack login over IPv4 and closes both probe transports', async () => {
    const interval = vi.spyOn(globalThis, 'setInterval');
    const mgr = new ImapManager(null);
    const probeCycle = interval.mock.calls.find(([, ms]) => ms === 180000)[0];
    vi.clearAllTimers();
    const acct = { id: 'probe-recovery', user_id: 'u1', imap_host: 'imap.example.com', imap_tls: true };
    const persistent = { close: vi.fn() };
    mgr.connections.set(acct.id, persistent);
    query.mockImplementation(async sql => ({ rows: sql.includes('MAX(uid)') ? [{ maxuid: 100 }] : [acct] }));
    const clients = [];
    ImapFlow.mockImplementation(function () {
      const client = Object.assign(new EventEmitter(), {
        connect: vi.fn(() => clients.length === 1 ? new Promise(() => {}) : Promise.resolve()),
        close: vi.fn(),
        getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
        search: vi.fn().mockResolvedValue([]),
      });
      clients.push(client);
      return client;
    });
    const cycle = probeCycle();
    await vi.advanceTimersByTimeAsync(25000);
    await cycle;
    expect(clients).toHaveLength(2);
    expect(ImapFlow.mock.calls.at(-1)[0].host).toBe('127.0.0.1');
    expect(clients[0].close).toHaveBeenCalledOnce();
    expect(clients[1].search).toHaveBeenCalledWith({ uid: '101:*' }, { uid: true });
    expect(clients[1].close).toHaveBeenCalledOnce();
    expect(persistent.close).not.toHaveBeenCalled();
    expect(mgr._stalenessCheckRunning).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('Gmail label memberships (#418)', () => {
  let rows, acct, serverUids;
  const sent = '[Gmail]/Sent Mail';
  const parsed = uid => ({ uid, messageId: '<self@example.com>', subject: 'Self mail',
    fromEmail: 'me@example.com', to: [], cc: [], replyTo: [], date: new Date('2026-09-01'),
    isRead: true, flags: ['\\Seen'], parsedHeaders: {} });
  function clientFor(folder) {
    return Object.assign(new EventEmitter(), {
      mailbox: { exists: serverUids.length, uidValidity: 1 },
      connect: vi.fn().mockResolvedValue(), close: vi.fn(), logout: vi.fn().mockResolvedValue(),
      getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
      search: vi.fn(async () => serverUids),
      fetch: vi.fn(async function* (range) {
        const uids = range.includes(':') ? serverUids : range.split(',').map(Number);
        for (const uid of uids) yield { uid, folder };
      }),
    });
  }
  beforeEach(() => {
    vi.useFakeTimers();
    rows = []; serverUids = [1];
    acct = { id: 'gmail-418', user_id: 'u418', enabled: true, imap_host: 'imap.gmail.com', imap_tls: true };
    parseMessage.mockImplementation(async m => parsed(m.uid));
    getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: true });
    resolveForConnection.mockResolvedValue({ host: '127.0.0.1', addresses: ['127.0.0.1'] });
    query.mockReset();
    query.mockImplementation(async (sql, params = []) => {
      const local = rows.filter(r => r.folder === params[1]);
      if (sql.includes('SELECT * FROM email_accounts') || sql.includes('SELECT id FROM email_accounts')) return { rows: [acct] };
      if (sql.includes('SELECT uid_validity, total_count')) return { rows: [{ uid_validity: 1, total_count: local.length }] };
      if (sql.includes('SELECT uid_validity')) return { rows: [{ uid_validity: 1 }] };
      if (sql.includes('COUNT(*) as count')) return { rows: [{ count: local.length, max_uid: Math.max(0, ...local.map(r => r.uid)) }] };
      if (sql.includes('COALESCE(MAX(uid), 0)')) return { rows: [{ max_uid: Math.max(0, ...local.map(r => r.uid)) }] };
      if (sql.trim().startsWith('SELECT') && sql.includes('COUNT(*)')) return { rows: [{ n: local.length }] };
      if (sql.includes('SELECT uid FROM messages')) return { rows: local.map(r => ({ uid: r.uid })) };
      if (sql.includes('AND 1 = (SELECT COUNT')) {
        // Model the existing single-row relocation: whichever folder syncs last wins.
        const same = rows.filter(r => r.messageId === params[3]);
        if (same.length === 1 && (same[0].folder !== params[0] || same[0].uid !== params[1])) {
          Object.assign(same[0], { folder: params[0], uid: params[1] });
          return { rows: [{ id: 'relocated' }] };
        }
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO messages')) {
        const exists = rows.some(r => r.folder === params[2] && r.uid === params[1]);
        if (!exists) rows.push({ folder: params[2], uid: params[1], messageId: params[3] });
        return { rows: [{ id: `row-${rows.length}`, is_new: !exists }] };
      }
      return { rows: [] };
    });
  });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });
  const manager = () => ({ backfillRunning: new Set(), broadcast: vi.fn(), pluginFacade: {} });
  async function sync(mgr, folder) {
    await ImapManager.prototype.syncMessages.call(mgr, acct, clientFor(folder), folder, 20, false, true);
  }
  async function backfill(mgr, folder) {
    ImapFlow.mockImplementation(function () { return clientFor(folder); });
    const pending = ImapManager.prototype.backfillMessages.call(mgr, acct, folder);
    await vi.runAllTimersAsync();
    await pending;
  }
  for (const mode of ['sync', 'backfill']) {
    for (const order of [['INBOX', sent], [sent, 'INBOX'], ['INBOX', 'Projects']]) {
      it(`${mode} preserves both memberships in order ${order.join(' -> ')}`, async () => {
        const mgr = manager();
        const run = mode === 'sync' ? sync : backfill;
        for (const folder of order) await run(mgr, folder);
        expect(rows.map(r => r.folder).sort()).toEqual([...order].sort());
        for (const folder of order) await run(mgr, folder);
        expect(rows).toHaveLength(2);
      });
    }
  }
  it('repairs an older INBOX hole even when cached counts and maximum UID look complete', async () => {
    serverUids = [1, 2];
    rows = [{ folder: 'INBOX', uid: 2 }, { folder: 'INBOX', uid: 3 },
      { folder: sent, uid: 10, messageId: '<self@example.com>' }];
    await backfill(manager(), 'INBOX');
    expect(rows).toContainEqual(expect.objectContaining({ folder: 'INBOX', uid: 1 }));
    expect(rows).toContainEqual(expect.objectContaining({ folder: sent, uid: 10 }));
  });
  for (const host of ['imap.example.com', 'imap.purelymail.com', 'imap.mail.me.com']) {
    for (const mode of ['sync', 'backfill']) {
      it(`${mode} preserves shared Message-IDs across folders on ${host}`, async () => {
        acct.imap_host = host;
        const mgr = manager();
        const run = mode === 'sync' ? sync : backfill;
        await run(mgr, 'INBOX');
        await run(mgr, 'Sent');
        expect(rows.map(r => r.folder).sort()).toEqual(['INBOX','Sent']);
        await run(mgr,'INBOX');
        expect(rows).toHaveLength(2);
      });
      it(`${mode} preserves two live UIDs with the same Message-ID inside one folder on ${host}`, async () => {
        acct.imap_host = host;
        serverUids = [1,2];
        const mgr = manager();
        const run = mode === 'sync' ? sync : backfill;
        await run(mgr, 'INBOX');
        expect(rows.map(r => r.uid).sort()).toEqual([1,2]);
        await run(mgr, 'INBOX');
        expect(rows).toHaveLength(2);
      });
    }
  }
});

describe('Gmail staleness membership check (#418)', () => {
  beforeEach(() => query.mockReset());
  it('does not let a Sent copy mask a missing INBOX UID', async () => {
    query.mockResolvedValue({ rows: [] });
    const account = { id: 'a418', imap_host: 'imap.gmail.com' };
    expect(await countMissingInboxCopies(account, [{ uid: 7, messageId: 'self@example.com' }])).toBe(1);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("folder = 'INBOX'"), ['a418', [7]]);
  });
  it('compares exact INBOX UIDs and handles pg bigint strings', async () => {
    query.mockResolvedValue({ rows: [{ uid: '7' }] });
    expect(await countMissingInboxCopies({ id: 'a418', imap_host: 'imap.gmail.com' }, [
      { uid: 7, messageId: 'same' }, { uid: 8, messageId: 'same' },
    ])).toBe(1);
  });
  it('uses exact UID membership on non-Gmail providers too', async () => {
    query.mockResolvedValue({ rows: [{ uid: '7' }] });
    expect(await countMissingInboxCopies({ id: 'a418', imap_host: 'imap.example.com' }, [
      { uid: 7, messageId: 'same' }, { uid: 8, messageId: null },
    ])).toBe(1);
  });
  it('does not count phantom search results that FETCH did not return', async () => {
    expect(await countMissingInboxCopies({ imap_host: 'imap.gmail.com' }, [])).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('folder integrity reconciliation safety', () => {
  const acct = { id: 'count-test', user_id: 'u', imap_host: 'imap.example.com' };
  const observed = { uidValidity: 8n, uidNext: 20, highestModseq: 22n };
  beforeEach(() => { query.mockReset(); query.mockResolvedValue({ rows: [], rowCount: 0 }); });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
  function setup(uids, exists = uids.length) {
    const lock = { release: vi.fn() };
    const client = { mailbox: { exists, uidValidity: 8n }, getMailboxLock: async () => lock, search: async () => uids,
      fetch: async function* () { for (const uid of uids) yield { uid, flags: new Set() }; } };
    const mgr = Object.assign(Object.create(ImapManager.prototype), {
      _withCountClient: async (_a, fn) => fn(client), syncMessages: vi.fn().mockResolvedValue({}),
      _applyFlagUpdates: vi.fn().mockResolvedValue(0), _isMoveUidGuarded: () => false,
      broadcast: vi.fn(), backfillMessages: vi.fn(), _bgConnSem: createKeyedSemaphore(2),
    });
    return { mgr, client, lock };
  }
  it('never deletes or checkpoints after a truncated flag fetch', async () => {
    const { mgr, lock } = setup([1], 2);
    await expect(mgr._refreshObservedFolder(acct, 'Sent', observed)).rejects.toThrow('Incomplete');
    expect(query.mock.calls.some(([sql]) => /DELETE|status_synced_at/.test(sql))).toBe(false);
    expect(lock.release).toHaveBeenCalledOnce();
  });
  it('rejects failed FETCH instead of treating the collected prefix as complete', async () => {
    const { mgr, client } = setup([1], 2);
    client.fetch = async function* () { yield { uid: 1, flags: new Set() }; throw new Error('Disconnected'); };
    await expect(mgr._refreshObservedFolder(acct, 'Sent', observed)).rejects.toThrow('Disconnected');
    expect(query).not.toHaveBeenCalled();
  });
  it.each([false, [2]])('does not delete on unavailable or equal-count changed membership (%s)', async response => {
    const { mgr, client } = setup([1]);
    client.search = async () => response;
    await expect(mgr._refreshObservedFolder(acct, 'Sent', observed)).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });

  it('a missing old UID schedules backfill without claiming a completed sync', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { mgr } = setup([1, 2]);
    query.mockResolvedValue({ rows: [{ uid: '2' }] });
    await mgr._refreshObservedFolder(acct, 'Sent', observed);
    expect(mgr.backfillMessages).toHaveBeenCalledWith(acct, 'Sent');
    expect(query.mock.calls.some(([sql]) => sql.includes('status_synced_at'))).toBe(false);
    expect(mgr._bgConnSem.activeCount(acct.imap_host)).toBe(0);
  });
  it('checkpoints only after fully verified membership', async () => {
    const { mgr } = setup([1, 2]);
    query.mockResolvedValue({ rows: [{ uid: '1' }, { uid: '2' }] });
    await mgr._refreshObservedFolder(acct, 'Sent', observed);
    const checkpoint = query.mock.calls.find(([sql]) => sql.includes('status_synced_at'));
    expect(checkpoint[1]).toEqual([acct.id, 'Sent', 20, '8', '22']);
    expect(checkpoint[0]).toContain('uid_validity=$4');
  });
  it('a rebuilt mailbox cannot use the previous epoch observation as a checkpoint', async () => {
    const { mgr, client } = setup([1]);
    client.mailbox.uidValidity = 9n;
    await mgr._refreshObservedFolder(acct, 'Sent', observed);
    expect(query).not.toHaveBeenCalled();
  });
  it('only removes old unguarded cached rows from a verified empty folder and checks the UID epoch in SQL', async () => {
    const { mgr } = setup([]);
    mgr._isMoveUidGuarded = (_a, _f, uid) => uid === 2;
    query.mockResolvedValue({ rows: [{ uid: '1', synced_at: new Date(0) }, { uid: '2', synced_at: new Date(0) }, { uid: '3', synced_at: new Date(Date.now() + 60000) }], rowCount: 1 });
    await mgr._refreshObservedFolder(acct, 'Sent', observed);
    const deletion = query.mock.calls.find(([sql]) => sql.startsWith('DELETE'));
    expect(deletion[1][2]).toEqual([1]);
    expect(deletion[0]).toContain('uid_validity=$5');
  });
  it('backs off unresolved membership without blocking other folders or advancing a checkpoint', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { mgr } = setup([]);
    Object.assign(mgr, { _statusSyncBackoff: new Map(), _statusSyncRunning: new Set(), backfillRunning: new Set(), onDemandSyncing: new Set(),
      _refreshObservedFolder: vi.fn().mockResolvedValue(false) });
    expect(mgr._queueObservedFolder(acct, 'INBOX', observed)).toBe(true);
    await new Promise(resolve => setImmediate(resolve));
    expect(mgr._queueObservedFolder(acct, 'INBOX', observed)).toBe(false);
    expect(mgr._queueObservedFolder(acct, 'Sent', observed)).toBe(true);
    await new Promise(resolve => setImmediate(resolve));
    expect(query.mock.calls.some(([sql]) => sql.includes('status_synced_at'))).toBe(false);
    const key = `${acct.id}:INBOX`;
    for (let i = 0; i < 10; i++) mgr._noteIntegrityRetry(key);
    expect(mgr._statusSyncBackoff.get(key).until-Date.now()).toBe(15*60000);
  });

  it('connection admission timeout removes its waiter without consuming a later released slot', async () => {
    vi.useFakeTimers();
    const sem = createKeyedSemaphore(1);
    await sem.acquire('host');
    const failed = expect(sem.acquire('host', { timeoutMs: 10 })).rejects.toThrow('admission timed out');
    await vi.advanceTimersByTimeAsync(10);
    await failed;
    expect(sem.waitingCount('host')).toBe(0);
    sem.release('host');
    expect(sem.activeCount('host')).toBe(0);
    await sem.acquire('host');
    expect(sem.activeCount('host')).toBe(1);
    sem.release('host');
  });
});


describe('backfill optional metadata fallback', () => {
  const query = { uid: true, flags: true, envelope: true, bodyStructure: true, headers: true };
  const collect = async iterator => { const out=[]; for await (const item of iterator) out.push(item.uid); return out; };
  it('retries only omitted UIDs after the full metadata fetch is drained', async () => {
    let drained=false;
    const client = { fetch: vi.fn((range) => (async function* () {
      if (range==='1,2,3') { yield {uid:1}; drained=true; }
      else { expect(drained).toBe(true); yield {uid:2}; yield {uid:3}; }
    })()) };
    expect(await collect(fetchBackfillBatch(client,[1,2,3],query))).toEqual([1,2,3]);
    expect(client.fetch.mock.calls[1]).toEqual(['2,3',{uid:true,flags:true,envelope:true},{uid:true}]);
  });
  it('does not add another request for a complete metadata response', async () => {
    const client = { fetch: vi.fn(async function* () { yield {uid:1}; }) };
    expect(await collect(fetchBackfillBatch(client,[1],query))).toEqual([1]);
    expect(client.fetch).toHaveBeenCalledTimes(1);
  });
  it('never invents rows for unfetchable UIDs or accepts unrequested/duplicate responses', async () => {
    const client = { fetch: vi.fn(async function* () { yield {uid:1}; yield {uid:1}; yield {uid:99}; }) };
    expect(await collect(fetchBackfillBatch(client,[1,2],query))).toEqual([1]);
    expect(client.fetch).toHaveBeenCalledTimes(2);
  });
  it('propagates transport failure rather than declaring a partial batch complete', async () => {
    const client = { fetch: vi.fn(async function* () { yield {uid:1}; throw new Error('Disconnected'); }) };
    await expect(collect(fetchBackfillBatch(client,[1,2],query))).rejects.toThrow('Disconnected');
    expect(client.fetch).toHaveBeenCalledTimes(1);
  });
});

// ── v0.2 antispam ingest hook (shared by syncMessages and backfillMessages) ──

describe('maybeClassifyNewMessage — antispam ingest hook', () => {
  beforeEach(() => { classifyAndTagMessage.mockReset(); });

  it('does nothing for accounts with antispam disabled', () => {
    const mgr = new ImapManager(null);
    mgr.maybeClassifyNewMessage({ id: 'acct', antispam_enabled: false }, 'msg-1', { parsedHeaders: {} });
    expect(classifyAndTagMessage).not.toHaveBeenCalled();
  });

  it('hands the new message to the pipeline with headers and the imap facade', () => {
    const mgr = new ImapManager(null);
    classifyAndTagMessage.mockResolvedValue({ verdict: 'spam' });
    mgr.maybeClassifyNewMessage(
      { id: 'acct', antispam_enabled: true }, 'msg-1',
      { parsedHeaders: { 'authentication-results': 'mx.example.com; dkim=fail' } },
    );
    expect(classifyAndTagMessage).toHaveBeenCalledTimes(1);
    const [messageId, opts] = classifyAndTagMessage.mock.calls[0];
    expect(messageId).toBe('msg-1');
    expect(opts.headers).toEqual({ 'authentication-results': 'mx.example.com; dkim=fail' });
    expect(typeof opts.imap.moveMessage).toBe('function');
    expect(typeof opts.imap.broadcast).toBe('function');
    expect(typeof opts.imap._guardMoveUid).toBe('function');
    expect(typeof opts.imap._unguardMoveUid).toBe('function');
  });

  it('defaults to an empty header list when the parsed message has none', () => {
    const mgr = new ImapManager(null);
    classifyAndTagMessage.mockResolvedValue(null);
    mgr.maybeClassifyNewMessage({ id: 'acct', antispam_enabled: 1 }, 'msg-2', undefined);
    expect(classifyAndTagMessage).toHaveBeenCalledWith('msg-2', expect.objectContaining({ headers: [] }));
  });

  it('swallows pipeline failures — sync must never break on classification', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mgr = new ImapManager(null);
    classifyAndTagMessage.mockRejectedValue(new Error('boom'));
    expect(() => mgr.maybeClassifyNewMessage({ id: 'acct', antispam_enabled: true }, 'msg-3', {})).not.toThrow();
    await new Promise(r => setTimeout(r, 0));
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('does not defer the auto-move on normal ingest (the sync path)', () => {
    const mgr = new ImapManager(null);
    classifyAndTagMessage.mockResolvedValue({ verdict: 'spam' });
    mgr.maybeClassifyNewMessage({ id: 'acct', antispam_enabled: true }, 'msg-4', {});
    expect(classifyAndTagMessage.mock.calls[0][1].deferAutoMove).toBe(false);
  });

  it('forwards deferAutoMove for the backfill path', () => {
    const mgr = new ImapManager(null);
    classifyAndTagMessage.mockResolvedValue({ verdict: 'spam' });
    mgr.maybeClassifyNewMessage(
      { id: 'acct', antispam_enabled: true }, 'msg-5', {}, { deferAutoMove: true },
    );
    expect(classifyAndTagMessage.mock.calls[0][1].deferAutoMove).toBe(true);
  });

  it('serializes auto-moves per account — one in flight, the rest queued', async () => {
    const mgr = new ImapManager(null);
    let releaseFirst;
    const firstStarted = new Promise(resolve => { releaseFirst = resolve; });
    const started = [];
    const move = vi.spyOn(mgr, 'moveMessage').mockImplementation(async (_acct, uid) => {
      started.push(uid);
      if (uid === 1) await firstStarted;
      return uid + 1000;
    });
    classifyAndTagMessage.mockResolvedValue({ verdict: 'spam' });
    mgr.maybeClassifyNewMessage({ id: 'acct', antispam_enabled: true }, 'msg-6', {});
    mgr.maybeClassifyNewMessage({ id: 'acct', antispam_enabled: true }, 'msg-7', {});
    const facades = classifyAndTagMessage.mock.calls.map(call => call[1].imap);

    const p1 = facades[0].moveMessage({ id: 'acct' }, 1, 'INBOX', 'Junk');
    const p2 = facades[1].moveMessage({ id: 'acct' }, 2, 'INBOX', 'Junk');
    await new Promise(r => setTimeout(r, 0));
    // Only the first move reached the pool: the second is waiting for the slot, so a
    // burst of classified messages cannot fan out concurrent moves (and overflow logins).
    expect(started).toEqual([1]);

    releaseFirst();
    await expect(p1).resolves.toBe(1001);
    await expect(p2).resolves.toBe(1002);
    expect(started).toEqual([1, 2]);
    expect(mgr._autoMoveSem.activeCount('acct')).toBe(0);
    move.mockRestore();
  });

  it('releases the per-account slot after a failed move', async () => {
    const mgr = new ImapManager(null);
    const move = vi.spyOn(mgr, 'moveMessage')
      .mockRejectedValueOnce(new Error('IMAP down'))
      .mockResolvedValue(42);
    classifyAndTagMessage.mockResolvedValue({ verdict: 'spam' });
    mgr.maybeClassifyNewMessage({ id: 'acct', antispam_enabled: true }, 'msg-8', {});
    const { imap } = classifyAndTagMessage.mock.calls[0][1];

    await expect(imap.moveMessage({ id: 'acct' }, 1, 'INBOX', 'Junk')).rejects.toThrow('IMAP down');
    expect(mgr._autoMoveSem.activeCount('acct')).toBe(0);
    // A failed move must not wedge the account: the next one goes through.
    await expect(imap.moveMessage({ id: 'acct' }, 2, 'INBOX', 'Junk')).resolves.toBe(42);
    move.mockRestore();
  });
});

describe('computeThreadId subject fallback requires a shared correspondent (#468)', () => {
  const ACCOUNT = 'acct-1';
  const OWNER = 'me@example.com';

  // The fallback only runs for messages with no References and no In-Reply-To, so every
  // case here passes null for both.
  const noHeaders = [null, null];

  beforeEach(() => {
    query.mockReset();
    getAccountAddresses.mockReset();
    getAccountAddresses.mockResolvedValue([OWNER]);
  });

  it('does not merge two senders who only have the account owner in common', async () => {
    // The report: PayPal and an unrelated sender used the same subject, and MailFlow
    // threaded them together.
    query.mockResolvedValueOnce({
      rows: [{
        thread_id: 'paypal-thread',
        from_email: 'service@paypal.com',
        to_addresses: [{ email: OWNER }],
        cc_addresses: [],
      }],
    });

    const id = await computeThreadId(ACCOUNT, '<new@other.com>', ...noHeaders, 'Login attempt', {
      fromEmail: 'alerts@other.com',
      to: [{ email: OWNER }],
      cc: [],
      own: OWNER,
    });

    expect(id).toBe('<new@other.com>'); // its own message id: a new thread
  });

  it('still threads a reply from the other party, which is why the fallback exists', async () => {
    query.mockResolvedValueOnce({
      rows: [{
        thread_id: 'project-thread',
        from_email: 'anna@partner.com',
        to_addresses: [{ email: OWNER }],
        cc_addresses: [],
      }],
    });

    // Our own reply, sent to Anna, with the headers stripped by the client.
    const id = await computeThreadId(ACCOUNT, '<reply@example.com>', ...noHeaders, 'RE: Project update', {
      fromEmail: OWNER,
      to: [{ email: 'anna@partner.com' }],
      cc: [],
      own: OWNER,
    });

    expect(id).toBe('project-thread');
  });

  it('matches on a cc participant, not just from and to', async () => {
    query.mockResolvedValueOnce({
      rows: [{
        thread_id: 'cc-thread',
        from_email: 'anna@partner.com',
        to_addresses: [{ email: OWNER }],
        cc_addresses: [{ email: 'bob@partner.com' }],
      }],
    });

    const id = await computeThreadId(ACCOUNT, '<x@partner.com>', ...noHeaders, 'Quarterly numbers', {
      fromEmail: 'bob@partner.com',
      to: [{ email: OWNER }],
      cc: [],
      own: OWNER,
    });

    expect(id).toBe('cc-thread');
  });

  it('skips a non-matching candidate and joins a later one that does share a correspondent', async () => {
    query.mockResolvedValueOnce({
      rows: [
        { thread_id: 'stranger', from_email: 'noreply@bank.com', to_addresses: [{ email: OWNER }], cc_addresses: [] },
        { thread_id: 'real', from_email: 'anna@partner.com', to_addresses: [{ email: OWNER }], cc_addresses: [] },
      ],
    });

    const id = await computeThreadId(ACCOUNT, '<y@partner.com>', ...noHeaders, 'Status', {
      fromEmail: 'anna@partner.com',
      to: [{ email: OWNER }],
      cc: [],
      own: OWNER,
    });

    expect(id).toBe('real');
  });

  it('is case insensitive about addresses', async () => {
    query.mockResolvedValueOnce({
      rows: [{ thread_id: 't', from_email: 'Anna@Partner.com', to_addresses: [{ email: OWNER }], cc_addresses: [] }],
    });

    const id = await computeThreadId(ACCOUNT, '<z@partner.com>', ...noHeaders, 'Status', {
      fromEmail: 'anna@PARTNER.COM', to: [], cc: [], own: OWNER.toUpperCase(),
    });

    expect(id).toBe('t');
  });

  it('parses address columns that arrive as JSON strings', async () => {
    query.mockResolvedValueOnce({
      rows: [{
        thread_id: 'legacy',
        from_email: 'anna@partner.com',
        to_addresses: JSON.stringify([{ email: OWNER }]),
        cc_addresses: '[]',
      }],
    });

    const id = await computeThreadId(ACCOUNT, '<w@partner.com>', ...noHeaders, 'Status', {
      fromEmail: 'anna@partner.com', to: [], cc: [], own: OWNER,
    });

    expect(id).toBe('legacy');
  });

  it('starts a new thread when the message has no correspondent but the owner', async () => {
    // A message to nobody but the account itself cannot be matched on participants, so it
    // must not fall back to subject-only matching.
    const id = await computeThreadId(ACCOUNT, '<self@example.com>', ...noHeaders, 'Notes to self', {
      fromEmail: OWNER, to: [{ email: OWNER }], cc: [], own: OWNER,
    });

    expect(id).toBe('<self@example.com>');
    expect(query).not.toHaveBeenCalled(); // no point querying with nothing to match on
  });

  it('treats an alias as the account\'s own address, not a shared correspondent', async () => {
    // An alias is typically a shared address like support@, which is exactly where unrelated
    // automated mail lands. If it counted as a correspondent it would merge that mail back
    // together and reintroduce the bug for alias users.
    // A fresh account id, because the own-address lookup is memoized per account for five
    // minutes and the earlier cases already cached acct-1 without an alias.
    const ALIAS_ACCOUNT = 'acct-alias';
    getAccountAddresses.mockResolvedValue([OWNER, 'support@example.com']);
    query.mockResolvedValueOnce({
      rows: [{
        thread_id: 'paypal-thread',
        from_email: 'service@paypal.com',
        to_addresses: [{ email: 'support@example.com' }],
        cc_addresses: [],
      }],
    });

    const id = await computeThreadId(ALIAS_ACCOUNT, '<new@other.com>', ...noHeaders, 'Login attempt', {
      fromEmail: 'alerts@other.com',
      to: [{ email: 'support@example.com' }],
      cc: [],
      own: OWNER,
    });

    expect(id).toBe('<new@other.com>'); // a new thread, not paypal-thread
  });

  it('does not treat a shared recipient as a shared correspondent', async () => {
    // The hole in the first version of this fix. Both messages are addressed to the same
    // third party, here a forwarding address that is neither the account login nor an alias.
    // Two unrelated senders writing to it have it in common, which is not correspondence:
    // forwarded mail, catch-all domains, mailing lists and BCC all produce this.
    const FWD_ACCOUNT = 'acct-forwarded';
    getAccountAddresses.mockResolvedValue(['simanoom@gmail.com']);
    query.mockResolvedValueOnce({
      rows: [{
        thread_id: 'storage-alert-thread',
        from_email: 'alert-3385@lxisa.zub',
        to_addresses: [{ email: 'me@aol.com' }],
        cc_addresses: [],
      }],
    });

    const id = await computeThreadId(FWD_ACCOUNT, '<second@yxcoi.isj>', ...noHeaders, 'Action required: storage 100% full', {
      fromEmail: 'alert-6476@yxcoi.isj',
      to: [{ email: 'me@aol.com' }],
      cc: [],
      own: 'simanoom@gmail.com',
    });

    expect(id).toBe('<second@yxcoi.isj>'); // its own thread, not the first sender's
  });

  it('threads a reply because the other party sent one and received the other', async () => {
    const REPLY_ACCOUNT = 'acct-reply-direction';
    getAccountAddresses.mockResolvedValue([OWNER]);
    query.mockResolvedValueOnce({
      rows: [{
        thread_id: 'anna-thread',
        from_email: 'anna@partner.com',
        to_addresses: [{ email: OWNER }],
        cc_addresses: [],
      }],
    });

    // Our own reply to Anna, headers stripped: she is our recipient and their sender.
    const id = await computeThreadId(REPLY_ACCOUNT, '<mine@example.com>', ...noHeaders, 'RE: Status', {
      fromEmail: OWNER,
      to: [{ email: 'anna@partner.com' }],
      cc: [],
      own: OWNER,
    });

    expect(id).toBe('anna-thread');
  });

  it('never reaches the fallback when the message carries threading headers', async () => {
    query.mockResolvedValueOnce({ rows: [{ message_id: '<root@x.com>', thread_id: 'header-thread' }] });

    const id = await computeThreadId(ACCOUNT, '<reply@x.com>', '<root@x.com>', '<root@x.com>', 'Anything', {
      fromEmail: 'someone@nowhere.com', to: [], cc: [], own: OWNER,
    });

    expect(id).toBe('header-thread');
  });
});
