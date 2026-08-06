import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('./DelegateContactPicker.jsx', import.meta.url), 'utf8');

test('provides dialog, combobox, listbox, and active-descendant semantics', () => {
  for (const token of [
    'role="dialog"', 'aria-modal="true"', 'role="combobox"',
    'aria-activedescendant', 'role="listbox"', 'role="option"',
  ]) assert.ok(source.includes(token), `missing ${token}`);
});

test('keeps keyboard navigation visible and inert during IME composition', () => {
  assert.match(source, /scrollIntoView\?\.\(\{ block: 'nearest' \}\)/);
  assert.match(source, /event\.isComposing/);
  assert.match(source, /event\.nativeEvent\?\.isComposing/);
  assert.match(source, /event\.keyCode === 229/);
  assert.match(source, /event\.target === searchRef\.current/);
});

test('resumes with frozen target IDs while cancellation only clears the continuation', () => {
  assert.match(source, /onCancel=\{clearContinuation\}/);
  assert.match(source, /frozenTargetIds: targetIds/);
  assert.match(source, /input: \{ contactId \}/);
});
