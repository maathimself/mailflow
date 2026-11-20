import { afterEach, beforeEach, describe, it, mock } from 'node:test';
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

beforeEach(() => {
  localStorage.clear();
  useStore.setState({ user: { id: 'user-1' }, composerContextMenuEnabled: true });
});
afterEach(() => {
  mock.timers.reset();
  api.getPreferences = originalGetPreferences;
  api.savePreferences = originalSavePreferences;
  useStore.getState().setUser(null);
});

describe('composer context menu preference', () => {
  it('saves the setting locally and sends it to the preferences API', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const saved = [];
    api.savePreferences = async payload => { saved.push(payload); return {}; };
    useStore.getState().setComposerContextMenuEnabled(false);
    assert.equal(useStore.getState().composerContextMenuEnabled, false);
    assert.equal(localStorage.getItem('mailflow_composer_context_menu'), 'false');
    mock.timers.tick(1001);
    await Promise.resolve(); await Promise.resolve();
    assert.deepEqual(saved, [{ composerContextMenuEnabled: false }]);
  });
  it('hydrates the setting from the account preferences and resets it on sign-out', async () => {
    api.getPreferences = async () => ({ composerContextMenuEnabled: false });
    await useStore.getState().loadPreferences();
    assert.equal(useStore.getState().composerContextMenuEnabled, false);
    assert.equal(localStorage.getItem('mailflow_composer_context_menu'), 'false');
    useStore.getState().setUser(null);
    assert.equal(useStore.getState().composerContextMenuEnabled, true);
  });
});
