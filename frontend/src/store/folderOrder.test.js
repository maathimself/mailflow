import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  cacheFolderOrder,
  cacheFolderOrderFromPreferences,
  mergeFolderOrder,
  readFolderOrder,
} from './folderOrder.js';

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    value: key => values.get(key),
  };
}

describe('folderOrder store preference', () => {
  it('sanitizes the locally cached order during store initialization', () => {
    const storage = memoryStorage({
      mailflow_folder_order: JSON.stringify({
        saved: ['INBOX', 'Archive', 'INBOX', 42],
        malformed: 'not-an-array',
      }),
    });

    assert.deepEqual(readFolderOrder(storage), {
      saved: ['INBOX', 'Archive'],
    });
  });

  it('updates one account without replacing another and mirrors local storage', () => {
    const storage = memoryStorage();
    const next = mergeFolderOrder(
      { other: ['INBOX'] },
      'account-1',
      ['Archive', 'INBOX'],
      storage,
    );

    const expected = {
      other: ['INBOX'],
      'account-1': ['Archive', 'INBOX'],
    };
    assert.deepEqual(next, expected);
    assert.deepEqual(
      JSON.parse(storage.value('mailflow_folder_order')),
      expected,
    );
  });

  it('sanitizes and caches the server order after login', () => {
    const storage = memoryStorage();
    const next = cacheFolderOrder({
      'account-2': ['Projects', 'INBOX', 'Projects'],
      malformed: null,
    }, storage);

    const expected = {
      'account-2': ['Projects', 'INBOX'],
    };
    assert.deepEqual(next, expected);
    assert.deepEqual(
      JSON.parse(storage.value('mailflow_folder_order')),
      expected,
    );
  });

  it('clears a previous user order when the server has no folderOrder preference', () => {
    const storage = memoryStorage({
      mailflow_folder_order: JSON.stringify({
        'previous-user-account': ['Archive', 'INBOX'],
      }),
    });

    const next = cacheFolderOrderFromPreferences({}, storage);

    assert.deepEqual(next, {});
    assert.deepEqual(
      JSON.parse(storage.value('mailflow_folder_order')),
      {},
    );
  });
});
