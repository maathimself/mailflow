import test from 'node:test';
import assert from 'node:assert/strict';
import { commandOutcomeNotification } from './outcomeNotification.js';

const t = (key, values) => values ? `${key}:${JSON.stringify(values)}` : key;

test('formats executor-returned failures that do not carry a top-level error', () => {
  assert.deepEqual(commandOutcomeNotification({
    status: 'failed',
    failed: [{ id: 'acct:<a>', error: 'read failed' }],
  }, t), {
    type: 'error',
    title: 'commandPalette.outcome.failedTitle',
    body: 'read failed',
  });
});

test('formats partial counts including targets that disappeared before execution', () => {
  assert.deepEqual(commandOutcomeNotification({
    status: 'partial',
    succeededIds: ['acct:<a>'],
    failed: [{ id: 'acct:<b>', error: 'move failed' }],
    missingTargetIds: ['acct:<c>'],
  }, t), {
    title: 'commandPalette.outcome.partialTitle',
    body: 'commandPalette.outcome.partialBody:{"succeeded":1,"failed":2}',
  });
});

test('uses executor-provided localized success and partial messages', () => {
  assert.deepEqual(commandOutcomeNotification({
    status: 'success',
    value: { messageKey: 'gtd.delegate.success', messageParams: { count: 2 } },
  }, t), {
    title: 'gtd.delegate.success:{"count":2}',
  });
  assert.deepEqual(commandOutcomeNotification({
    status: 'partial',
    value: { messageKey: 'gtd.delegate.partial', messageParams: { succeeded: 1, failed: 1 } },
  }, t), {
    title: 'gtd.delegate.partial:{"count":2,"succeeded":1,"failed":1}',
  });
});

test('folds vanished frozen targets into the localized delegation partial outcome', () => {
  assert.deepEqual(commandOutcomeNotification({
    status: 'partial',
    succeededIds: ['acct:<a>'],
    failed: [],
    missingTargetIds: ['acct:<gone>'],
    value: { messageKey: 'gtd.delegate.success', messageParams: { count: 1 } },
  }, t), {
    title: 'gtd.delegate.partial:{"count":2,"succeeded":1,"failed":1}',
  });
});
