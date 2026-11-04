// CSRF defense-in-depth for the cookie-authenticated /api surface. A mutating
// request must carry a custom header that a cross-site <form> cannot set and a
// cross-origin fetch cannot send without a CORS preflight — which the CORS policy
// in index.js restricts to FRONTEND_URL. SameSite=lax cookies are the primary defense;
// this closes same-site/subdomain and legacy-browser gaps. The external DAV server
// (/carddav) and OAuth flows (/oauth) are mounted outside /api and use their own
// auth, so they are intentionally not gated here.
//
// An API token request needs no header: a cross-site page cannot make the browser send
// `Authorization: Bearer`, since setting it needs the same CORS preflight. Browsers do attach some
// Authorization headers on their own, such as cached Basic credentials, so the exemption is for a
// request apiTokenAuth has authenticated, never for one that merely carries the header.
const CSRF_SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function csrfGuard(req, res, next) {
  if (CSRF_SAFE_METHODS.has(req.method)) return next();
  if (req.apiToken) return next();
  if (req.get('X-Requested-With')) return next();
  return res.status(403).json({ error: 'Missing required X-Requested-With header' });
}
