import { describe, expect, it } from 'vitest';

import { withGtdDelegationLock } from './gtdDelegationLock.js';

describe('withGtdDelegationLock', () => {
  it('serializes work for one account thread without blocking other threads', async () => {
    let releaseFirst;
    const order = [];
    const first = withGtdDelegationLock('a1', 'thread-1', async () => {
      order.push('first-start');
      await new Promise(resolve => { releaseFirst = resolve; });
      order.push('first-end');
    });
    const second = withGtdDelegationLock('a1', 'thread-1', async () => {
      order.push('second');
    });
    const other = withGtdDelegationLock('a1', 'thread-2', async () => {
      order.push('other');
    });

    await other;
    expect(order).toEqual(['first-start', 'other']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first-start', 'other', 'first-end', 'second']);
  });

  it('allows an awaited same-thread hook to re-enter the owning operation', async () => {
    const result = await Promise.race([
      withGtdDelegationLock('a1', 'thread-reentrant', () => (
        withGtdDelegationLock('a1', 'thread-reentrant', async () => 'nested')
      )),
      new Promise(resolve => setTimeout(() => resolve('timed-out'), 30)),
    ]);
    expect(result).toBe('nested');
  });
});
