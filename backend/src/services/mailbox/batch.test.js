import { describe, expect, it, vi } from 'vitest';
import { runInBatches } from './batch.js';

describe('runInBatches', () => {
  it('does not start the next batch until the current batch settles', async () => {
    const events = [];
    const releases = [];
    const fn = vi.fn((item) => new Promise((resolve) => {
      events.push(`start:${item}`);
      releases.push(() => {
        events.push(`end:${item}`);
        resolve(item * 2);
      });
    }));

    const pending = runInBatches([1, 2, 3], 2, fn);
    await Promise.resolve();
    expect(events).toEqual(['start:1', 'start:2']);

    releases.shift()();
    releases.shift()();
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(['start:1', 'start:2', 'end:1', 'end:2', 'start:3']);

    releases.shift()();
    await expect(pending).resolves.toEqual([
      { status: 'fulfilled', value: 2 },
      { status: 'fulfilled', value: 4 },
      { status: 'fulfilled', value: 6 },
    ]);
  });

  it('returns rejected entries without aborting later batches', async () => {
    const error = new Error('failed');
    const results = await runInBatches([1, 2, 3], 2, async item => {
      if (item === 2) throw error;
      return item;
    });

    expect(results).toEqual([
      { status: 'fulfilled', value: 1 },
      { status: 'rejected', reason: error },
      { status: 'fulfilled', value: 3 },
    ]);
  });
});
