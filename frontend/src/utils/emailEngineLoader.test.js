import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRetryableLoader } from './emailEngineLoader.js';

describe('createRetryableLoader', () => {
  it('coalesces concurrent loads and retries after a rejection', async () => {
    let attempts = 0;
    const load = createRetryableLoader(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('chunk unavailable');
      return { ready: true };
    });

    const first = load();
    const duplicate = load();
    assert.equal(first, duplicate);
    await assert.rejects(first, /chunk unavailable/);
    assert.deepEqual(await load(), { ready: true });
    assert.equal(attempts, 2);
  });

  it('turns a synchronous loader failure into a retryable rejection', async () => {
    let attempts = 0;
    const load = createRetryableLoader(() => {
      attempts += 1;
      if (attempts === 1) throw new Error('loader setup failed');
      return 'ready';
    });

    await assert.rejects(load(), /loader setup failed/);
    assert.equal(await load(), 'ready');
  });
});
