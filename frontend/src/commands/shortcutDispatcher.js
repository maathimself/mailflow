const isTypingTarget = target => ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName)
  || target?.isContentEditable || target?.closest?.('[data-shortcut-recorder="true"]');

export function shortcutEventChord(event) {
  const key = event.key === ' ' ? 'space' : event.key.toLowerCase();
  const parts = [];
  if (event.metaKey) parts.push('meta');
  if (event.ctrlKey) parts.push('ctrl');
  if (event.altKey) parts.push('alt');
  if (event.shiftKey && (key === 'space' || /^[a-z0-9]$/.test(key))) parts.push('shift');
  parts.push(key);
  return parts.join('+');
}

export function createShortcutDispatcher({ registry, getContext, getBindings, execute, timers }) {
  let pending = null;
  let pendingTimer = null;
  let pendingContextKey = null;

  const reset = () => {
    pending = null;
    pendingContextKey = null;
    if (pendingTimer) timers.clearTimeout(pendingTimer);
    pendingTimer = null;
  };

  const handleKeyDown = event => {
    const context = getContext();
    const contextKey = JSON.stringify([
      context.surface, context.modal?.kind || '', context.editing,
      context.accountId, context.folder, context.activeConversationId,
      context.selectedConversationIds, context.shortcutOverrides,
    ]);
    if ((pending && pendingContextKey !== contextKey) || context.modal || context.editing
      || isTypingTarget(event.target) || event.isComposing || event.keyCode === 229) {
      reset();
      return false;
    }
    const chord = shortcutEventChord(event);
    if (chord === 'escape' && pending) {
      event.preventDefault();
      reset();
      return true;
    }
    const available = new Map(registry.list(context)
      .map(result => result.command)
      .map(command => [command.id, command]));
    const candidates = getBindings().flatMap(item => available.has(item.commandId)
      ? item.bindings.map(binding => ({ ...binding, commandId: item.commandId }))
      : []);
    const resolved = pending ? `${pending} ${chord}` : chord;
    const exact = candidates.filter(candidate => candidate.keys.toLowerCase() === resolved)
      .sort((a, b) => (available.get(b.commandId).rank?.base ?? 0)
        - (available.get(a.commandId).rank?.base ?? 0));
    if (exact.length) {
      event.preventDefault();
      reset();
      execute(exact[0].commandId, { source: 'shortcut' });
      return true;
    }
    if (candidates.some(candidate => candidate.keys.toLowerCase().startsWith(`${resolved} `))) {
      event.preventDefault();
      reset();
      pending = resolved;
      pendingContextKey = contextKey;
      pendingTimer = timers.setTimeout(reset, 1000);
      return true;
    }
    reset();
    return false;
  };

  return Object.freeze({ handleKeyDown, reset });
}
