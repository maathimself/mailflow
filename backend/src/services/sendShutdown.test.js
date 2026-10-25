import { describe, expect, it, vi } from 'vitest';

vi.mock('./sendHold.js', () => ({ flushHeldSends: vi.fn() }));
vi.mock('./scheduledSend.js', () => ({ stopScheduledSender: vi.fn() }));

import { flushHeldSends } from './sendHold.js';
import { stopScheduledSender } from './scheduledSend.js';
import { flushSendsForShutdown } from './sendShutdown.js';

describe('flushSendsForShutdown', () => {
  it('stops the scheduled sender and flushes held sends in the same wait, with the same budget', async () => {
    let finishScheduled;
    flushHeldSends.mockResolvedValue();
    stopScheduledSender.mockReturnValue(new Promise(resolve => { finishScheduled = resolve; }));
    let done = false;
    const flushed = flushSendsForShutdown(8000).then(() => { done = true; });
    await new Promise(resolve => setImmediate(resolve));
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
});
