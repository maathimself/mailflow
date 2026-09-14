import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSelectedAccount, pruneFolders } from './accountScope.js';

const accounts = [{ id: 'a', enabled: true }, { id: 'b', enabled: true }];

describe('resolveSelectedAccount: the pinned-to-a-deleted-account bug', () => {
  test('falls back to the unified inbox when the selected account is gone', () => {
    // The defect: selectedAccountId came from localStorage and was never checked against the
    // account list. Deleting the selected account left the client asking the server about an
    // id it no longer knew, on every poll, forever, across reloads.
    assert.equal(resolveSelectedAccount(accounts, 'deleted-id'), null);
  });

  test('the favicon reads a real number again once the fallback applies', () => {
    // Reproduces the visible symptom. The badge is `byAccount[selected] ?? 0`, so a dead id
    // silently rendered zero while other accounts genuinely had unread mail.
    const counts = { byAccount: { a: 3, b: 0 }, total: 3 };
    const faviconFor = id => (id ? (counts.byAccount[id] ?? 0) : counts.total);
    assert.equal(faviconFor('deleted-id'), 0, 'the bug, stated as an assertion');
    assert.equal(faviconFor(resolveSelectedAccount(accounts, 'deleted-id')), 3);
  });

  test('keeps a selection that still exists', () => {
    assert.equal(resolveSelectedAccount(accounts, 'a'), 'a');
  });

  test('leaves the unified inbox alone', () => {
    assert.equal(resolveSelectedAccount(accounts, null), null);
    assert.equal(resolveSelectedAccount([], null), null);
  });

  test('does not guess when the account list is not a list', () => {
    // A failed or in-flight fetch must not look like "your account was deleted".
    for (const bad of [undefined, null, 'nope', {}]) {
      assert.equal(resolveSelectedAccount(bad, 'a'), 'a', `accounts=${String(bad)} must not clear the selection`);
    }
  });

  test('an empty account list clears the selection, because nothing can be selected', () => {
    assert.equal(resolveSelectedAccount([], 'a'), null);
  });

  test('tolerates malformed account entries', () => {
    assert.equal(resolveSelectedAccount([null, undefined, { id: 'a' }], 'a'), 'a');
    assert.equal(resolveSelectedAccount([null, {}], 'a'), null);
  });
});

describe('pruneFolders', () => {
  test('drops folder lists for accounts that no longer exist', () => {
    // These were being polled every 60 seconds and returning 404 each time.
    const folders = { a: [{ path: 'INBOX' }], gone: [{ path: 'INBOX' }] };
    assert.deepEqual(Object.keys(pruneFolders(folders, accounts)), ['a']);
  });

  test('returns the same object when there is nothing to prune, so no needless re-render', () => {
    const folders = { a: [], b: [] };
    assert.equal(pruneFolders(folders, accounts), folders);
  });

  test('does not prune against a list it cannot trust', () => {
    const folders = { a: [], gone: [] };
    for (const bad of [undefined, null, 'nope']) {
      assert.equal(pruneFolders(folders, bad), folders, `accounts=${String(bad)} must not drop cached folders`);
    }
  });

  test('degenerate input does not throw', () => {
    assert.equal(pruneFolders(null, accounts), null);
    assert.deepEqual(pruneFolders({}, accounts), {});
    assert.deepEqual(pruneFolders({ a: [] }, []), {});
  });
});
