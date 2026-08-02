export function composeModalKeyAction(event, { localEscapeOwned = false } = {}) {
  if (event?.isComposing || event?.keyCode === 229) return 'ignore';
  const key = String(event?.key || '').toLowerCase();
  if (key === 'escape' && localEscapeOwned) return 'dismiss-overlay';
  if ((event?.ctrlKey || event?.metaKey) && !event?.altKey && key === 'enter') return 'send';
  return null;
}

export function handleComposeModalKeyDown(event, {
  localEscapeOwned = false,
  dismissOverlay,
  send,
} = {}) {
  const action = composeModalKeyAction(event, { localEscapeOwned });
  if (action === 'ignore' || action == null) return false;
  event.preventDefault?.();
  event.stopPropagation?.();
  if (action === 'dismiss-overlay') dismissOverlay?.();
  if (action === 'send') send?.();
  return true;
}
