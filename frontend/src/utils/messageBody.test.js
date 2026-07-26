import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fetchMessageBodyWithRetry } from './messageBody.js';

describe('fetchMessageBodyWithRetry', () => {
  it('retries transient failures with exponential delays', async () => {
    let calls = 0;
    const delays = [];
    const result = await fetchMessageBodyWithRetry('message-1', {
      load: async () => {
        calls += 1;
        if (calls < 3) throw new Error('socket hang up');
        return { text: 'loaded' };
      },
      wait: async delay => { delays.push(delay); },
    });

    assert.deepEqual(result, { text: 'loaded' });
    assert.equal(calls, 3);
    assert.deepEqual(delays, [500, 1000]);
  });

  it('does not retry permanent failures', async () => {
    let calls = 0;
    await assert.rejects(
      fetchMessageBodyWithRetry('message-1', {
        load: async () => {
          calls += 1;
          throw new Error('Permission denied');
        },
        wait: async () => {},
      }),
      /Permission denied/,
    );
    assert.equal(calls, 1);
  });

  it('stops retrying when the caller has cancelled', async () => {
    let cancelled = false;
    let calls = 0;
    await assert.rejects(
      fetchMessageBodyWithRetry('message-1', {
        load: async () => {
          calls += 1;
          throw new Error('Command canceled');
        },
        wait: async () => { cancelled = true; },
        isCancelled: () => cancelled,
      }),
      /Command canceled/,
    );
    assert.equal(calls, 1);
  });
});
