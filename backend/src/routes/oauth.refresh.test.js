import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// oauth.js imports imapManager from ../index.js, which has heavy load-time side
// effects (Redis connect, migrations). Mock it so importing oauth.js is inert.
vi.mock('../index.js', () => ({ imapManager: {} }));
vi.mock('../services/db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock('../services/encryption.js', () => ({ encrypt: (v) => v, decrypt: (v) => v }));
// A stand-in for MailFlow's built-in Microsoft app (#674), so no test depends on the shipped ID.
vi.mock('../services/microsoftBuiltinApp.js', () => ({ MAILFLOW_MS_CLIENT_ID: 'builtin-app-id' }));

const { query } = await import('../services/db.js');
const { refreshMicrosoftToken } = await import('./oauth.js');

const OK_TOKENS = { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 };
const res = (ok, body) => ({ ok, json: async () => body });
// fetch(url, { body: URLSearchParams }) — the URLSearchParams passed to the nth call
const bodyOf = (call) => call[1].body;

describe('Microsoft token refresh — public (device-code) vs confidential (auth-code) client', () => {
  beforeEach(() => {
    query.mockReset();
    query.mockResolvedValue({ rows: [] });
    process.env.MS_CLIENT_ID = 'client-123';
    process.env.MS_TENANT_ID = 'common';
    delete process.env.MS_CLIENT_SECRET;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.MS_CLIENT_SECRET;
  });

  it('omits client_secret for a public account even when a secret is configured (#216 / AADSTS90023)', async () => {
    process.env.MS_CLIENT_SECRET = 'secret-xyz';
    const fetchMock = vi.fn().mockResolvedValue(res(true, OK_TOKENS));
    vi.stubGlobal('fetch', fetchMock);

    await refreshMicrosoftToken({ id: 'a1', oauth_refresh_token: 'stored-rt', oauth_public_client: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bodyOf(fetchMock.mock.calls[0]).has('client_secret')).toBe(false);
  });

  it('sends client_secret for a confidential account', async () => {
    process.env.MS_CLIENT_SECRET = 'secret-xyz';
    const fetchMock = vi.fn().mockResolvedValue(res(true, OK_TOKENS));
    vi.stubGlobal('fetch', fetchMock);

    await refreshMicrosoftToken({ id: 'a2', oauth_refresh_token: 'stored-rt', oauth_public_client: false });

    expect(bodyOf(fetchMock.mock.calls[0]).get('client_secret')).toBe('secret-xyz');
  });

  it('never sends a secret when none is configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue(res(true, OK_TOKENS));
    vi.stubGlobal('fetch', fetchMock);

    await refreshMicrosoftToken({ id: 'a3', oauth_refresh_token: 'stored-rt', oauth_public_client: false });

    expect(bodyOf(fetchMock.mock.calls[0]).has('client_secret')).toBe(false);
  });

  it('self-heals: retries without the secret on AADSTS90023 and records the account as public', async () => {
    process.env.MS_CLIENT_SECRET = 'secret-xyz';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(res(false, { error: 'invalid_request', error_description: "AADSTS90023: Public clients can't send a client secret." }))
      .mockResolvedValueOnce(res(true, OK_TOKENS));
    vi.stubGlobal('fetch', fetchMock);

    const result = await refreshMicrosoftToken({ id: 'a4', oauth_refresh_token: 'stored-rt', oauth_public_client: false });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodyOf(fetchMock.mock.calls[0]).has('client_secret')).toBe(true);   // first attempt: with secret
    expect(bodyOf(fetchMock.mock.calls[1]).has('client_secret')).toBe(false);  // retry: without secret
    expect(result.oauth_public_client).toBe(true);

    // The persisted UPDATE records the learned public flag (param index 3 = isPublic).
    const updateCall = query.mock.calls.find(c => /UPDATE email_accounts/.test(c[0]) && /oauth_public_client/.test(c[0]));
    expect(updateCall).toBeTruthy();
    expect(updateCall[1][3]).toBe(true);
  });

  it('keeps a confidential account confidential on a successful refresh (never flips to public)', async () => {
    process.env.MS_CLIENT_SECRET = 'secret-xyz';
    const fetchMock = vi.fn().mockResolvedValue(res(true, OK_TOKENS));
    vi.stubGlobal('fetch', fetchMock);

    const result = await refreshMicrosoftToken({ id: 'a6', oauth_refresh_token: 'stored-rt', oauth_public_client: false });

    expect(fetchMock).toHaveBeenCalledTimes(1); // succeeded with the secret, no retry
    expect(result.oauth_public_client).toBe(false);
    const updateCall = query.mock.calls.find(c => /UPDATE email_accounts/.test(c[0]) && /oauth_public_client/.test(c[0]));
    expect(updateCall[1][3]).toBe(false);
  });

  it('still throws when the secretless retry also fails', async () => {
    process.env.MS_CLIENT_SECRET = 'secret-xyz';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(res(false, { error_description: "AADSTS90023: Public clients can't send a client secret." }))
      .mockResolvedValueOnce(res(false, { error_description: 'AADSTS700003: still broken after retry.' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(refreshMicrosoftToken({ id: 'a7', oauth_refresh_token: 'stored-rt', oauth_public_client: false }))
      .rejects.toThrow(/still broken after retry/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry when a confidential refresh fails for a non-secret reason', async () => {
    process.env.MS_CLIENT_SECRET = 'secret-xyz';
    const fetchMock = vi.fn().mockResolvedValue(res(false, { error: 'invalid_grant', error_description: 'AADSTS700082: refresh token expired.' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(refreshMicrosoftToken({ id: 'a5', oauth_refresh_token: 'stored-rt', oauth_public_client: false }))
      .rejects.toThrow(/refresh token expired/);
    expect(fetchMock).toHaveBeenCalledTimes(1); // no retry on a non-AADSTS90023 error
  });
});

// A refresh token only works with the client that obtained it, so an account refreshes
// through the client and tenant it was connected with, whatever MS_CLIENT_ID is now (#674).
describe('Microsoft token refresh: client identity', () => {
  const urlOf = (call) => call[0];
  const updateCall = () => query.mock.calls.find(c => /UPDATE email_accounts/.test(c[0]));

  beforeEach(() => {
    query.mockReset();
    query.mockResolvedValue({ rows: [] });
    delete process.env.MS_CLIENT_ID;
    delete process.env.MS_CLIENT_SECRET;
    delete process.env.MS_TENANT_ID;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.MS_CLIENT_ID;
    delete process.env.MS_CLIENT_SECRET;
    delete process.env.MS_TENANT_ID;
  });

  it('refreshes a built-in account through the built-in client, with no Client ID configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue(res(true, OK_TOKENS));
    vi.stubGlobal('fetch', fetchMock);

    await refreshMicrosoftToken({ id: 'b1', oauth_refresh_token: 'rt', oauth_public_client: true,
      oauth_client_id: 'builtin-app-id', oauth_tenant_id: 'consumers' });

    expect(urlOf(fetchMock.mock.calls[0])).toBe('https://login.microsoftonline.com/consumers/oauth2/v2.0/token');
    expect(bodyOf(fetchMock.mock.calls[0]).get('client_id')).toBe('builtin-app-id');
    expect(bodyOf(fetchMock.mock.calls[0]).has('client_secret')).toBe(false);
  });

  it('keeps a built-in account on the built-in client after the admin configures an own app', async () => {
    process.env.MS_CLIENT_ID = 'own-app-id';
    process.env.MS_TENANT_ID = 'contoso.example';
    process.env.MS_CLIENT_SECRET = 'secret-xyz';
    const fetchMock = vi.fn().mockResolvedValue(res(true, OK_TOKENS));
    vi.stubGlobal('fetch', fetchMock);

    await refreshMicrosoftToken({ id: 'b2', oauth_refresh_token: 'rt', oauth_public_client: true,
      oauth_client_id: 'builtin-app-id', oauth_tenant_id: 'consumers' });

    expect(urlOf(fetchMock.mock.calls[0])).toContain('/consumers/');
    expect(bodyOf(fetchMock.mock.calls[0]).get('client_id')).toBe('builtin-app-id');
    expect(bodyOf(fetchMock.mock.calls[0]).has('client_secret')).toBe(false);
  });

  it('never sends a secret with the built-in client, even on a confidential-flagged account whose ID equals MS_CLIENT_ID', async () => {
    process.env.MS_CLIENT_ID = 'builtin-app-id';
    process.env.MS_CLIENT_SECRET = 'secret-xyz';
    const fetchMock = vi.fn().mockResolvedValue(res(true, OK_TOKENS));
    vi.stubGlobal('fetch', fetchMock);

    await refreshMicrosoftToken({ id: 'b3', oauth_refresh_token: 'rt', oauth_public_client: false,
      oauth_client_id: 'builtin-app-id', oauth_tenant_id: 'consumers' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bodyOf(fetchMock.mock.calls[0]).has('client_secret')).toBe(false);
  });

  it('keeps an account on the app it was connected with after MS_CLIENT_ID changes, without the new secret', async () => {
    process.env.MS_CLIENT_ID = 'new-app-id';
    process.env.MS_CLIENT_SECRET = 'new-secret';
    const fetchMock = vi.fn().mockResolvedValue(res(true, OK_TOKENS));
    vi.stubGlobal('fetch', fetchMock);

    await refreshMicrosoftToken({ id: 'b4', oauth_refresh_token: 'rt', oauth_public_client: false,
      oauth_client_id: 'old-app-id', oauth_tenant_id: 'organizations' });

    expect(urlOf(fetchMock.mock.calls[0])).toContain('/organizations/');
    expect(bodyOf(fetchMock.mock.calls[0]).get('client_id')).toBe('old-app-id');
    expect(bodyOf(fetchMock.mock.calls[0]).has('client_secret')).toBe(false);
  });

  it('sends the secret for an account stored with the configured confidential app', async () => {
    process.env.MS_CLIENT_ID = 'own-app-id';
    process.env.MS_CLIENT_SECRET = 'secret-xyz';
    const fetchMock = vi.fn().mockResolvedValue(res(true, OK_TOKENS));
    vi.stubGlobal('fetch', fetchMock);

    await refreshMicrosoftToken({ id: 'b5', oauth_refresh_token: 'rt', oauth_public_client: false,
      oauth_client_id: 'own-app-id', oauth_tenant_id: 'common' });

    expect(bodyOf(fetchMock.mock.calls[0]).get('client_secret')).toBe('secret-xyz');
  });

  it('falls back to the instance config for an account with no stored identity, and records it', async () => {
    process.env.MS_CLIENT_ID = 'own-app-id';
    process.env.MS_TENANT_ID = 'contoso.example';
    process.env.MS_CLIENT_SECRET = 'secret-xyz';
    const fetchMock = vi.fn().mockResolvedValue(res(true, OK_TOKENS));
    vi.stubGlobal('fetch', fetchMock);

    const result = await refreshMicrosoftToken({ id: 'b6', oauth_refresh_token: 'rt', oauth_public_client: false,
      oauth_client_id: null, oauth_tenant_id: null });

    expect(urlOf(fetchMock.mock.calls[0])).toContain('/contoso.example/');
    expect(bodyOf(fetchMock.mock.calls[0]).get('client_id')).toBe('own-app-id');
    expect(bodyOf(fetchMock.mock.calls[0]).get('client_secret')).toBe('secret-xyz');
    // Only written where the column is still empty, so a stored identity is never replaced.
    expect(updateCall()[0]).toMatch(/oauth_client_id = COALESCE\(oauth_client_id, \$6\)/);
    expect(updateCall()[0]).toMatch(/oauth_tenant_id = COALESCE\(oauth_tenant_id, \$7\)/);
    expect(updateCall()[1].slice(5)).toEqual(['own-app-id', 'contoso.example']);
    expect(result).toMatchObject({ oauth_client_id: 'own-app-id', oauth_tenant_id: 'contoso.example' });
  });

  // A sign-in through another client that finished while this refresh was in flight stored
  // that client's tokens and ID. This refresh's tokens belong to the old client, so the
  // UPDATE only matches a row that still belongs to the client it used.
  it('saves only while the row still belongs to the client the refresh used', async () => {
    const fetchMock = vi.fn().mockResolvedValue(res(true, OK_TOKENS));
    vi.stubGlobal('fetch', fetchMock);
    query.mockResolvedValue({ rows: [], rowCount: 0 });
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await refreshMicrosoftToken({ id: 'b8', oauth_refresh_token: 'rt', oauth_public_client: true,
      oauth_client_id: 'builtin-app-id', oauth_tenant_id: 'consumers' });

    const [sql, params] = updateCall();
    expect(sql).toMatch(/WHERE id = \$5\s+AND COALESCE\(oauth_client_id, \$6\) = \$6\s+AND COALESCE\(oauth_tenant_id, \$7\) = \$7/);
    expect(params.slice(4)).toEqual(['b8', 'builtin-app-id', 'consumers']);
    expect(warned).toHaveBeenCalledWith(expect.stringMatching(/not saved: the account was signed in again/));
    // The caller still gets a working access token for the connection it is making.
    expect(result.oauth_access_token).toBe('new-access');
    warned.mockRestore();
  });

  it('fails loudly, without calling Microsoft, for an old account when no Client ID is configured', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(refreshMicrosoftToken({ id: 'b7', oauth_refresh_token: 'rt', oauth_public_client: true }))
      .rejects.toThrow(/Microsoft integration not configured/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
