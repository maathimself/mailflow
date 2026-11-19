import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidForwardAddress, labelNameErrorKey, MAX_LABEL_NAME_LENGTH } from './ruleActions.js';

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

// The same cases as the server's labelNameError (backend inboxRules.labels.test.js), so the editor
// refuses exactly what the server would (D#751).
test('label names the server accepts pass the editor too', () => {
  for (const name of ['Receipt', 'Receipts/2026', 'Paid · 2026', 'Projekt Ä', 'x'.repeat(MAX_LABEL_NAME_LENGTH), '  Receipt  ']) {
    assert.equal(labelNameErrorKey(name), null, name);
  }
});

test('label names the server refuses are refused before saving', () => {
  for (const name of ['', '   ', undefined]) assert.equal(labelNameErrorKey(name), 'admin.rules.errorLabelEmpty', String(name));
  for (const name of [
    'x'.repeat(MAX_LABEL_NAME_LENGTH + 1), 'Re*', '50%', 'a\\b', 'a\nb',
    '/Receipt', 'Receipt/', 'A//B', 'A/../B', 'inbox', 'INBOX/Receipt',
  ]) {
    assert.equal(labelNameErrorKey(name), 'admin.rules.errorLabelInvalid', JSON.stringify(name));
  }
});
