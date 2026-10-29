import { describe, it, expect } from 'vitest';
import { createPluginRegistry } from './registry.js';

const base = { id: 'p1', name: 'Plugin One', version: '1.0.0', tier: 1 };

describe('ordered content transformations', () => {
  it('awaits activation gates and chains the previous result without invoking disabled hooks', async () => {
    const registry = createPluginRegistry();
    registry.register({ ...base, hooks: { content: async ({ value }) => value + 'A' } });
    registry.register({ ...base, id: 'p2', isActive: async () => false, hooks: { content: () => { throw new Error('disabled'); } } });
    registry.register({ ...base, id: 'p3', hooks: { content: { isActive: async () => true, handler: ({ value }) => value + 'B' } } });
    expect(await registry.transformHook('content', {}, 'start')).toBe('startAB');
  });
  it('propagates gate and handler failures instead of silently sending untransformed content', async () => {
    for (const manifest of [
      { isActive: async () => { throw new Error('gate failed'); }, hooks: { content: () => 'bad' } },
      { hooks: { content: () => { throw new Error('handler failed'); } } },
    ]) {
      const registry = createPluginRegistry(); registry.register({ ...base, ...manifest });
      await expect(registry.transformHook('content', {}, 'original')).rejects.toThrow('failed');
    }
  });
});

describe('plugin registry — registration & validation', () => {
  it('registers a valid manifest and exposes it', () => {
    const r = createPluginRegistry();
    r.register(base);
    expect(r.has('p1')).toBe(true);
    expect(r.get('p1').name).toBe('Plugin One');
    expect(r.list()).toHaveLength(1);
  });

  it('rejects bad ids, missing fields, and bad tiers', () => {
    const r = createPluginRegistry();
    expect(() => r.register({ ...base, id: 'Bad Id' })).toThrow(/plugin id/);
    expect(() => r.register({ ...base, id: undefined })).toThrow(/plugin id/);
    expect(() => r.register({ ...base, name: '' })).toThrow(/needs a name/);
    expect(() => r.register({ ...base, version: undefined })).toThrow(/needs a version/);
    expect(() => r.register({ ...base, tier: 3 })).toThrow(/tier must be 1 or 2/);
  });

  it('rejects duplicate ids', () => {
    const r = createPluginRegistry();
    r.register(base);
    expect(() => r.register(base)).toThrow(/already registered/);
  });
});

describe('plugin registry — runHook (fire-and-forget)', () => {
  it('runs every active handler for the hook', async () => {
    const r = createPluginRegistry();
    const calls = [];
    r.register({ ...base, id: 'a', hooks: { onX: (ctx) => calls.push(`a:${ctx.v}`) } });
    r.register({ ...base, id: 'b', hooks: { onX: (ctx) => calls.push(`b:${ctx.v}`) } });
    r.register({ ...base, id: 'c', hooks: { onY: () => calls.push('c') } }); // different hook
    const errors = await r.runHook('onX', { v: 1 });
    expect(calls.sort()).toEqual(['a:1', 'b:1']);
    expect(errors).toEqual([]);
  });

  it('swallows a throwing handler and still runs the others', async () => {
    const r = createPluginRegistry();
    const calls = [];
    r.register({ ...base, id: 'boom', hooks: { onX: () => { throw new Error('kaboom'); } } });
    r.register({ ...base, id: 'ok', hooks: { onX: () => calls.push('ok') } });
    const errors = await r.runHook('onX', {});
    expect(calls).toEqual(['ok']);           // the good plugin still ran
    expect(errors).toHaveLength(1);
    expect(errors[0].pluginId).toBe('boom'); // failure surfaced for logging, not thrown
  });

  it('respects isActive gating (per-account enablement)', async () => {
    const r = createPluginRegistry();
    const calls = [];
    r.register({
      ...base, id: 'gated',
      isActive: (ctx) => ctx.account?.enabled === true,
      hooks: { onX: () => calls.push('ran') },
    });
    await r.runHook('onX', { account: { enabled: false } });
    expect(calls).toEqual([]);               // inactive → skipped
    await r.runHook('onX', { account: { enabled: true } });
    expect(calls).toEqual(['ran']);          // active → ran
  });

  it('a throwing isActive excludes the plugin rather than breaking dispatch', async () => {
    const r = createPluginRegistry();
    const calls = [];
    r.register({ ...base, id: 'bad-gate', isActive: () => { throw new Error('x'); }, hooks: { onX: () => calls.push('x') } });
    r.register({ ...base, id: 'good', hooks: { onX: () => calls.push('good') } });
    await r.runHook('onX', {});
    expect(calls).toEqual(['good']);
  });
});

describe('plugin registry — collectHook (value contribution)', () => {
  it('returns each active handler’s defined result and drops undefined', async () => {
    const r = createPluginRegistry();
    r.register({ ...base, id: 'a', hooks: { folders: () => ['Todo'] } });
    r.register({ ...base, id: 'b', hooks: { folders: () => ['Watch', 'Someday'] } });
    r.register({ ...base, id: 'c', hooks: { folders: () => undefined } }); // contributes nothing
    const results = await r.collectHook('folders', {});
    expect(results.flat().sort()).toEqual(['Someday', 'Todo', 'Watch']);
  });

  it('swallows a throwing collector (contributes nothing)', async () => {
    const r = createPluginRegistry();
    r.register({ ...base, id: 'boom', hooks: { folders: () => { throw new Error('x'); } } });
    r.register({ ...base, id: 'ok', hooks: { folders: () => ['Todo'] } });
    const results = await r.collectHook('folders', {});
    expect(results).toEqual([['Todo']]);
  });
});

describe('plugin registry — per-hook isActive & hasActive', () => {
  it('rejects a hook entry that is neither a function nor { handler }', () => {
    const r = createPluginRegistry();
    expect(() => r.register({ ...base, hooks: { onX: 42 } })).toThrow(/must be a function or { handler }/);
    expect(() => r.register({ ...base, id: 'p2', hooks: { onX: {} } })).toThrow(/must be a function or { handler }/);
  });

  it('accepts the { handler, isActive } entry form and gates only that hook', async () => {
    const r = createPluginRegistry();
    const calls = [];
    r.register({
      ...base, id: 'gtd',
      hooks: {
        always: () => calls.push('always'),                                   // bare fn — never gated
        gated: { handler: () => calls.push('gated'), isActive: (ctx) => !!ctx.account?.gtd_enabled },
      },
    });
    // The account-scoped hook is gated…
    await r.runHook('gated', { account: { gtd_enabled: false } });
    expect(calls).toEqual([]);
    // …while the bare hook on the same plugin runs regardless of that gate.
    await r.runHook('always', { account: { gtd_enabled: false } });
    expect(calls).toEqual(['always']);
    await r.runHook('gated', { account: { gtd_enabled: true } });
    expect(calls).toEqual(['always', 'gated']);
  });

  it('per-hook isActive composes with (does not override) manifest isActive', async () => {
    const r = createPluginRegistry();
    const calls = [];
    r.register({
      ...base, id: 'both',
      isActive: (ctx) => ctx.tier2 === true,                                  // manifest gate
      hooks: { gated: { handler: () => calls.push('ran'), isActive: (ctx) => ctx.on === true } },
    });
    await r.runHook('gated', { tier2: true, on: false });   // hook gate rejects
    await r.runHook('gated', { tier2: false, on: true });   // manifest gate rejects
    expect(calls).toEqual([]);
    await r.runHook('gated', { tier2: true, on: true });    // both pass
    expect(calls).toEqual(['ran']);
  });

  it('hasActive reflects both bare and gated handlers for the ctx', () => {
    const r = createPluginRegistry();
    r.register({
      ...base, id: 'gtd',
      hooks: { ingest: { handler: () => {}, isActive: (ctx) => !!ctx.account?.gtd_enabled } },
    });
    expect(r.hasActive('ingest', { account: { gtd_enabled: true } })).toBe(true);
    expect(r.hasActive('ingest', { account: { gtd_enabled: false } })).toBe(false);
    expect(r.hasActive('nonexistent', {})).toBe(false);
  });
});
