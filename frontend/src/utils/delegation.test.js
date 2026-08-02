import test from 'node:test';
import assert from 'node:assert/strict';
import {
  contactOption,
  createPickerRequestGate,
  delegationCacheIds,
  delegateLabel,
  delegateNeedsContact,
  delegateTooltip,
  nextPickerIndex,
  normalizeCarddavStatus,
  normalizeDelegateOutcome,
  pickerDecision,
} from './delegation.js';

test('only an external CardDAV connection requires contact input', () => {
  assert.equal(delegateNeedsContact({ connected: true }), true);
  assert.equal(delegateNeedsContact({ connected: false }), false);
  assert.equal(delegateNeedsContact(null), false);
});

test('delegate label uses normalized API identity', () => {
  assert.equal(delegateLabel({ display_name: 'Casey Rivera', primary_email: 'casey@example.test' }), 'Casey Rivera');
  assert.equal(delegateLabel({ display_name: '', primary_email: 'casey@example.test' }), 'casey@example.test');
  assert.equal(delegateLabel(null), '');
});

test('partial API responses map database IDs back to stable target IDs', () => {
  const targets = [
    { id: 'acct:<a>', message: { id: '11111111-1111-4111-8111-111111111111' } },
    { id: 'acct:<b>', message: { id: '22222222-2222-4222-8222-222222222222' } },
  ];
  const result = {
    status: 'partial',
    successCount: 1,
    failureCount: 1,
    results: [
      { messageId: targets[0].message.id, ok: true },
      { messageId: targets[1].message.id, ok: false, error: { code: 'operation_failed' } },
    ],
  };
  assert.deepEqual(normalizeDelegateOutcome(result, targets), {
    status: 'partial',
    succeededIds: ['acct:<a>'],
    failed: [{ id: 'acct:<b>', error: 'operation_failed' }],
    value: {
      messageKey: 'gtd.delegate.partial',
      messageParams: { count: 2, succeeded: 1, failed: 1 },
    },
  });
});

test('picker index wraps and preserves no selection for an empty list', () => {
  assert.equal(nextPickerIndex(2, 1, 3), 0);
  assert.equal(nextPickerIndex(0, -1, 0), -1);
});

test('contact options retain stable IDs and prefer display names', () => {
  assert.deepEqual(contactOption({
    id: 'contact-1', display_name: 'Casey Rivera', primary_email: 'casey@example.test',
  }), { id: 'contact-1', label: 'Casey Rivera', email: 'casey@example.test' });
});

test('failed or absent CardDAV status defaults to disconnected', () => {
  assert.deepEqual(normalizeCarddavStatus(undefined), { connected: false });
  assert.deepEqual(normalizeCarddavStatus({ connected: true, contactCount: 4 }), {
    connected: true, contactCount: 4,
  });
});

test('stale contact responses are ignored', () => {
  const gate = createPickerRequestGate();
  const first = gate.start();
  const second = gate.start();
  assert.equal(gate.isCurrent(first), false);
  assert.equal(gate.isCurrent(second), true);
});

test('picker decisions distinguish no-person from cancel', () => {
  assert.deepEqual(pickerDecision('no-person'), { type: 'submit', contactId: null });
  assert.deepEqual(pickerDecision('cancel'), { type: 'cancel' });
  assert.deepEqual(pickerDecision('contact', 'contact-1'), { type: 'submit', contactId: 'contact-1' });
});

test('tooltip includes email when distinct from the display name', () => {
  assert.equal(delegateTooltip({
    display_name: 'Casey Rivera', primary_email: 'casey@example.test',
  }), 'Casey Rivera <casey@example.test>');
  assert.equal(delegateTooltip({ display_name: '', primary_email: 'casey@example.test' }), 'casey@example.test');
});

test('delegation cache IDs include matching thread summaries and children', () => {
  const child = { id: 'child-a', account_id: 'account-1', thread_id: 'thread-1' };
  assert.deepEqual(delegationCacheIds({
    messages: [
      { id: 'summary', account_id: 'account-1', thread_id: 'thread-1' },
      { id: 'other', account_id: 'account-1', thread_id: 'thread-2' },
      { id: 'other-account', account_id: 'account-2', thread_id: 'thread-1' },
    ],
    searchResults: [{ id: 'search-copy', account_id: 'account-1', thread_id: 'thread-1' }],
    threadMessages: { 'thread-1': [
      child, { id: 'child-b', account_id: 'account-1', thread_id: 'thread-1' },
    ] },
  }, child), ['child-a', 'summary', 'search-copy', 'child-b']);
});
