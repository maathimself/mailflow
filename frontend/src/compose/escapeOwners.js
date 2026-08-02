export function createComposeEscapeOwnerRegistry() {
  let order = 0;
  const owners = new Map();

  function register({ sessionId, dismiss, priority = 0 }) {
    if (!sessionId || typeof dismiss !== 'function') return () => {};
    const token = Symbol(sessionId);
    owners.set(token, { sessionId, dismiss, priority, order: ++order });
    return () => owners.delete(token);
  }

  function dismissTop(sessionId) {
    const owner = [...owners.values()]
      .filter(entry => entry.sessionId === sessionId)
      .sort((left, right) => right.priority - left.priority || right.order - left.order)[0];
    if (!owner) return false;
    owner.dismiss();
    return true;
  }

  return Object.freeze({
    register,
    dismissTop,
    clear: () => owners.clear(),
  });
}

export const composeEscapeOwners = createComposeEscapeOwnerRegistry();
