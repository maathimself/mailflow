import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import pg from 'pg';

// kvStore.js, sessionStore.js and userSessions.js against PostgreSQL, in a schema of their own
// made from the real migration, over a pool so concurrent statements really are concurrent.
const boundary = vi.hoisted(() => ({ pool: null }));
vi.mock('./db.js', () => ({ query: (text, params) => boundary.pool.query(text, params) }));
vi.mock('../index.js', () => ({ imapManager: { closeSockets: vi.fn() } }));

const { kv, sweepExpired } = await import('./kvStore.js');
const { PgSessionStore } = await import('./sessionStore.js');
const { destroyUserSessions } = await import('./userSessions.js');
const { consume, release } = await import('./rateLimiter.js');

const MIGRATION = new URL('../../migrations/0076_sessions_and_kv_store.sql', import.meta.url);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const call = (fn) => new Promise((resolve, reject) => fn((err, v) => (err ? reject(err) : resolve(v))));

describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('sessions and kv_store in PostgreSQL', () => {
  const schema = `kv_test_${process.pid}_${Date.now()}`;
  let admin;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    boundary.pool = new pg.Pool({
      connectionString: process.env.MAILFLOW_TEST_DATABASE_URL, max: 8, options: `-c search_path=${schema}`,
    });
    await boundary.pool.query(readFileSync(MIGRATION, 'utf8'));
  });
  afterAll(async () => {
    await boundary.pool?.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });
  beforeEach(async () => { await boundary.pool.query('TRUNCATE kv_store, sessions'); });

  describe('kv', () => {
    it('reads back what it set, and nothing for an absent key', async () => {
      expect(await kv.set('a', 'one')).toBe('OK');
      expect(await kv.get('a')).toBe('one');
      expect(await kv.get('missing')).toBeNull();
      expect(await kv.del('a')).toBe(1);
      expect(await kv.get('a')).toBeNull();
    });

    it('a key past its expiry reads as absent, and SET NX succeeds over it', async () => {
      await kv.set('t', 'x', { PX: 30 });
      expect(await kv.get('t')).toBe('x');
      await sleep(60);
      expect(await kv.get('t')).toBeNull();
      expect(await kv.pTTL('t')).toBe(-2);
      expect(await kv.set('t', 'y', { NX: true, EX: 60 })).toBe('OK');
      expect(await kv.get('t')).toBe('y');
    });

    it('SET NX refuses a live key, with or without an expiry', async () => {
      await kv.set('n', '1', { EX: 60 });
      await kv.set('forever', '1');
      expect(await kv.set('n', '2', { NX: true, EX: 60 })).toBeNull();
      expect(await kv.set('forever', '2', { NX: true })).toBeNull();
      expect(await kv.get('n')).toBe('1');
    });

    it('concurrent SET NX on one key has exactly one winner', async () => {
      const results = await Promise.all(Array.from({ length: 24 }, (_, i) => kv.set('race', String(i), { NX: true, EX: 90 })));
      expect(results.filter(r => r === 'OK')).toHaveLength(1);
    });

    it('INCR and DECR count from an absent key, and concurrent INCRs lose nothing', async () => {
      expect(await kv.incr('c')).toBe(1);
      expect(await kv.decr('d')).toBe(-1);
      await Promise.all(Array.from({ length: 40 }, () => kv.incr('c')));
      expect(await kv.get('c')).toBe('41');
    });

    it('INCR on an expired counter starts again at 1 with no expiry', async () => {
      await kv.incr('e');
      await kv.pExpire('e', 30);
      await sleep(60);
      expect(await kv.incr('e')).toBe(1);
      expect(await kv.pTTL('e')).toBe(-1);
    });

    it('PTTL answers -1 without an expiry and the time left with one', async () => {
      await kv.set('p', 'v');
      expect(await kv.pTTL('p')).toBe(-1);
      expect(await kv.pExpire('p', 60000)).toBe(true);
      const ttl = await kv.pTTL('p');
      expect(ttl).toBeGreaterThan(55000);
      expect(ttl).toBeLessThanOrEqual(60000);
      expect(await kv.pExpire('absent', 1000)).toBe(false);
    });

    it('the sweep deletes expired rows only', async () => {
      await kv.set('old', 'x', { PX: 1 });
      await kv.set('live', 'x', { EX: 60 });
      await kv.set('forever', 'x');
      await sleep(20);
      await sweepExpired();
      const { rows } = await boundary.pool.query('SELECT key FROM kv_store ORDER BY key');
      expect(rows.map(r => r.key)).toEqual(['forever', 'live']);
    });
  });

  describe('the rate limiter on kv', () => {
    it('limits after max hits in the window and hands one back on release', async () => {
      const hits = [];
      for (let i = 0; i < 4; i++) hits.push((await consume('login:1.2.3.4', 3, 60000)).limited);
      expect(hits).toEqual([false, false, false, true]);
      await release('login:1.2.3.4');
      await release('login:1.2.3.4');
      expect((await consume('login:1.2.3.4', 3, 60000)).limited).toBe(false);
    });

    it('starts a new window once the old one has passed', async () => {
      await consume('w', 1, 40);
      expect((await consume('w', 1, 40)).limited).toBe(true);
      await sleep(80);
      const next = await consume('w', 1, 40);
      expect(next.limited).toBe(false);
      expect(next.resetMs).toBe(40);
    });
  });

  describe('PgSessionStore', () => {
    const store = new PgSessionStore();
    const sess = (userId, ms = 60000) => ({ cookie: { expires: new Date(Date.now() + ms).toISOString() }, userId });

    it('stores, reads back and destroys a session, keeping its owner', async () => {
      await call(cb => store.set('s1', sess('u1'), cb));
      expect(await call(cb => store.get('s1', cb))).toMatchObject({ userId: 'u1' });
      const { rows } = await boundary.pool.query('SELECT user_id FROM sessions');
      expect(rows).toEqual([{ user_id: 'u1' }]);
      await call(cb => store.destroy('s1', cb));
      expect(await call(cb => store.get('s1', cb))).toBeNull();
    });

    it('an expired session reads as ended', async () => {
      await call(cb => store.set('gone', sess('u1', 20), cb));
      await sleep(50);
      expect(await call(cb => store.get('gone', cb))).toBeNull();
    });

    it('touch moves the expiry only when it moves by more than a minute', async () => {
      const at = Date.now() + 3600000;
      await call(cb => store.set('t', sess('u1', 3600000), cb));
      const expiry = async () => (await boundary.pool.query("SELECT expires_at FROM sessions WHERE sid = 't'")).rows[0].expires_at.getTime();
      await call(cb => store.touch('t', { cookie: { expires: new Date(at + 30000).toISOString() } }, cb));
      expect(Math.abs(await expiry() - at)).toBeLessThan(1000);
      await call(cb => store.touch('t', { cookie: { expires: new Date(at + 120000).toISOString() } }, cb));
      expect(Math.abs(await expiry() - (at + 120000))).toBeLessThan(1000);
    });

    it('a session without a cookie expiry gets the idle window', async () => {
      await call(cb => store.set('nocookie', { userId: 'u1' }, cb));
      const { rows } = await boundary.pool.query("SELECT expires_at FROM sessions WHERE sid = 'nocookie'");
      expect(rows[0].expires_at.getTime() - Date.now()).toBeGreaterThan(6 * 24 * 3600000);
    });

    it("destroyUserSessions deletes the user's sessions only, sparing an excepted one", async () => {
      for (const [sid, user] of [['a', 'u1'], ['b', 'u1'], ['c', 'u2'], ['pending', undefined]]) {
        await call(cb => store.set(sid, sess(user), cb));
      }
      await destroyUserSessions('u1', { exceptSessionId: 'b' });
      const left = async () => (await boundary.pool.query('SELECT sid FROM sessions ORDER BY sid')).rows.map(r => r.sid);
      expect(await left()).toEqual(['b', 'c', 'pending']);
      await destroyUserSessions('u1');
      expect(await left()).toEqual(['c', 'pending']);
    });
  });
});
