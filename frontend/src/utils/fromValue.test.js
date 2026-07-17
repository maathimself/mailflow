import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { accountFromValue, aliasFromValue, sendAsFromValue, resolveFromValue } from './fromValue.js';

describe('accountFromValue / aliasFromValue / sendAsFromValue', () => {
  it('encodes an account value', () => {
    assert.equal(accountFromValue('acct-1'), 'account:acct-1');
  });

  it('encodes an alias value', () => {
    assert.equal(aliasFromValue('alias-1', 'acct-1'), 'alias:alias-1:acct-1');
  });

  it('encodes a sendas value', () => {
    assert.equal(sendAsFromValue('acct-1', 'sales@example.com'), 'sendas:acct-1:sales@example.com');
  });
});

describe('resolveFromValue', () => {
  it('resolves an account value', () => {
    assert.deepEqual(resolveFromValue('account:acct-1'), { accountId: 'acct-1', aliasId: null, fromEmail: null });
  });

  it('resolves an alias value', () => {
    assert.deepEqual(resolveFromValue('alias:alias-1:acct-1'), { accountId: 'acct-1', aliasId: 'alias-1', fromEmail: null });
  });

  it('resolves a sendas value', () => {
    assert.deepEqual(resolveFromValue('sendas:acct-1:sales@example.com'), { accountId: 'acct-1', aliasId: null, fromEmail: 'sales@example.com' });
  });

  it('round-trips through the matching encoder for all three forms', () => {
    assert.deepEqual(resolveFromValue(accountFromValue('acct-1')), { accountId: 'acct-1', aliasId: null, fromEmail: null });
    assert.deepEqual(resolveFromValue(aliasFromValue('alias-1', 'acct-1')), { accountId: 'acct-1', aliasId: 'alias-1', fromEmail: null });
    assert.deepEqual(resolveFromValue(sendAsFromValue('acct-1', 'sales@example.com')), { accountId: 'acct-1', aliasId: null, fromEmail: 'sales@example.com' });
  });

  it('returns an empty/null shape for a falsy value', () => {
    assert.deepEqual(resolveFromValue(''), { accountId: '', aliasId: null, fromEmail: null });
    assert.deepEqual(resolveFromValue(undefined), { accountId: '', aliasId: null, fromEmail: null });
  });
});
