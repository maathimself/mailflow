// Pure allow-list for the generic right-sidebar layout preferences persisted by
// PATCH /auth/preferences. The sidebar is application infrastructure; it does not
// own or inspect the feature content currently rendered inside it.

const RIGHT_SIDEBAR_WIDTH_MIN = 200;
const RIGHT_SIDEBAR_WIDTH_MAX = 600;

function sanitizeWidth(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n >= RIGHT_SIDEBAR_WIDTH_MIN && n <= RIGHT_SIDEBAR_WIDTH_MAX ? n : null;
}

export function sanitizeRightSidebarPrefs(body = {}) {
  return {
    rightSidebarWidth: sanitizeWidth(body.rightSidebarWidth),
    rightSidebarHidden: typeof body.rightSidebarHidden === 'boolean' ? body.rightSidebarHidden : null,
  };
}
