import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { tx } = vi.hoisted(() => ({ tx: { query: null } }));
vi.mock('../services/db.js', () => ({ query: vi.fn(), withTransaction: vi.fn(async fn => fn({ query: tx.query })) }));
vi.mock('../middleware/auth.js', () => ({
  requireAdmin: (req, _res, next) => { req.session = { userId: 'admin-1', username: 'admin' }; next(); },
}));
vi.mock('../services/encryption.js', () => ({ decrypt: v => v, encrypt: v => v }));
vi.mock('../services/hostValidation.js', () => ({ validateHost: vi.fn(), resolveForConnection: vi.fn() }));
vi.mock('../services/smtpTransport.js', () => ({ createSmtpTransport: vi.fn() }));
vi.mock('../services/connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn(async () => ({ allowPrivateHosts: false })), invalidateConnectionPolicyCache: vi.fn() }));
vi.mock('../services/apiTokens.js', async (importOriginal) => ({ ...(await importOriginal()), invalidateApiTokenSettingsCache: vi.fn() }));
vi.mock('../services/authLimiter.js', () => ({ reloadAuthSettings: vi.fn() }));
vi.mock('../index.js', () => ({ imapManager: {} }));
vi.mock('../services/carddavSync.js', () => ({ stopCardavUser: vi.fn() }));
vi.mock('../plugins/registry.js', () => ({ pluginRegistry: {} }));
vi.mock('../services/userSessions.js', () => ({ destroyUserSessions: vi.fn() }));

import express from 'express';
import adminRoutes, { disableUserTotp, setUserPassword } from './admin.js';
import { query } from '../services/db.js';
import { invalidateApiTokenSettingsCache } from '../services/apiTokens.js';

let server;
let base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRoutes);
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
});

beforeEach(() => {
  query.mockReset().mockResolvedValue({ rows: [] });
  invalidateApiTokenSettingsCache.mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

const patch = body => fetch(`${base}/api/admin/settings`, {
  method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const switchWrites = () => query.mock.calls.filter(([sql]) => sql.includes("'api_tokens_enabled'")).map(([, params]) => params);

describe('the admin switch for API tokens', () => {
  it.each([[true, 'true', 'on'], [false, 'false', 'off']])('turns them %s and drops the cached setting at once', async (value, stored, word) => {
    const res = await patch({ api_tokens_enabled: value });
    expect(res.status).toBe(200);
    expect(switchWrites()).toEqual([[stored]]);
    expect(invalidateApiTokenSettingsCache).toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(`[admin] admin turned API tokens ${word}`);
  });

  it('takes only a boolean, as the other switches do', async () => {
    for (const value of ['true', 1, null, 'on']) {
      query.mockClear();
      expect((await patch({ api_tokens_enabled: value })).status).toBe(200);
      expect(switchWrites(), JSON.stringify(value)).toEqual([]);
    }
  });

  it('still takes effect when a setting after it is refused', async () => {
    const res = await patch({ api_tokens_enabled: false, mfa_enforcement: 'sometimes' });
    expect(res.status).toBe(400);
    expect(switchWrites()).toEqual([['false']]);
    expect(invalidateApiTokenSettingsCache).toHaveBeenCalled();
  });
});

describe('an admin setting a password', () => {
  it('deletes the user\'s API tokens in the same transaction as the new password', async () => {
    const inTransaction = [];
    tx.query = vi.fn(async (sql) => { inTransaction.push(sql); return { rows: [] }; });
    query.mockResolvedValue({ rows: [{ username: 'maria' }] });
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await setUserPassword({ params: { id: 'b2b2b2b2-0000-4000-8000-000000000002' }, body: { password: 'nova-senha-123' },
      session: { userId: 'admin-1', username: 'admin' }, sessionID: 's', ip: '203.0.113.7' }, res);
    expect(inTransaction[0]).toMatch(/^UPDATE users SET password_hash/);
    expect(inTransaction).toContain('DELETE FROM api_tokens WHERE user_id = $1');
    expect(query.mock.calls.some(([sql]) => sql.includes('api_tokens'))).toBe(false);
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });
});

// #617: a token must not get round the server's sign-in policy, so a change that tightens it
// deletes the tokens it no longer allows, in the transaction that makes the change.
describe('sign-in policy changes and API tokens', () => {
  const USER = 'b2b2b2b2-0000-4000-8000-000000000002';
  const PROVIDER = 'c0c0c0c0-0000-4000-8000-000000000001';
  let inTransaction;
  const firstWords = () => inTransaction.map(([sql]) => sql.trim().split(/\s+/).slice(0, 3).join(' '));
  beforeEach(() => {
    inTransaction = [];
    tx.query = vi.fn(async (sql, params) => {
      inTransaction.push([sql, params]);
      if (sql.startsWith('UPDATE oidc_providers')) return { rows: [{ id: PROVIDER, slug: 'corp' }] };
      return { rows: [], rowCount: sql.startsWith('DELETE') ? 2 : 1 };
    });
    // An enabled provider, and an identity at it for the admin, so password sign-in can go off.
    query.mockImplementation(async sql => {
      if (sql.includes('COUNT(*)')) return { rows: [{ count: '1' }] };
      if (sql.startsWith('SELECT allow_insecure, issuer_url, client_id FROM oidc_providers')) {
        return { rows: [{ allow_insecure: false, issuer_url: 'https://idp.example.com', client_id: 'mailflow' }] };
      }
      if (sql.includes("key = 'internal_auth_disabled'")) return { rows: [{ value: 'false' }] };
      return { rows: [{ username: 'maria' }] };
    });
  });

  it('password sign-in turned off: every token not confirmed through single sign-on', async () => {
    expect((await patch({ internal_auth_disabled: true })).status).toBe(200);
    expect(firstWords()).toEqual(['INSERT INTO system_settings', 'DELETE FROM api_tokens']);
    expect(inTransaction[0][1]).toEqual(['true']);
    expect(inTransaction[1][1]).toEqual([['oidc']]);
    expect(console.log).toHaveBeenCalledWith('[admin] admin set internal_auth_disabled=true, and deleted 2 API tokens');
  });

  it('two-factor required: tokens confirmed with only a password', async () => {
    expect((await patch({ mfa_enforcement: 'required' })).status).toBe(200);
    expect(firstWords()).toEqual(['INSERT INTO system_settings', 'DELETE FROM api_tokens']);
    expect(inTransaction[1][1]).toEqual([['totp', 'oidc']]);
    expect(console.log).toHaveBeenCalledWith('[admin] admin set mfa_enforcement=required, and deleted 2 API tokens');
  });

  it('turning either one off deletes nothing', async () => {
    expect((await patch({ internal_auth_disabled: false, mfa_enforcement: 'off' })).status).toBe(200);
    expect(firstWords()).toEqual(['INSERT INTO system_settings', 'INSERT INTO system_settings']);
    expect(console.log).toHaveBeenCalledWith('[admin] admin set internal_auth_disabled=false');
    expect(console.log).toHaveBeenCalledWith('[admin] admin set mfa_enforcement=off');
  });

  it('a refused change deletes nothing', async () => {
    query.mockImplementation(async sql => (sql.includes('COUNT(*)') ? { rows: [{ count: '0' }] } : { rows: [] }));
    expect((await patch({ internal_auth_disabled: true })).status).toBe(400);
    expect((await patch({ mfa_enforcement: 'sometimes' })).status).toBe(400);
    expect(inTransaction).toEqual([]);
  });

  it("an admin turning off a user's two-factor: all of that user's tokens", async () => {
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await disableUserTotp({ params: { id: USER }, session: { userId: 'admin-1', username: 'admin' }, ip: '203.0.113.7' }, res);
    expect(inTransaction).toEqual([
      ['UPDATE users SET totp_secret = NULL, totp_enabled = false WHERE id = $1', [USER]],
      ['DELETE FROM api_tokens WHERE user_id = $1', [USER]],
    ]);
    expect(console.log).toHaveBeenCalledWith(`[admin] admin disabled 2FA for user maria (${USER}), and deleted 2 API tokens`);
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });

  describe('an SSO provider turned off, or pointed at another issuer or client', () => {
    const update = body => fetch(`${base}/api/admin/oidc/${PROVIDER}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });

    it('takes the tokens confirmed through it along', async () => {
      expect((await update({ enabled: false })).status).toBe(200);
      expect(firstWords()).toEqual(['UPDATE oidc_providers SET', 'DELETE FROM api_tokens']);
      expect(inTransaction[1]).toEqual(['DELETE FROM api_tokens WHERE oidc_provider_id = $1', [PROVIDER]]);
      expect(console.log).toHaveBeenCalledWith('[admin] admin turned off SSO provider corp, and deleted 2 API tokens');
    });

    it.each([
      ['issuer', { issuer_url: 'https://other-idp.example.com' }],
      ['client', { client_id: 'mailflow-2' }],
    ])('takes them along when its %s changes: another identity source vouched for them', async (_what, body) => {
      expect((await update(body)).status).toBe(200);
      expect(firstWords()).toEqual(['UPDATE oidc_providers SET', 'DELETE FROM api_tokens']);
      expect(inTransaction[1]).toEqual(['DELETE FROM api_tokens WHERE oidc_provider_id = $1', [PROVIDER]]);
      expect(console.log).toHaveBeenCalledWith('[admin] admin changed the issuer or client of SSO provider corp, and deleted 2 API tokens');
    });

    it('leaves them while it stays on, through any other change, the same issuer and client sent back included', async () => {
      expect((await update({ enabled: true })).status).toBe(200);
      expect((await update({ name: 'Corp', issuer_url: 'https://idp.example.com', client_id: 'mailflow' })).status).toBe(200);
      expect((await update({ issuer_url: ' https://idp.example.com ', client_id: '' })).status).toBe(200);
      expect(firstWords()).toEqual(['UPDATE oidc_providers SET', 'UPDATE oidc_providers SET', 'UPDATE oidc_providers SET']);
    });

    it('deletes nothing for a provider that is not there', async () => {
      tx.query = vi.fn(async (sql, params) => { inTransaction.push([sql, params]); return { rows: [] }; });
      expect((await update({ enabled: false })).status).toBe(404);
      expect(firstWords()).toEqual(['UPDATE oidc_providers SET']);
    });
  });
});
