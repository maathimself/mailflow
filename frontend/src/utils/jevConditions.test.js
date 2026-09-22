import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeJevConditions } from './jevConditions.js';

test('normalizes an omitted Jev threshold while preserving explicit invalid values', () => {
  const conditions = [
    { field: 'jev', question: 'Invoice?' },
    { field: 'jev', question: 'Receipt?', threshold: null },
    { field: 'from', value: 'sender@example.org' },
  ];
  assert.deepEqual(normalizeJevConditions(conditions), [
    { field: 'jev', question: 'Invoice?', threshold: 0.8 },
    { field: 'jev', question: 'Receipt?', threshold: null },
    { field: 'from', value: 'sender@example.org' },
  ]);
  assert.equal(conditions[0].threshold, undefined);
});
