export function isRestorableFocus(element) {
  return Boolean(
    element?.isConnected
    && !element.disabled
    && element.tabIndex !== -1
    && element.getClientRects?.().length,
  );
}

export function nextFocusIndex(count, currentIndex, backwards) {
  if (count <= 0) return -1;
  if (backwards) return currentIndex <= 0 ? count - 1 : currentIndex - 1;
  return currentIndex >= count - 1 ? 0 : currentIndex + 1;
}
