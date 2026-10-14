import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Mounted as index.js mounts it: cors() for the app, the CardDAV router behind it. The real
// rateLimiter runs against an in-memory Redis, as in routes/carddav.auth.test.js.
const { rs } = vi.hoisted(() => ({ rs: { store: new Map() } }));
vi.mock('../services/redis.js', () => ({
  redisClient: {
    async incr(k)        { const e = rs.store.get(k) || { v: 0, exp: 0 }; e.v++; rs.store.set(k, e); return e.v; },
    async decr(k)        { const e = rs.store.get(k) || { v: 0, exp: 0 }; e.v--; rs.store.set(k, e); return e.v; },
    async pExpire(k, ms) { const e = rs.store.get(k); if (e) e.exp = Date.now() + ms; return true; },
    async pTTL(k)        { const e = rs.store.get(k); return e ? (e.exp - Date.now()) : -2; },
    async del(k)         { rs.store.delete(k); return 1; },
  },
}));
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../services/authEvents.js', () => ({ logAuthEvent: vi.fn() }));
vi.mock('../services/authLimiter.js', () => ({ authLimiterConfig: { maxRequests: 10, windowMs: 60000 } }));

import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import carddavRouter from '../routes/carddav.js';
import { query } from '../services/db.js';
import { corsExceptDav } from './corsExceptDav.js';

const APP = 'https://mail.example.invalid';
const USER = { id: 'u1', password_hash: bcrypt.hashSync('right', 4), totp_enabled: false };
const basic = `Basic ${Buffer.from('alice:right').toString('base64')}`;

describe('CORS for the app, not for CardDAV', () => {
  let server, base;
  beforeAll(async () => {
    const app = express();
    app.use(corsExceptDav(cors({ origin: APP, credentials: true })));
    app.use('/api', (_req, res) => res.json({ ok: true }));
    app.use('/carddav', carddavRouter);
    await new Promise(resolve => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
  beforeEach(() => {
    rs.store.clear();
    query.mockReset().mockImplementation(async (sql) => (/system_settings/.test(sql) ? { rows: [] } : { rows: [USER] }));
  });

  // DAVx5 asks the principal what it serves and finds no address book without this header.
  it("answers a contact app's OPTIONS with the CardDAV capabilities", async () => {
    for (const path of ['/carddav/', '/carddav/u1/']) {
      const res = await fetch(`${base}${path}`, { method: 'OPTIONS', headers: { Authorization: basic } });
      expect(res.status, path).toBe(200);
      expect(res.headers.get('dav'), path).toMatch(/addressbook/);
      expect(res.headers.get('allow'), path).toMatch(/PROPFIND/);
    }
  });

  it("still answers the web app's preflight for the API", async () => {
    const res = await fetch(`${base}/api/anything`, {
      method: 'OPTIONS',
      headers: { Origin: APP, 'Access-Control-Request-Method': 'POST' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(APP);
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
  });

  it('still adds CORS headers to API responses', async () => {
    const res = await fetch(`${base}/api/anything`, { headers: { Origin: APP } });
    expect(res.headers.get('access-control-allow-origin')).toBe(APP);
  });
});
