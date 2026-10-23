import { contactOption } from './delegation.js';

export function nextPickerIndex(index, delta, length) {
  if (length <= 0) return -1;
  if (index < 0) return delta < 0 ? length - 1 : 0;
  return (index + delta + length) % length;
}

export function createPickerRequestGate() {
  let generation = 0;
  return {
    issue: () => ++generation,
    isCurrent: value => value === generation,
  };
}

export function normalizeContactOptions(contacts) {
  return (Array.isArray(contacts) ? contacts : []).map(contactOption).filter(Boolean);
}

export function shouldHandlePickerListKey(key, targetRole) {
  return targetRole === 'combobox' && ['ArrowDown', 'ArrowUp', 'Enter'].includes(key);
}

export function pickerQueryChange(query) {
  return { query, options: [], active: -1, loading: true, error: null };
}

export function invalidatePickerQuery(gate, query) {
  gate.issue();
  return pickerQueryChange(query);
}

export function scrollPickerOptionIntoView(list, index) {
  if (index < 0) return;
  list?.querySelector?.(`#gtd-delegate-option-${index}`)?.scrollIntoView?.({ block: 'nearest' });
}
