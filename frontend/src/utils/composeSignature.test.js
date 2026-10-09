import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSignatureEnabled } from './composeSignature.js';

test('signatures remain enabled for existing accounts without a preference', () => {
  assert.equal(resolveSignatureEnabled({}), true);
  assert.equal(resolveSignatureEnabled(undefined), true);
});

test('new messages, replies and forwards use the mailbox signature default', () => {
  assert.equal(resolveSignatureEnabled({ signature_enabled: false }), false);
  assert.equal(resolveSignatureEnabled({ signature_enabled: true }), true);
});

test('saved drafts override the current mailbox default', () => {
  assert.equal(resolveSignatureEnabled({ signature_enabled: true }, ''), false);
  assert.equal(resolveSignatureEnabled({ signature_enabled: false }, '<p>Saved signature</p>'), true);
});
