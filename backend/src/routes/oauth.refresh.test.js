import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// oauth.js imports imapManager from ../index.js, which has heavy load-time side
// effects (Redis connect, migrations). Mock it so importing oauth.js is inert.
vi.mock('../index.js', () => ({ imapManager: {} }));
vi.mock('../services/db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock('../services/encryption.js', () => ({ encrypt: (v) => v, decrypt: (v) => v }));

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
