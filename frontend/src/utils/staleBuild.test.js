// Run with: node --test src/utils/staleBuild.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AUTO_RELOAD_INTERVAL_MS, claimAutoReload, isStaleBuildError } from './staleBuild.js';

function memoryStorage() {
  const data = new Map();
  return { getItem: k => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)) };
}

describe('isStaleBuildError', () => {
  it('recognises each browser\'s failed dynamic import and Vite\'s CSS preload failure', () => {
    for (const message of [
      // Firefox, as reported against webmail after the 3.7.1 deploy
      'error loading dynamically imported module: https://webmail.example/assets/AdminPanel-BbJRN0h2.js',
      'Failed to fetch dynamically imported module: https://mail.example/assets/ContactsPage-x1.js', // Chromium
      'Importing a module script failed.', // Safari
      'Unable to preload CSS for /assets/AdminPanel-x.css', // Vite
    ]) {
      assert.equal(isStaleBuildError(new Error(message)), true, message);
    }
  });

  it('leaves every other error alone', () => {
    for (const value of [new Error('kaboom'), new TypeError('x is undefined'), 'Network error', null, undefined]) {
      assert.equal(isStaleBuildError(value), false, String(value));
    }
  });
});

describe('claimAutoReload', () => {
  it('allows one automatic reload, then none until the interval has passed', () => {
    const storage = memoryStorage();
    assert.equal(claimAutoReload(storage, 1_000_000), true);
    assert.equal(claimAutoReload(storage, 1_000_000 + AUTO_RELOAD_INTERVAL_MS - 1), false);
    assert.equal(claimAutoReload(storage, 1_000_000 + AUTO_RELOAD_INTERVAL_MS), true);
  });

  it('never reloads without working session storage, since a loop could not be stopped', () => {
    assert.equal(claimAutoReload(null), false);
    assert.equal(claimAutoReload({ getItem() { throw new Error('denied'); }, setItem() {} }), false);
    assert.equal(claimAutoReload({ getItem: () => null, setItem() { throw new Error('quota'); } }), false);
  });
});
