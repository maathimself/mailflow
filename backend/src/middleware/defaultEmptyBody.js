// Express 4's body parsers always initialised req.body to {}. Express 5 leaves it
// undefined when no parser handled the request (no body, or another content type),
// so a handler that destructures req.body would throw. Restore the empty-object contract.
export function defaultEmptyBody(req, _res, next) {
  if (req.body === undefined) req.body = {};
  next();
}
