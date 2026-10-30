import test from 'node:test';
import assert from 'node:assert/strict';
import { api } from './api.js';

// The server marks a GTD label refusal whose row named another message with `changed` (#665), and
// the callers tell it apart from an only-copy 409 by that flag.
test('a refused label removal carries the server\'s changed flag, and only-copy refusals do not', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: false, status: 409, json: async () => ({ error: 'This label changed on the server', changed: true }) });
    await assert.rejects(api.gtdUnclassify('m1', 'todo'), err => err.status === 409 && err.changed === true);

    globalThis.fetch = async () => ({ ok: false, status: 409, json: async () => ({ error: 'only copy', onlyCopy: true }) });
    await assert.rejects(api.gtdUnclassify('m1', 'todo'), err => err.status === 409 && !('changed' in err));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
