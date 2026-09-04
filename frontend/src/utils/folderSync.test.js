import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { shouldSyncFolder, folderSyncKey, FOLDER_SYNC_MIN_INTERVAL_MS } from './folderSync.js';

const ACC = 'acc-1';
const NOW = 1_000_000;

describe('shouldSyncFolder: the bug it exists to fix', () => {
  test('syncs a folder that already holds messages', () => {
    // The whole defect: the old code only synced a folder with zero local messages, so any
    // folder holding even one went permanently stale. Nothing here depends on emptiness.
    assert.equal(shouldSyncFolder({ accountId: ACC, folder: 'Sent Items', lastSyncedAt: null, now: NOW }), true);
  });

  test('syncs a folder never pulled before', () => {
    assert.equal(shouldSyncFolder({ accountId: ACC, folder: 'Archive', now: NOW }), true);
  });

  test('syncs again once the interval has elapsed', () => {
    const last = NOW - FOLDER_SYNC_MIN_INTERVAL_MS;
    assert.equal(shouldSyncFolder({ accountId: ACC, folder: 'Sent Items', lastSyncedAt: last, now: NOW }), true);
  });
});

describe('shouldSyncFolder: the refresh loop it must not create', () => {
  test('refuses a second sync immediately after one', () => {
    // A finished sync broadcasts sync_complete, which becomes mailflow:refresh, which
    // re-runs the effect that triggered the sync. Returning true here would loop forever.
    assert.equal(shouldSyncFolder({ accountId: ACC, folder: 'Sent Items', lastSyncedAt: NOW, now: NOW }), false);
  });

  test('refuses throughout the interval, right up to the boundary', () => {
    for (const elapsed of [0, 1, 100, 15_000, FOLDER_SYNC_MIN_INTERVAL_MS - 1]) {
      assert.equal(
        shouldSyncFolder({ accountId: ACC, folder: 'Sent Items', lastSyncedAt: NOW - elapsed, now: NOW }),
        false, `must not sync ${elapsed}ms after the last pull`,
      );
    }
  });

  test('a forced sync still cannot be triggered by a refresh, because refreshes do not force', () => {
    // Guards the contract: force is reserved for an explicit user action. This test exists
    // so that wiring force to a refresh handler later would look obviously wrong.
    assert.equal(shouldSyncFolder({ accountId: ACC, folder: 'Sent', lastSyncedAt: NOW, now: NOW, force: false }), false);
  });
});

describe('shouldSyncFolder: what is out of scope', () => {
  test('never syncs INBOX, which IDLE and the poll already cover', () => {
    assert.equal(shouldSyncFolder({ accountId: ACC, folder: 'INBOX', lastSyncedAt: null, now: NOW }), false);
    assert.equal(shouldSyncFolder({ accountId: ACC, folder: 'INBOX', now: NOW, force: true }), false,
      'not even when forced: it would duplicate work, not add coverage');
  });

  test('never syncs the unified inbox, which is not one folder on one account', () => {
    assert.equal(shouldSyncFolder({ accountId: null, folder: 'INBOX', now: NOW }), false);
    assert.equal(shouldSyncFolder({ accountId: null, folder: 'Sent Items', now: NOW, force: true }), false);
  });

  test('does nothing without a folder name', () => {
    assert.equal(shouldSyncFolder({ accountId: ACC, folder: null, now: NOW }), false);
    assert.equal(shouldSyncFolder({ accountId: ACC, folder: '', now: NOW, force: true }), false);
  });
});

describe('shouldSyncFolder: explicit user action', () => {
  test('force overrides the interval', () => {
    // "Sync now" on a folder pulled seconds ago should still refresh it; the user asked.
    assert.equal(shouldSyncFolder({ accountId: ACC, folder: 'Sent Items', lastSyncedAt: NOW, now: NOW, force: true }), true);
  });
});

describe('shouldSyncFolder: degenerate input', () => {
  test('treats an unusable timestamp as never synced rather than blocking forever', () => {
    for (const bad of [NaN, undefined, 'yesterday', {}]) {
      assert.equal(shouldSyncFolder({ accountId: ACC, folder: 'Sent', lastSyncedAt: bad, now: NOW }), true,
        `lastSyncedAt=${String(bad)} must not wedge the folder`);
    }
  });

  test('does not throw on missing arguments', () => {
    assert.equal(shouldSyncFolder(), false);
    assert.equal(shouldSyncFolder({}), false);
  });

  test('honours a custom interval', () => {
    const opts = { accountId: ACC, folder: 'Sent', lastSyncedAt: NOW - 5_000, now: NOW };
    assert.equal(shouldSyncFolder({ ...opts, minIntervalMs: 10_000 }), false);
    assert.equal(shouldSyncFolder({ ...opts, minIntervalMs: 1_000 }), true);
  });
});

describe('folderSyncKey', () => {
  test('scopes by account, since one folder name exists on many', () => {
    assert.notEqual(folderSyncKey('a', 'Sent Items'), folderSyncKey('b', 'Sent Items'));
    assert.equal(folderSyncKey('a', 'Sent Items'), 'a:Sent Items');
  });
});
