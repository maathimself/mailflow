import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map();
vi.mock('./redis.js', () => ({
  redisClient: {
    set: vi.fn(async (key, value) => { store.set(key, value); return 'OK'; }),
    get: vi.fn(async key => store.get(key) ?? null),
  },
}));

import { holdSend, cancelSend, getSendStatus, flushHeldSends, heldSendCount } from './sendHold.js';

const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

beforeEach(() => {
  store.clear();
  vi.useFakeTimers();
});
afterEach(async () => {
  await flushHeldSends(0);
  vi.useRealTimers();
});

describe('holdSend', () => {
  it('waits out the window, then delivers once and records the result', async () => {
    const run = vi.fn().mockResolvedValue({ ok: true, sentFolder: 'Sent' });
    const { id, sendAt } = await holdSend({ userId: 'u1', delayMs: 10_000, run });
    expect(Date.parse(sendAt)).toBeGreaterThan(Date.now());
    expect(await getSendStatus('u1', id)).toEqual({ status: 'pending' });

    await vi.advanceTimersByTimeAsync(9_999);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(run).toHaveBeenCalledOnce();
    expect(await getSendStatus('u1', id)).toEqual({ status: 'sent', result: { ok: true, sentFolder: 'Sent' } });
    expect(heldSendCount()).toBe(0);
  });

  it('records the send as delivered as soon as SMTP accepts it, before the bookkeeping after', async () => {
    let finishBookkeeping;
    const run = vi.fn(async (onDelivered) => {
      await onDelivered();
      await new Promise(resolve => { finishBookkeeping = resolve; }); // the Sent copy, say
      return { ok: true, sentFolder: 'Sent' };
    });
    const { id } = await holdSend({ userId: 'u1', delayMs: 1000, run });
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    // What a restarted process would read if this one died now.
    expect(JSON.parse(store.get(`send_hold:u1:${id}`))).toEqual({ status: 'sent', result: { ok: true } });
    finishBookkeeping();
    await flush();
    expect(await getSendStatus('u1', id)).toEqual({ status: 'sent', result: { ok: true, sentFolder: 'Sent' } });
  });

  it('records a failure with the message that is safe to show', async () => {
    const run = vi.fn().mockRejectedValue(Object.assign(new Error('535 bad credentials'), { publicMessage: 'Authentication failed.' }));
    const { id } = await holdSend({ userId: 'u1', delayMs: 1000, run });
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(await getSendStatus('u1', id)).toEqual({ status: 'failed', error: 'Authentication failed.' });
  });
});

describe('cancelSend', () => {
  it('undoes a send that has not started: it never delivers', async () => {
    const run = vi.fn().mockResolvedValue({ ok: true });
    const onCancel = vi.fn();
    const { id } = await holdSend({ userId: 'u1', delayMs: 10_000, run, onCancel });
    expect(await cancelSend('u1', id)).toEqual({ cancelled: true });
    expect(onCancel).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).not.toHaveBeenCalled();
    expect(await getSendStatus('u1', id)).toEqual({ status: 'cancelled' });
  });

  it('cannot take back a send that is already being delivered', async () => {
    let finish;
    const run = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    const { id } = await holdSend({ userId: 'u1', delayMs: 1000, run });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await cancelSend('u1', id)).toEqual({ cancelled: false, status: 'sending' });
    finish({ ok: true });
    await flush();
    expect(await cancelSend('u1', id)).toEqual({ cancelled: false, status: 'sent', result: { ok: true } });
  });

  it("keeps each user's sends to themselves", async () => {
    const run = vi.fn().mockResolvedValue({ ok: true });
    const { id } = await holdSend({ userId: 'u1', delayMs: 10_000, run });
    expect(await cancelSend('u2', id)).toEqual({ cancelled: false, status: 'unknown' });
    expect(await getSendStatus('u2', id)).toEqual({ status: 'unknown' });
    await vi.advanceTimersByTimeAsync(10_000);
    await flush();
    expect(run).toHaveBeenCalledOnce();
  });
});

describe('after the process that held a send is gone', () => {
  it('reports a send that never started as lost, and one that had started as unknown', async () => {
    store.set('send_hold:u1:never-started', JSON.stringify({ status: 'pending', sendAt: new Date().toISOString() }));
    store.set('send_hold:u1:mid-send', JSON.stringify({ status: 'sending' }));
    expect(await getSendStatus('u1', 'never-started')).toEqual({ status: 'lost' });
    expect(await getSendStatus('u1', 'mid-send')).toEqual({ status: 'unknown' });
    expect(await getSendStatus('u1', 'no-record')).toEqual({ status: 'unknown' });
  });
});

describe('flushHeldSends', () => {
  it('delivers every held send at once, for a graceful shutdown', async () => {
    const run = vi.fn().mockResolvedValue({ ok: true });
    const a = await holdSend({ userId: 'u1', delayMs: 10_000, run });
    const b = await holdSend({ userId: 'u2', delayMs: 10_000, run });
    expect(await flushHeldSends(5000)).toBe(2);
    expect(run).toHaveBeenCalledTimes(2);
    expect(await getSendStatus('u1', a.id)).toMatchObject({ status: 'sent' });
    expect(await getSendStatus('u2', b.id)).toMatchObject({ status: 'sent' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('does nothing when nothing is held', async () => {
    expect(await flushHeldSends(5000)).toBe(0);
  });
});
