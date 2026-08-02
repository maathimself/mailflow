const MIN_COMPOSER_WIDTH = 380;
const COMPOSER_GAP = 12;
const MIN_CAPACITY = 1;
const MAX_CAPACITY = 3;

function timestamp(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function byCreationOrder(left, right) {
  return timestamp(left.createdAt) - timestamp(right.createdAt)
    || left.slot - right.slot
    || String(left.id).localeCompare(String(right.id));
}

function byFocusPriority(left, right) {
  return timestamp(right.lastFocusedAt) - timestamp(left.lastFocusedAt)
    || timestamp(right.createdAt) - timestamp(left.createdAt)
    || left.slot - right.slot
    || String(left.id).localeCompare(String(right.id));
}

export function capacityForDockWidth(width) {
  const usableWidth = Number.isFinite(width) ? Math.max(0, width) : 0;
  const capacity = Math.floor((usableWidth + COMPOSER_GAP) / (MIN_COMPOSER_WIDTH + COMPOSER_GAP));
  return Math.min(MAX_CAPACITY, Math.max(MIN_CAPACITY, capacity));
}

export function visibleComposeSessions(sessions, capacity) {
  const visibleCapacity = Math.min(
    MAX_CAPACITY,
    Math.max(MIN_CAPACITY, Number.isInteger(capacity) ? capacity : MIN_CAPACITY),
  );
  return sessions
    .filter(session => session.presentationState === 'expanded')
    .sort(byFocusPriority)
    .slice(0, visibleCapacity)
    .sort(byCreationOrder);
}

export function composeChipSessions(sessions, capacity) {
  const visibleIds = new Set(
    visibleComposeSessions(sessions, capacity).map(session => session.id),
  );
  return sessions
    .filter(session => !visibleIds.has(session.id))
    .sort((left, right) => left.slot - right.slot
      || String(left.id).localeCompare(String(right.id)));
}

export function nextComposeFocus(sessions) {
  return sessions
    .filter(session => session.presentationState === 'expanded')
    .sort(byFocusPriority)[0]?.id ?? null;
}
