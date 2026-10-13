// Where a new message window opens (#591): on screen, whatever the font size, which MailApp applies
// by scaling the whole interface, so the window's own pixels are screen pixels / scale.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.json')) {
      return { format: 'module', source: `export default ${readFileSync(new URL(url), 'utf8')}`, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const store = new Map();
globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
  clear: () => store.clear(),
};
const { useStore } = await import('./index.js');
// A 1400 x 900 screen, read when a window opens; set after the store loads, as it is no browser.
globalThis.window = { innerWidth: 1400, innerHeight: 900 };

beforeEach(() => useStore.setState({ messageWindows: [], _winSeq: 0 }));

for (const fontSize of [100, 125, 90]) {
  test(`opens wholly on screen at ${fontSize}%`, () => {
    useStore.setState({ fontSize });
    useStore.getState().openMessageWindow('m1');
    const [win] = useStore.getState().messageWindows;
    const scale = fontSize / 100;
    // In screen pixels the window, resize handle included, is inside the 1400 x 900 screen.
    assert.ok(win.x >= 0 && win.y >= 0, JSON.stringify(win));
    assert.ok((win.x + win.w) * scale <= 1400, `right edge ${(win.x + win.w) * scale}`);
    assert.ok((win.y + win.h) * scale <= 900, `bottom edge ${(win.y + win.h) * scale}`);
  });
}
