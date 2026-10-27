import { describe, expect, it, vi } from 'vitest';

vi.mock('./sendHold.js', () => ({ flushHeldSends: vi.fn(), beginHeldSendShutdown: vi.fn() }));
vi.mock('./scheduledSend.js', () => ({ stopScheduledSender: vi.fn() }));

import { beginHeldSendShutdown, flushHeldSends } from './sendHold.js';
import { stopScheduledSender } from './scheduledSend.js';
import { FORCE_EXIT_MS, finishHeldSendsForShutdown, flushSendsForShutdown, shutDown } from './sendShutdown.js';

describe('flushSendsForShutdown', () => {
  it('stops the scheduled sender and flushes held sends in the same wait, with the same budget', async () => {
    let finishScheduled;
    flushHeldSends.mockResolvedValue();
    stopScheduledSender.mockReturnValue(new Promise(resolve => { finishScheduled = resolve; }));
    let done = false;
    const flushed = flushSendsForShutdown(8000).then(() => { done = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(beginHeldSendShutdown).toHaveBeenCalledOnce();
    expect(flushHeldSends).toHaveBeenCalledWith(8000);
    expect(stopScheduledSender).toHaveBeenCalledWith(8000);
    // The process waits for the scheduled sends in flight too.
    expect(done).toBe(false);
    finishScheduled();
    await flushed;
    expect(done).toBe(true);
  });

  it('never rejects, so the exit still happens', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    flushHeldSends.mockRejectedValue(new Error('redis down'));
    stopScheduledSender.mockRejectedValue(new Error('db down'));
    await expect(flushSendsForShutdown(10)).resolves.toBeDefined();
  });

  it('waits once more, before the exit, for a send held after the first flush', async () => {
    flushHeldSends.mockClear();
    flushHeldSends.mockResolvedValue(1);
    await finishHeldSendsForShutdown(3000);
    expect(flushHeldSends).toHaveBeenCalledWith(3000);
    flushHeldSends.mockRejectedValue(new Error('redis down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(finishHeldSendsForShutdown(10)).resolves.toBeUndefined();
  });
});

describe('shutDown', () => {
  const setup = () => {
    let closed;
    let now = 1_000_000;
    const exit = vi.fn();
    const forced = [];
    const deps = {
      code: 0,
      httpServer: { close: vi.fn(cb => { closed = cb; }) },
      closeClients: vi.fn(),
      quit: vi.fn(async () => {}),
      exit,
      clock: () => now,
      schedule: (fn, ms) => { forced.push({ fn, ms }); return { unref() {} }; },
    };
    return { deps, exit, forced, close: () => closed(), advance: ms => { now += ms; } };
  };

  it('closes the clients, and once the server has closed flushes the held sends again, then exits', async () => {
    flushHeldSends.mockReset();
    stopScheduledSender.mockReset();
    flushHeldSends.mockResolvedValue(0);
    stopScheduledSender.mockResolvedValue();
    const s = setup();
    shutDown(s.deps);
    expect(s.deps.closeClients).toHaveBeenCalledOnce();
    expect(flushHeldSends).toHaveBeenCalledTimes(1);
    expect(s.forced).toEqual([{ fn: expect.any(Function), ms: FORCE_EXIT_MS }]);
    // A send held by a request still in flight, after the first flush looked.
    let finishLast;
    flushHeldSends.mockReturnValueOnce(new Promise(resolve => { finishLast = resolve; }));
    s.advance(3_000);
    const closing = s.close();
    await new Promise(resolve => setImmediate(resolve));
    expect(flushHeldSends).toHaveBeenCalledTimes(2);
    // Its own budget: up to half a second before the forced exit, not the first flush's 25 s.
    expect(flushHeldSends).toHaveBeenLastCalledWith(FORCE_EXIT_MS - 500 - 3_000);
    expect(s.exit).not.toHaveBeenCalled();
    finishLast(1);
    await closing;
    expect(s.deps.quit).toHaveBeenCalledOnce();
    expect(s.exit).toHaveBeenCalledWith(0);
  });

  it('the last flush still has time when the first one used all of its own', async () => {
    flushHeldSends.mockReset();
    flushHeldSends.mockResolvedValue(0);
    stopScheduledSender.mockResolvedValue();
    const s = setup();
    shutDown(s.deps);
    s.advance(25_000);
    await s.close();
    expect(flushHeldSends).toHaveBeenLastCalledWith(2_500);
  });
});
