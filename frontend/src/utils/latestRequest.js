export function createLatestRequest() {
  let sequence = 0;

  return {
    invalidate: () => { sequence += 1; },
    run: async (request, apply) => {
      const current = ++sequence;
      const value = await request();
      if (current !== sequence) return false;
      apply(value);
      return true;
    },
  };
}
