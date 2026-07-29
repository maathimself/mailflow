import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidForwardAddress } from './ruleActions.js';

test('accepts one plain forwarding address', () => {
  assert.equal(isValidForwardAddress('recipient@example.com'), true);
});

test('rejects empty, multiple, malformed, and injected forwarding addresses', () => {
  for (const value of [
    '',
    'not-an-address',
    'first@example.com,second@example.com',
    'recipient@example.com\r\nBcc: hidden@example.com',
  ]) {
    assert.equal(isValidForwardAddress(value), false, value);
  }
});
