export const UNDO_WINDOW_MS = 4500;
export const INBOX_TRIAGE_UNDO_SCOPE = 'inbox-triage';

let undoSequence = 0;

export function isInboxTriageContext(context = {}) {
  const ids = context.displayedMessageIds instanceof Set
    ? context.displayedMessageIds
    : new Set(context.displayedMessageIds || []);
  return context.selectedFolder === 'INBOX'
    && !String(context.searchQuery || '').trim()
    && !context.activeGtdTab
    && Boolean(context.selectedMessageId)
    && ids.has(context.selectedMessageId);
}

// Capture eligibility and user-action order at initiation. The expiry is
// deliberately omitted: addNotification stamps it when the inverse actually
// becomes available, so async thread expansion/classification cannot consume
// the user's visible undo window.
export function createInboxTriageUndoMetadata(context) {
  if (!isInboxTriageContext(context)) return {};
  undoSequence += 1;
  return { undoScope: INBOX_TRIAGE_UNDO_SCOPE, undoSequence };
}

export function getUndoRemainingMs(notification, now = Date.now()) {
  const expiresAt = Number(notification?.undoExpiresAt);
  return Number.isFinite(expiresAt) ? Math.max(0, expiresAt - now) : 0;
}

// Bind a delayed commit and its inverse to the same absolute boundary. The
// deadline is created only after any producer-specific async preparation has
// completed; subtracting a second clock read keeps timer setup overhead from
// extending the commit past the advertised inverse lifetime.
export function scheduleInboxTriageUndoCommit(callback, metadata = {}, {
  now = Date.now,
  setTimer = setTimeout,
} = {}) {
  const undoExpiresAt = now() + UNDO_WINDOW_MS;
  const timer = setTimer(callback, Math.max(0, undoExpiresAt - now()));
  return {
    timer,
    undoMetadata: { ...metadata, undoExpiresAt },
  };
}

export function findLatestInboxTriageUndo(notifications, now = Date.now()) {
  const candidates = (notifications || []).filter(notification =>
    notification?.undoScope === INBOX_TRIAGE_UNDO_SCOPE
    && typeof notification.onUndo === 'function'
    && Number.isFinite(notification.undoExpiresAt)
    && notification.undoExpiresAt > now
  );
  if (candidates.length === 0) return null;

  // Notifications are prepended on completion. Async actions can finish out
  // of order, so prefer the initiation sequence captured at the keypress/click.
  const sequenced = candidates.filter(notification => Number.isFinite(notification.undoSequence));
  if (sequenced.length === 0) return candidates[0];
  return sequenced.reduce((latest, notification) =>
    notification.undoSequence > latest.undoSequence ? notification : latest);
}

export function registerInboxTriageUndoShortcut({ shortcutBus, getState, getDisplayedMessageIds }) {
  const onUndo = () => {
    const state = getState();
    if (!isInboxTriageContext({
      selectedFolder: state.selectedFolder,
      searchQuery: state.searchQuery,
      activeGtdTab: state.activeGtdTab,
      selectedMessageId: state.selectedMessageId,
      displayedMessageIds: getDisplayedMessageIds(),
    })) return;
    const notification = findLatestInboxTriageUndo(state.notifications);
    if (notification) state.runNotificationUndo(notification.id);
  };

  shortcutBus.on('undo', onUndo);
  return () => shortcutBus.off('undo', onUndo);
}
