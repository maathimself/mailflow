// Canonical UUID matcher and an Express router.param guard.
//
// Several routes take a UUID path param (:id, :aliasId, ...) and pass it straight into a
// uuid-typed SQL comparison. Without validation a malformed value raises a Postgres cast
// error that surfaces as a 500 (via express-async-errors) instead of a clean 400. Registering
// `router.param('id', uuidParam('id'))` converts that into a 400 before any query runs.
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

// Factory for a router.param callback: (req, res, next, value) => 400 on a malformed UUID.
export function uuidParam(name) {
  return (req, res, next, value) => {
    if (!isUuid(value)) return res.status(400).json({ error: `Invalid ${name}` });
    next();
  };
}
