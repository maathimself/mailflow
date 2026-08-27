// Manages per-email <style> tag injection into document.head and their cleanup.
// Each email's scoped CSS lives in its own <style> element, keyed by prefix,
// so switching messages removes the old email's styles without touching others.
const injected = new Map(); // prefix → <style> elements

export function injectEmailStyles(prefix, styleBlocks) {
  removeEmailStyles(prefix); // clean up any stale block from a prior render of the same prefix
  const elements = styleBlocks.map((css, index) => {
    const element = document.createElement('style');
    element.dataset.emailPrefix = prefix;
    element.dataset.emailStyleIndex = String(index);
    if (index === styleBlocks.length - 1) element.dataset.mailflowEmailBase = '';
    element.textContent = css;
    document.head.appendChild(element);
    return element;
  });
  if (elements.length) injected.set(prefix, elements);
}

export function getEmailStyleSheets(prefix) {
  return (injected.get(prefix) || []).map(element => element.sheet).filter(Boolean);
}

export function removeEmailStyles(prefix) {
  for (const element of injected.get(prefix) || []) element.remove();
  injected.delete(prefix);
}
