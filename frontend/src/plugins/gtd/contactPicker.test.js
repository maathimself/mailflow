import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createPickerRequestGate, invalidatePickerQuery, nextPickerIndex, normalizeContactOptions, pickerQueryChange, scrollPickerOptionIntoView, shouldHandlePickerListKey } from './contactPicker.js';

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

  it('reserves list navigation and selection keys for the combobox', () => {
    assert.equal(shouldHandlePickerListKey('Enter', 'combobox'), true);
    assert.equal(shouldHandlePickerListKey('ArrowDown', 'combobox'), true);
    assert.equal(shouldHandlePickerListKey('Enter', null), false);
    assert.equal(shouldHandlePickerListKey('Enter', 'button'), false);
  });

  it('invalidates stale options immediately when the query changes', () => {
    assert.deepEqual(pickerQueryChange('new search'), {
      query: 'new search', options: [], active: -1, loading: true, error: null,
    });
  });

  it('invalidates an in-flight request before the debounced replacement starts', () => {
    const gate = createPickerRequestGate();
    const inFlight = gate.issue();

    invalidatePickerQuery(gate, 'new search');

    assert.equal(gate.isCurrent(inFlight), false);
  });

  it('keeps the active keyboard option in the nearest visible area', () => {
    const calls = [];
    const option = { scrollIntoView: value => calls.push(value) };
    scrollPickerOptionIntoView({ querySelector: selector => (
      selector === '#gtd-delegate-option-12' ? option : null
    ) }, 12);

    assert.deepEqual(calls, [{ block: 'nearest' }]);
  });
});
