export function nextSelection(current, nextOrUpdater) {
  const currentCopy = new Set(current || []);
  const next = typeof nextOrUpdater === 'function' ? nextOrUpdater(currentCopy) : nextOrUpdater;
  return new Set(next || []);
}
