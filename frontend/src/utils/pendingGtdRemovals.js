import { removeGtdThreadFromSections } from './gtd.js';

export const pendingGtdRemovalMap = new Map();
export const completedGtdRemovalMap = new Map();

function normalizeStates(states) {
  return [...new Set((states || []).filter(Boolean))].sort();
}

function removalKey(identity, states) {
  return JSON.stringify([identity, normalizeStates(states)]);
}

function setExpiring(map, identity, states, ttlMs) {
  const normalizedStates = normalizeStates(states);
  const key = removalKey(identity, normalizedStates);
  const existing = map.get(key);
  if (existing?.timer) clearTimeout(existing.timer);
  const timer = setTimeout(() => map.delete(key), ttlMs);
  map.set(key, { identity, states: normalizedStates, timer });
}

function clearRemoval(map, identity, states) {
  const key = removalKey(identity, states);
  const existing = map.get(key);
  if (existing?.timer) clearTimeout(existing.timer);
  map.delete(key);
}

export function setPendingGtdRemoval(identity, states) {
  clearRemoval(completedGtdRemovalMap, identity, states);
  setExpiring(pendingGtdRemovalMap, identity, states, 30000);
}

export function setCompletedGtdRemoval(identity, states) {
  clearRemoval(pendingGtdRemovalMap, identity, states);
  setExpiring(completedGtdRemovalMap, identity, states, 10000);
}

export function clearGtdRemovalGuard(identity, states) {
  clearRemoval(pendingGtdRemovalMap, identity, states);
  clearRemoval(completedGtdRemovalMap, identity, states);
}

export function applyGtdRemovalGuard(sections) {
  if (pendingGtdRemovalMap.size === 0 && completedGtdRemovalMap.size === 0) return sections;
  let guarded = sections;
  for (const removal of [...pendingGtdRemovalMap.values(), ...completedGtdRemovalMap.values()]) {
    guarded = removeGtdThreadFromSections(guarded, removal.identity, removal.states);
  }
  return guarded;
}
