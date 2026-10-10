import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The real rateLimiter runs against this in-memory Redis, so the tests see the shared
// auth:<ip> counter the login routes use.
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
vi.mock('../services/authLimiter.js', () => ({
  authLimiterConfig: { maxRequests: 3, windowMs: 60000 },
}));

import express from 'express';
import bcrypt from 'bcryptjs';
import carddavRouter from './carddav.js';
import { query } from '../services/db.js';
import { redisClient } from '../services/redis.js';

const USER = { id: 'u1', password_hash: bcrypt.hashSync('right', 4), totp_enabled: false };

function buildApp() {
  const app = express();
  app.use('/carddav', carddavRouter);
  return app;
}

describe('CardDAV Basic auth and the shared login rate limit', () => {
  let server;
  let base;

  beforeAll(async () => {
    await new Promise(resolve => {
      server = buildApp().listen(0, resolve);
    });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  beforeEach(() => {
    rs.store.clear();
    query.mockReset().mockResolvedValue({ rows: [USER] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // The discovery request every CardDAV client starts a sync with.
  const propfind = password => fetch(`${base}/carddav/`, {
    method: 'PROPFIND',
    headers: { Authorization: `Basic ${Buffer.from(`alice:${password}`).toString('base64')}` },
  });

  it('refuses the right password once wrong guesses have used up the budget', async () => {
    for (let i = 0; i < 3; i++) expect((await propfind('wrong')).status).toBe(401);
    const res = await propfind('right');
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('lets only the budgeted number of concurrent guesses reach the password check', async () => {
    const compare = vi.spyOn(bcrypt, 'compare');
    const responses = await Promise.all(Array.from({ length: 8 }, () => propfind('wrong')));
    expect(compare).toHaveBeenCalledTimes(3);
    expect(responses.map(r => r.status).sort((a, b) => a - b))
      .toEqual([401, 401, 401, 429, 429, 429, 429, 429]);
  });

  it('never limits a client that keeps sending the right password', async () => {
    for (let i = 0; i < 10; i++) expect((await propfind('right')).status).toBe(207);
  });

  it('does not count requests refused while right passwords are being checked', async () => {
    const compare = bcrypt.compare;
    let checking = 0;
    let open;
    const gate = new Promise(resolve => { open = resolve; });
    vi.spyOn(bcrypt, 'compare').mockImplementation(async (...args) => {
      checking++;
      await gate;
      return compare(...args);
    });
    let answered = 0;
    const burst = Array.from({ length: 6 }, () => propfind('right').then(r => { answered++; return r.status; }));
    // Three requests hold the whole budget inside the password check, and the other three are refused.
    await vi.waitFor(() => expect([checking, answered]).toEqual([3, 3]), { timeout: 4000 }).finally(open);
    expect((await Promise.all(burst)).sort((a, b) => a - b)).toEqual([207, 207, 207, 429, 429, 429]);
    expect((await propfind('right')).status).toBe(207);
  });

  it('keeps the slot of a request refused in the last seconds of the window', async () => {
    for (let i = 0; i < 3; i++) await propfind('wrong');
    // A hand-back this close to the end could land after the key expires and uncount a new guess.
    vi.spyOn(redisClient, 'pTTL').mockResolvedValue(1000);
    expect((await propfind('right')).status).toBe(429);
    expect([...rs.store.values()].map(e => e.v)).toEqual([4]);
  });

  it('hands back only the right password\'s own slot, not the wrong guesses before it', async () => {
    const statuses = [];
    for (const password of ['wrong', 'wrong', 'right', 'wrong', 'wrong']) {
      statuses.push((await propfind(password)).status);
    }
    expect(statuses).toEqual([401, 401, 207, 401, 429]);
  });

  it('counts and limits guesses at unknown and SSO-only usernames like any other', async () => {
    for (let i = 0; i < 2; i++) expect((await propfind('wrong')).status).toBe(401);
    query.mockResolvedValue({ rows: [] });
    expect((await propfind('wrong')).status).toBe(401);
    expect((await propfind('wrong')).status).toBe(429);
    query.mockResolvedValue({ rows: [{ ...USER, password_hash: null }] });
    expect((await propfind('wrong')).status).toBe(429);
  });

  it('does not use up the budget for a 2FA account whose password is right', async () => {
    query.mockResolvedValue({ rows: [{ ...USER, totp_enabled: true }] });
    for (let i = 0; i < 4; i++) expect((await propfind('right')).status).toBe(403);
  });

  it('does not use up the budget when the user lookup fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    query.mockRejectedValue(new Error('db down'));
    for (let i = 0; i < 4; i++) expect((await propfind('right')).status).toBe(500);
    query.mockResolvedValue({ rows: [USER] });
    expect((await propfind('right')).status).toBe(207);
  });
});
