import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));

import bcrypt from 'bcryptjs';
import express from 'express';
import totpRoutes from './totp.js';
import { query } from '../services/db.js';

describe('POST /api/totp/disable', () => {
  let srv, base, passwordHash, userId;
  let users = 0;
  beforeAll(async () => {
    passwordHash = await bcrypt.hash('right password', 4);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.session = { userId }; next(); });
    app.use('/api/totp', totpRoutes);
    await new Promise(r => { srv = app.listen(0, r); });
    base = `http://127.0.0.1:${srv.address().port}`;
  });
  afterAll(async () => { await new Promise(r => srv.close(r)); });
  beforeEach(() => {
    // A new user each time, so the route's per-user attempt limit never decides a result.
    userId = `user-${++users}`;
    query.mockReset().mockImplementation(async (sql) => {
      if (sql.includes('SELECT id FROM users')) return { rows: [{ id: userId }] };
      if (sql.includes('SELECT password_hash FROM users')) return { rows: [{ password_hash: passwordHash }] };
      return { rows: [] };
    });
  });

  const disable = async (password) => {
    const res = await fetch(`${base}/api/totp/disable`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    return { status: res.status, json: await res.json() };
  };
  const turnedOff = () => query.mock.calls.some(([sql]) => sql.includes('totp_enabled = false'));

  it('refuses a wrong password with 403, not the 401 the client takes for a lost session', async () => {
    // request() in frontend/src/utils/api.js signs the browser out on any 401 outside
    // /auth/, so a mistyped password here dropped a signed-in user to the login page.
    const res = await disable('wrong password');

    expect(res).toEqual({ status: 403, json: { error: 'Incorrect password' } });
    expect(turnedOff()).toBe(false);
  });

  it('turns 2FA off for the right password', async () => {
    const res = await disable('right password');

    expect(res).toEqual({ status: 200, json: { ok: true } });
    expect(turnedOff()).toBe(true);
  });
});
