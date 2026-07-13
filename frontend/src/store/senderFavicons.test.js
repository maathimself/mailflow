import { afterEach, beforeEach, describe, it } from 'node:test';
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

globalThis.localStorage = (() => {
  let values = { mailflow_theme: 'dark' };
  return {
    getItem: key => values[key] ?? null,
    setItem: (key, value) => { values[key] = String(value); },
    removeItem: key => { delete values[key]; },
    clear: () => { values = {}; },
  };
})();

const { api } = await import('../utils/api.js');
const { useStore } = await import('./index.js');
const originalGetPreferences = api.getPreferences;
const originalSavePreferences = api.savePreferences;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function faviconState() {
  const state = useStore.getState();
  return {
    loaded: state.senderFaviconsLoaded,
    enabled: state.senderFavicons,
    saving: state.senderFaviconsSaving,
  };
}

describe('sender favicon preference state', () => {
  beforeEach(() => {
    useStore.setState({
      user: null,
      senderFaviconsLoaded: false,
      senderFavicons: false,
      senderFaviconsSaving: false,
    });
  });

  afterEach(() => {
    api.getPreferences = originalGetPreferences;
    api.savePreferences = originalSavePreferences;
  });

  it('marks the preference loaded after an explicit enable recovers from failed hydration', async () => {
    useStore.getState().setUser({ id: 'user-1' });
    api.getPreferences = async () => { throw new Error('load failed'); };
    await useStore.getState().loadPreferences();
    assert.deepEqual(faviconState(), { loaded: false, enabled: false, saving: false });

    api.savePreferences = async () => ({});
    await useStore.getState().setSenderFavicons(true);

    assert.deepEqual(faviconState(), { loaded: true, enabled: true, saving: false });
  });

  it('discards a delayed enable completion after the authenticated user changes', async () => {
    const save = deferred();
    useStore.getState().setUser({ id: 'user-1' });
    api.savePreferences = () => save.promise;
    const enabling = useStore.getState().setSenderFavicons(true);
    assert.deepEqual(faviconState(), { loaded: false, enabled: false, saving: true });

    useStore.getState().setUser({ id: 'user-2' });
    save.resolve({});
    await enabling;

    assert.deepEqual(faviconState(), { loaded: false, enabled: false, saving: false });
  });

  it('discards delayed preference hydration after the authenticated user changes', async () => {
    const load = deferred();
    useStore.getState().setUser({ id: 'user-1' });
    api.getPreferences = () => load.promise;
    const hydrating = useStore.getState().loadPreferences();

    useStore.getState().setUser({ id: 'user-2' });
    load.resolve({ senderFavicons: true, aiActions: [] });
    await hydrating;

    assert.deepEqual(faviconState(), { loaded: false, enabled: false, saving: false });
  });

  it('resolves a missing current-user preference to enabled after normal hydration', async () => {
    useStore.getState().setUser({ id: 'user-1' });
    api.getPreferences = async () => ({ aiActions: [] });

    await useStore.getState().loadPreferences();

    assert.deepEqual(faviconState(), { loaded: true, enabled: true, saving: false });
  });

  it('keeps a current-user disable visually off and clears saving when persistence fails', async () => {
    useStore.getState().setUser({ id: 'user-1' });
    api.getPreferences = async () => ({ senderFavicons: true, aiActions: [] });
    await useStore.getState().loadPreferences();
    api.savePreferences = async () => { throw new Error('save failed'); };

    await assert.rejects(useStore.getState().setSenderFavicons(false), /save failed/);

    assert.deepEqual(faviconState(), { loaded: true, enabled: false, saving: false });
  });

  it('leaves the preference off and unloaded when enabling fails to persist', async () => {
    useStore.getState().setUser({ id: 'user-1' });
    api.getPreferences = async () => { throw new Error('load failed'); };
    await useStore.getState().loadPreferences();
    assert.deepEqual(faviconState(), { loaded: false, enabled: false, saving: false });

    api.savePreferences = async () => { throw new Error('save failed'); };
    await assert.rejects(useStore.getState().setSenderFavicons(true), /save failed/);

    assert.deepEqual(faviconState(), { loaded: false, enabled: false, saving: false });
  });

  it('lets a toggle completed mid-hydration survive the stale load response', async () => {
    const load = deferred();
    useStore.getState().setUser({ id: 'user-1' });
    api.getPreferences = () => load.promise;
    api.savePreferences = async () => ({});
    const hydrating = useStore.getState().loadPreferences();

    // User flips the toggle on while the GET is still in flight.
    await useStore.getState().setSenderFavicons(true);
    assert.deepEqual(faviconState(), { loaded: true, enabled: true, saving: false });

    // The in-flight GET resolves with the pre-toggle (stale) value.
    load.resolve({ senderFavicons: false, aiActions: [] });
    await hydrating;

    assert.deepEqual(faviconState(), { loaded: true, enabled: true, saving: false });
  });
});
