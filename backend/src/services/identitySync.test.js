import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock('./encryption.js', () => ({ decrypt: vi.fn(v => v) }));
vi.mock('./jmapClient.js', () => ({
  loadJmapSession: vi.fn(),
  fetchIdentities: vi.fn(),
  fetchMaskedEmails: vi.fn(),
  sessionHasMaskedEmail: vi.fn(),
}));
vi.mock('./connectionPolicy.js', () => ({
  getConnectionPolicy: vi.fn().mockResolvedValue({ allowPrivateHosts: false, allowInsecureTls: false, allowNonstandardPorts: false }),
}));

const { query, withTransaction } = await import('./db.js');
const { decrypt } = await import('./encryption.js');
const { loadJmapSession, fetchIdentities, fetchMaskedEmails, sessionHasMaskedEmail } = await import('./jmapClient.js');
const { getConnectionPolicy } = await import('./connectionPolicy.js');
const { syncAccountIdentities } = await import('./identitySync.js');

const ACCOUNT_ID = 'acct-1';

// withTransaction's real implementation begins/commits/rolls back around fn(client); the
// mock just needs to hand back a client whose query calls the tests can inspect.
function fakeClient() {
  const calls = [];
  const client = { query: vi.fn(async (sql, params) => { calls.push([sql, params]); return { rows: [] }; }) };
  return { client, calls };
}

// Upserts/deletes are shared across both kinds now (identity + masked reconcile in one
// transaction), so tests select by kind (params[1]) rather than assuming there's only one.
function upsertsFor(calls, kind) {
  return calls.filter(([sql, params]) => sql.includes('ON CONFLICT') && params[1] === kind);
}
function deleteFor(calls, kind) {
  return calls.find(([sql, params]) => sql.trim().startsWith('DELETE') && params[1] === kind);
}

beforeEach(() => {
  query.mockReset();
  withTransaction.mockReset();
  decrypt.mockReset().mockImplementation(v => v);
  loadJmapSession.mockReset();
  fetchIdentities.mockReset();
  getConnectionPolicy.mockReset().mockResolvedValue({ allowPrivateHosts: false, allowInsecureTls: false, allowNonstandardPorts: false });
  fetchMaskedEmails.mockReset();
  // Most tests are about identity reconciliation; default the capability off so they don't
  // also have to stub a masked-email fetch.
  sessionHasMaskedEmail.mockReset().mockReturnValue(false);
});

describe('syncAccountIdentities — no-op cases', () => {
  it('is a no-op when the account does not exist', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    const result = await syncAccountIdentities(ACCOUNT_ID);

    expect(result).toEqual({ syncedAt: null });
    expect(loadJmapSession).not.toHaveBeenCalled();
  });

  it('is a no-op when no session URL is configured', async () => {
    query.mockResolvedValueOnce({ rows: [{ jmap_session_url: null, jmap_api_token: 'enc:token' }] });

    const result = await syncAccountIdentities(ACCOUNT_ID);

    expect(result).toEqual({ syncedAt: null });
    expect(loadJmapSession).not.toHaveBeenCalled();
  });

  it('is a no-op when no token is configured (decrypt returns falsy)', async () => {
    query.mockResolvedValueOnce({ rows: [{ jmap_session_url: 'https://mail.example.com/jmap', jmap_api_token: null }] });
    decrypt.mockReturnValue(null);

    const result = await syncAccountIdentities(ACCOUNT_ID);

    expect(result).toEqual({ syncedAt: null });
    expect(loadJmapSession).not.toHaveBeenCalled();
  });
});

describe('syncAccountIdentities — connection policy', () => {
  const accountRow = { jmap_session_url: 'https://mail.example.com/jmap', jmap_api_token: 'enc:token' };

  it('threads the connection policy\'s allowPrivateHosts through to loadJmapSession and fetchIdentities', async () => {
    query.mockResolvedValueOnce({ rows: [accountRow] }).mockResolvedValueOnce({ rows: [] });
    getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: true, allowInsecureTls: false, allowNonstandardPorts: false });
    loadJmapSession.mockResolvedValue({ sessionUrl: accountRow.jmap_session_url });
    fetchIdentities.mockResolvedValue([]);
    const { client } = fakeClient();
    withTransaction.mockImplementation(async fn => fn(client));

    await syncAccountIdentities(ACCOUNT_ID);

    expect(loadJmapSession).toHaveBeenCalledWith(accountRow.jmap_session_url, 'enc:token', { allowPrivate: true });
    expect(fetchIdentities).toHaveBeenCalledWith({ sessionUrl: accountRow.jmap_session_url }, 'enc:token', { allowPrivate: true });
  });
});

describe('syncAccountIdentities — identity reconciliation', () => {
  const accountRow = { jmap_session_url: 'https://mail.example.com/jmap', jmap_api_token: 'enc:token' };

  it('adds new identities, updates changed ones by provider_id, and removes disappeared ones', async () => {
    query
      .mockResolvedValueOnce({ rows: [accountRow] }) // account load
      .mockResolvedValueOnce({ rows: [] });          // final UPDATE ...sync_at
    loadJmapSession.mockResolvedValue({ sessionUrl: accountRow.jmap_session_url });
    fetchIdentities.mockResolvedValue([
      { id: 'id-1', name: 'Sales', email: 'sales@example.com', replyTo: null },
      { id: 'id-2', name: 'Support', email: 'support@example.com', replyTo: [{ name: 'Help', email: 'help@example.com' }] },
    ]);
    const { client, calls } = fakeClient();
    withTransaction.mockImplementation(async fn => fn(client));

    const result = await syncAccountIdentities(ACCOUNT_ID);

    expect(result.syncedAt).toBeInstanceOf(Date);
    const upserts = upsertsFor(calls, 'identity');
    expect(upserts).toHaveLength(2);
    expect(upserts[0][1]).toEqual([ACCOUNT_ID, 'identity', 'id-1', 'sales@example.com', 'Sales', '[]']);
    expect(upserts[1][1]).toEqual([ACCOUNT_ID, 'identity', 'id-2', 'support@example.com', 'Support', JSON.stringify([{ name: 'Help', email: 'help@example.com' }])]);
    // The delete keeps exactly the provider_ids still present.
    expect(deleteFor(calls, 'identity')[1]).toEqual([ACCOUNT_ID, 'identity', ['id-1', 'id-2']]);

    const syncUpdate = query.mock.calls.find(c => /jmap_identity_sync_at/.test(c[0]));
    expect(syncUpdate[1][1]).toBe(ACCOUNT_ID);
  });

  it('stores a wildcard (*@domain) identity address unchanged', async () => {
    query.mockResolvedValueOnce({ rows: [accountRow] }).mockResolvedValueOnce({ rows: [] });
    loadJmapSession.mockResolvedValue({});
    fetchIdentities.mockResolvedValue([
      { id: 'id-wild', name: 'Catch-all', email: '*@example.com', replyTo: null },
    ]);
    const { client, calls } = fakeClient();
    withTransaction.mockImplementation(async fn => fn(client));

    await syncAccountIdentities(ACCOUNT_ID);

    expect(upsertsFor(calls, 'identity')[0][1]).toEqual([ACCOUNT_ID, 'identity', 'id-wild', '*@example.com', 'Catch-all', '[]']);
  });

  it('skips an identity whose display name contains header control characters', async () => {
    query.mockResolvedValueOnce({ rows: [accountRow] }).mockResolvedValueOnce({ rows: [] });
    loadJmapSession.mockResolvedValue({});
    fetchIdentities.mockResolvedValue([
      { id: 'id-bad', name: 'Evil\r\nBcc: attacker@evil.example', email: 'ok@example.com', replyTo: null },
      { id: 'id-good', name: 'Fine', email: 'fine@example.com', replyTo: null },
    ]);
    const { client, calls } = fakeClient();
    withTransaction.mockImplementation(async fn => fn(client));

    await syncAccountIdentities(ACCOUNT_ID);

    const upserts = upsertsFor(calls, 'identity');
    expect(upserts).toHaveLength(1);
    expect(upserts[0][1][2]).toBe('id-good');
  });

  it('skips an identity with an unusable email address', async () => {
    query.mockResolvedValueOnce({ rows: [accountRow] }).mockResolvedValueOnce({ rows: [] });
    loadJmapSession.mockResolvedValue({});
    fetchIdentities.mockResolvedValue([
      { id: 'id-bad', name: 'Broken', email: 'not-an-email', replyTo: null },
    ]);
    const { client, calls } = fakeClient();
    withTransaction.mockImplementation(async fn => fn(client));

    await syncAccountIdentities(ACCOUNT_ID);

    expect(upsertsFor(calls, 'identity')).toHaveLength(0);
    // Nothing survives -> the delete-stale clause runs with an empty keep-list, wiping all identity rows.
    expect(deleteFor(calls, 'identity')[1]).toEqual([ACCOUNT_ID, 'identity', []]);
  });

  it('drops a reply-to entry with an unusable address but keeps the identity', async () => {
    query.mockResolvedValueOnce({ rows: [accountRow] }).mockResolvedValueOnce({ rows: [] });
    loadJmapSession.mockResolvedValue({});
    fetchIdentities.mockResolvedValue([
      { id: 'id-1', name: 'Sales', email: 'sales@example.com', replyTo: [{ name: 'Bad', email: 'not-an-email' }, { email: 'good@example.com' }] },
    ]);
    const { client, calls } = fakeClient();
    withTransaction.mockImplementation(async fn => fn(client));

    await syncAccountIdentities(ACCOUNT_ID);

    expect(JSON.parse(upsertsFor(calls, 'identity')[0][1][5])).toEqual([{ email: 'good@example.com' }]);
  });
});

describe('syncAccountIdentities — Masked Email reconciliation (optional capability)', () => {
  const accountRow = { jmap_session_url: 'https://mail.example.com/jmap', jmap_api_token: 'enc:token' };

  beforeEach(() => {
    fetchIdentities.mockResolvedValue([]);
  });

  it('does not call fetchMaskedEmails at all when the capability is absent', async () => {
    query.mockResolvedValueOnce({ rows: [accountRow] }).mockResolvedValueOnce({ rows: [] });
    loadJmapSession.mockResolvedValue({});
    sessionHasMaskedEmail.mockReturnValue(false);
    const { client, calls } = fakeClient();
    withTransaction.mockImplementation(async fn => fn(client));

    await syncAccountIdentities(ACCOUNT_ID);

    expect(fetchMaskedEmails).not.toHaveBeenCalled();
    // Still reconciles the masked kind to empty — see the "capability disappeared" test below.
    expect(deleteFor(calls, 'masked')[1]).toEqual([ACCOUNT_ID, 'masked', []]);
  });

  it('syncs enabled masked-email addresses when the capability is present', async () => {
    query.mockResolvedValueOnce({ rows: [accountRow] }).mockResolvedValueOnce({ rows: [] });
    loadJmapSession.mockResolvedValue({});
    sessionHasMaskedEmail.mockReturnValue(true);
    fetchMaskedEmails.mockResolvedValue([
      { id: 'mask-1', email: 'random1@fastmail.example', state: 'enabled', description: 'Private address', forDomain: 'example.com' },
    ]);
    const { client, calls } = fakeClient();
    withTransaction.mockImplementation(async fn => fn(client));

    await syncAccountIdentities(ACCOUNT_ID);

    const upserts = upsertsFor(calls, 'masked');
    expect(upserts).toHaveLength(1);
    expect(upserts[0][1]).toEqual([ACCOUNT_ID, 'masked', 'mask-1', 'random1@fastmail.example', 'Private address', '[]']);
  });

  it('falls back to forDomain for the name when description is blank', async () => {
    query.mockResolvedValueOnce({ rows: [accountRow] }).mockResolvedValueOnce({ rows: [] });
    loadJmapSession.mockResolvedValue({});
    sessionHasMaskedEmail.mockReturnValue(true);
    fetchMaskedEmails.mockResolvedValue([
      { id: 'mask-1', email: 'random1@fastmail.example', state: 'enabled', description: '', forDomain: 'example.com' },
    ]);
    const { client, calls } = fakeClient();
    withTransaction.mockImplementation(async fn => fn(client));

    await syncAccountIdentities(ACCOUNT_ID);

    expect(upsertsFor(calls, 'masked')[0][1][4]).toBe('example.com');
  });

  it.each(['pending', 'disabled', 'deleted'])('excludes a %s mask (only enabled masks are usable)', async (state) => {
    query.mockResolvedValueOnce({ rows: [accountRow] }).mockResolvedValueOnce({ rows: [] });
    loadJmapSession.mockResolvedValue({});
    sessionHasMaskedEmail.mockReturnValue(true);
    fetchMaskedEmails.mockResolvedValue([
      { id: 'mask-1', email: 'random1@fastmail.example', state, description: 'Private address' },
    ]);
    const { client, calls } = fakeClient();
    withTransaction.mockImplementation(async fn => fn(client));

    await syncAccountIdentities(ACCOUNT_ID);

    expect(upsertsFor(calls, 'masked')).toHaveLength(0);
  });

  it('updates an existing mask and removes one that disappeared, by provider_id', async () => {
    query.mockResolvedValueOnce({ rows: [accountRow] }).mockResolvedValueOnce({ rows: [] });
    loadJmapSession.mockResolvedValue({});
    sessionHasMaskedEmail.mockReturnValue(true);
    fetchMaskedEmails.mockResolvedValue([
      { id: 'mask-1', email: 'random1@fastmail.example', state: 'enabled', description: 'Renamed label' },
    ]);
    const { client, calls } = fakeClient();
    withTransaction.mockImplementation(async fn => fn(client));

    await syncAccountIdentities(ACCOUNT_ID);

    expect(upsertsFor(calls, 'masked')[0][1][4]).toBe('Renamed label');
    expect(deleteFor(calls, 'masked')[1]).toEqual([ACCOUNT_ID, 'masked', ['mask-1']]);
  });

  it('wipes all masked rows (but leaves identity rows untouched) when the capability disappears', async () => {
    query.mockResolvedValueOnce({ rows: [accountRow] }).mockResolvedValueOnce({ rows: [] });
    loadJmapSession.mockResolvedValue({});
    fetchIdentities.mockResolvedValue([{ id: 'id-1', name: 'Sales', email: 'sales@example.com', replyTo: null }]);
    sessionHasMaskedEmail.mockReturnValue(false);
    const { client, calls } = fakeClient();
    withTransaction.mockImplementation(async fn => fn(client));

    await syncAccountIdentities(ACCOUNT_ID);

    expect(fetchMaskedEmails).not.toHaveBeenCalled();
    expect(deleteFor(calls, 'masked')[1]).toEqual([ACCOUNT_ID, 'masked', []]);
    // Identity reconciliation is unaffected by the masked-capability check.
    expect(upsertsFor(calls, 'identity')).toHaveLength(1);
  });

  it('rejects a masked email with an unusable address', async () => {
    query.mockResolvedValueOnce({ rows: [accountRow] }).mockResolvedValueOnce({ rows: [] });
    loadJmapSession.mockResolvedValue({});
    sessionHasMaskedEmail.mockReturnValue(true);
    fetchMaskedEmails.mockResolvedValue([
      { id: 'mask-1', email: 'not-an-email', state: 'enabled', description: 'Bad' },
    ]);
    const { client, calls } = fakeClient();
    withTransaction.mockImplementation(async fn => fn(client));

    await syncAccountIdentities(ACCOUNT_ID);

    expect(upsertsFor(calls, 'masked')).toHaveLength(0);
  });

  it('rejects a masked email whose description contains header control characters', async () => {
    query.mockResolvedValueOnce({ rows: [accountRow] }).mockResolvedValueOnce({ rows: [] });
    loadJmapSession.mockResolvedValue({});
    sessionHasMaskedEmail.mockReturnValue(true);
    fetchMaskedEmails.mockResolvedValue([
      { id: 'mask-1', email: 'random1@fastmail.example', state: 'enabled', description: 'Evil\r\nBcc: attacker@evil.example' },
    ]);
    const { client, calls } = fakeClient();
    withTransaction.mockImplementation(async fn => fn(client));

    await syncAccountIdentities(ACCOUNT_ID);

    expect(upsertsFor(calls, 'masked')).toHaveLength(0);
  });

  it('lets an identity and a masked address share the same provider_id without conflict (unique per kind)', async () => {
    query.mockResolvedValueOnce({ rows: [accountRow] }).mockResolvedValueOnce({ rows: [] });
    loadJmapSession.mockResolvedValue({});
    fetchIdentities.mockResolvedValue([{ id: 'shared-id', name: 'Sales', email: 'sales@example.com', replyTo: null }]);
    sessionHasMaskedEmail.mockReturnValue(true);
    fetchMaskedEmails.mockResolvedValue([
      { id: 'shared-id', email: 'random1@fastmail.example', state: 'enabled', description: 'Private address' },
    ]);
    const { client, calls } = fakeClient();
    withTransaction.mockImplementation(async fn => fn(client));

    await syncAccountIdentities(ACCOUNT_ID);

    expect(upsertsFor(calls, 'identity')).toHaveLength(1);
    expect(upsertsFor(calls, 'masked')).toHaveLength(1);
  });
});

describe('syncAccountIdentities — error recording', () => {
  const accountRow = { jmap_session_url: 'https://mail.example.com/jmap', jmap_api_token: 'enc:token' };

  it('records a JMAP_CONFIG error message and rethrows', async () => {
    query.mockResolvedValueOnce({ rows: [accountRow] }).mockResolvedValueOnce({ rows: [] });
    loadJmapSession.mockRejectedValue(Object.assign(new Error('bad token'), { code: 'JMAP_CONFIG', status: 422 }));

    await expect(syncAccountIdentities(ACCOUNT_ID)).rejects.toMatchObject({ code: 'JMAP_CONFIG' });

    const errorUpdate = query.mock.calls.find(c => /jmap_identity_sync_error/.test(c[0]));
    expect(errorUpdate[1]).toEqual(['bad token', ACCOUNT_ID]);
  });

  it('records a generic safe message for an unexpected error (never leaks internals)', async () => {
    query.mockResolvedValueOnce({ rows: [accountRow] }).mockResolvedValueOnce({ rows: [] });
    loadJmapSession.mockRejectedValue(new Error('ECONNRESET: some internal socket detail'));

    await expect(syncAccountIdentities(ACCOUNT_ID)).rejects.toThrow();

    const errorUpdate = query.mock.calls.find(c => /jmap_identity_sync_error/.test(c[0]));
    expect(errorUpdate[1]).toEqual(['JMAP synchronization failed', ACCOUNT_ID]);
  });

  it('does not touch jmap_identity_sync_at on failure (only sync_error)', async () => {
    query.mockResolvedValueOnce({ rows: [accountRow] }).mockResolvedValueOnce({ rows: [] });
    loadJmapSession.mockRejectedValue(Object.assign(new Error('timeout'), { code: 'JMAP_SYNC' }));

    await expect(syncAccountIdentities(ACCOUNT_ID)).rejects.toBeTruthy();

    const calls = query.mock.calls.filter(c => c[0].includes('UPDATE email_accounts'));
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).not.toContain('jmap_identity_sync_at');
  });

  it('records the same error whether it came from fetchIdentities or a masked-email failure', async () => {
    query.mockResolvedValueOnce({ rows: [accountRow] }).mockResolvedValueOnce({ rows: [] });
    loadJmapSession.mockResolvedValue({});
    fetchIdentities.mockResolvedValue([]);
    sessionHasMaskedEmail.mockReturnValue(true);
    fetchMaskedEmails.mockRejectedValue(Object.assign(new Error('masked email fetch failed'), { code: 'JMAP_SYNC' }));

    await expect(syncAccountIdentities(ACCOUNT_ID)).rejects.toMatchObject({ code: 'JMAP_SYNC' });

    const errorUpdate = query.mock.calls.find(c => /jmap_identity_sync_error/.test(c[0]));
    expect(errorUpdate[1]).toEqual(['masked email fetch failed', ACCOUNT_ID]);
  });
});
