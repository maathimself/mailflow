import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock('./encryption.js', () => ({ decrypt: vi.fn(v => v) }));
vi.mock('./jmapClient.js', () => ({ loadJmapSession: vi.fn(), fetchIdentities: vi.fn() }));
vi.mock('./connectionPolicy.js', () => ({
  getConnectionPolicy: vi.fn().mockResolvedValue({ allowPrivateHosts: false, allowInsecureTls: false, allowNonstandardPorts: false }),
}));

const { query, withTransaction } = await import('./db.js');
const { decrypt } = await import('./encryption.js');
const { loadJmapSession, fetchIdentities } = await import('./jmapClient.js');
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

beforeEach(() => {
  query.mockReset();
  withTransaction.mockReset();
  decrypt.mockReset().mockImplementation(v => v);
  loadJmapSession.mockReset();
  fetchIdentities.mockReset();
  getConnectionPolicy.mockReset().mockResolvedValue({ allowPrivateHosts: false, allowInsecureTls: false, allowNonstandardPorts: false });
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

describe('syncAccountIdentities — reconciliation', () => {
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
    // Two upserts (one per identity) + one delete-stale statement.
    const upserts = calls.filter(([sql]) => sql.includes('ON CONFLICT'));
    const deletes = calls.filter(([sql]) => sql.trim().startsWith('DELETE'));
    expect(upserts).toHaveLength(2);
    expect(deletes).toHaveLength(1);
    expect(upserts[0][1]).toEqual([ACCOUNT_ID, 'id-1', 'sales@example.com', 'Sales', '[]']);
    expect(upserts[1][1]).toEqual([ACCOUNT_ID, 'id-2', 'support@example.com', 'Support', JSON.stringify([{ name: 'Help', email: 'help@example.com' }])]);
    // The delete keeps exactly the provider_ids still present.
    expect(deletes[0][1]).toEqual([ACCOUNT_ID, ['id-1', 'id-2']]);

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

    const upsert = calls.find(([sql]) => sql.includes('ON CONFLICT'));
    expect(upsert[1]).toEqual([ACCOUNT_ID, 'id-wild', '*@example.com', 'Catch-all', '[]']);
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

    const upserts = calls.filter(([sql]) => sql.includes('ON CONFLICT'));
    expect(upserts).toHaveLength(1);
    expect(upserts[0][1][1]).toBe('id-good');
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

    expect(calls.filter(([sql]) => sql.includes('ON CONFLICT'))).toHaveLength(0);
    // Nothing survives -> the delete-stale clause runs with an empty keep-list, wiping all identity rows.
    const del = calls.find(([sql]) => sql.trim().startsWith('DELETE'));
    expect(del[1]).toEqual([ACCOUNT_ID, []]);
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

    const upsert = calls.find(([sql]) => sql.includes('ON CONFLICT'));
    expect(JSON.parse(upsert[1][4])).toEqual([{ email: 'good@example.com' }]);
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
});
