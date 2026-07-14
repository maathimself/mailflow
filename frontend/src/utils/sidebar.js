export function collapsedTooltip(label, collapsed) {
  if (!collapsed) return undefined;
  // An empty title suppresses the browser's own tooltip, so drop the attribute.
  return label?.trim() || undefined;
}

export function activateOnKey(activate) {
  return (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault(); // Space would otherwise scroll the page.
    activate();
  };
}
