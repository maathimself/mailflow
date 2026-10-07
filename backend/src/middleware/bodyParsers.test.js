import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { EventEmitter, once } from 'node:events';
import http from 'node:http';

// requireAuth runs for real; only its users-table lookup is stubbed. u1 is a live account. Any
// other id stands for an account deleted after its session was created: deleting a user leaves
// their sessions in the store.
vi.mock('../services/db.js', () => ({
  query: vi.fn(async (_sql, params) => ({ rows: params?.[0] === 'u1' ? [{ id: 'u1' }] : [] })),
}));

import express from 'express';
import session from 'express-session';
import { buildSessionOptions } from '../utils/sessionConfig.js';
import { requireAuth } from './auth.js';
import { mountBodyParsers } from './bodyParsers.js';

const LARGE_BODY_PATHS = ['/api/mail/send', '/api/mail/draft', '/api/gtd/pet/import'];
const TWO_MB = 2 * 1024 * 1024;
// Over the global 1 MB limit, so only the larger limits can accept it.
const OVER_1MB = JSON.stringify({ text: 'x'.repeat(TWO_MB) });

// Same order as index.js: the body parsers, then the session, the screen lock, the routers, which
// each start with router.use(requireAuth) except sign-in, and the last error handler. `parsed`
// records every body that got past the parsers, which is how far a request travels before a
// router can turn it away. `answered` records whether the whole request had arrived by the time
// its response went out. `sessionReads` fires once the parsers' paths have read a request's
// session, so a test can change that session while the body is still arriving, and
// `failStoreReads` makes the session store fail as Redis does while it restarts.
const parsed = [];
const answered = [];
const sessionReads = new EventEmitter();
let failStoreReads = false;
function buildApp() {
  const app = express();
  const store = new session.MemoryStore();
  const get = store.get.bind(store);
  store.get = (sid, callback) => (failStoreReads ? callback(new Error('store unavailable')) : get(sid, callback));
  const sessionMiddleware = session(buildSessionOptions(store, 'test-secret-'.padEnd(40, 'x')));
  app.use((req, res, next) => {
    res.on('finish', () => answered.push({ status: res.statusCode, bodyReceived: req.complete }));
    next();
  });
  mountBodyParsers(app, (req, res, next) => sessionMiddleware(req, res, (err) => {
    sessionReads.emit('read');
    next(err);
  }));
  app.use(sessionMiddleware);
  app.get('/login/:userId', (req, res) => { req.session.userId = req.params.userId; res.json({ ok: true }); });
  // A sign-in still waiting for its second factor, as POST /api/auth/login leaves one.
  app.get('/login-part-way', (req, res) => { req.session.pendingUserId = 'u1'; res.json({ ok: true }); });
  app.get('/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));
  app.get('/lock', (req, res) => { req.session.locked = true; res.json({ ok: true }); });
  // Stands in for index.js's screen-lock check.
  app.use((req, res, next) => (req.session?.locked ? res.status(423).json({ error: 'Locked', locked: true }) : next()));
  app.use((req, _res, next) => {
    if (req.body?.text) parsed.push(req.path);
    next();
  });
  // Stands in for POST /api/auth/login, which parses a JSON body from a signed-out client.
  app.post('/api/auth/login', (req, res) => res.json({ received: req.body }));
  const routes = express.Router();
  routes.use(requireAuth);
  routes.post([...LARGE_BODY_PATHS, '/api/rules'], (req, res) => res.json({ received: req.body.text.length }));
  app.use(routes);
  // Stands in for index.js's last error handler, which answers at once. Express's default one
  // would read off the body first and hide an error answered early.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => res.status(500).json({ error: 'Internal server error' }));
  return app;
}

let server;
let base;
let cookie;
// One per path, because requireAuth ends a deleted account's session when it turns it away.
const deletedAccountCookies = {};

// Resolves once the whole response has arrived. express-session holds back the last byte of a
// response until it has saved or touched the session, so by then the app has recorded its answer
// and none can land in the next test's `answered`.
async function fetchFully(path, init) {
  const res = await fetch(`${base}${path}`, init);
  await res.clone().arrayBuffer();
  return res;
}
const cookieFrom = (res) => (res.headers.get('set-cookie') || '').split(';')[0];
const signIn = async (userId) => cookieFrom(await fetchFully(`/login/${userId}`));

beforeAll(async () => {
  await new Promise((resolve) => { server = buildApp().listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  cookie = await signIn('u1');
  for (const path of LARGE_BODY_PATHS) deletedAccountCookies[path] = await signIn('deleted');
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  parsed.length = 0;
  answered.length = 0;
});

const post = (path, body, headers = {}) => fetchFully(path, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body,
});

// Sends OVER_1MB to `path` in two halves and runs `meanwhile(sessionCookie)` after the session
// has been read but before the second half goes out. Resolves to the response status once the
// response has been read in full.
async function postWhile(path, sessionCookie, meanwhile) {
  const request = http.request(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(OVER_1MB), cookie: sessionCookie },
  });
  const status = new Promise((resolve, reject) => {
    request.on('response', (res) => res.on('end', () => resolve(res.statusCode)).resume());
    request.on('error', reject);
  });
  const read = once(sessionReads, 'read');
  request.write(OVER_1MB.slice(0, TWO_MB / 2));
  await read;
  await meanwhile(sessionCookie);
  request.end(OVER_1MB.slice(TWO_MB / 2));
  return status;
}

describe('JSON body limits and sign-in', () => {
  it.each(LARGE_BODY_PATHS)('turns away a signed-out POST to %s without parsing its body', async (path) => {
    // The bug: these parsers ran before the session was loaded, so anyone could make the
    // server read, inflate and parse up to 35 MB before a router answered 401.
    const res = await post(path, OVER_1MB);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Not authenticated' });
    expect(parsed).toEqual([]);
    // The 401 waits until the rest of the body has arrived and been discarded. Behind nginx
    // every request is Connection: close, and answering one with body data still unread
    // resets the connection, which can lose the 401 on the way to the client.
    expect(answered).toEqual([{ status: 401, bodyReceived: true }]);

    // So does any session without a signed-in user: a cookie that names no session, and a
    // sign-in still waiting for its second factor.
    for (const other of ['connect.sid=s%3Anot-a-session.x', cookieFrom(await fetchFully('/login-part-way'))]) {
      expect((await post(path, OVER_1MB, { cookie: other })).status).toBe(401);
    }
    expect(parsed).toEqual([]);

    // A body that cannot parse gets the same 401, so the parser never ran, and so does a body
    // marked as gzip that is not, so nothing was inflated either.
    expect((await post(path, '{')).status).toBe(401);
    expect((await post(path, 'not gzip', { 'Content-Encoding': 'gzip' })).status).toBe(401);
  });

  it.each(LARGE_BODY_PATHS)('still accepts a signed-in body over 1 MB at %s', async (path) => {
    const res = await post(path, OVER_1MB, { cookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: TWO_MB });
  });

  it.each(LARGE_BODY_PATHS)('answers a session whose account was deleted only once its body has arrived at %s', async (path) => {
    // The router's requireAuth turns this session away, as on every other route. A check that
    // looked up the account in front of the parser would send that 401 with the body still
    // unread, which can lose it in the same way.
    const res = await post(path, OVER_1MB, { cookie: deletedAccountCookies[path] });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Not authenticated' });
    expect(answered).toEqual([{ status: 401, bodyReceived: true }]);
  });

  it.each(LARGE_BODY_PATHS)('still stops a POST to %s when the session signs out or locks during the upload', async (path) => {
    // The session is read before the body now, so it has to be read again once the body is
    // in, or a sign-out, lock or password reset during a long upload would not count.
    const signedOut = await postWhile(path, await signIn('u1'), (c) => fetchFully('/logout', { headers: { cookie: c } }));
    expect(signedOut).toBe(401);
    const locked = await postWhile(path, await signIn('u1'), (c) => fetchFully('/lock', { headers: { cookie: c } }));
    expect(locked).toBe(423);
  });

  it('answers a session store failure as an error, and only once the body has arrived', async () => {
    failStoreReads = true;
    try {
      const res = await post('/api/mail/draft', OVER_1MB, { cookie });
      expect(res.status).toBe(500);
    } finally {
      failStoreReads = false;
    }
    expect(answered).toEqual([{ status: 500, bodyReceived: true }]);

    // A failure when the session is read again after the upload is an error too, not a sign-out.
    try {
      expect(await postWhile('/api/mail/draft', cookie, () => { failStoreReads = true; })).toBe(500);
    } finally {
      failStoreReads = false;
    }
  });

  it('keeps the 1 MB limit on every other route', async () => {
    const res = await post('/api/rules', OVER_1MB, { cookie });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'Request too large. Total attachment size must not exceed 25 MB.' });
  });

  it('still parses a signed-out body on a route that does not require sign-in', async () => {
    const res = await post('/api/auth/login', JSON.stringify({ username: 'a' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: { username: 'a' } });
  });
});
