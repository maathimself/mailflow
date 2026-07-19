import { describe, it, expect, vi } from 'vitest';
import { EmbeddingWorker } from './worker.js';

const ZERO = '00000000-0000-0000-0000-000000000000';
const uid = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

function makeStore(messages, opts = {}) {
  const watermark = new Map();
  const state = { upsertCalls: 0, resetCalls: 0 };
  return {
    ZERO_UUID: ZERO,
    _messages: messages,
    _state: state,
    async scanForEmbedding(target, afterId, limit) {
      return messages
        .filter((m) => (m.embedGen == null || m.embedGen !== target) && !m.isDeleted && m.id > afterId)
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .slice(0, limit)
        .map((m) => m.id);
    },
    async fetchForEmbedding(ids) {
      return messages.filter((m) => ids.includes(m.id)).map((m) => ({
        id: m.id, subject: m.subject || '', bodyText: m.bodyText || '', bodyHtml: m.bodyHtml || '', lastModified: m.lastModified,
      }));
    },
    async upsert() { state.upsertCalls++; },
    async setEmbedGen(ids, target) { for (const id of ids) { const m = messages.find((x) => x.id === id); if (m) m.embedGen = target; } },
    async setEmbedGenIfUnchanged(items, target) {
      const missed = [];
      for (const it of items) {
        const m = messages.find((x) => x.id === it.id);
        if (opts.casMiss?.has(it.id)) { missed.push(it.id); continue; }
        if (m && m.lastModified === it.lastModified) m.embedGen = target; else missed.push(it.id);
      }
      return missed;
    },
    async stampSkipped(target, casItems, plainIds) {
      const missed = [];
      for (const it of casItems) {
        const m = messages.find((x) => x.id === it.id);
        if (opts.casMiss?.has(it.id)) { missed.push(it.id); continue; }
        if (m && m.lastModified === it.lastModified) m.embedGen = target; else missed.push(it.id);
      }
      for (const id of plainIds) { const m = messages.find((x) => x.id === id); if (m) m.embedGen = target; }
      return missed;
    },
    async getWatermark(gen) { state.getWatermarkCalled = true; return watermark.get(gen) || ZERO; },
    async setWatermark(gen, id) { watermark.set(gen, id); },
    async resetWatermark(gen) { state.resetCalls++; watermark.set(gen, ZERO); },
  };
}
const fakeClient = { async embed(inputs) { return inputs.map(() => [0.1, 0.2, 0.3, 0.4]); } };
const deps = (store, over = {}) => ({ store, client: fakeClient, preprocessCfg: {}, maxInputChars: 32768, batchSize: 32, ...over });

// A generations collaborator stub for the activation seam. `building` is what
// buildingGeneration() returns (null ⇒ the run's gen is NOT building — an active
// or incremental run); `activate` is the activateGeneration spy.
function makeGenerations({ building = null, activate } = {}) {
  return {
    buildingGeneration: vi.fn(async () => building),
    activateGeneration: activate || vi.fn(async () => {}),
  };
}

describe('EmbeddingWorker.runOnce', () => {
  it('embeds pending messages and stamps embed_gen', async () => {
    const msgs = [
      { id: uid(1), subject: 'hello', bodyText: 'world', lastModified: 't1', embedGen: null },
      { id: uid(2), subject: 'foo', bodyText: 'bar', lastModified: 't2', embedGen: null },
    ];
    const store = makeStore(msgs);
    const w = new EmbeddingWorker(deps(store));
    const res = await w.runOnce('7');
    expect(res.claimed).toBe(2);
    expect(res.succeeded).toBe(2);
    expect(msgs.every((m) => m.embedGen === '7')).toBe(true);
  });

  it('excludes a CAS miss from succeeded but still advances the watermark', async () => {
    const msgs = [
      { id: uid(1), subject: 's1', bodyText: 'b1', lastModified: 't1', embedGen: null },
      { id: uid(2), subject: 's2', bodyText: 'b2', lastModified: 't2', embedGen: null },
    ];
    const store = makeStore(msgs, { casMiss: new Set([uid(2)]) });
    const w = new EmbeddingWorker(deps(store));
    const res = await w.runOnce('7');
    expect(res.succeeded).toBe(1);
    const m2 = msgs.find((m) => m.id === uid(2));
    expect(m2.embedGen).toBeNull(); // recovered by backstop later
  });

  it('is idempotent — a second run finds nothing', async () => {
    const msgs = [{ id: uid(1), subject: 's', bodyText: 'b', lastModified: 't1', embedGen: null }];
    const store = makeStore(msgs);
    const w = new EmbeddingWorker(deps(store));
    await w.runOnce('7');
    const res2 = await w.runOnce('7');
    expect(res2.claimed).toBe(0);
  });

  it('resets the watermark on scan exhaustion (P2)', async () => {
    const store = makeStore([]);
    const w = new EmbeddingWorker(deps(store));
    await w.runOnce('7');
    expect(store._state.resetCalls).toBeGreaterThan(0);
  });

  it('aborts after maxConsecutiveFailures on a persistent embed failure (does not loop)', async () => {
    const msgs = Array.from({ length: 10 }, (_, i) => ({ id: uid(i + 1), subject: 's', bodyText: 'b', lastModified: `t${i}`, embedGen: null }));
    const store = makeStore(msgs);
    const scanSpy = vi.spyOn(store, 'scanForEmbedding');
    const failingClient = { async embed() { throw new Error('unreachable'); } };
    const w = new EmbeddingWorker(deps(store, { client: failingClient, maxConsecutiveFailures: 3 }));
    await expect(w.runOnce('7')).rejects.toThrow(/aborting after 3 consecutive failures/);
    expect(scanSpy.mock.calls.length).toBe(3); // bounded, not infinite
  });

  it('downshifts on a permanent 4xx: isolates the poison message and embeds the rest (W1)', async () => {
    const msgs = [
      { id: uid(1), subject: 'good one', bodyText: 'hello', lastModified: 't1', embedGen: null },
      { id: uid(2), subject: 'poison here', bodyText: 'x', lastModified: 't2', embedGen: null },
      { id: uid(3), subject: 'good two', bodyText: 'world', lastModified: 't3', embedGen: null },
    ];
    const store = makeStore(msgs);
    // 4xx whenever the batch contains the poison text; succeeds otherwise.
    const poisonClient = {
      async embed(inputs) {
        if (inputs.some((t) => t.includes('poison'))) { const e = new Error('unembeddable input'); e.permanent4xx = true; throw e; }
        return inputs.map(() => [0.1, 0.2, 0.3, 0.4]);
      },
    };
    const w = new EmbeddingWorker(deps(store, { client: poisonClient, maxConsecutiveFailures: 3 }));
    const res = await w.runOnce('7');
    expect(msgs.find((m) => m.id === uid(1)).embedGen).toBe('7'); // embedded
    expect(msgs.find((m) => m.id === uid(3)).embedGen).toBe('7'); // embedded
    expect(msgs.find((m) => m.id === uid(2)).embedGen).toBe('7'); // stamp-dropped (leaves the scan)
    expect(res.succeeded).toBe(2); // only the two good ones count as embedded
  });

  it('all-4xx batch leaves rows unstamped and aborts after maxConsecutiveFailures (no silent drop) (W1)', async () => {
    const msgs = Array.from({ length: 4 }, (_, i) => ({ id: uid(i + 1), subject: 's', bodyText: 'b', lastModified: `t${i}`, embedGen: null }));
    const store = makeStore(msgs);
    const scanSpy = vi.spyOn(store, 'scanForEmbedding');
    const allBadClient = { async embed() { const e = new Error('always bad'); e.permanent4xx = true; throw e; } };
    const w = new EmbeddingWorker(deps(store, { client: allBadClient, maxConsecutiveFailures: 3 }));
    await expect(w.runOnce('7')).rejects.toThrow(/aborting after 3 consecutive failures/);
    expect(msgs.every((m) => m.embedGen === null)).toBe(true); // nothing silently dropped
    expect(scanSpy.mock.calls.length).toBe(3); // bounded
  });
});

// The activation seam: the SHARED worker-run completion point that both drivers
// (the manual build route and the scheduler) reach. When a run drains the scan
// for the generation that is currently 'building', the worker promotes it to
// 'active' — the production wiring that was missing (activateGeneration had no
// non-test caller, so completed builds stayed 'building' forever).
describe('EmbeddingWorker activation seam', () => {
  it('activates the building generation once, without force, after the scan drains', async () => {
    const gen = '7';
    const msgs = [
      { id: uid(1), subject: 'a', bodyText: 'b', lastModified: 't1', embedGen: null },
      { id: uid(2), subject: 'c', bodyText: 'd', lastModified: 't2', embedGen: null },
    ];
    const store = makeStore(msgs);
    const activateSpy = vi.fn(async () => {});
    const generations = makeGenerations({ building: { id: gen }, activate: activateSpy });
    const w = new EmbeddingWorker(deps(store, { generations }));
    const res = await w.runOnce(gen);
    expect(res.succeeded).toBe(2);
    expect(generations.buildingGeneration).toHaveBeenCalled();
    expect(activateSpy).toHaveBeenCalledTimes(1);
    expect(activateSpy.mock.calls[0]).toEqual([gen]); // called with the gen only — no force
  });

  it('does not activate when the run aborts before draining the scan', async () => {
    const gen = '7';
    const msgs = Array.from({ length: 6 }, (_, i) => ({ id: uid(i + 1), subject: 's', bodyText: 'b', lastModified: `t${i}`, embedGen: null }));
    const store = makeStore(msgs);
    const failingClient = { async embed() { throw new Error('unreachable'); } };
    const activateSpy = vi.fn(async () => {});
    const generations = makeGenerations({ building: { id: gen }, activate: activateSpy });
    const w = new EmbeddingWorker(deps(store, { client: failingClient, maxConsecutiveFailures: 2, generations }));
    await expect(w.runOnce(gen)).rejects.toThrow(/aborting after/);
    expect(activateSpy).not.toHaveBeenCalled(); // the scan never drained → no coverage → no activation
  });

  it('never activates an active generation on an incremental run (no building generation)', async () => {
    const gen = '7';
    const store = makeStore([]); // nothing pending — scan drains immediately
    const activateSpy = vi.fn(async () => {});
    const generations = makeGenerations({ building: null, activate: activateSpy });
    const w = new EmbeddingWorker(deps(store, { generations }));
    await w.runOnce(gen);
    expect(activateSpy).not.toHaveBeenCalled();
  });

  it('never activates an active generation on a backstop run', async () => {
    const gen = '7';
    const store = makeStore([]);
    const activateSpy = vi.fn(async () => {});
    const generations = makeGenerations({ building: null, activate: activateSpy });
    const w = new EmbeddingWorker(deps(store, { generations }));
    await w.runBackstop(gen);
    expect(activateSpy).not.toHaveBeenCalled();
  });

  it('does not activate the running generation when a DIFFERENT generation is building (rebuild in progress)', async () => {
    const activeGen = '7';
    const store = makeStore([]);
    const activateSpy = vi.fn(async () => {});
    const generations = makeGenerations({ building: { id: '8' }, activate: activateSpy });
    const w = new EmbeddingWorker(deps(store, { generations }));
    await w.runOnce(activeGen);
    expect(activateSpy).not.toHaveBeenCalled();
  });

  it('swallows the "still has messages" activation race and leaves the run result intact', async () => {
    const gen = '7';
    const msgs = [{ id: uid(1), subject: 'a', bodyText: 'b', lastModified: 't1', embedGen: null }];
    const store = makeStore(msgs);
    const activateSpy = vi.fn(async () => { throw new Error(`generation ${gen} still has messages needing embedding; pass force to override`); });
    const generations = makeGenerations({ building: { id: gen }, activate: activateSpy });
    const w = new EmbeddingWorker(deps(store, { generations }));
    const res = await w.runOnce(gen); // must NOT reject — activation is a post-coverage promotion
    expect(res.succeeded).toBe(1);
    expect(activateSpy).toHaveBeenCalledTimes(1);
  });

  it('swallows the "not in building state" activation race (already active/retired)', async () => {
    const gen = '7';
    const store = makeStore([]);
    const activateSpy = vi.fn(async () => { throw new Error(`generation ${gen} not in 'building' state`); });
    const generations = makeGenerations({ building: { id: gen }, activate: activateSpy });
    const w = new EmbeddingWorker(deps(store, { generations }));
    await expect(w.runOnce(gen)).resolves.toBeTruthy();
    expect(activateSpy).toHaveBeenCalledTimes(1);
  });
});

describe('EmbeddingWorker.runBackstop', () => {
  it('ignores the watermark and finds a sub-watermark straggler', async () => {
    const msgs = [{ id: uid(1), subject: 's', bodyText: 'b', lastModified: 't1', embedGen: null }];
    const store = makeStore(msgs);
    await store.setWatermark('7', uid(999)); // high watermark that would hide id 1
    const w = new EmbeddingWorker(deps(store));
    const res = await w.runBackstop('7');
    expect(res.succeeded).toBe(1);
    expect(msgs[0].embedGen).toBe('7');
  });
});
