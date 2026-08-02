export function createPendingOperationManager(timers) {
  const operations = new Set();

  const register = operation => {
    operations.add(operation);
    return () => operations.delete(operation);
  };

  const flush = async (mode = 'normal') => {
    const pending = [...operations];
    operations.clear();
    await Promise.allSettled(pending.map(operation => {
      timers.clearTimeout(operation.timer);
      if (mode === 'unload' && operation.unload) return operation.unload();
      return operation.run();
    }));
  };

  return Object.freeze({ register, flush });
}
