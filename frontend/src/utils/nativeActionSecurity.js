export function isTrustedNativeMessage(event, expectedWindow = window) {
  return event.source === expectedWindow && event.origin === expectedWindow.location.origin;
}

export function createBoundedActionIdTracker(limit = 1000) {
  const ids = new Set();

  return {
    has(id) {
      return ids.has(id);
    },

    remember(id) {
      if (ids.has(id)) return false;
      ids.add(id);

      while (ids.size > limit) {
        ids.delete(ids.values().next().value);
      }

      return true;
    },
  };
}
