import assert from 'node:assert/strict';
import test from 'node:test';
import { createBoundedActionIdTracker, isTrustedNativeMessage } from './nativeActionSecurity.js';

test('accepts native window messages only from the same window and origin', () => {
  const expectedWindow = { location: { origin: 'https://mail.example.com' } };

  assert.equal(isTrustedNativeMessage({
    source: expectedWindow,
    origin: 'https://mail.example.com',
  }, expectedWindow), true);
  assert.equal(isTrustedNativeMessage({
    source: expectedWindow,
    origin: 'https://attacker.test',
  }, expectedWindow), false);
  assert.equal(isTrustedNativeMessage({
    source: {},
    origin: 'https://mail.example.com',
  }, expectedWindow), false);
});

test('bounded action ID tracker evicts the oldest IDs', () => {
  const tracker = createBoundedActionIdTracker(2);

  assert.equal(tracker.remember('one'), true);
  assert.equal(tracker.remember('two'), true);
  assert.equal(tracker.remember('two'), false);
  assert.equal(tracker.remember('three'), true);
  assert.equal(tracker.has('one'), false);
  assert.equal(tracker.has('two'), true);
  assert.equal(tracker.has('three'), true);
});
