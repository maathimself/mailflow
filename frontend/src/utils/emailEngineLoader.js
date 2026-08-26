export function createRetryableLoader(loader) {
  let pending = null;
  return function load() {
    if (!pending) {
      let attempt;
      try {
        attempt = Promise.resolve(loader());
      } catch (error) {
        attempt = Promise.reject(error);
      }
      pending = attempt;
      void attempt.catch(() => {
        if (pending === attempt) pending = null;
      });
    }
    return pending;
  };
}
