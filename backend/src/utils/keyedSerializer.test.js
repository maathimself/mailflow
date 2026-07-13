import { describe, it, expect } from 'vitest';
import { createKeyedSerializer } from './keyedSerializer.js';

const tick = () => new Promise(r => setTimeout(r, 0));

describe('createKeyedSerializer', () => {
  it('runs operations for the same key strictly one at a time, in submission order', async () => {
    const run = createKeyedSerializer();
    const log = [];
    const op = (id) => async () => {
      log.push(`start-${id}`);
      await tick();
      log.push(`end-${id}`);
    };
    // Fire two overlapping ops for the same key without awaiting the first — the
    // guard against the reconnect race the route depends on.
    const p1 = run('acct', op(1));
    const p2 = run('acct', op(2));
    await Promise.all([p1, p2]);
    expect(log).toEqual(['start-1', 'end-1', 'start-2', 'end-2']);
  });

  it('lets operations for different keys run concurrently', async () => {
    const run = createKeyedSerializer();
    const log = [];
    const op = (id) => async () => { log.push(`start-${id}`); await tick(); log.push(`end-${id}`); };
    await Promise.all([run('a', op('a')), run('b', op('b'))]);
    // Both started before either ended.
    expect(log.slice(0, 2).sort()).toEqual(['start-a', 'start-b']);
  });

  it('continues the chain after an operation rejects', async () => {
    const run = createKeyedSerializer();
    const log = [];
    const bad = run('acct', async () => { log.push('bad'); throw new Error('boom'); });
    const good = run('acct', async () => { log.push('good'); return 'ok'; });
    await expect(bad).rejects.toThrow('boom');
    await expect(good).resolves.toBe('ok');
    expect(log).toEqual(['bad', 'good']);
  });

  it('settles each operation with its own result', async () => {
    const run = createKeyedSerializer();
    const [a, b] = await Promise.all([
      run('k', async () => 1),
      run('k', async () => 2),
    ]);
    expect([a, b]).toEqual([1, 2]);
  });
});
