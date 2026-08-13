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
