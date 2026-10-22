// CORS for the web app, but not for the CardDAV server.
//
// cors() answers every OPTIONS request itself, with a bare 204, before any router runs. CardDAV
// clients send OPTIONS to learn what the server does, and DAVx5 finds no address book unless the
// answer carries "addressbook" in its DAV header, which only the CardDAV router's own OPTIONS
// handler sends. CardDAV clients are not browsers, so CORS means nothing to them anyway.
export function corsExceptDav(corsMiddleware) {
  return (req, res, next) => (isDavPath(req.path) ? next() : corsMiddleware(req, res, next));
}

const isDavPath = (path) => path === '/carddav' || path.startsWith('/carddav/');
