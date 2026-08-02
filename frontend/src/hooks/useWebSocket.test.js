import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.json')) {
      return {
        format: 'module',
        source: `export default ${readFileSync(new URL(url), 'utf8')}`,
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});

globalThis.localStorage = {
  getItem: () => null,
  setItem() {},
  removeItem() {},
};

const { dispatchComposeSessionInvalidation } = await import('./useWebSocket.js');

describe('compose WebSocket invalidation bridge', () => {
  it('dispatches the complete server event as CustomEvent detail', () => {
    const dispatched = [];
    class SyntheticCustomEvent {
      constructor(type, options) {
        this.type = type;
        this.detail = options.detail;
      }
    }
    const data = {
      type: 'compose_sessions_updated', action: 'updated',
      sessionId: '11111111-1111-4111-8111-111111111111',
      slot: 1, revision: 4, clientId: 'browser-synthetic',
    };
    dispatchComposeSessionInvalidation(data, {
      eventTarget: { dispatchEvent: event => dispatched.push(event) },
      CustomEvent: SyntheticCustomEvent,
    });

    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].type, 'mailflow:compose-session-updated');
    assert.equal(dispatched[0].detail, data);
  });
});
