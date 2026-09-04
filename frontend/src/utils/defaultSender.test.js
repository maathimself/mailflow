import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveInitialFrom, isValidFromValue } from './defaultSender.js';

const accounts = [
  { id: 'acc-work', aliases: [{ id: 'al-sales' }, { id: 'al-support' }] },
  { id: 'acc-personal', aliases: [] },
  { id: 'acc-side' },  // no aliases key at all
];

describe('isValidFromValue', () => {
  test('accepts an account the user has', () => {
    assert.equal(isValidFromValue('account:acc-personal', accounts), true);
  });

  test('accepts an alias that belongs to the named account', () => {
    assert.equal(isValidFromValue('alias:al-sales:acc-work', accounts), true);
  });

  test('rejects an alias attached to the wrong account', () => {
    assert.equal(isValidFromValue('alias:al-sales:acc-personal', accounts), false);
  });

  test('rejects accounts and aliases that no longer exist', () => {
    assert.equal(isValidFromValue('account:acc-deleted', accounts), false);
    assert.equal(isValidFromValue('alias:al-gone:acc-work', accounts), false);
  });

  test('rejects malformed and empty values without throwing', () => {
    for (const v of [null, undefined, '', 'acc-work', 'alias:', 'alias:a', 'alias:a:b:c', 'account:', 42, {}]) {
      assert.equal(isValidFromValue(v, accounts), false, `${JSON.stringify(v)} must be rejected`);
    }
  });

  test('copes with a missing or malformed account list', () => {
    assert.equal(isValidFromValue('account:acc-work', null), false);
    assert.equal(isValidFromValue('account:acc-work', [null, undefined]), false);
    assert.equal(isValidFromValue('alias:al-sales:acc-side', accounts), false); // account has no aliases key
  });
});

describe('resolveInitialFrom: the unified inbox case (#417)', () => {
  test('uses the configured default when no account context exists', () => {
    const from = resolveInitialFrom({
      selectedAccountId: null,              // the unified inbox
      defaultSender: 'account:acc-personal',
      lastUsedAccountId: 'acc-work',
      accounts,
    });
    assert.equal(from, 'account:acc-personal');
  });

  test('the configured default outranks last-used, which is the whole point', () => {
    // Without this the drift continues and setting a default appears to do nothing.
    const from = resolveInitialFrom({
      defaultSender: 'account:acc-side',
      lastUsedAccountId: 'acc-work',
      accounts,
    });
    assert.equal(from, 'account:acc-side');
  });

  test('an alias can be the default, not just an account', () => {
    const from = resolveInitialFrom({ defaultSender: 'alias:al-support:acc-work', accounts });
    assert.equal(from, 'alias:al-support:acc-work');
  });

  test('falls through when the default points at something deleted', () => {
    const from = resolveInitialFrom({
      defaultSender: 'account:acc-deleted',
      lastUsedAccountId: 'acc-work',
      accounts,
    });
    assert.equal(from, 'account:acc-work', 'a stale preference must not strand the composer');
  });

  test('falls all the way to the first account when nothing else resolves', () => {
    const from = resolveInitialFrom({
      defaultSender: 'account:gone',
      lastUsedAccountId: 'also-gone',
      accounts,
    });
    assert.equal(from, 'account:acc-work');
  });
});

describe('resolveInitialFrom: existing behaviour must not regress', () => {
  test('a reply carrying an alias wins over everything', () => {
    const from = resolveInitialFrom({
      composeData: { aliasId: 'al-sales', accountId: 'acc-work' },
      selectedAccountId: 'acc-personal',
      defaultSender: 'account:acc-side',
      accounts,
    });
    assert.equal(from, 'alias:al-sales:acc-work');
  });

  test('a reply carrying an account wins over the default', () => {
    const from = resolveInitialFrom({
      composeData: { accountId: 'acc-work' },
      defaultSender: 'account:acc-side',
      accounts,
    });
    assert.equal(from, 'account:acc-work', 'replies must answer from the account that received the mail');
  });

  test('viewing one account outranks the default', () => {
    // #417 is about the unified inbox. Composing while reading an account's folder should
    // still send from that account.
    const from = resolveInitialFrom({
      selectedAccountId: 'acc-personal',
      defaultSender: 'account:acc-side',
      accounts,
    });
    assert.equal(from, 'account:acc-personal');
  });

  test('last-used still applies when no default is configured', () => {
    const from = resolveInitialFrom({ lastUsedAccountId: 'acc-side', accounts });
    assert.equal(from, 'account:acc-side');
  });

  test('a stale last-used is skipped, as it was before', () => {
    const from = resolveInitialFrom({ lastUsedAccountId: 'acc-deleted', accounts });
    assert.equal(from, 'account:acc-work');
  });
});

describe('resolveInitialFrom: degenerate input', () => {
  test('returns an empty value when there are no accounts', () => {
    assert.equal(resolveInitialFrom({ accounts: [] }), '');
    assert.equal(resolveInitialFrom({ defaultSender: 'account:x', accounts: [] }), '');
  });

  test('does not throw on missing arguments', () => {
    assert.equal(resolveInitialFrom(), '');
    assert.equal(resolveInitialFrom({}), '');
    assert.equal(resolveInitialFrom({ accounts: null }), '');
  });

  test('ignores a reply account that is not in the list', () => {
    // A message from an account since removed or disabled: better to fall back to something
    // that can actually send than to sit on a From that cannot.
    const from = resolveInitialFrom({ composeData: { accountId: 'acc-deleted' }, accounts });
    assert.equal(from, 'account:acc-work');
  });
});
