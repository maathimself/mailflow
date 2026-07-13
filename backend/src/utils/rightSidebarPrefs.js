// Pure allow-list for the generic right-sidebar layout preferences persisted by
// PATCH /auth/preferences. The sidebar is application infrastructure; it does not
// own or inspect the feature content rendered inside it — collapse state is keyed
// by opaque section id, so this bounds the shape without interpreting the keys.

const RIGHT_SIDEBAR_WIDTH_MIN = 200;
const RIGHT_SIDEBAR_WIDTH_MAX = 600;
const MAX_COLLAPSED_KEYS = 40;
const MAX_KEY_LENGTH = 255;

function sanitizeWidth(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n >= RIGHT_SIDEBAR_WIDTH_MIN && n <= RIGHT_SIDEBAR_WIDTH_MAX ? n : null;
}

function sanitizeCollapsed(value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return null;
  const clean = {};
  for (const [key, collapsed] of Object.entries(value)) {
    if (typeof key !== 'string' || key.length === 0 || key.length > MAX_KEY_LENGTH) continue;
    clean[key] = Boolean(collapsed);
    if (Object.keys(clean).length >= MAX_COLLAPSED_KEYS) break;
  }
  return clean;
}

export function sanitizeRightSidebarPrefs(body = {}) {
  return {
    rightSidebarWidth: sanitizeWidth(body.rightSidebarWidth),
    rightSidebarHidden: typeof body.rightSidebarHidden === 'boolean' ? body.rightSidebarHidden : null,
    rightSidebarCollapsed: sanitizeCollapsed(body.rightSidebarCollapsed),
  };
}
