// A request sent while the page closes is keepalive, so it completes after the page is gone; the
// flag clears again for a page restored from the back-forward cache.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis.window ?? { dispatchEvent() {}, location: { origin: 'https://mail.example' } };
const seen = [];
globalThis.fetch = async (url, opts) => { seen.push(opts); return { ok: true, status: 200, json: async () => ({ ok: true }) }; };
const { api, setPageClosing } = await import('./api.js');

test('requests sent while the page closes are keepalive, and only then', async () => {
  await api.bulkArchive(['a']);
  setPageClosing(true);
  await api.bulkArchive(['b']);
  setPageClosing(false);
  await api.bulkArchive(['c']);
  assert.deepEqual(seen.map(o => o.keepalive === true), [false, true, false]);
});
