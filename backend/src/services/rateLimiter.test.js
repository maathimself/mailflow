import { describe, it, expect, beforeEach, vi } from 'vitest';

// Shared mock Redis state (hoisted so the vi.mock factory can reference it).
const { rs } = vi.hoisted(() => ({ rs: { fail: false, store: new Map() } }));
vi.mock('./redis.js', () => ({
  redisClient: {
    async incr(k)        { if (rs.fail) throw new Error('down'); const e = rs.store.get(k) || { v: 0, exp: 0 }; e.v++; rs.store.set(k, e); return e.v; },
    async pExpire(k, ms) { if (rs.fail) throw new Error('down'); const e = rs.store.get(k); if (e) e.exp = Date.now() + ms; return true; },
    async pTTL(k)        { if (rs.fail) throw new Error('down'); const e = rs.store.get(k); return e ? (e.exp - Date.now()) : -2; },
    async decr(k)        { if (rs.fail) throw new Error('down'); const e = rs.store.get(k) || { v: 0, exp: 0 }; e.v--; rs.store.set(k, e); return e.v; },
    async del(k)         { if (rs.fail) throw new Error('down'); rs.store.delete(k); return 1; },
  },
}));

const { consume, reset, release } = await import('./rateLimiter.js');

describe('rateLimiter — Redis path', () => {
  beforeEach(() => { rs.fail = false; rs.store.clear(); });

  it('allows up to max requests then limits', async () => {
    const out = [];
    for (let i = 0; i < 4; i++) out.push((await consume('k1', 3, 60000)).limited);
    expect(out).toEqual([false, false, false, true]);
  });

  it('reports a positive resetMs while limited', async () => {
    await consume('k2', 1, 60000);
    const r = await consume('k2', 1, 60000);
    expect(r.limited).toBe(true);
    expect(r.resetMs).toBeGreaterThan(0);
  });

  it('reset() clears the counter', async () => {
    await consume('k3', 1, 60000);
    expect((await consume('k3', 1, 60000)).limited).toBe(true);
    await reset('k3');
    expect((await consume('k3', 1, 60000)).limited).toBe(false);
  });

  it('release() hands back one hit', async () => {
    await consume('k4', 2, 60000);
    await consume('k4', 2, 60000);
    await release('k4');
    expect((await consume('k4', 2, 60000)).limited).toBe(false);
    expect((await consume('k4', 2, 60000)).limited).toBe(true);
  });

  it('release() on an expired key does not leave a spare hit behind', async () => {
    await release('k5');
    expect((await consume('k5', 1, 60000)).limited).toBe(false);
    expect((await consume('k5', 1, 60000)).limited).toBe(true);
  });
});

describe('rateLimiter — in-memory fallback when Redis is down', () => {
  beforeEach(() => { rs.fail = true; });

  it('still enforces the limit', async () => {
    const key = 'mem-' + Math.random();
    const out = [];
    for (let i = 0; i < 4; i++) out.push((await consume(key, 3, 60000)).limited);
    expect(out).toEqual([false, false, false, true]);
  });

  it('reset() clears the in-memory counter', async () => {
    const key = 'mem-' + Math.random();
    await consume(key, 1, 60000);
    expect((await consume(key, 1, 60000)).limited).toBe(true);
    await reset(key);
    expect((await consume(key, 1, 60000)).limited).toBe(false);
  });

  it('release() hands back one in-memory hit, never below zero', async () => {
    const key = 'mem-' + Math.random();
    await release(key);
    await consume(key, 1, 60000);
    await release(key);
    await release(key);
    expect((await consume(key, 1, 60000)).limited).toBe(false);
    expect((await consume(key, 1, 60000)).limited).toBe(true);
  });
});
