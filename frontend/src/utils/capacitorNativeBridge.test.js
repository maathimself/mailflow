import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@capacitor/core') {
      return { url: 'data:text/javascript,' + encodeURIComponent(`
        export const Capacitor = { isNativePlatform: () => true };
        export const calls = [];
        export function registerPlugin() {
          return {
            openOidcLogout: async () => { throw new Error('not implemented'); },
            setUnreadCount: async ({ count }) => { calls.push(count); },
          };
        }
      `), shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

test('missing optional logout support leaves other native methods available', async () => {
  const previousWindow = globalThis.window;
  try {
    const { Capacitor, calls } = await import('@capacitor/core');
    globalThis.window = { Capacitor };
    const { installCapacitorNativeBridge } = await import('./capacitorNativeBridge.js');
    await installCapacitorNativeBridge();
    const bridge = window.mailflowNative;
    await bridge.badges.setUnreadCount(1);
    assert.deepEqual(await bridge.openOidcLogout('https://id.example.com/end'), { handled: false });
    await bridge.badges.setUnreadCount(2);
    assert.deepEqual(calls, [1, 2]);
  } finally {
    globalThis.window = previousWindow;
    hooks.deregister();
  }
});
