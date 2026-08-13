import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createPickerRequestGate, nextPickerIndex, normalizeContactOptions } from './contactPicker.js';

describe('contact picker helpers', () => {
  it('wraps keyboard selection and handles empty lists', () => {
    assert.equal(nextPickerIndex(0, -1, 3), 2);
    assert.equal(nextPickerIndex(2, 1, 3), 0);
    assert.equal(nextPickerIndex(-1, 1, 3), 0);
    assert.equal(nextPickerIndex(0, 1, 0), -1);
  });

  it('rejects stale request completions', () => {
    const gate = createPickerRequestGate();
    const first = gate.issue();
    const second = gate.issue();
    assert.equal(gate.isCurrent(first), false);
    assert.equal(gate.isCurrent(second), true);
  });

  it('normalizes contacts and drops unusable rows', () => {
    assert.deepEqual(normalizeContactOptions([
      { id: 'c1', display_name: 'Casey', primary_email: 'c@example.test' },
      { id: 'c2', primary_email: 'e@example.test' },
      { display_name: 'missing id' },
    ]), [
      { id: 'c1', label: 'Casey', email: 'c@example.test' },
      { id: 'c2', label: 'e@example.test', email: 'e@example.test' },
    ]);
  });
});
