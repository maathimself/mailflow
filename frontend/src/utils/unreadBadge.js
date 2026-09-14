// Whether to render an unread badge, and what it should say.
//
// A badge is an attention indicator, not a data field: absence means "nothing to tell you".
// Staleness therefore ANNOTATES a badge that already exists for a real reason and must never
// create one. The four sidebar call sites previously each carried their own copy of
// `count > 0 || stale`, so a folder or account with zero unread grew a ghost badge every time
// its observation aged past STATUS_STALE_MS and lost it again on the next observation. On the
// collapsed sidebar that badge is a bare accent dot, visually identical to new mail arriving.
//
// An unknown count also renders nothing. "Unknown is not zero" governs how a count is
// DISPLAYED (see the message-list header, which is a data field and shows an em dash), not
// whether an indicator appears. Inventing an indicator for a value we do not have is the same
// false signal in the other direction.
//
// One helper rather than four inline conditions, so the invariant has a single home and a test.

/**
 * @param count      unread count; null/undefined/NaN mean not yet observed
 * @param known      false when no server observation exists yet
 * @param stale      true when the observation is older than the freshness threshold
 * @param observedAt ISO timestamp of the observation, used in the stale title
 * @param max        clamp above which the text becomes `${max}+`
 * @returns {{text: string, stale: boolean, title: string} | null} null means render nothing
 */
export function unreadBadge({ count, known = true, stale = false, observedAt = null, max = null } = {}) {
  if (!known) return null;
  if (!Number.isFinite(count) || count <= 0) return null;
  const shown = max != null && count > max ? `${max}+` : String(count);
  return {
    text: stale ? `~${shown}` : shown,
    stale: !!stale,
    title: stale
      ? `Last observed unread count${observedAt ? ` (${new Date(observedAt).toLocaleString()})` : ''}; awaiting server refresh`
      : 'Unread messages',
  };
}
