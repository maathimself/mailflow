import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Unlinking an SSO identity (#617): the API tokens confirmed through its provider go with the
// user's last identity there, in the same transaction, and stay while another identity at that
// provider remains.
vi.mock('../services/db.js', () => ({ query: vi.fn(), pool: { connect: vi.fn() } }));
vi.mock('../services/encryption.js', () => ({ decrypt: (v) => v, isEncrypted: () => false }));
vi.mock('../index.js', () => ({ imapManager: {} }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: 'u1' }; next(); } }));
vi.mock('../services/authEvents.js', () => ({ logAuthEvent: vi.fn() }));
vi.mock('../services/hostValidation.js', () => ({ validateHost: vi.fn(async () => null) }));
vi.mock('../services/connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn(async () => ({ allowPrivateHosts: false })) }));

import express from 'express';
import { pool } from '../services/db.js';
import oidcApiRouter from './oidc.js';

const IDENTITY = 'd4d4d4d4-4444-4444-8444-d4d4d4d4d4d4';
const PROVIDER = 'c0c0c0c0-0000-4000-8000-000000000001';

let server, base, statements, identityFound, othersAtProvider, hasPassword;

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
  identityFound = true;
  othersAtProvider = 0;
  hasPassword = true;
  pool.connect.mockReset().mockImplementation(async () => ({
    query: vi.fn(async (sql, params) => {
      statements.push([sql, params]);
      if (sql.startsWith('SELECT password_hash FROM users')) return { rows: [{ password_hash: hasPassword ? 'hash' : null }] };
      if (sql.startsWith('SELECT COUNT(*) AS count FROM user_identities WHERE user_id = $1')) return { rows: [{ count: '1' }] };
      if (sql.startsWith('DELETE FROM user_identities')) return { rows: identityFound ? [{ provider_id: PROVIDER }] : [] };
      if (sql.startsWith('SELECT COUNT(*)::int AS count FROM user_identities WHERE user_id = $1 AND provider_id = $2')) return { rows: [{ count: othersAtProvider }] };
      if (sql.startsWith('DELETE FROM api_tokens')) return { rows: [], rowCount: 2 };
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  }));
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

const unlink = () => fetch(`${base}/api/auth/oidc/identities/${IDENTITY}`, { method: 'DELETE' });
const firstWords = () => statements.map(([sql]) => sql.trim().split(/\s+/).slice(0, 3).join(' '));

describe('DELETE /api/auth/oidc/identities/:id', () => {
  it('deletes the tokens confirmed through the provider with the user\'s last identity there, in one transaction', async () => {
    const res = await unlink();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(firstWords()).toEqual([
      'SELECT password_hash FROM', 'BEGIN', 'DELETE FROM user_identities', 'SELECT COUNT(*)::int AS', 'DELETE FROM api_tokens', 'COMMIT',
    ]);
    expect(statements[2]).toEqual(['DELETE FROM user_identities WHERE id = $1 AND user_id = $2 RETURNING provider_id', [IDENTITY, 'u1']]);
    expect(statements[4]).toEqual(['DELETE FROM api_tokens WHERE user_id = $1 AND oidc_provider_id = $2', ['u1', PROVIDER]]);
    expect(console.log).toHaveBeenCalledWith(`[oidc] user u1 unlinked their last identity at provider ${PROVIDER}, and deleted 2 API tokens`);
  });

  it('keeps them while another identity at that provider remains', async () => {
    othersAtProvider = 1;
    expect((await unlink()).status).toBe(200);
    expect(firstWords()).toEqual(['SELECT password_hash FROM', 'BEGIN', 'DELETE FROM user_identities', 'SELECT COUNT(*)::int AS', 'COMMIT']);
  });

  it('deletes nothing for an identity that is not the user\'s', async () => {
    identityFound = false;
    expect((await unlink()).status).toBe(200);
    expect(firstWords()).toEqual(['SELECT password_hash FROM', 'BEGIN', 'DELETE FROM user_identities', 'COMMIT']);
  });

  it('still refuses to unlink the only way to sign in, before anything is written', async () => {
    hasPassword = false;
    const res = await unlink();
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Cannot unlink your only login method. Set a password first.' });
    expect(firstWords()).toEqual(['SELECT password_hash FROM', 'SELECT COUNT(*) AS']);
  });
});
