import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { filterAccounts, normalizeAccountFilter } from './accountFilter.js';

const ACCOUNTS = [
  { id: 'a1', name: 'Sales Team', email_address: 'sales@example.com' },
  { id: 'a2', name: 'Support', email_address: 'Help.Desk@Gmail.com' },
  { id: 'a3', name: null, email_address: 'jane.doe@gmail.com' },
  { id: 'a4', name: 'Billing', email_address: undefined },
];
const ids = (list) => list.map(a => a.id);

describe('normalizeAccountFilter', () => {
  it('trims and lowercases the query', () => {
    assert.equal(normalizeAccountFilter('  SaLeS  '), 'sales');
  });

  it('treats non-strings as an empty query', () => {
    for (const q of [null, undefined, 42, {}]) assert.equal(normalizeAccountFilter(q), '', String(q));
  });
});

describe('filterAccounts', () => {
  it('matches the account name case-insensitively', () => {
    assert.deepEqual(ids(filterAccounts(ACCOUNTS, 'sales team')), ['a1']);
    assert.deepEqual(ids(filterAccounts(ACCOUNTS, 'SUPP')), ['a2']);
  });

  it('matches the email address case-insensitively', () => {
    assert.deepEqual(ids(filterAccounts(ACCOUNTS, 'help.desk@gmail')), ['a2']);
    assert.deepEqual(ids(filterAccounts(ACCOUNTS, 'gmail.com')), ['a2', 'a3']);
  });

  it('ignores leading and trailing whitespace in the query', () => {
    assert.deepEqual(ids(filterAccounts(ACCOUNTS, '   jane  ')), ['a3']);
  });

  it('tolerates accounts with a missing name or email', () => {
    assert.deepEqual(ids(filterAccounts(ACCOUNTS, 'billing')), ['a4']);
    assert.deepEqual(ids(filterAccounts(ACCOUNTS, 'undefined')), []);
    assert.deepEqual(ids(filterAccounts(ACCOUNTS, 'null')), []);
  });

  it('returns an empty list when nothing matches', () => {
    assert.deepEqual(filterAccounts(ACCOUNTS, 'no-such-mailbox'), []);
  });

  it('returns the full list, same reference, for an empty or blank query', () => {
    for (const q of ['', '   ', null, undefined]) {
      assert.equal(filterAccounts(ACCOUNTS, q), ACCOUNTS, JSON.stringify(q));
    }
  });

  it('preserves the original order and never mutates the input', () => {
    const before = ACCOUNTS.map(a => ({ ...a }));
    const result = filterAccounts(ACCOUNTS, 'l');
    assert.notEqual(result, ACCOUNTS);
    assert.deepEqual(ids(result), ['a1', 'a2', 'a3', 'a4']);
    assert.deepEqual(ACCOUNTS, before);
  });

  it('treats a missing account list as empty', () => {
    assert.deepEqual(filterAccounts(null, 'x'), []);
    assert.deepEqual(filterAccounts(undefined, ''), []);
  });
});
