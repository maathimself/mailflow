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
// Answers by URL ending, as [status, body]; anything else is a body. `gate` holds a response back.
let answers = {};
let gate = null;
globalThis.fetch = async (url) => {
  served.push(String(url));
  if (gate) await gate;
  const [status, body, headers = {}] = Object.entries(answers).find(([end]) => String(url).endsWith(end))?.[1] ?? [200, { html: `<p>${url}</p>` }];
  return { ok: status < 400, status, headers: { get: name => headers[name] ?? null }, json: async () => body };
};

const { useStore } = await import('../store/index.js');
const { bodyCache, prefetchBody, prefetchBodyOnHover } = await import('./bodyCache.js');
const { api } = await import('./api.js');
const body = (n, size = 10) => ({ html: 'x'.repeat(size), n });

describe('bodyCache', () => {
  beforeEach(() => { bodyCache.clear(); served = []; answers = {}; gate = null; });

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
    const load = prefetchBody('p1');
    prefetchBody('p1');
    assert.equal(typeof load?.then, 'function', 'the load, for the hover prefetch to wait on');
    await load;
    assert.equal(served.filter(u => u.includes('/p1/')).length, 1);
    assert.ok(bodyCache.get('p1')?.html);
    assert.equal(prefetchBody('p1'), undefined, 'nothing to wait on once cached');
    assert.equal(served.filter(u => u.includes('/p1/')).length, 1, 'not again once cached');
  });

  test('a prefetch asks for remote images to stay blocked unless told otherwise', async () => {
    await prefetchBody('p2');
    assert.ok(served.some(u => u.endsWith('/messages/p2/body')), served.join(' '));
  });

  test('prefetched bodies count against the same caps', async () => {
    for (let i = 0; i < 55; i += 1) await prefetchBody(`q${i}`);
    assert.ok(!bodyCache.has('q0') && bodyCache.has('q54'), 'the oldest prefetch went past 50');
  });

  test('a hover prefetch says what came of it: a body, a decline, a throttle', async () => {
    answers = { '/h2/body?prefetch=1': [204, null, { 'X-Prefetch': 'later' }], '/h6/body?prefetch=1': [204, null, { 'X-Prefetch': 'never' }], '/h7/body?prefetch=1': [204, null, { 'X-Prefetch': 'repair' }], '/h3/body?prefetch=1': [503, { error: 'busy', busy: true }], '/h4/body?prefetch=1': [429, { error: 'slow down' }], '/h5/body?prefetch=1': [500, { error: 'x' }] };
    assert.equal(await prefetchBodyOnHover('h1'), 'ok');
    assert.ok(bodyCache.has('h1'));
    assert.equal(await prefetchBodyOnHover('h1'), 'cached');
    assert.equal(await prefetchBodyOnHover('h2'), 'declined');
    assert.ok(!bodyCache.has('h2'), 'a 204 stores nothing');
    assert.equal(await prefetchBodyOnHover('h6'), 'never');
    assert.equal(await prefetchBodyOnHover('h7'), 'skip', 'a body due its repair is left to the click');
    assert.ok(!bodyCache.has('h7'));
    assert.equal(await prefetchBodyOnHover('h3'), 'throttled');
    assert.equal(await prefetchBodyOnHover('h4'), 'throttled');
    assert.equal(await prefetchBodyOnHover('h5'), 'failed');
    assert.ok(served.every(u => !u.includes('remoteImages')), 'never asks for remote images');
  });

  test('a click during a hover prefetch takes its body, or fetches itself (and repairs) when the prefetch was turned away', async () => {
    let open;
    gate = new Promise(r => { open = r; });
    const hover = prefetchBodyOnHover('j1');
    const click = api.getMessageBody('j1');
    open();
    gate = null;
    assert.ok((await click).html);
    assert.equal(await hover, 'ok');
    assert.deepEqual(served.filter(u => u.includes('/j1/')).map(u => u.replace(/^.*\/messages/, '')), ['/j1/body?prefetch=1'], 'one request');

    answers = { '/j2/body?prefetch=1': [204, null, { 'X-Prefetch': 'repair' }] };
    const declined = prefetchBodyOnHover('j2');
    const click2 = api.getMessageBody('j2');
    assert.ok((await click2).html);
    assert.equal(await declined, 'skip');
    assert.deepEqual(served.filter(u => u.includes('/j2/')).map(u => u.replace(/^.*\/messages/, '')), ['/j2/body?prefetch=1', '/j2/body']);
  });

  test('a prefetch that comes back after the user changed is not cached for the next one', async () => {
    useStore.setState({ user: { id: 'carol' } });
    let open;
    gate = new Promise(r => { open = r; });
    const hover = prefetchBodyOnHover('k1');
    const adjacent = prefetchBody('k2');
    useStore.setState({ user: { id: 'dave' } });
    open();
    gate = null;
    await Promise.all([hover, adjacent]);
    assert.ok(!bodyCache.has('k1') && !bodyCache.has('k2'));
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
