import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';

// JMAP identity sync surface of accounts.js end-to-end: token encrypt-on-write, the
// validate-before-insert/update gate (JMAP_CONFIG -> 422, JMAP_SYNC -> accept + best-effort
// sync), the token-clear transaction (wipe token/sync columns + delete every synced
// sendable_addresses row), the manual refresh endpoint's status shape + rate limit, and
// that the token itself never appears in any response. syncAccountIdentities and
// loadJmapSession are mocked — their own behavior is covered by identitySync.test.js and
// jmapClient.test.js; this file is about how the route wires them.
vi.mock('../services/db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'u1' }; next(); },
}));
vi.mock('../index.js', () => ({
  imapManager: { connectAccount: vi.fn().mockResolvedValue(undefined), disconnectAccount: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../services/encryption.js', () => ({ encrypt: vi.fn(v => (v ? `enc:${v}` : v)) }));
vi.mock('../services/jmapClient.js', () => ({ loadJmapSession: vi.fn() }));
vi.mock('../services/identitySync.js', () => ({ syncAccountIdentities: vi.fn() }));
vi.mock('../services/rateLimiter.js', () => ({ consume: vi.fn().mockResolvedValue({ limited: false, resetMs: 0 }) }));
// Real DNS-resolving validateHost would make every jmap_session_url-carrying test a real
// network call; mock it so it approves by default, and let individual tests override it
// to exercise the SSRF-rejection paths.
vi.mock('../services/hostValidation.js', () => ({ validateHost: vi.fn().mockResolvedValue(null) }));
// getConnectionPolicy caches its result at module scope for 30s (see connectionPolicy.js)
// across every test in this file — mock it directly rather than through query() so each
// test's mockResolvedValueOnce chain matches only the calls this route actually makes.
vi.mock('../services/connectionPolicy.js', () => ({
  getConnectionPolicy: vi.fn().mockResolvedValue({ allowPrivateHosts: false, allowInsecureTls: false, allowNonstandardPorts: false }),
}));

import express from 'express';
import { query, withTransaction } from '../services/db.js';
import { encrypt } from '../services/encryption.js';
import { loadJmapSession } from '../services/jmapClient.js';
import { syncAccountIdentities } from '../services/identitySync.js';
import { consume } from '../services/rateLimiter.js';
import { validateHost } from '../services/hostValidation.js';
import accountRoutes from './accounts.js';

const ACCOUNT_ID = 'acct-1';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/accounts', accountRoutes);
  return app;
}

let server;
let base;

beforeAll(async () => {
  await new Promise((resolve) => { server = buildApp().listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  query.mockReset();
  withTransaction.mockReset();
  encrypt.mockClear();
  loadJmapSession.mockReset();
  syncAccountIdentities.mockReset();
  consume.mockReset().mockResolvedValue({ limited: false, resetMs: 0 });
  validateHost.mockReset().mockResolvedValue(null);
});

const post = (path, body) => fetch(`${base}/api/accounts${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const put = (path, body) => fetch(`${base}/api/accounts${path}`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

function insertedRow(overrides = {}) {
  return {
    id: ACCOUNT_ID, user_id: 'u1', name: 'Work', sender_name: null, email_address: 'me@example.com',
    color: '#6366f1', protocol: 'imap', imap_host: null, imap_port: 993, imap_skip_tls_verify: false,
    smtp_host: null, smtp_port: 587, smtp_tls: 'STARTTLS', auth_user: null, oauth_provider: null,
    enabled: true, last_sync: null, sync_error: null, sort_order: 0, folder_mappings: {},
    signature: null, created_at: new Date().toISOString(), categorization_enabled: false,
    gtd_enabled: false, gtd_folders: {},
    jmap_session_url: null, jmap_api_token: null, jmap_identity_sync_at: null, jmap_identity_sync_error: null,
    ...overrides,
  };
}

describe('POST /accounts — jmap_api_token', () => {
  it('rejects a token without a session URL, before any DB or JMAP call', async () => {
    const res = await post('/', { name: 'Work', email_address: 'me@example.com', jmap_api_token: 'secret-token' });

    expect(res.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
    expect(loadJmapSession).not.toHaveBeenCalled();
  });

  it('rejects a bad token/config with 422 and never writes the account row', async () => {
    loadJmapSession.mockRejectedValue(Object.assign(new Error('token rejected'), { code: 'JMAP_CONFIG', status: 422 }));

    const res = await post('/', {
      name: 'Work', email_address: 'me@example.com',
      jmap_session_url: 'https://mail.example.com/jmap', jmap_api_token: 'secret-token',
    });
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body.error).toBe('token rejected');
    expect(query).not.toHaveBeenCalled(); // no INSERT — rejected before any DB write
  });

  it('accepts the save on a transient (JMAP_SYNC) failure and still creates the account', async () => {
    query
      .mockResolvedValueOnce({ rows: [insertedRow({ jmap_session_url: 'https://mail.example.com/jmap', jmap_api_token: 'enc:secret-token' })] }) // INSERT
      .mockResolvedValueOnce({ rows: [insertedRow({ jmap_session_url: 'https://mail.example.com/jmap', jmap_api_token: 'enc:secret-token', jmap_identity_sync_error: 'Could not reach the JMAP server' })] }); // loadOwnedAccount refetch
    loadJmapSession.mockRejectedValue(Object.assign(new Error('unreachable'), { code: 'JMAP_SYNC' }));
    syncAccountIdentities.mockRejectedValue(Object.assign(new Error('unreachable'), { code: 'JMAP_SYNC' }));

    const res = await post('/', {
      name: 'Work', email_address: 'me@example.com',
      jmap_session_url: 'https://mail.example.com/jmap', jmap_api_token: 'secret-token',
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.jmap_identity_sync_configured).toBe(true);
    expect(body.jmap_identity_sync_error).toBe('Could not reach the JMAP server');
    expect(body.jmap_api_token).toBeUndefined();
  });

  it('encrypts the token before storing it, and never returns it', async () => {
    query
      .mockResolvedValueOnce({ rows: [insertedRow({ jmap_session_url: 'https://mail.example.com/jmap', jmap_api_token: 'enc:secret-token' })] })
      .mockResolvedValueOnce({ rows: [insertedRow({ jmap_session_url: 'https://mail.example.com/jmap', jmap_api_token: 'enc:secret-token', jmap_identity_sync_at: new Date().toISOString() })] });
    loadJmapSession.mockResolvedValue({ sessionUrl: 'https://mail.example.com/jmap' });
    syncAccountIdentities.mockResolvedValue({ syncedAt: new Date() });

    const res = await post('/', {
      name: 'Work', email_address: 'me@example.com',
      jmap_session_url: 'https://mail.example.com/jmap', jmap_api_token: 'secret-token',
    });
    const rawBody = await res.text();

    expect(res.status).toBe(200);
    expect(encrypt).toHaveBeenCalledWith('secret-token');
    // INSERT params include the encrypted (not plaintext) token.
    const insertCall = query.mock.calls[0];
    expect(insertCall[1]).toContain('enc:secret-token');
    expect(rawBody).not.toContain('secret-token');
    expect(syncAccountIdentities).toHaveBeenCalledWith(ACCOUNT_ID);
  });
});

describe('POST/PUT /accounts — jmap_session_url SSRF guard', () => {
  it('POST rejects a plaintext http session URL when private hosts are not allowed, before any DB call', async () => {
    const res = await post('/', { name: 'Work', email_address: 'me@example.com', jmap_session_url: 'http://mail.example.com/jmap' });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toMatch(/JMAP:.*HTTPS/i);
    expect(query).not.toHaveBeenCalled();
    expect(validateHost).not.toHaveBeenCalled(); // rejected on the policy check alone
  });

  it('POST rejects a session URL whose host resolves to a private/reserved address', async () => {
    validateHost.mockResolvedValue('Host resolves to a private or reserved IP address');

    const res = await post('/', { name: 'Work', email_address: 'me@example.com', jmap_session_url: 'https://internal.example.com/jmap' });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe('JMAP: Host resolves to a private or reserved IP address');
    expect(query).not.toHaveBeenCalled();
  });

  it('PUT rejects an updated session URL whose host resolves to a private/reserved address', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID, gtd_folders: {}, jmap_session_url: 'https://mail.example.com/jmap' }] });
    validateHost.mockResolvedValue('Host resolves to a private or reserved IP address');

    const res = await put(`/${ACCOUNT_ID}`, { jmap_session_url: 'https://internal.example.com/jmap' });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe('JMAP: Host resolves to a private or reserved IP address');
    expect(query).toHaveBeenCalledTimes(1); // only the ownership check — no UPDATE
  });
});

describe('PUT /accounts/:id — jmap_api_token', () => {
  it('clears the token, sync status, and every synced sendable address in one transaction', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID, gtd_folders: {}, jmap_session_url: 'https://mail.example.com/jmap' }] }); // ownership check
    const clientCalls = [];
    const client = { query: vi.fn(async (sql, params) => { clientCalls.push([sql, params]); return { rows: [insertedRow({ jmap_session_url: 'https://mail.example.com/jmap' })] }; }) };
    withTransaction.mockImplementation(async fn => fn(client));

    const res = await put(`/${ACCOUNT_ID}`, { jmap_api_token: '' });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.jmap_identity_sync_configured).toBe(false);
    expect(body.jmap_api_token).toBeUndefined();
    expect(clientCalls.some(([sql]) => /SET\s+jmap_api_token\s*=\s*NULL/.test(sql))).toBe(true);
    expect(clientCalls.some(([sql]) => sql.includes('DELETE FROM sendable_addresses'))).toBe(true);
    expect(syncAccountIdentities).not.toHaveBeenCalled();
  });

  it('clearing the token in the same request as other field edits still persists those edits (regression: the settings form bundles every field into one Save)', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID, gtd_folders: {}, jmap_session_url: 'https://mail.example.com/jmap' }] }); // ownership check
    const clientCalls = [];
    const client = {
      query: vi.fn(async (sql, params) => {
        clientCalls.push([sql, params]);
        return { rows: [insertedRow({ name: 'New Name', jmap_session_url: 'https://mail.example.com/jmap' })] };
      }),
    };
    withTransaction.mockImplementation(async fn => fn(client));

    const res = await put(`/${ACCOUNT_ID}`, { jmap_api_token: '', name: 'New Name' });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.name).toBe('New Name');
    expect(body.jmap_identity_sync_configured).toBe(false);
    const updateCall = clientCalls.find(([sql]) => sql.startsWith('UPDATE email_accounts'));
    expect(updateCall[0]).toMatch(/name\s*=\s*\$1/); // the name change is not dropped
    expect(updateCall[1]).toContain('New Name');
    expect(updateCall[0]).toMatch(/jmap_api_token\s*=\s*NULL/);
    expect(updateCall[0]).toMatch(/jmap_identity_sync_at\s*=\s*NULL/);
    expect(updateCall[0]).toMatch(/jmap_identity_sync_error\s*=\s*NULL/);
    expect(clientCalls.some(([sql]) => sql.includes('DELETE FROM sendable_addresses'))).toBe(true);
    expect(syncAccountIdentities).not.toHaveBeenCalled();
  });

  it('rejects a 400 when a token is set with no session URL configured or provided', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID, gtd_folders: {}, jmap_session_url: null }] });

    const res = await put(`/${ACCOUNT_ID}`, { jmap_api_token: 'secret-token' });

    expect(res.status).toBe(400);
    expect(loadJmapSession).not.toHaveBeenCalled();
  });

  it('validates against the existing stored session URL when the request only sends a token', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID, gtd_folders: {}, jmap_session_url: 'https://mail.example.com/jmap' }] }) // ownership check
      .mockResolvedValueOnce({ rows: [insertedRow({ jmap_session_url: 'https://mail.example.com/jmap', jmap_api_token: 'enc:new-token' })] }) // UPDATE
      .mockResolvedValueOnce({ rows: [insertedRow({ jmap_session_url: 'https://mail.example.com/jmap', jmap_api_token: 'enc:new-token', jmap_identity_sync_at: new Date().toISOString() })] }); // loadOwnedAccount
    loadJmapSession.mockResolvedValue({});
    syncAccountIdentities.mockResolvedValue({ syncedAt: new Date() });

    const res = await put(`/${ACCOUNT_ID}`, { jmap_api_token: 'new-token' });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(loadJmapSession).toHaveBeenCalledWith('https://mail.example.com/jmap', 'new-token', { allowPrivate: false });
    expect(body.jmap_identity_sync_configured).toBe(true);
    expect(syncAccountIdentities).toHaveBeenCalledWith(ACCOUNT_ID);
  });

  it('rejects a bad token with 422 before writing anything', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID, gtd_folders: {}, jmap_session_url: 'https://mail.example.com/jmap' }] });
    loadJmapSession.mockRejectedValue(Object.assign(new Error('bad token'), { code: 'JMAP_CONFIG', status: 422 }));

    const res = await put(`/${ACCOUNT_ID}`, { jmap_api_token: 'bad-token' });
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body.error).toBe('bad token');
    expect(query).toHaveBeenCalledTimes(1); // only the ownership check — no UPDATE
  });
});

describe('POST /accounts/:id/identities/refresh', () => {
  it('returns 404 when the account is not owned by the user', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    const res = await post(`/${ACCOUNT_ID}/identities/refresh`, {});

    expect(res.status).toBe(404);
  });

  it('returns 409 when JMAP identity sync is not configured', async () => {
    query.mockResolvedValueOnce({ rows: [insertedRow({ jmap_api_token: null })] });

    const res = await post(`/${ACCOUNT_ID}/identities/refresh`, {});

    expect(res.status).toBe(409);
    expect(syncAccountIdentities).not.toHaveBeenCalled();
  });

  it('runs the sync and returns only a { synced_at, error } status shape — never addresses', async () => {
    const syncedAt = new Date().toISOString();
    query
      .mockResolvedValueOnce({ rows: [insertedRow({ jmap_api_token: 'enc:token' })] }) // loadOwnedAccount (ownership + configured check)
      .mockResolvedValueOnce({ rows: [insertedRow({ jmap_api_token: 'enc:token', jmap_identity_sync_at: syncedAt, jmap_identity_sync_error: null })] }); // loadOwnedAccount refetch
    syncAccountIdentities.mockResolvedValue({ syncedAt: new Date(syncedAt) });

    const res = await post(`/${ACCOUNT_ID}/identities/refresh`, {});
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(['error', 'synced_at']);
    expect(body.synced_at).toBe(syncedAt);
    expect(body.error).toBeNull();
    expect(syncAccountIdentities).toHaveBeenCalledWith(ACCOUNT_ID);
  });

  it('reports a recorded sync error rather than throwing', async () => {
    query
      .mockResolvedValueOnce({ rows: [insertedRow({ jmap_api_token: 'enc:token' })] })
      .mockResolvedValueOnce({ rows: [insertedRow({ jmap_api_token: 'enc:token', jmap_identity_sync_error: 'bad token' })] });
    syncAccountIdentities.mockRejectedValue(Object.assign(new Error('bad token'), { code: 'JMAP_CONFIG' }));

    const res = await post(`/${ACCOUNT_ID}/identities/refresh`, {});
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.error).toBe('bad token');
  });

  it('is rate-limited per user, with a Retry-After header on 429', async () => {
    consume.mockResolvedValue({ limited: true, resetMs: 3000 });

    const res = await post(`/${ACCOUNT_ID}/identities/refresh`, {});

    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('3');
    expect(query).not.toHaveBeenCalled();
    expect(consume.mock.calls[0][0]).toContain('u1');
  });
});
