import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import session from 'express-session';

const prefs = new Map(); // userId -> preferences.sessionDays as stored (text from ->>)
const query = vi.fn(async (_sql, [userId]) => ({ rows: prefs.has(userId) ? [{ days: prefs.get(userId) }] : [{ days: null }] }));
vi.mock('./db.js', () => ({ query: (...args) => query(...args) }));

import {
  applySessionLifetime, parseSessionDays, rememberSessionDays, sessionLifetimeMs,
  DEFAULT_SESSION_DAYS, SESSION_DAY_CHOICES, _resetSessionLifetimeCache,
} from './sessionLifetime.js';
import { buildSessionOptions } from '../utils/sessionConfig.js';

const DAY = 24 * 60 * 60 * 1000;

// The real express-session with the real options, so the cookie the browser gets is checked.
function startApp({ apiToken = false } = {}) {
  const app = express();
  app.use(session(buildSessionOptions(new session.MemoryStore(), 'x'.repeat(40))));
  if (apiToken) app.use((req, _res, next) => { req.apiToken = { id: 't1' }; next(); });
  app.use(applySessionLifetime);
  app.get('/login/:id', (req, res) => { req.session.userId = req.params.id; res.json({ ok: true }); });
  app.get('/read', (_req, res) => res.json({ ok: true }));
  return new Promise(resolve => {
    const server = app.listen(0, () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}
const daysLeft = res => (new Date(/Expires=([^;]+)/.exec(res.headers.get('set-cookie'))[1]).getTime() - Date.now()) / DAY;

beforeEach(() => { prefs.clear(); query.mockClear(); _resetSessionLifetimeCache(); });
afterEach(() => vi.restoreAllMocks());

describe('parseSessionDays', () => {
  it('takes the offered choices and 0 for the default', () => {
    for (const n of SESSION_DAY_CHOICES) {
      expect(parseSessionDays(n)).toBe(n);
      expect(parseSessionDays(String(n))).toBe(n);
    }
    expect(parseSessionDays(0)).toBe(0);
    expect(parseSessionDays('0')).toBe(0);
  });

  it('refuses anything else, including days beyond 90', () => {
    for (const bad of [1, 8, 91, 180, 365, -7, 7.5, '30d', 'abc', null, true, {}, []]) {
      expect(parseSessionDays(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('turns a choice into a lifetime, and anything else into the server default', () => {
    expect(sessionLifetimeMs(30)).toBe(30 * DAY);
    expect(sessionLifetimeMs(0)).toBe(DEFAULT_SESSION_DAYS * DAY);
    expect(sessionLifetimeMs(500)).toBe(DEFAULT_SESSION_DAYS * DAY);
  });
});

describe('applySessionLifetime (D#400)', () => {
  it("gives a signed-in user's cookie their chosen lifetime", async () => {
    prefs.set('u30', '30');
    const { server, base } = await startApp();
    try {
      const login = await fetch(`${base}/login/u30`);
      const cookie = login.headers.get('set-cookie').split(';')[0];
      const read = await fetch(`${base}/read`, { headers: { cookie } });
      expect(daysLeft(read)).toBeGreaterThan(29.9);
      expect(daysLeft(read)).toBeLessThanOrEqual(30);
    } finally { server.close(); }
  });

  it('uses the server default for a user who has not chosen', async () => {
    const { server, base } = await startApp();
    try {
      const login = await fetch(`${base}/login/unset`);
      const read = await fetch(`${base}/read`, { headers: { cookie: login.headers.get('set-cookie').split(';')[0] } });
      expect(daysLeft(read)).toBeGreaterThan(DEFAULT_SESSION_DAYS - 0.1);
      expect(daysLeft(read)).toBeLessThanOrEqual(DEFAULT_SESSION_DAYS);
    } finally { server.close(); }
  });

  it('follows a change on the next request, and shortens as well as lengthens', async () => {
    prefs.set('u', '90');
    const { server, base } = await startApp();
    try {
      const login = await fetch(`${base}/login/u`);
      const cookie = login.headers.get('set-cookie').split(';')[0];
      expect(daysLeft(await fetch(`${base}/read`, { headers: { cookie } }))).toBeGreaterThan(89.9);
      rememberSessionDays('u', 7); // what PATCH /preferences does
      const after = daysLeft(await fetch(`${base}/read`, { headers: { cookie } }));
      expect(after).toBeGreaterThan(6.9);
      expect(after).toBeLessThanOrEqual(7);
    } finally { server.close(); }
  });

  it('reads the choice once and then from its cache', async () => {
    prefs.set('u', '14');
    const { server, base } = await startApp();
    try {
      const login = await fetch(`${base}/login/u`);
      const cookie = login.headers.get('set-cookie').split(';')[0];
      for (let i = 0; i < 3; i++) await fetch(`${base}/read`, { headers: { cookie } });
      expect(query).toHaveBeenCalledTimes(1);
    } finally { server.close(); }
  });

  it('ignores a stored value that is not a choice', async () => {
    prefs.set('u', '365');
    const { server, base } = await startApp();
    try {
      const login = await fetch(`${base}/login/u`);
      const read = await fetch(`${base}/read`, { headers: { cookie: login.headers.get('set-cookie').split(';')[0] } });
      expect(daysLeft(read)).toBeLessThanOrEqual(DEFAULT_SESSION_DAYS);
    } finally { server.close(); }
  });

  it('keeps the current lifetime when the lookup fails, and still answers', async () => {
    query.mockRejectedValueOnce(new Error('db down'));
    const req = { session: { userId: 'u', cookie: { maxAge: 123 } } };
    const next = vi.fn();
    await applySessionLifetime(req, {}, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.session.cookie.maxAge).toBe(123);
  });

  it('leaves signed-out and API token requests alone', async () => {
    const next = vi.fn();
    await applySessionLifetime({ session: { cookie: { maxAge: 1 } } }, {}, next);
    await applySessionLifetime({ apiToken: { id: 't' }, session: { userId: 'u' } }, {}, next);
    expect(next).toHaveBeenCalledTimes(2);
    expect(query).not.toHaveBeenCalled();
  });
});
