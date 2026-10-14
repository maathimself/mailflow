// The body cache the reading pane and the conversation cards share.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.json')) return { format: 'module', shortCircuit: true, source: `export default ${readFileSync(new URL(url), 'utf8')}` };
    return nextLoad(url, context);
  },
});
const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, CustomEvent: dom.window.CustomEvent });
let served = [];
globalThis.fetch = async (url) => { served.push(String(url)); return { ok: true, status: 200, json: async () => ({ html: `<p>${url}</p>` }) }; };

const { useStore } = await import('../store/index.js');
const { bodyCache, prefetchBody } = await import('./bodyCache.js');
const body = (n, size = 10) => ({ html: 'x'.repeat(size), n });

describe('bodyCache', () => {
  beforeEach(() => { bodyCache.clear(); served = []; });

  test('keeps the 50 most recently used, counting a read as a use', () => {
    for (let i = 0; i < 50; i += 1) bodyCache.set(`m${i}`, body(i));
    bodyCache.get('m0'); // read: now the most recent
    bodyCache.set('m50', body(50));
    assert.ok(bodyCache.has('m0'), 'a body just read stays');
    assert.ok(!bodyCache.has('m1'), 'the least recently used goes');
  });

  test('stays under its size cap, however few bodies that is', () => {
    bodyCache.set('big1', body(1, 25 * 1024 * 1024));
    bodyCache.set('big2', body(2, 25 * 1024 * 1024));
    assert.ok(!bodyCache.has('big1'));
    assert.ok(bodyCache.has('big2'), 'the newest is kept even alone over the cap');
  });

  test('keeps nothing empty, and evicts by what a body is', () => {
    bodyCache.set('empty', { html: '', text: '' });
    assert.ok(!bodyCache.has('empty'));
    bodyCache.set('blocked', { html: 'x', hasBlockedRemoteImages: true });
    bodyCache.set('open', { html: 'x' });
    assert.equal(bodyCache.evict(b => b.hasBlockedRemoteImages), true);
    assert.deepEqual([bodyCache.has('blocked'), bodyCache.has('open')], [false, true]);
  });

  test('prefetches once, into the cache', async () => {
    prefetchBody('p1');
    prefetchBody('p1');
    await new Promise(r => setTimeout(r, 20));
    assert.equal(served.filter(u => u.includes('/p1/')).length, 1);
    assert.ok(bodyCache.get('p1')?.html);
    prefetchBody('p1');
    assert.equal(served.filter(u => u.includes('/p1/')).length, 1, 'not again once cached');
  });

  test("is emptied when another user signs in: it holds the last one's mail", () => {
    useStore.setState({ user: { id: 'alice' } });
    bodyCache.set('a', body(1));
    useStore.setState({ user: { id: 'alice', name: 'A' } });
    assert.ok(bodyCache.has('a'), 'the same user, updated');
    useStore.setState({ user: { id: 'bob' } });
    assert.ok(!bodyCache.has('a'));
  });
});
