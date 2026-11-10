import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spamFolderPaths, selectionSpamAction } from './spamFolders.js';

describe('spamFolderPaths', () => {
  test('a mapped spam folder wins over the folder list', () => {
    assert.deepEqual([...spamFolderPaths({ folder_mappings: { spam: 'Custom/Spam' } }, [{ path: 'Junk', name: 'Junk' }])], ['Custom/Spam']);
  });
  test('falls back to \\Junk special-use and spam-like names', () => {
    const folders = [{ path: 'INBOX', name: 'INBOX' }, { path: 'X', name: 'X', special_use: '\\Junk' }, { path: 'Posta indesiderata', name: 'Posta indesiderata' }];
    assert.deepEqual([...spamFolderPaths({}, folders)], ['X', 'Posta indesiderata']);
  });
  test('no folders, no paths', () => {
    assert.equal(spamFolderPaths(undefined, undefined).size, 0);
  });
});

describe('selectionSpamAction', () => {
  const paths = { a: new Set(['Junk']), b: new Set(['Spam']), none: new Set() };
  const pathsFor = acct => paths[acct] ?? null;
  const msg = (account_id, folder) => ({ account_id, folder });

  test('inbox mail from accounts with spam folders can be marked as spam', () => {
    assert.deepEqual(selectionSpamAction([msg('a', 'INBOX'), msg('b', 'INBOX')], pathsFor), { action: 'spam', enabled: true, pending: false });
  });
  test('mail all in spam folders offers Not spam', () => {
    assert.deepEqual(selectionSpamAction([msg('a', 'Junk'), msg('b', 'Spam')], pathsFor), { action: 'ham', enabled: true, pending: false });
  });
  test('a mix of spam and inbox mail offers neither', () => {
    assert.deepEqual(selectionSpamAction([msg('a', 'Junk'), msg('a', 'INBOX')], pathsFor), { action: 'spam', enabled: false, pending: false });
  });
  test('an account without a spam folder disables it', () => {
    assert.deepEqual(selectionSpamAction([msg('a', 'INBOX'), msg('none', 'INBOX')], pathsFor), { action: 'spam', enabled: false, pending: false });
  });
  test('an account whose folders have not loaded is pending', () => {
    assert.deepEqual(selectionSpamAction([msg('a', 'INBOX'), msg('unloaded', 'INBOX')], pathsFor), { action: 'spam', enabled: false, pending: true });
  });
  test('an empty selection offers nothing', () => {
    assert.deepEqual(selectionSpamAction([], pathsFor), { action: 'spam', enabled: false, pending: false });
  });
});
