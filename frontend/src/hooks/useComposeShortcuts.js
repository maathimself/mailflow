import { useEffect, useRef } from 'react';
import { composeEscapeOwners } from '../compose/escapeOwners.js';

const COMPOSER_SELECTOR = '[data-compose-session-id]';

function timestamp(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function composerSessionId(target) {
  return target?.closest?.(COMPOSER_SELECTOR)?.getAttribute?.('data-compose-session-id') || null;
}

function availableCommand(registry, context, commandId) {
  return registry.list(context).some(result => result.command.id === commandId);
}

function lifecycleAvailableForSession(registry, context, commandId, session) {
  const command = registry.get(commandId);
  if (!command || !session) return false;
  return command.isAvailable({
    ...context,
    draft: { id: session.id, slot: session.slot, revision: session.revision },
  });
}

function visibleFallback(visibleSessions, mode) {
  if (mode === 'leftmost') return visibleSessions[0]?.id || null;
  return [...visibleSessions]
    .sort((left, right) => timestamp(right.lastFocusedAt) - timestamp(left.lastFocusedAt)
      || right.slot - left.slot)[0]?.id || null;
}

export function createComposeShortcutHandler({
  commandController,
  registry,
  getContext,
  getSessions,
  getVisibleSessions,
  getFocusedSessionId,
  dismissEscapeOwner = sessionId => composeEscapeOwners.dismissTop(sessionId),
}) {
  const execute = (event, commandId, input) => {
    const currentContext = getContext();
    if (!availableCommand(registry, currentContext, commandId)) return false;
    event.preventDefault();
    commandController.execute(commandId, {
      source: 'compose-shortcut',
      ...(input ? { input } : {}),
    });
    return true;
  };

  const executeLifecycle = (event, commandId, sessionId, sessions) => {
    const currentContext = getContext();
    const session = sessions.find(item => item.id === sessionId);
    if (!lifecycleAvailableForSession(registry, currentContext, commandId, session)) return false;

    if (!currentContext.draft?.id) {
      const activateId = `compose.activateSlot${session.slot}`;
      if (!availableCommand(registry, currentContext, activateId)) return false;
      event.preventDefault();
      commandController.execute(activateId, { source: 'compose-shortcut' });
      commandController.execute(commandId, {
        source: 'compose-shortcut',
        input: { sessionId },
      });
      return true;
    }

    event.preventDefault();
    commandController.execute(commandId, {
      source: 'compose-shortcut',
      input: { sessionId },
    });
    return true;
  };

  return event => {
    if (event.isComposing || event.keyCode === 229) return false;

    const key = String(event.key || '').toLowerCase();
    const modified = (event.metaKey || event.ctrlKey) && !event.altKey;
    const domSessionId = composerSessionId(event.target);
    const sessions = getSessions();
    const visibleSessions = getVisibleSessions();
    const focusedSessionId = getFocusedSessionId();

    if (modified && !event.shiftKey && key === 'w') {
      if (!domSessionId) return false;
      return executeLifecycle(event, 'compose.minimize', domSessionId, sessions);
    }

    if (modified && !event.shiftKey && /^[1-9]$/.test(key)) {
      const commandId = `compose.activateSlot${key}`;
      return execute(event, commandId);
    }

    if (key !== 'escape' || event.metaKey || event.ctrlKey || event.altKey) return false;

    const escapeSessionId = domSessionId || focusedSessionId
      || visibleFallback(visibleSessions, 'recent');
    if (!event.shiftKey && escapeSessionId && dismissEscapeOwner(escapeSessionId)) {
      event.preventDefault();
      event.stopPropagation?.();
      return true;
    }

    if (event.shiftKey) {
      const sessionId = domSessionId || focusedSessionId
        || visibleFallback(visibleSessions, 'leftmost');
      if (!sessionId || !sessions.some(session => session.id === sessionId)) return false;
      return executeLifecycle(event, 'compose.minimize', sessionId, sessions);
    }

    const sessionId = domSessionId || focusedSessionId || visibleFallback(visibleSessions, 'recent');
    if (!sessionId || !sessions.some(session => session.id === sessionId)) return false;
    return executeLifecycle(event, 'compose.close', sessionId, sessions);
  };
}

export function useComposeShortcuts(options) {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    const handler = event => createComposeShortcutHandler(optionsRef.current)(event);
    const documentLike = optionsRef.current.document || globalThis.document;
    documentLike?.addEventListener?.('keydown', handler, true);
    return () => documentLike?.removeEventListener?.('keydown', handler, true);
  }, []);
}
