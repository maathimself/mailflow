// The hover quick-actions vocabulary (#440), shared by the store (preference
// sanitizing), RowHoverActions (rendering), and the settings panel (choices).
// Canonical order is render order; customization is membership, never order.
export const HOVER_ACTION_KEYS = ['markRead', 'star', 'archive', 'snooze', 'delete', 'move'];

// The pre-#440 cluster, byte-identical for callers that configure nothing.
export const DEFAULT_HOVER_ACTIONS = ['markRead', 'star', 'delete', 'move'];

// Normalize a stored or incoming set: canonical order, known keys only.
export const sanitizeHoverActionSet = (keys) =>
  HOVER_ACTION_KEYS.filter(k => Array.isArray(keys) && keys.includes(k));
