import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('imapflow', () => ({ ImapFlow: vi.fn() }));
vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./messageParser.js', () => ({ parseMessage: vi.fn(), buildSnippetFromHtml: vi.fn(), snippetFromBody: vi.fn(), decodeMimeWords: vi.fn(), detectBulkFromParsedHeaders: vi.fn(), parseRawHeaders: vi.fn() }));
vi.mock('../routes/oauth.js', () => ({ refreshMicrosoftToken: vi.fn() }));
vi.mock('./emailSanitizer.js', () => ({ sanitizeEmail: vi.fn() }));
vi.mock('./encryption.js', () => ({ decrypt: vi.fn() }));
vi.mock('./pushNotifications.js', () => ({ sendPushToUser: vi.fn() }));
vi.mock('../utils/redact.js', () => ({ redactEmail: vi.fn() }));
vi.mock('./hostValidation.js', () => ({ resolveForConnection: vi.fn() }));
vi.mock('./gtdTransitions.js', () => ({ runGtdTransitions: vi.fn(), threadKeysForMessageIds: vi.fn(), threadKeysInFolders: vi.fn() }));

import { providerProfile, makeClientCfg, gtdRelocateGuard, insertCopiedSibling, deleteMessageCopyRow, emitAfterDeferredCopySync, emitGtdSectionsRefreshOnDelete, emitGtdSectionsRefreshIfEnabled, selectGtdReevalIds, ensureMailbox, runGtdSyncTick, createKeyedSemaphore, isConnectionRefusal, connectCooldownMs, effectiveSyncIntervalMs, planModseqSync, connectStaggerFor } from './imapManager.js';
import { query } from './db.js';
import { invalidateGtdConfigCache } from './gtdConfig.js';
import { runGtdTransitions, threadKeysInFolders } from './gtdTransitions.js';

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

// ── gtdRelocateGuard — move-detector exemption ───────────────────────────────

describe('gtdRelocateGuard — GTD folder relocate exemption', () => {
  it('is a no-op when GTD is disabled (no designated folders)', () => {
    const guard = gtdRelocateGuard([], 5);
    expect(guard.clause).toBe('');
    expect(guard.params).toEqual([]);
  });

  it('binds the designated folders as a single array param', () => {
    const guard = gtdRelocateGuard(['Todo', 'Watch'], 5);
    expect(guard.params).toEqual([['Todo', 'Watch']]);
  });

  it('exempts both the target folder ($1) and the row current folder', () => {
    const { clause } = gtdRelocateGuard(['Todo'], 5);
    // Target folder being synced ($1) must not be relocated INTO a GTD folder…
    expect(clause).toContain('$1 <> ALL($5::text[])');
    // …and a row already living in a GTD folder must not be relocated OUT of it.
    expect(clause).toContain('folder <> ALL($5::text[])');
  });

  it('uses the supplied positional bind index', () => {
    const { clause } = gtdRelocateGuard(['Todo'], 7);
    expect(clause).toContain('$7::text[]');
    expect(clause).not.toContain('$5');
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

// ── copyMessage non-UIDPLUS carry-over — emitAfterDeferredCopySync ────────────
// On a non-UIDPLUS COPY the destination sibling row is deferred to syncFolderOnDemand,
// so the early gtd_sections_updated emit can leave GTD section data stale until the sync lands.
// This follow-up emit fires once the deferred sync resolves so the data converges.

describe('emitAfterDeferredCopySync', () => {
  beforeEach(() => { query.mockReset(); runGtdTransitions.mockReset(); });

  it('re-emits gtd_sections_updated after the deferred destination sync resolves', async () => {
    const mgr = { syncFolderOnDemand: vi.fn().mockResolvedValue(undefined), broadcast: vi.fn() };
    const account = { id: 'acct-1', user_id: 'user-1' }; // gtd_enabled falsy → no transition re-run
    await emitAfterDeferredCopySync(mgr, account, 'Todo', 100, 'INBOX');
    expect(mgr.syncFolderOnDemand).toHaveBeenCalledWith(account, 'Todo');
    expect(mgr.broadcast).toHaveBeenCalledWith({ type: 'gtd_sections_updated', accountId: 'acct-1' }, 'user-1');
    expect(runGtdTransitions).not.toHaveBeenCalled();
  });

  it('does not emit when the deferred sync fails', async () => {
    const mgr = { syncFolderOnDemand: vi.fn().mockRejectedValue(new Error('sync boom')), broadcast: vi.fn() };
    const account = { id: 'acct-1', user_id: 'user-1' };
    await emitAfterDeferredCopySync(mgr, account, 'Todo', 100, 'INBOX');
    expect(mgr.broadcast).not.toHaveBeenCalled();
    expect(runGtdTransitions).not.toHaveBeenCalled();
  });

  it('re-runs the transition engine over the copied message thread once the sibling syncs', async () => {
    const mgr = { syncFolderOnDemand: vi.fn().mockResolvedValue(undefined), broadcast: vi.fn() };
    const account = { id: 'acct-1', user_id: 'user-1', gtd_enabled: true };
    query.mockResolvedValueOnce({ rows: [{ thread_key: 'thr-9' }] }); // thread_key lookup
    await emitAfterDeferredCopySync(mgr, account, 'Todo', 100, 'INBOX');
    // thread_key resolved from the source (account, uid, fromFolder), then engine re-run.
    expect(query.mock.calls[0][1]).toEqual(['acct-1', 100, 'INBOX']);
    expect(runGtdTransitions).toHaveBeenCalledWith(mgr, account, ['thr-9']);
  });

  it('swallows a transition re-run failure after still emitting', async () => {
    const mgr = { syncFolderOnDemand: vi.fn().mockResolvedValue(undefined), broadcast: vi.fn() };
    const account = { id: 'acct-1', user_id: 'user-1', gtd_enabled: true };
    query.mockRejectedValueOnce(new Error('db boom'));
    await emitAfterDeferredCopySync(mgr, account, 'Todo', 100, 'INBOX');
    expect(mgr.broadcast).toHaveBeenCalled(); // emit still happened
    expect(runGtdTransitions).not.toHaveBeenCalled();
  });
});

// ── selectGtdReevalIds — INBOX GTD candidate selection ───────────────────────
// The GTD re-eval hook feeds off the id of every newly-inserted INBOX row (read or unread),
// minus only the rows the block-list / inbox rules genuinely DELETED. A rule-MOVED reply is
// kept (its thread still needs re-evaluating). The unread-gated `newMessages` list cannot be
// reused, so this selection is extracted and pinned here.

describe('selectGtdReevalIds', () => {
  it('includes an already-read is_new arrival (read state is not a gate)', () => {
    // A reply that arrived already \Seen (read on another device) never enters the unread
    // notification list, but must still reach the engine to clear Watch/Delegated.
    expect(selectGtdReevalIds(['read-reply'], [])).toEqual(['read-reply']);
  });

  it('excludes a genuinely-deleted candidate but keeps a rule-MOVED one', () => {
    // 'deleted' was expunged/dropped by a rule → exclude it. 'moved' was refiled by a rule
    // (its row still lives in another folder) → keep it, so its thread is re-evaluated and a
    // self-reply's Watch/Delegated label still clears. 'stayed' never left INBOX.
    const ids = ['deleted', 'moved', 'stayed'];
    expect(selectGtdReevalIds(ids, ['deleted'])).toEqual(['moved', 'stayed']);
  });

  it('accepts the deleted ids as a Set and returns [] when all candidates were deleted', () => {
    expect(selectGtdReevalIds(['a', 'b'], new Set(['a', 'b']))).toEqual([]);
  });

  it('returns [] for an empty candidate list', () => {
    expect(selectGtdReevalIds([], ['x'])).toEqual([]);
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

// ── emitGtdSectionsRefreshOnDelete — ordinary-sync delete refresh gate ────────
// An ordinary sync that deletes rows the server no longer has (reconcile orphan-removal,
// UIDVALIDITY purge) can drop a GTD thread's INBOX/label copy without any GTD tick firing,
// leaving GTD section data stale until the next tick or a user action. This helper fires ONE
// gtd_sections_updated for the account, gated cheaply on gtd_enabled + deletions>0 with no
// per-row EXISTS on the hot path. getGtdConfig is the real cached implementation here (only db
// is mocked), so the gate is exercised end-to-end; unique account ids + cache invalidation keep
// the 5-min config cache from leaking across cases.

describe('emitGtdSectionsRefreshOnDelete', () => {
  beforeEach(() => {
    query.mockReset();
    ['acct-del-on', 'acct-del-off', 'acct-del-zero', 'acct-del-err'].forEach(invalidateGtdConfigCache);
  });

  it('fires exactly one gtd_sections_updated for a gtd-enabled account with a delete batch', async () => {
    query.mockResolvedValueOnce({ rows: [{ gtd_enabled: true, gtd_folders: {} }] }); // getGtdConfig lookup
    const mgr = { broadcast: vi.fn() };
    const account = { id: 'acct-del-on', user_id: 'user-1' };
    await emitGtdSectionsRefreshOnDelete(mgr, account, 4);
    expect(mgr.broadcast).toHaveBeenCalledTimes(1);
    expect(mgr.broadcast).toHaveBeenCalledWith({ type: 'gtd_sections_updated', accountId: 'acct-del-on' }, 'user-1');
  });

  it('does not emit for a gtd-disabled account even when rows were deleted', async () => {
    query.mockResolvedValueOnce({ rows: [{ gtd_enabled: false, gtd_folders: {} }] }); // getGtdConfig lookup
    const mgr = { broadcast: vi.fn() };
    const account = { id: 'acct-del-off', user_id: 'user-1' };
    await emitGtdSectionsRefreshOnDelete(mgr, account, 4);
    expect(mgr.broadcast).not.toHaveBeenCalled();
  });

  it('does not emit — and never reads the config — when zero rows were deleted', async () => {
    const mgr = { broadcast: vi.fn() };
    const account = { id: 'acct-del-zero', user_id: 'user-1' };
    await emitGtdSectionsRefreshOnDelete(mgr, account, 0);
    expect(mgr.broadcast).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled(); // short-circuits before the cached getGtdConfig — stays off the hot path
  });

  it('swallows a config-lookup failure without emitting or throwing (never disturbs sync)', async () => {
    query.mockRejectedValueOnce(new Error('db boom')); // getGtdConfig throws
    const mgr = { broadcast: vi.fn() };
    const account = { id: 'acct-del-err', user_id: 'user-1' };
    await expect(emitGtdSectionsRefreshOnDelete(mgr, account, 2)).resolves.toBeUndefined();
    expect(mgr.broadcast).not.toHaveBeenCalled();
  });
});

// ── emitGtdSectionsRefreshIfEnabled — backfill (insert) refresh gate ──────────
// The name insert-triggered (backfill) call sites import. Same cheap gate as the
// delete-triggered alias, exercised with a backfill-shaped changedCount: emit once only
// when GTD is enabled AND rows changed.
describe('emitGtdSectionsRefreshIfEnabled', () => {
  beforeEach(() => {
    query.mockReset();
    ['acct-bf-on', 'acct-bf-off', 'acct-bf-zero'].forEach(invalidateGtdConfigCache);
  });

  it('is the exact function the delete-named alias delegates to', () => {
    expect(emitGtdSectionsRefreshOnDelete).toBe(emitGtdSectionsRefreshIfEnabled);
  });

  it('fires one gtd_sections_updated when a backfill wrote rows for a gtd-enabled account', async () => {
    query.mockResolvedValueOnce({ rows: [{ gtd_enabled: true, gtd_folders: {} }] });
    const mgr = { broadcast: vi.fn() };
    await emitGtdSectionsRefreshIfEnabled(mgr, { id: 'acct-bf-on', user_id: 'user-1' }, 12);
    expect(mgr.broadcast).toHaveBeenCalledTimes(1);
    expect(mgr.broadcast).toHaveBeenCalledWith({ type: 'gtd_sections_updated', accountId: 'acct-bf-on' }, 'user-1');
  });

  it('does not emit for a gtd-disabled account even when rows were backfilled', async () => {
    query.mockResolvedValueOnce({ rows: [{ gtd_enabled: false, gtd_folders: {} }] });
    const mgr = { broadcast: vi.fn() };
    await emitGtdSectionsRefreshIfEnabled(mgr, { id: 'acct-bf-off', user_id: 'user-1' }, 12);
    expect(mgr.broadcast).not.toHaveBeenCalled();
  });

  it('does not emit — and never reads the config — when a backfill changed nothing', async () => {
    const mgr = { broadcast: vi.fn() };
    await emitGtdSectionsRefreshIfEnabled(mgr, { id: 'acct-bf-zero', user_id: 'user-1' }, 0);
    expect(mgr.broadcast).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });
});

// ── runGtdSyncTick — periodic GTD label-folder tick body ────────────────────
// Extracted out of the class so the config-fetch → per-folder fingerprint/sync →
// transitions/broadcast sequencing is unit-testable with a mock manager instead of a live
// IMAP pool. The whole body is wrapped in a try/catch (mirrors _syncTick), so a config-fetch
// DB blip must be logged with account context and never escape as an unhandled rejection.
// getGtdConfig is the real cached implementation here (only db is mocked); unique account
// ids + cache invalidation keep the 5-min config cache from leaking across cases.

describe('runGtdSyncTick', () => {
  const mgrWithConnection = (accountId, overrides = {}) => ({
    connections: new Map([[accountId, {}]]),
    onDemandSyncing: new Set(),
    _gtdFolderFingerprint: vi.fn(),
    _gtdSyncFolder: vi.fn().mockResolvedValue(undefined),
    broadcast: vi.fn(),
    ...overrides,
  });

  beforeEach(() => {
    query.mockReset();
    runGtdTransitions.mockReset();
    threadKeysInFolders.mockReset();
    [
      'acct-tick-noconn', 'acct-tick-err', 'acct-tick-off',
      'acct-tick-same', 'acct-tick-changed', 'acct-tick-partial',
    ].forEach(invalidateGtdConfigCache);
  });

  it('skips entirely — no config read, no sync — when the account has no live connection', async () => {
    const mgr = { connections: new Map(), onDemandSyncing: new Set(), _gtdFolderFingerprint: vi.fn(), _gtdSyncFolder: vi.fn(), broadcast: vi.fn() };
    const account = { id: 'acct-tick-noconn', user_id: 'user-1' };
    await runGtdSyncTick(mgr, account);
    expect(query).not.toHaveBeenCalled();
    expect(mgr.broadcast).not.toHaveBeenCalled();
  });

  it('logs and swallows a config-fetch rejection instead of letting it escape as an unhandled rejection', async () => {
    query.mockRejectedValueOnce(new Error('db boom')); // getGtdConfig lookup throws
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mgr = mgrWithConnection('acct-tick-err');
    const account = { id: 'acct-tick-err', user_id: 'user-1' };
    await expect(runGtdSyncTick(mgr, account)).resolves.toBeUndefined();
    expect(mgr.broadcast).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('GTD tick error'), 'db boom');
    warnSpy.mockRestore();
  });

  it('is inert — no folder sync, no broadcast — when GTD is disabled for the account', async () => {
    query.mockResolvedValueOnce({ rows: [{ gtd_enabled: false, gtd_folders: {} }] });
    const mgr = mgrWithConnection('acct-tick-off');
    const account = { id: 'acct-tick-off', user_id: 'user-1' };
    await runGtdSyncTick(mgr, account);
    expect(mgr._gtdSyncFolder).not.toHaveBeenCalled();
    expect(mgr.broadcast).not.toHaveBeenCalled();
  });

  it('does not broadcast or re-run transitions when the folder fingerprint is unchanged', async () => {
    const allTodo = { todo: 'Todo', watch: 'Todo', delegated: 'Todo', someday: 'Todo', reference: 'Todo' };
    query.mockResolvedValueOnce({ rows: [{ gtd_enabled: true, gtd_folders: allTodo }] });
    const mgr = mgrWithConnection('acct-tick-same', {
      _gtdFolderFingerprint: vi.fn().mockResolvedValue('3:1:60:30'), // same before/after
    });
    const account = { id: 'acct-tick-same', user_id: 'user-1' };
    await runGtdSyncTick(mgr, account);
    expect(mgr._gtdSyncFolder).toHaveBeenCalledWith(account, 'Todo');
    expect(mgr.broadcast).not.toHaveBeenCalled();
    expect(runGtdTransitions).not.toHaveBeenCalled();
  });

  it('broadcasts gtd_sections_updated and re-runs transitions when a folder fingerprint changes', async () => {
    const allTodo = { todo: 'Todo', watch: 'Todo', delegated: 'Todo', someday: 'Todo', reference: 'Todo' };
    query.mockResolvedValueOnce({ rows: [{ gtd_enabled: true, gtd_folders: allTodo }] });
    threadKeysInFolders.mockResolvedValueOnce(['thr-1', 'thr-2']);
    const mgr = mgrWithConnection('acct-tick-changed', {
      _gtdFolderFingerprint: vi.fn()
        .mockResolvedValueOnce('3:1:60:30')  // before
        .mockResolvedValueOnce('4:1:90:40'), // after — changed
    });
    const account = { id: 'acct-tick-changed', user_id: 'user-1' };
    await runGtdSyncTick(mgr, account);
    expect(threadKeysInFolders).toHaveBeenCalledWith('acct-tick-changed', ['Todo']);
    expect(runGtdTransitions).toHaveBeenCalledWith(mgr, account, ['thr-1', 'thr-2']);
    expect(mgr.broadcast).toHaveBeenCalledTimes(1);
    expect(mgr.broadcast).toHaveBeenCalledWith({ type: 'gtd_sections_updated', accountId: 'acct-tick-changed' }, 'user-1');
  });

  it('keeps processing remaining folders when one folder sync throws', async () => {
    // todo/delegated/reference -> Todo, watch/someday -> Watch: two distinct designated folders.
    const twoFolders = { todo: 'Todo', watch: 'Watch', delegated: 'Todo', someday: 'Watch', reference: 'Todo' };
    query.mockResolvedValueOnce({ rows: [{ gtd_enabled: true, gtd_folders: twoFolders }] });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mgr = mgrWithConnection('acct-tick-partial', {
      _gtdFolderFingerprint: vi.fn().mockResolvedValue('1:0:10:10'), // unchanged for the folder that completes
      _gtdSyncFolder: vi.fn()
        .mockRejectedValueOnce(new Error('imap boom')) // first designated folder fails
        .mockResolvedValueOnce(undefined),              // second designated folder still runs
    });
    const account = { id: 'acct-tick-partial', user_id: 'user-1' };
    await runGtdSyncTick(mgr, account);
    expect(mgr._gtdSyncFolder).toHaveBeenCalledTimes(2);
    expect(mgr._gtdSyncFolder).toHaveBeenNthCalledWith(1, account, 'Todo');
    expect(mgr._gtdSyncFolder).toHaveBeenNthCalledWith(2, account, 'Watch');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('GTD sync error'), 'imap boom');
    warnSpy.mockRestore();
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
