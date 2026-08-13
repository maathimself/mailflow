const listeners = new Set();
const CLOSED = Object.freeze({ phase: 'closed', messageIds: Object.freeze([]), error: null });
export const MAX_DELEGATION_MESSAGES = 100;
let state = CLOSED;

function publish(next) {
  state = Object.freeze({
    phase: next.phase,
    messageIds: Object.freeze([...(next.messageIds || [])]),
    error: next.error ?? null,
  });
  for (const listener of listeners) listener();
}

export function openDelegation(messageIds) {
  const ids = [...new Set((messageIds || []).filter(Boolean))];
  publish({
    phase: ids.length > MAX_DELEGATION_MESSAGES ? 'rejected' : 'checking',
    messageIds: ids,
    error: null,
  });
  return state;
}

export function updateDelegation(phase, error = null) {
  publish({ phase, messageIds: state.messageIds, error });
}

export function closeDelegation() {
  publish(CLOSED);
}

export function subscribeDelegation(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getDelegationSnapshot() {
  return state;
}
