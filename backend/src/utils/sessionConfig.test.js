import { afterEach, describe, it, expect, vi } from 'vitest';
import express from 'express';
import session from 'express-session';
import { buildSessionOptions, parseSessionIdleDays, SESSION_IDLE_MS } from './sessionConfig.js';

// Drives the real express-session middleware rather than asserting on the options object,
// because the defect in #465 was behavioral: the options looked reasonable and the cookie
// still was not re-sent.
function startApp(overrides = {}) {
  const app = express();
  const opts = { ...buildSessionOptions(new session.MemoryStore(), 'test-secret-'.padEnd(40, 'x')), ...overrides };
  app.use(session(opts));
  // A read-only route: it must not modify the session, which is the whole point. Reading
  // mail is all requests like this one.
  app.get('/read', (req, res) => res.json({ views: req.session.views ?? 0 }));
  app.get('/login', (req, res) => { req.session.userId = 'u1'; res.json({ ok: true }); });
  return new Promise(resolve => {
    const server = app.listen(0, () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

const cookieFrom = (res) => (res.headers.get('set-cookie') || '').split(';')[0];

describe('session cookie lifetime (#465)', () => {
  it('re-sends the cookie on a request that does not modify the session', async () => {
    // The bug: the cookie was refreshed only when the session changed, so a user who only
    // read mail kept the cookie issued at login and was signed out a fixed 7 days later.
    const { server, base } = await startApp();
    try {
      const login = await fetch(`${base}/login`);
      const cookie = cookieFrom(login);
      expect(cookie).toBeTruthy();

      const read = await fetch(`${base}/read`, { headers: { cookie } });
      expect(read.headers.get('set-cookie')).toBeTruthy();
    } finally {
      server.close();
    }
  });

  it('does not re-send it when rolling is off, which is the behavior being fixed', async () => {
    const { server, base } = await startApp({ rolling: false });
    try {
      const login = await fetch(`${base}/login`);
      const read = await fetch(`${base}/read`, { headers: { cookie: cookieFrom(login) } });
      expect(read.headers.get('set-cookie')).toBeNull();
    } finally {
      server.close();
    }
  });

  it('keeps the cookie http-only, lax and secure-when-proxied', async () => {
    const opts = buildSessionOptions(new session.MemoryStore(), 'x'.repeat(40));
    expect(opts.cookie.httpOnly).toBe(true);
    expect(opts.cookie.sameSite).toBe('lax');
    expect(opts.cookie.secure).toBe('auto');
    expect(opts.resave).toBe(false);
    expect(opts.saveUninitialized).toBe(false);
  });

  it('measures the idle window in days, not minutes', () => {
    expect(SESSION_IDLE_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe('SESSION_IDLE_DAYS (D#400)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('defaults to 7 days when unset or empty', () => {
    expect(parseSessionIdleDays(undefined)).toBe(7);
    expect(parseSessionIdleDays('')).toBe(7);
    expect(parseSessionIdleDays('  ')).toBe(7);
  });

  it('takes whole days from 1 to 365', () => {
    expect(parseSessionIdleDays('1')).toBe(1);
    expect(parseSessionIdleDays(' 30 ')).toBe(30);
    expect(parseSessionIdleDays('365')).toBe(365);
  });

  it('refuses anything else instead of guessing', () => {
    for (const bad of ['0', '366', '-5', '1.5', '30d', '1e3', 'abc', '0x10', '99999999999999999999']) {
      expect(parseSessionIdleDays(bad), bad).toBeNull();
    }
  });

  it('sets the cookie lifetime from the environment', async () => {
    vi.stubEnv('SESSION_IDLE_DAYS', '30');
    vi.resetModules();
    const fresh = await import('./sessionConfig.js');
    expect(fresh.SESSION_IDLE_MS).toBe(30 * 24 * 60 * 60 * 1000);
    expect(fresh.buildSessionOptions(new session.MemoryStore(), 'x'.repeat(40)).cookie.maxAge).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it('sends a cookie that lasts the configured days', async () => {
    vi.stubEnv('SESSION_IDLE_DAYS', '180');
    vi.resetModules();
    const fresh = await import('./sessionConfig.js');
    const app = express();
    app.use(session(fresh.buildSessionOptions(new session.MemoryStore(), 'x'.repeat(40))));
    app.get('/login', (req, res) => { req.session.userId = 'u1'; res.json({ ok: true }); });
    const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/login`);
      const expires = /Expires=([^;]+)/.exec(res.headers.get('set-cookie'))[1];
      const days = (new Date(expires).getTime() - Date.now()) / (24 * 60 * 60 * 1000);
      expect(days).toBeGreaterThan(179.9);
      expect(days).toBeLessThanOrEqual(180);
    } finally {
      server.close();
    }
  });

  it('falls back to 7 days for an invalid value when imported without the server', async () => {
    vi.stubEnv('SESSION_IDLE_DAYS', '30d');
    vi.resetModules();
    const fresh = await import('./sessionConfig.js');
    expect(fresh.SESSION_IDLE_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});
