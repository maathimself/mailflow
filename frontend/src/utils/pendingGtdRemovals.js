import { removeGtdThreadFromSections } from './gtd.js';

export const pendingGtdRemovalMap = new Map();
export const completedGtdRemovalMap = new Map();

function normalizeStates(states) {
  return [...new Set((states || []).filter(Boolean))].sort();
}

function removalKey(identity, states, accountId = null) {
  return JSON.stringify([accountId, identity, normalizeStates(states)]);
}

function setExpiring(map, identity, states, accountId, ttlMs) {
  const normalizedStates = normalizeStates(states);
  const key = removalKey(identity, normalizedStates, accountId);
  const existing = map.get(key);
  if (existing?.timer) clearTimeout(existing.timer);
  const timer = setTimeout(() => map.delete(key), ttlMs);
  map.set(key, { identity, states: normalizedStates, accountId, timer });
}

function clearRemoval(map, identity, states, accountId = null) {
  const key = removalKey(identity, states, accountId);
  const existing = map.get(key);
  if (existing?.timer) clearTimeout(existing.timer);
  map.delete(key);
}

export function setPendingGtdRemoval(identity, states, accountId = null) {
  clearRemoval(completedGtdRemovalMap, identity, states, accountId);
  setExpiring(pendingGtdRemovalMap, identity, states, accountId, 30000);
}

export function setCompletedGtdRemoval(identity, states, accountId = null) {
  clearRemoval(pendingGtdRemovalMap, identity, states, accountId);
  setExpiring(completedGtdRemovalMap, identity, states, accountId, 10000);
}

export function clearGtdRemovalGuard(identity, states, accountId = null) {
  clearRemoval(pendingGtdRemovalMap, identity, states, accountId);
  clearRemoval(completedGtdRemovalMap, identity, states, accountId);
}

export function applyGtdRemovalGuard(sections) {
  if (pendingGtdRemovalMap.size === 0 && completedGtdRemovalMap.size === 0) return sections;
  let guarded = sections;
  for (const removal of [...pendingGtdRemovalMap.values(), ...completedGtdRemovalMap.values()]) {
    guarded = removeGtdThreadFromSections(guarded, removal.identity, removal.states, removal.accountId);
  }
  return guarded;
}
