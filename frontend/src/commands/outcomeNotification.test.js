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
