// The Scheduled view's feed (#543, design 5.3): a burst of scheduled_changed events is one refetch
// of the list and the counts, a change is compared with what the message was before (the toasts),
// an answer for a user who signed out is dropped, and the list is fetched once while something is
// scheduled. The store is real; the api is a fake, and the timer is fired by hand.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.json')) {
      return { format: 'module', shortCircuit: true, source: `export default ${readFileSync(new URL(url), 'utf8')}` };
    }
    return nextLoad(url, context);
  },
});

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid' });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
  CustomEvent: dom.window.CustomEvent,
});
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.matchMedia = dom.window.matchMedia;

const { useStore } = await import('../store/index.js');
const { createScheduledFeed } = await import('./scheduledFeed.js');

const settle = () => new Promise(r => setTimeout(r, 0));
const row = (id, status, over = {}) => ({ id, status, accountId: 'acct', sendAt: '2026-10-26T07:00:00Z', summary: { subject: `S ${id}`, to: [] }, ...over });

function harness() {
  const timers = [];
  const calls = [];
  let lists = [];
  const client = {
    scheduled: { list: async () => { calls.push('list'); return lists.shift() ?? { messages: [], moreSent: false }; } },
    getUnreadCounts: async () => { calls.push('counts'); return { total: 0, byAccount: {}, snapshots: {}, scheduled: { pending: 2, attention: 1 } }; },
  };
  const feed = createScheduledFeed({
    store: useStore, client,
    schedule: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    unschedule: (id) => { if (id) timers[id - 1].fn = null; },
  });
  const fire = async () => { for (const tm of timers.splice(0)) tm.fn?.(); await settle(); await settle(); };
  return { feed, calls, timers, fire, answer: (...l) => { lists = l; } };
}

beforeEach(() => {
  useStore.setState({ user: { id: 'u1' }, isLocked: false, scheduledList: null, scheduledSummaries: {}, scheduledCount: 0, scheduledAttention: 0 });
});

describe('scheduledFeed', () => {
  test('a burst of changes is one refetch of the list and the counts, after the debounce', async () => {
    const h = harness();
    h.answer({ messages: [row('a', 'scheduled')], moreSent: true });
    h.feed.changed();
    h.feed.changed();
    h.feed.changed();
    assert.deepEqual(h.calls, []);
    assert.equal(h.timers.filter(tm => tm.fn).length, 1);
    assert.equal(h.timers.at(-1).ms, 300);
    await h.fire();
    assert.deepEqual(h.calls.sort(), ['counts', 'list']);
    const state = useStore.getState();
    assert.equal(state.scheduledList.messages[0].id, 'a');
    assert.equal(state.scheduledList.moreSent, true);
    assert.equal(state.scheduledCount, 2);
    assert.equal(state.scheduledAttention, 1);
  });

  test('a steady stream of changes still refreshes within the maximum wait', async () => {
    let clock = 0;
    const timers = [];
    const feed = createScheduledFeed({
      store: useStore, client: { scheduled: { list: async () => ({ messages: [] }) }, getUnreadCounts: async () => null },
      schedule: (fn, ms) => { timers.push(ms); return timers.length; }, unschedule: () => {}, clock: () => clock,
    });
    feed.changed();
    for (clock = 250; clock <= 1750; clock += 250) feed.changed();
    clock = 1900;
    feed.changed();
    assert.equal(timers[0], 300);
    assert.equal(timers.at(-2), 250, '2000 - 1750');
    assert.equal(timers.at(-1), 100, 'the burst is refreshed 2 s after its first change');
  });

  test('a message the sender sent keeps the subject it had, and is told once', async () => {
    const h = harness();
    const heard = [];
    const stop = h.feed.start({ onNotices: n => heard.push(...n) });
    h.answer(
      { messages: [row('a', 'sending'), row('b', 'scheduled')] },
      { messages: [row('a', 'sent', { summary: null }), row('b', 'failed', { failureCode: 'tls' })] },
    );
    await h.feed.refresh();
    assert.deepEqual(heard, [], 'nothing to compare the first list with');
    await h.feed.refresh();
    assert.deepEqual(heard.map(n => [n.kind, n.row.id]), [['sent', 'a'], ['attention', 'b']]);
    const sent = useStore.getState().scheduledList.messages.find(m => m.id === 'a');
    assert.equal(sent.summary.subject, 'S a');
    assert.equal(sent.cachedSummary, true);
    stop();
  });

  test('a change during a fetch is fetched once more after it', async () => {
    let release;
    let first = true;
    const client = {
      scheduled: { list: () => (first ? (first = false, new Promise(r => { release = r; })) : Promise.resolve({ messages: [row('z', 'scheduled')] })) },
      getUnreadCounts: async () => null,
    };
    const feed = createScheduledFeed({ store: useStore, client, schedule: setTimeout, unschedule: clearTimeout, delayMs: 0 });
    const out = feed.refresh();
    feed.refresh();
    release({ messages: [] });
    await out;
    await settle(); await settle();
    assert.equal(useStore.getState().scheduledList.messages[0]?.id, 'z');
  });

  test('an answer for a user who signed out meanwhile is dropped', async () => {
    let release;
    const client = { scheduled: { list: () => new Promise(r => { release = r; }) }, getUnreadCounts: async () => null };
    const feed = createScheduledFeed({ store: useStore, client });
    const out = feed.refresh();
    useStore.setState({ user: { id: 'u2' }, scheduledList: null });
    release({ messages: [row('a', 'scheduled')] });
    await out;
    assert.equal(useStore.getState().scheduledList, null);
  });

  test('a failed first fetch says so; a failed later one keeps what is shown', async () => {
    let fail = true;
    const client = {
      scheduled: { list: async () => { if (fail) throw new Error('offline'); return { messages: [row('a', 'scheduled')] }; } },
      getUnreadCounts: async () => null,
    };
    const feed = createScheduledFeed({ store: useStore, client });
    await feed.refresh();
    assert.equal(useStore.getState().scheduledList.error, 'offline');
    fail = false;
    useStore.getState().setScheduledList(null);
    await feed.refresh();
    fail = true;
    await feed.refresh();
    assert.equal(useStore.getState().scheduledList.messages[0].id, 'a');
    assert.equal(useStore.getState().scheduledList.error, null);
  });

  test('start fetches the list once while something is scheduled, and not while locked', async () => {
    const h = harness();
    const stop = h.feed.start();
    assert.deepEqual(h.calls, []);
    useStore.setState({ isLocked: true, scheduledCount: 1 });
    await settle();
    assert.deepEqual(h.calls, []);
    useStore.setState({ isLocked: false });
    await settle(); await settle();
    assert.ok(h.calls.includes('list'));
    const count = h.calls.length;
    useStore.setState({ scheduledCount: 3 });
    await settle();
    assert.equal(h.calls.length, count, 'loaded once');
    stop();
  });

  test('a lock clears the list and the subjects it kept', async () => {
    const h = harness();
    h.answer({ messages: [row('a', 'scheduled')] });
    await h.feed.refresh();
    assert.ok(useStore.getState().scheduledSummaries.a);
    useStore.getState().setLocked(true);
    const state = useStore.getState();
    assert.equal(state.scheduledList, null);
    assert.deepEqual(state.scheduledSummaries, {});
    assert.equal(state.scheduledCount, 0);
    state.setLocked(false);
  });
});
