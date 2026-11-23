import { UNDO_WINDOW_MS } from './undoableAction.js';

// Where a desktop Undo bar shows (#813). Under the list while the list is on screen, as it always
// has. When it is not (List first with a message open, or Contacts), the list is only hidden, so
// a bar there counted down unseen: after replying from an open message the user had no Undo, and
// going back to the list showed what was left of it. Then the bars float at the bottom right of
// the window instead. A phone shows them as action bars in NotificationToasts either way (null).
export function undoBarHost({ isMobile, listFirst, showContacts, messageOpen }) {
  if (isMobile) return null;
  if (showContacts || (listFirst && messageOpen)) return 'floating';
  return 'list';
}

// How much of a notification's Undo window is left, counted from when it was raised, not from when
// a bar for it appeared: a bar that moves between the list and the floating stack (the user opens
// or closes a message) must not start the window again, or it would offer an Undo for an action
// that has already gone to the server. A notification without a time stamp gets its whole window.
export function undoWindowLeft(notification, now = Date.now()) {
  const windowMs = notification.undoMs ?? UNDO_WINDOW_MS;
  const raisedAt = Number(notification.createdAt);
  const leftMs = Number.isFinite(raisedAt) ? Math.max(0, Math.min(windowMs, raisedAt + windowMs - now)) : windowMs;
  return { windowMs, leftMs };
}
