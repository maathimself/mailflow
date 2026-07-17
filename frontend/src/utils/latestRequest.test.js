import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createLatestRequest } from './latestRequest.js';

describe('createLatestRequest', () => {
  it('ignores an older response that finishes after a newer response', async () => {
    const pending = [];
    const request = () => new Promise(resolve => pending.push(resolve));
    const applied = [];
    const latest = createLatestRequest();

    const older = latest.run(request, value => applied.push(value));
    const newer = latest.run(request, value => applied.push(value));

    pending[1]('new inbox');
    await newer;
    pending[0]('stale inbox');
    await older;

    assert.deepEqual(applied, ['new inbox']);
  });

  it('ignores an in-flight response after optimistic state invalidates it', async () => {
    let resolveRequest;
    const latest = createLatestRequest();
    const applied = [];
    const inFlight = latest.run(
      () => new Promise(resolve => { resolveRequest = resolve; }),
      value => applied.push(value),
    );

    latest.invalidate();
    resolveRequest('snapshot from before archive');
    await inFlight;

    assert.deepEqual(applied, []);
  });
});
