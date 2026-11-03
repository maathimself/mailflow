// Every request an API token can make (#617). Anything not listed here is refused with 403,
// including routes added later, until someone adds them on purpose. apiTokenAllowlist.test.js
// checks each entry against the routers and every other route against the matcher.
//
// A path is matched exactly against req.originalUrl without its query string, as the screen-lock
// gate does: case-sensitive, anchored, with no trailing slash and no prefix matching, and for the
// method listed only (HEAD and OPTIONS are on no entry). :uuid matches a UUID and nothing else, so
// a literal sibling route can never be taken for one. Anything unusual (an encoded character, a
// double slash, a dot segment) matches no entry, so it is refused.
//
// scope null: any valid token. guard: a post-parse check in middleware/apiTokenGuards.js.
const ENTRIES = [
  { method: 'GET', path: '/api/health', scope: null },
  { method: 'GET', path: '/api/version', scope: null },
  { method: 'GET', path: '/api/api-tokens/self', scope: null },

  // The response is narrowed for tokens (routes/accounts.js).
  { method: 'GET', path: '/api/accounts', scope: 'read' },
  { method: 'GET', path: '/api/accounts/:uuid/folders', scope: 'read' },
  { method: 'GET', path: '/api/mail/messages', scope: 'read' },
  { method: 'GET', path: '/api/mail/messages/:uuid', scope: 'read' },
  { method: 'GET', path: '/api/mail/messages/:uuid/body', scope: 'read' },
  { method: 'GET', path: '/api/mail/resolve-message', scope: 'read' },
  // The query form only: the legacy path form carries Message-IDs, which can contain slashes.
  { method: 'GET', path: '/api/mail/thread', scope: 'read' },
  { method: 'GET', path: '/api/mail/unread-counts', scope: 'read' },
  { method: 'GET', path: '/api/mail/category-counts', scope: 'read' },
  { method: 'GET', path: '/api/search', scope: 'read' },
  { method: 'GET', path: '/api/search/contacts', scope: 'read' },

  // Not the single-message PATCH /read and /star: they do not type-check their boolean, and the
  // bulk routes do.
  { method: 'POST', path: '/api/mail/messages/bulk-read', scope: 'organize' },
  { method: 'POST', path: '/api/mail/messages/bulk-star', scope: 'organize' },
  { method: 'POST', path: '/api/mail/messages/bulk-archive', scope: 'organize', guard: 'bulkArchive' },
  { method: 'POST', path: '/api/mail/messages/bulk-move', scope: 'organize', guard: 'bulkMove' },
  { method: 'POST', path: '/api/mail/messages/:uuid/snooze', scope: 'organize', guard: 'snooze' },
  { method: 'PATCH', path: '/api/mail/messages/:uuid/snooze', scope: 'organize' },
  { method: 'POST', path: '/api/mail/messages/:uuid/unsnooze', scope: 'organize' },
  { method: 'PATCH', path: '/api/mail/messages/:uuid/category', scope: 'organize' },

  { method: 'POST', path: '/api/mail/draft', scope: 'draft', guard: 'draft' },
  { method: 'POST', path: '/api/mail/reply-drafts/indicators', scope: 'draft' },
];

const UUID_PATTERN = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function compile(entry) {
  const pattern = entry.path.split('/').map(segment => (segment === ':uuid' ? UUID_PATTERN : escapeRegex(segment))).join('/');
  return Object.freeze({ ...entry, guard: entry.guard ?? null, regex: new RegExp(`^${pattern}$`) });
}

export const API_TOKEN_ROUTES = Object.freeze(ENTRIES.map(compile));

// The entry a request matches, or null.
export function matchApiTokenRoute(method, originalUrl) {
  if (typeof method !== 'string' || typeof originalUrl !== 'string') return null;
  const path = originalUrl.split('?')[0];
  return API_TOKEN_ROUTES.find(route => route.method === method && route.regex.test(path)) ?? null;
}
