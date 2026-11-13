import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Unlinking an SSO identity (#617): the API tokens confirmed through its provider go with the
// user's last identity there, in the same transaction, and stay while another identity at that
// provider remains. The rule is services/userIdentities.js, which the admin's unlink
// (routes/admin.js) shares; this drives it through the user's route.
const mocks = vi.hoisted(() => ({ client: { query: vi.fn() } }));
vi.mock('../services/db.js', () => ({ query: vi.fn(), pool: {}, withTransaction: async fn => fn(mocks.client) }));
vi.mock('../services/encryption.js', () => ({ decrypt: (v) => v, encrypt: (v) => v, isEncrypted: () => false }));
vi.mock('../index.js', () => ({ imapManager: {} }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: 'u1', username: 'maria' }; next(); } }));
vi.mock('../services/authEvents.js', () => ({ logAuthEvent: vi.fn() }));
vi.mock('../services/hostValidation.js', () => ({ validateHost: vi.fn(async () => null) }));
vi.mock('../services/connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn(async () => ({ allowPrivateHosts: false })) }));

import express from 'express';
import oidcApiRouter from './oidc.js';

const IDENTITY = 'd4d4d4d4-4444-4444-8444-d4d4d4d4d4d4';
const OTHER = 'd5d5d5d5-5555-4555-8555-d5d5d5d5d5d5';
const PROVIDER = 'c0c0c0c0-0000-4000-8000-000000000001';

let server, base, statements, identities, othersAtProvider, hasPassword;

beforeAll(async () => {
  const app = express();
  app.use('/api/auth/oidc', oidcApiRouter);
  await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  await new Promise(r => server.close(r));
});

beforeEach(() => {
  statements = [];
  identities = [{ id: IDENTITY, provider_name: 'Pocket ID', provider_slug: 'pocket' }];
  othersAtProvider = false;
  hasPassword = true;
  mocks.client.query.mockReset().mockImplementation(async (sql, params) => {
    statements.push([sql, params]);
    if (sql.startsWith('SELECT password_hash IS NOT NULL AS has_password FROM users')) return { rows: [{ has_password: hasPassword }] };
    if (sql.trimStart().startsWith('SELECT ui.id')) return { rows: identities };
    if (sql.startsWith("SELECT value FROM system_settings WHERE key = 'internal_auth_disabled'")) return { rows: [{ value: 'false' }] };
    if (sql.startsWith('DELETE FROM user_identities')) return { rows: [{ provider_id: PROVIDER }] };
    if (sql.startsWith('SELECT 1 FROM user_identities WHERE user_id = $1 AND provider_id = $2')) return { rows: othersAtProvider ? [{ '?column?': 1 }] : [] };
    if (sql.startsWith('DELETE FROM api_tokens')) return { rows: [], rowCount: 2 };
    throw new Error(`unexpected statement: ${sql}`);
  });
  vi.spyOn(console, 'log').mockImplementation(() => {}).mockClear();
});

const unlink = (id = IDENTITY) => fetch(`${base}/api/auth/oidc/identities/${id}`, { method: 'DELETE' });
const firstWords = () => statements.map(([sql]) => sql.trim().split(/\s+/).slice(0, 3).join(' '));

describe('DELETE /api/auth/oidc/identities/:id', () => {
  it('deletes the tokens confirmed through the provider with the user\'s last identity there, in the transaction', async () => {
    const res = await unlink();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(firstWords()).toEqual([
      'SELECT password_hash IS', 'SELECT ui.id, ui.issuer,', 'SELECT value FROM', 'DELETE FROM user_identities', 'SELECT 1 FROM', 'DELETE FROM api_tokens',
    ]);
    expect(statements[3]).toEqual(['DELETE FROM user_identities WHERE id = $1 AND user_id = $2 RETURNING provider_id', [IDENTITY, 'u1']]);
    expect(statements[5]).toEqual(['DELETE FROM api_tokens WHERE user_id = $1 AND oidc_provider_id = $2', ['u1', PROVIDER]]);
    expect(console.log).toHaveBeenCalledWith('[oidc] user u1 unlinked their last identity at pocket, and deleted 2 API tokens');
  });

  it('keeps them while another identity at that provider remains', async () => {
    identities.push({ id: OTHER, provider_name: 'Pocket ID', provider_slug: 'pocket' });
    othersAtProvider = true;
    expect((await unlink()).status).toBe(200);
    expect(firstWords()).toEqual(['SELECT password_hash IS', 'SELECT ui.id, ui.issuer,', 'DELETE FROM user_identities', 'SELECT 1 FROM']);
    expect(console.log).not.toHaveBeenCalled();
  });

  it('deletes nothing for an identity that is not the user\'s', async () => {
    const res = await unlink(OTHER);
    expect(res.status).toBe(404);
    expect(firstWords()).toEqual(['SELECT password_hash IS', 'SELECT ui.id, ui.issuer,']);
  });

  it('still refuses to unlink the only way to sign in, before anything is written', async () => {
    hasPassword = false;
    const res = await unlink();
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Cannot unlink your only login method. Set a password first.' });
    expect(firstWords()).toEqual(['SELECT password_hash IS', 'SELECT ui.id, ui.issuer,']);
  });
});
