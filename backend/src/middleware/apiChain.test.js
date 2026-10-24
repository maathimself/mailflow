import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter, once } from 'node:events';
import http from 'node:http';

// The whole /api chain as index.js mounts it (mountApiAuth), with a real express-session on a
// MemoryStore, the real body parsers, CSRF check, screen lock, token guards and requireAuth, and
// stub routers in index.js's places. The rate limiter runs for real on this in-memory Redis.
const { rs, db } = vi.hoisted(() => ({
  rs: { store: new Map() },
  db: { enabled: true, tokens: new Map(), users: new Set(), events: [], used: [], failLookup: false, sources: [], folders: {}, messages: [] },
}));
vi.mock('../services/redis.js', () => ({
  redisClient: {
    async incr(k)        { const e = rs.store.get(k) || { v: 0, exp: 0 }; e.v++; rs.store.set(k, e); return e.v; },
    async decr(k)        { const e = rs.store.get(k) || { v: 0, exp: 0 }; e.v--; rs.store.set(k, e); return e.v; },
    async pExpire(k, ms) { const e = rs.store.get(k); if (e) e.exp = Date.now() + ms; return true; },
    async pTTL(k)        { const e = rs.store.get(k); return e ? (e.exp - Date.now()) : -2; },
    async del(k)         { rs.store.delete(k); return 1; },
  },
}));
vi.mock('../services/db.js', () => ({
  query: vi.fn(async (sql, params) => {
    if (sql.includes("key = 'api_tokens_enabled'")) return { rows: [{ value: db.enabled ? 'true' : 'false' }] };
    if (sql.includes('WHERE t.token_hash = $1')) {
      if (db.failLookup) throw new Error('database unavailable');
      const token = db.tokens.get(params[0]);
      return { rows: token ? [token] : [] };
    }
    if (sql.startsWith('SELECT 1 FROM api_tokens WHERE id = $1')) {
      return { rows: [...db.tokens.values()].some(t => t.id === params[0] && !t.expired) ? [{}] : [] };
    }
    if (sql.startsWith('UPDATE api_tokens SET last_used_at')) { db.used.push(params); return { rows: [] }; }
    if (sql.startsWith('SELECT id FROM users WHERE id = $1')) return { rows: db.users.has(params[0]) ? [{ id: params[0] }] : [] };
    if (sql.includes('INSERT INTO auth_events')) { db.events.push(params); return { rows: [] }; }
    if (sql.includes('bool_or(')) return { rows: db.sources };
    if (sql.startsWith('SELECT m.* FROM messages m')) return { rows: db.messages.filter(m => m.id === params[0]) };
    if (sql.includes('FROM folders WHERE account_id = $1 AND path = $2')) {
      const roles = db.folders[params[1]];
      return { rows: roles ? [{ no_select: false, special_use: null, ...roles }] : [] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  }),
}));
vi.mock('../services/lastSeen.js', () => ({ touchLastSeen: vi.fn() }));
vi.mock('../index.js', () => ({ imapManager: {} }));

import express from 'express';
import session from 'express-session';
import { readFileSync } from 'fs';
import { buildSessionOptions } from '../utils/sessionConfig.js';
import { touchLastSeen } from '../services/lastSeen.js';
import { generateToken, hashToken, invalidateApiTokenSettingsCache, resetTokenUseForTests } from '../services/apiTokens.js';
import { requireAuth } from './auth.js';
import { mountApiAuth } from './apiChain.js';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const ID1 = 'a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1';
const ONE_MB = 1024 * 1024;

// Tokens and their rows, as findTokenByHash returns them.
const tokens = {};
function addToken(key, { userId = 'u1', scopes = ['read', 'organize', 'draft'], expired = false } = {}) {
  const secret = generateToken();
  const row = {
    id: `${key}-id`, user_id: userId, name: key, scopes, created_at: new Date('2026-10-01T00:00:00Z'),
    expires_at: expired ? new Date('2026-10-02T00:00:00Z') : null, expired, username: userId === 'u1' ? 'maria' : userId,
  };
  db.tokens.set(hashToken(secret), row);
  tokens[key] = { secret, row };
}
const bearer = key => ({ Authorization: `Bearer ${tokens[key]?.secret ?? key}` });

// `answered` records each response and whether the whole request had arrived by then;
// `sessionReads` fires once the large-body path has looked for a session, as in bodyParsers.test.js.
const answered = [];
const sessionReads = new EventEmitter();
let store;
let server;
let base;

function buildApp() {
  const app = express();
  // As index.js sets it behind its proxy, so a test can say what the proxy wrote.
  app.set('trust proxy', 1);
  store = new session.MemoryStore();
  const sessionMiddleware = session(buildSessionOptions(store, 'test-secret-'.padEnd(40, 'x')));
  app.use((req, res, next) => {
    res.on('finish', () => answered.push({ path: req.originalUrl.split('?')[0], status: res.statusCode, bodyReceived: req.complete }));
    next();
  });
  mountApiAuth(app, (req, res, next) => sessionMiddleware(req, res, (err) => {
    sessionReads.emit('read');
    next(err);
  }));
  // Sign-in and lock stand-ins for a browser session.
  app.get('/login/:userId', (req, res) => { req.session.userId = req.params.userId; res.json({ ok: true }); });
  app.get('/lock', (req, res) => { req.session.locked = true; res.json({ ok: true }); });

  const who = (req, res) => res.json({ userId: req.session.userId, tokenId: req.apiToken?.id ?? null, body: req.body ?? null });
  const mail = express.Router();
  mail.use(requireAuth);
  mail.get('/messages', who);
  mail.post('/messages/bulk-read', who);
  mail.post('/messages/bulk-move', who);
  mail.post('/messages/:id/snooze', who);
  mail.post('/send', who);
  mail.post('/draft', (req, res) => res.json({ received: req.body.body.length, bodyIsHtml: req.body.bodyIsHtml }));
  app.use('/api/mail', mail);
  const accounts = express.Router();
  accounts.use(requireAuth);
  accounts.get('/', who);
  app.use('/api/accounts', accounts);
  // POST /api/auth/login: public, and parses a JSON body from a signed-out client.
  app.post('/api/auth/login', (req, res) => { req.session.userId = req.body.username; res.json({ signedIn: req.body.username }); });
  app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
  // Stands in for index.js's last error handler.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => res.status(500).json({ error: 'Internal server error' }));
  return app;
}

async function fetchFully(path, init) {
  const res = await fetch(`${base}${path}`, init);
  await res.clone().arrayBuffer();
  return res;
}
const cookieFrom = res => (res.headers.get('set-cookie') || '').split(';')[0];
const signIn = async userId => cookieFrom(await fetchFully(`/login/${userId}`));
const get = (path, headers = {}) => fetchFully(path, { headers });
const post = (path, body, headers = {}) => fetchFully(path, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body),
});
const failures = () => [...rs.store].filter(([k]) => k.startsWith('rl:apitoken-fail:')).reduce((n, [, e]) => n + e.v, 0);
const sessionCount = () => Object.keys(store.sessions).length;
const failEvents = () => db.events.filter(([type]) => type === 'api_token_auth_fail');

beforeAll(async () => {
  await new Promise(resolve => { server = buildApp().listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});

beforeEach(() => {
  rs.store.clear();
  db.enabled = true;
  db.failLookup = false;
  db.tokens.clear();
  db.users = new Set(['u1', 'u2']);
  db.events.length = 0;
  db.used.length = 0;
  db.sources = [{ id: ACCOUNT, imap_host: 'mail.example.com', oauth_provider: null, has_draft: false }];
  db.folders = { Archive: {}, Trash: { special_use: '\\Trash' } };
  db.messages = [];
  addToken('reader', { scopes: ['read'] });
  addToken('all');
  addToken('expired', { expired: true });
  addToken('orphan', { userId: 'deleted-user' });
  invalidateApiTokenSettingsCache();
  resetTokenUseForTests();
  touchLastSeen.mockClear();
  answered.length = 0;
});

describe('a valid token', () => {
  it('reaches an allowlisted route as its user, with no session or cookie made for it', async () => {
    const before = sessionCount();
    const res = await get('/api/mail/messages', bearer('reader'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ userId: 'u1', tokenId: 'reader-id' });
    expect(res.headers.get('set-cookie')).toBe(null);
    expect(sessionCount()).toBe(before);
    expect(db.used).toEqual([['reader-id', '127.0.0.1']]);
  });

  it('of any scope reaches the health check', async () => {
    addToken('drafter', { scopes: ['draft'] });
    const res = await get('/api/health', bearer('drafter'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('is a token request only: a session cookie on it is ignored', async () => {
    const cookie = await signIn('u2');
    const res = await get('/api/mail/messages', { ...bearer('reader'), cookie });
    expect(await res.json()).toMatchObject({ userId: 'u1', tokenId: 'reader-id' });
    expect(res.headers.get('set-cookie')).toBe(null);
    // Nor does a cookie rescue a token that fails.
    const refused = await get('/api/mail/messages', { ...bearer('mfat_unknown'), cookie });
    expect(refused.status).toBe(401);
  });

  it('does not count as the user being seen, as a browser request does', async () => {
    await get('/api/mail/messages', bearer('reader'));
    expect(touchLastSeen).not.toHaveBeenCalled();
    await get('/api/mail/messages', { cookie: await signIn('u1') });
    expect(touchLastSeen).toHaveBeenCalledWith('u1');
  });

  it('is never held by a screen lock, which belongs to a browser session', async () => {
    const cookie = await signIn('u2');
    await fetchFully('/lock', { headers: { cookie } });
    expect((await get('/api/accounts', { cookie })).status).toBe(423);
    expect((await get('/api/accounts', { ...bearer('reader'), cookie })).status).toBe(200);
  });

  it('whose user has gone gets 401, not a 500 from ending a session it does not have', async () => {
    const res = await get('/api/mail/messages', bearer('orphan'));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Invalid or expired API token' });
  });
});

describe('what a valid token may not do', () => {
  it('reach a route that is not on the allowlist, with the body read off first', async () => {
    const res = await post('/api/mail/send', { to: ['x@example.com'], pad: 'x'.repeat(256 * 1024) }, bearer('all'));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'This API token cannot be used for this request' });
    expect(answered).toEqual([{ path: '/api/mail/send', status: 403, bodyReceived: true }]);
    // Not a failed credential.
    expect(failures()).toBe(0);
    expect(failEvents()).toEqual([]);
  });

  it('use a route its scopes do not cover', async () => {
    const res = await post('/api/mail/messages/bulk-read', { ids: [ID1], read: true }, bearer('reader'));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'This API token does not have the organize scope' });
    expect(failures()).toBe(0);
  });

  it('move mail into Trash: the guards run once the body is parsed', async () => {
    const headers = bearer('all');
    expect((await post('/api/mail/messages/bulk-move', { ids: [ID1], folder: 'Archive' }, headers)).status).toBe(200);
    const res = await post('/api/mail/messages/bulk-move', { ids: [ID1], folder: 'Trash' }, headers);
    expect(res.status).toBe(403);
  });

  it('snooze a draft out of Drafts, which it may not move or archive either', async () => {
    db.messages = [{ id: ID1, account_id: ACCOUNT, folder: 'Drafts', message_id: '<d@example.com>', thread_id: null }];
    const until = { until: '2026-10-20T08:00:00Z' };
    expect((await post(`/api/mail/messages/${ID1}/snooze`, until, bearer('all'))).status).toBe(200);
    db.sources[0].has_draft = true;
    const res = await post(`/api/mail/messages/${ID1}/snooze`, until, bearer('all'));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'API tokens cannot move or archive drafts' });
  });

  it('send more than 1 MB: refused by its length before any parser reads it', async () => {
    const res = await rawPost('/api/mail/draft', { headers: { ...bearer('all'), 'Content-Length': 2 * ONE_MB } });
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: 'Request too large. API token requests must not exceed 1 MB.' });
    expect(res.headers.connection).toBe('close');
    expect(res.closedByServer).toBe(true);
  });

  it('send a draft over 1 MB without a length either', async () => {
    const draft = JSON.stringify({ accountId: ACCOUNT, to: ['a@example.com'], body: 'x'.repeat(ONE_MB + 10) });
    const res = await rawPost('/api/mail/draft', { headers: bearer('all'), chunks: [draft], end: true });
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: 'Request too large. API token requests must not exceed 1 MB.' });
  });
});

describe('a token that fails', () => {
  it.each([
    ['unknown', `Bearer ${generateToken()}`],
    ['malformed', 'Bearer mfat_short'],
    ['expired', null],
  ])('gets 401 with a Bearer challenge when %s, and is logged', async (kind, header) => {
    const headers = header ? { Authorization: header } : bearer('expired');
    const res = await post('/api/mail/messages/bulk-read', { ids: [ID1], read: true }, headers);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Invalid or expired API token' });
    expect(res.headers.get('www-authenticate')).toBe('Bearer realm="MailFlow", error="invalid_token"');
    // Only what could be a guess spends a slot of its address's failure budget.
    expect(failures()).toBe(kind === 'expired' ? 0 : 1);
    const [event] = failEvents();
    expect(event[0]).toBe('api_token_auth_fail');
    // The account is named only when the token was found, expired.
    expect(event[2]).toBe(kind === 'expired' ? 'u1' : null);
    expect(event.slice(4)).toEqual(['127.0.0.1', false]);
    expect(answered.at(-1).bodyReceived).toBe(true);
  });

  it('when expired, is told so every time rather than to wait, and leaves its address\'s budget alone', async () => {
    for (let i = 0; i < 25; i++) {
      const res = await get('/api/mail/messages', bearer('expired'));
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe('Bearer realm="MailFlow", error="invalid_token"');
    }
    // Logged, but not 25 times over.
    expect(failEvents()).toHaveLength(20);
    // A mistyped new token from the same address is still told it is wrong.
    expect((await get('/api/mail/messages', bearer(generateToken()))).status).toBe(401);
    expect(failures()).toBe(1);
  });

  it('gets 429 once 20 have failed from its address', async () => {
    for (let i = 0; i < 20; i++) expect((await get('/api/mail/messages', bearer(generateToken()))).status).toBe(401);
    const res = await get('/api/mail/messages', bearer(generateToken()));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'Too many failed API token attempts. Try again later.' });
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(failEvents()).toHaveLength(20);
  });

  it('gets 401 when tokens are turned off, whatever the token', async () => {
    db.enabled = false;
    for (const key of ['reader', generateToken()]) {
      const res = await get('/api/mail/messages', bearer(key));
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'API tokens are turned off on this server' });
    }
  });
});

describe('the failure budget never shuts out a valid token', () => {
  it('after 25 failures from the same address', async () => {
    for (let i = 0; i < 25; i++) await get('/api/mail/messages', bearer(generateToken()));
    expect((await get('/api/mail/messages', bearer(generateToken()))).status).toBe(429);
    expect((await get('/api/mail/messages', bearer('reader'))).status).toBe(200);
  });

  it('with 25 valid requests at once', async () => {
    const statuses = await Promise.all(Array.from({ length: 25 }, () => get('/api/mail/messages', bearer('reader')).then(r => r.status)));
    expect(statuses).toEqual(Array(25).fill(200));
    expect(failures()).toBe(0);
  });

  it('when the token lookup fails: nothing is counted, and later requests are judged afresh', async () => {
    db.failLookup = true;
    for (let i = 0; i < 25; i++) {
      expect((await post('/api/mail/messages/bulk-read', { ids: [ID1], read: true }, bearer('all'))).status).toBe(500);
    }
    expect(answered.at(-1)).toMatchObject({ status: 500, bodyReceived: true });
    db.failLookup = false;
    expect(failures()).toBe(0);
    expect((await get('/api/mail/messages', bearer(generateToken()))).status).toBe(401);
    expect((await get('/api/mail/messages', bearer('reader'))).status).toBe(200);
  });
});

describe('the address a token request comes from', () => {
  // What a proxy trusted too far, or a client it trusts, may write: not an address, or an address
  // too long for the VARCHAR(45) columns.
  const FORGED = ['not-an-address', `2001:db8::1%${'x'.repeat(60)}`];
  const failureKeys = () => [...rs.store.keys()].filter(k => k.startsWith('rl:apitoken-fail:'));

  it('is never a value that is not one: no budget of its own, and logged without one', async () => {
    for (const forwarded of FORGED) {
      expect((await get('/api/mail/messages', { ...bearer(generateToken()), 'X-Forwarded-For': forwarded })).status).toBe(401);
    }
    expect(failureKeys()).toEqual(['rl:apitoken-fail:unknown']);
    expect(failures()).toBe(2);
    expect(failEvents().map(event => event[4])).toEqual([null, null]);
  });

  it('is not recorded as where a token was last used unless it is one', async () => {
    expect((await get('/api/mail/messages', { ...bearer('reader'), 'X-Forwarded-For': FORGED[1] })).status).toBe(200);
    expect(db.used).toEqual([['reader-id', null]]);
  });

  it('is kept when it is one', async () => {
    await get('/api/mail/messages', { ...bearer(generateToken()), 'X-Forwarded-For': '203.0.113.9' });
    expect(failureKeys()).toEqual(['rl:apitoken-fail:203.0.113.9']);
    expect(failEvents()[0][4]).toBe('203.0.113.9');
  });
});

describe('the limits a valid token answers to', () => {
  const spend = (key, count) => rs.store.set(`rl:${key}`, { v: count, exp: Date.now() + 60_000 });

  it('600 requests per token per 5 minutes', async () => {
    spend('api-token:reader-id', 600);
    const res = await get('/api/mail/messages', bearer('reader'));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'Too many requests for this API token. Try again later.' });
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    // Another of the user's tokens still has its own.
    expect((await get('/api/mail/messages', bearer('all'))).status).toBe(200);
  });

  it('1200 requests per user across their tokens', async () => {
    spend('api-token-user:u1', 1200);
    for (const key of ['reader', 'all']) expect((await get('/api/mail/messages', bearer(key))).status).toBe(429);
  });

  it('60 drafts per user per 10 minutes', async () => {
    spend('api-token-draft:u1', 60);
    const draft = { accountId: ACCOUNT, to: ['a@example.com'], body: 'Hello' };
    expect((await post('/api/mail/draft', draft, bearer('all'))).status).toBe(429);
    // Only drafts.
    expect((await post('/api/mail/messages/bulk-read', { ids: [ID1], read: true }, bearer('all'))).status).toBe(200);
  });
});

describe('CSRF and token requests', () => {
  it('a token write needs no X-Requested-With, a cookie write still does', async () => {
    const body = { ids: [ID1], read: true };
    expect((await post('/api/mail/messages/bulk-read', body, bearer('all'))).status).toBe(200);
    const cookie = await signIn('u1');
    const refused = await post('/api/mail/messages/bulk-read', body, { cookie });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: 'Missing required X-Requested-With header' });
    expect((await post('/api/mail/messages/bulk-read', body, { cookie, 'X-Requested-With': 'MailFlow' })).status).toBe(200);
  });

  it('only a token that authenticated is exempt, not an Authorization header', async () => {
    const cookie = await signIn('u1');
    // An auth proxy's JWT leaves the cookie session in charge, and its CSRF check with it.
    const refused = await post('/api/mail/messages/bulk-read', { ids: [ID1], read: true }, { cookie, Authorization: 'Bearer eyJhbGciOi.eyJzdWIi.sig' });
    expect(refused.status).toBe(403);
    // Nor cached Basic credentials, which a browser can attach to a cross-site request by itself.
    const basic = await post('/api/mail/messages/bulk-read', { ids: [ID1], read: true }, { cookie, Authorization: 'Basic dTE6cGFzc3dvcmQ=' });
    expect(basic.status).toBe(403);
    expect(await basic.json()).toEqual({ error: 'Missing required X-Requested-With header' });
  });
});

describe('an Authorization header that is not an API token', () => {
  const JWT = { Authorization: 'Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJtYXJpYSJ9.c2ln' };

  it.each([true, false])('leaves the cookie session alone, tokens on: %s', async (enabled) => {
    db.enabled = enabled;
    const cookie = await signIn('u2');
    const res = await get('/api/mail/messages', { ...JWT, cookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ userId: 'u2', tokenId: null });
    const basic = await get('/api/mail/messages', { Authorization: 'Basic dTI6cGFzc3dvcmQ=', cookie });
    expect(basic.status).toBe(200);
    expect(failures()).toBe(0);
  });

  it.each([true, false])('still lets the browser sign in, tokens on: %s', async (enabled) => {
    db.enabled = enabled;
    const res = await post('/api/auth/login', { username: 'u2' }, { ...JWT, 'X-Requested-With': 'MailFlow' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ signedIn: 'u2' });
    expect(cookieFrom(res)).toMatch(/^connect\.sid=/);
    expect(failures()).toBe(0);
  });
});

describe('a token draft', () => {
  const draft = { accountId: ACCOUNT, to: ['a@example.com'], body: 'x'.repeat(600 * 1024) };

  it('is read in, checked again and handed to the route as plain text', async () => {
    const res = await post('/api/mail/draft', draft, bearer('all'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: 600 * 1024, bodyIsHtml: false });
  });

  it('is stopped by revoking the token while it uploads', async () => {
    const status = await postWhile('/api/mail/draft', JSON.stringify(draft), bearer('all'), () => db.tokens.delete(hashToken(tokens.all.secret)));
    expect(status).toEqual({ status: 401, body: { error: 'Invalid or expired API token' } });
  });

  it('is stopped by turning tokens off while it uploads', async () => {
    const status = await postWhile('/api/mail/draft', JSON.stringify(draft), bearer('all'), () => {
      db.enabled = false;
      invalidateApiTokenSettingsCache();
    });
    expect(status.status).toBe(401);
  });
});

describe('refused bodies are read off only up to 1 MB', () => {
  it('a longer one is not waited for: the answer goes out and the connection is dropped', async () => {
    // Only the headers are sent: the 2 MB the request declares never comes.
    const res = await rawPost('/api/mail/send', { headers: { ...bearer('all'), 'Content-Length': 2 * ONE_MB } });
    expect(res.status).toBe(403);
    expect(res.headers.connection).toBe('close');
    expect(res.closedByServer).toBe(true);
    expect(answered.at(-1)).toMatchObject({ status: 403, bodyReceived: false });
  });

  it('nor is one that is all sent, 2 MB of it', async () => {
    const chunks = Array(32).fill('x'.repeat(64 * 1024));
    const res = await rawPost('/api/mail/send', { headers: { ...bearer('all'), 'Content-Length': 2 * ONE_MB }, chunks, end: true });
    expect(answered.at(-1)).toMatchObject({ path: '/api/mail/send', status: 403 });
    expect(res.closedByServer).toBe(true);
    // A client still sending may see the connection reset instead of the answer.
    if (!res.reset) expect([res.status, res.headers.connection]).toEqual([403, 'close']);
  });

  it('nor one without a length that turns out longer', async () => {
    // Just over 1 MB, and the request is never finished.
    const res = await rawPost('/api/mail/send', { headers: bearer(generateToken()), chunks: Array(17).fill('x'.repeat(64 * 1024)) });
    expect(answered.at(-1)).toMatchObject({ path: '/api/mail/send', status: 401, bodyReceived: false });
    expect(res.closedByServer).toBe(true);
    if (!res.reset) expect([res.status, res.headers.connection]).toEqual([401, 'close']);
  });

  it('a shorter one is read off in full, and the connection kept', async () => {
    const res = await post('/api/mail/send', { pad: 'x'.repeat(900 * 1024) }, bearer('all'));
    expect(res.status).toBe(403);
    expect(res.headers.get('connection')).not.toBe('close');
    expect(answered.at(-1)).toMatchObject({ status: 403, bodyReceived: true });
  });
});

describe('index.js', () => {
  it('mounts this chain ahead of every router', () => {
    const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    const mounted = index.indexOf('mountApiAuth(app, sessionMiddleware);');
    expect(mounted).toBeGreaterThan(0);
    expect(index.indexOf("app.use('/api/auth', authRoutes);")).toBeGreaterThan(mounted);
    // Nothing of the chain is mounted a second time, out of order.
    for (const piece of ['mountBodyParsers(', 'app.use(sessionMiddleware)', 'CSRF_SAFE_METHODS', 'LOCK_ALLOWED']) {
      expect(index, piece).not.toContain(piece);
    }
  });
});

// Sends `body` in two halves and runs `meanwhile` once the session has been looked for, before the
// second half goes out. Resolves to the answer once it has been read in full.
async function postWhile(path, body, headers, meanwhile) {
  const request = http.request(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers },
  });
  const answer = new Promise((resolve, reject) => {
    request.on('response', (res) => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    request.on('error', reject);
  });
  const read = once(sessionReads, 'read');
  request.write(body.slice(0, body.length / 2));
  await read;
  await meanwhile();
  request.end(body.slice(body.length / 2));
  return answer;
}

// A POST the server may cut off: sends the headers, then any chunks, and ends the request only when
// asked. It asks to keep the connection, as undici and other clients that reach the backend directly
// do, so only the server can have it closed, by closing it or by answering Connection: close.
// Resolves with the answer, or reset: true when the connection was reset before one could be read,
// and closedByServer: whether the connection was closed within a second of that.
async function rawPost(path, { headers, chunks = [], end = false }) {
  const agent = new http.Agent({ keepAlive: true });
  const request = http.request(`${base}${path}`, { method: 'POST', agent, headers: { 'Content-Type': 'application/json', ...headers } });
  const socket = new Promise(resolve => request.once('socket', resolve));
  const outcome = new Promise((resolve) => {
    request.on('response', (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text ? JSON.parse(text) : null }));
      res.on('error', () => resolve({ reset: true }));
    });
    request.on('error', () => resolve({ reset: true }));
  });
  request.flushHeaders();
  for (const chunk of chunks) request.write(chunk);
  if (end) request.end();
  const result = await outcome;
  const connection = await socket;
  let timer;
  const closedByServer = connection.destroyed || await Promise.race([
    once(connection, 'close').then(() => true),
    new Promise(resolve => { timer = setTimeout(resolve, 1000, false); }),
  ]);
  clearTimeout(timer);
  agent.destroy();
  return { ...result, closedByServer };
}
