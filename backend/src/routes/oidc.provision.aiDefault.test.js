import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// An account created by SSO auto-provisioning takes the admin's "Allow AI for new users" setting
// (#644), the same as one created by registration. Harness as in oidc.screenLock.test.js.
vi.mock('../services/db.js', () => ({ query: vi.fn(), pool: { connect: vi.fn() } }));
vi.mock('../services/encryption.js', () => ({ decrypt: (v) => v, isEncrypted: () => false }));
vi.mock('../index.js', () => ({ imapManager: { connectAllForUser: vi.fn() } }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (_req, _res, next) => next() }));
vi.mock('../services/authEvents.js', () => ({ logAuthEvent: vi.fn() }));
vi.mock('../services/hostValidation.js', () => ({ validateHost: vi.fn(async () => null) }));
vi.mock('../services/connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn(async () => ({ allowPrivateHosts: false })) }));
// Token signatures are not what is under test here.
vi.mock('jose', async (importOriginal) => ({ ...(await importOriginal()), jwtVerify: vi.fn() }));

import express from 'express';
import session from 'express-session';
import { jwtVerify } from 'jose';
import { query, pool } from '../services/db.js';
import { buildSessionOptions } from '../utils/sessionConfig.js';
import { oidcBrowserRouter } from './oidc.js';

const realFetch = global.fetch;
const issuer = 'https://idp.example.com';
const provider = {
  id: 'p1', slug: 'idp', issuer_url: issuer, client_id: 'mailflow', client_secret: 'secret',
  allow_insecure: false, enabled: true, provisioning_mode: 'open',
};
const discoveryDoc = {
  issuer,
  authorization_endpoint: `${issuer}/authorize`,
  token_endpoint: `${issuer}/token`,
  jwks_uri: `${issuer}/jwks`,
};

let server, base, clientQueries, newUsersSetting;

beforeAll(async () => {
  process.env.APP_URL = 'https://mail.example.com';
  global.fetch = vi.fn(async (url) => {
    if (String(url) === `${issuer}/.well-known/openid-configuration`) return { ok: true, status: 200, json: async () => discoveryDoc };
    if (String(url) === `${issuer}/token`) return { ok: true, status: 200, json: async () => ({ id_token: 'id-token' }) };
    throw new Error(`unexpected fetch: ${url}`);
  });
  const app = express();
  app.use(session(buildSessionOptions(new session.MemoryStore(), 'test-secret-'.padEnd(40, 'x'))));
  app.get('/session', (req, res) => res.json({ oidcPending: req.session.oidcPending ?? null }));
  app.use('/auth/oidc', oidcBrowserRouter);
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  global.fetch = realFetch;
  delete process.env.APP_URL;
  server.closeAllConnections();
  await new Promise(r => server.close(r));
});

beforeEach(() => {
  clientQueries = [];
  newUsersSetting = undefined;
  query.mockReset().mockImplementation(async (sql) => ({ rows: sql.includes('FROM oidc_providers') ? [provider] : [] }));
  pool.connect.mockReset().mockImplementation(async () => ({
    query: vi.fn(async (sql, params) => {
      clientQueries.push({ sql, params });
      if (sql.includes('FROM oidc_providers')) return { rows: [provider] };
      if (sql.includes('COUNT(*)')) return { rows: [{ count: '1' }] };
      if (sql.includes('FROM system_settings WHERE key = $1') && params[0] === 'ai_new_users_enabled') {
        return { rows: newUsersSetting === undefined ? [] : [{ value: newUsersSetting }] };
      }
      if (sql.startsWith('INSERT INTO users')) return { rows: [{ id: 'u-new', username: params[0], is_admin: params[1] }] };
      return { rows: [] };
    }),
    release: vi.fn(),
  }));
  jwtVerify.mockReset();
});

const get = (path, cookie) => realFetch(`${base}${path}`, { headers: cookie ? { cookie } : {}, redirect: 'manual' });

// Runs an SSO sign-in for an identity MailFlow has never seen, and returns the new user's ai_enabled.
async function provision() {
  clientQueries = [];
  const start = await get('/auth/oidc/idp/start');
  const cookie = start.headers.get('set-cookie').split(';')[0];
  const { oidcPending } = await (await get('/session', cookie)).json();
  jwtVerify.mockResolvedValue({ payload: { iss: issuer, sub: 'idp-new', nonce: oidcPending.nonce, email: 'new@example.net', email_verified: true } });
  const done = await get(`/auth/oidc/idp/callback?code=c1&state=${oidcPending.state}`, cookie);
  expect(done.headers.get('location')).toBe('/?oidc_success=login');
  const insert = clientQueries.find(q => q.sql.startsWith('INSERT INTO users'));
  expect(insert.sql).toMatch(/\(username, password_hash, is_admin, ai_enabled\)/);
  return insert.params[2];
}

describe('SSO auto-provisioning: AI access for the new account', () => {
  it('is on when the setting has never been saved', async () => {
    expect(await provision()).toBe(true);
  });

  it('follows "Allow AI for new users"', async () => {
    newUsersSetting = 'false';
    expect(await provision()).toBe(false);
    newUsersSetting = 'true';
    expect(await provision()).toBe(true);
  });
});
