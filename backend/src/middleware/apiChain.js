import { apiTokenAuth } from './apiTokenAuth.js';
import { apiTokenGuards } from './apiTokenGuards.js';
import { mountBodyParsers } from './bodyParsers.js';
import { csrfGuard } from './csrfGuard.js';
import { screenLockGate } from './screenLock.js';

// Everything that decides who a request is and whether it may go on, in the order it has to run.
// index.js mounts it ahead of the routers and the tests mount the same function, so the order is
// tested as it runs.
//
// API tokens come first: a token request has to be decided before the 35 MB parsers read its body,
// and before express-session, which skips any request that already carries req.session. Their
// post-parse guards come last, once the body is in.
export function mountApiAuth(app, sessionMiddleware) {
  app.use('/api', apiTokenAuth);
  // Body parsers live in bodyParsers.js. The larger limits are for signed-in requests only, so
  // those paths load the session there first.
  mountBodyParsers(app, sessionMiddleware);
  app.use(sessionMiddleware);
  app.use('/api', csrfGuard);
  app.use('/api', screenLockGate);
  app.use('/api', apiTokenGuards);
}
