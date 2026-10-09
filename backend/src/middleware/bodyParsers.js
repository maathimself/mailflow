import express from 'express';
import { requireAuth } from './auth.js';

// The routers behind the larger limits below require auth, but only once the body has been
// parsed, so without a check in front of these parsers anyone could make the server read,
// inflate and parse up to 35 MB per request. index.js mounts the parsers before its session
// middleware, so these paths load the session themselves; express-session skips a request
// whose session is already loaded.
export function mountBodyParsers(app, sessionMiddleware) {
  const signedIn = [loadSessionBeforeParsing(sessionMiddleware), requireSignInBeforeParsing];
  // 25 MB attachment limit → ~34 MB base64 on the wire; add headroom for the rest of the payload.
  app.use('/api/mail/send', signedIn, express.json({ limit: '35mb' }), reloadSession);
  app.use('/api/mail/draft', signedIn, express.json({ limit: '35mb' }), reloadSession);
  // A pet-import body carries a base64 spritesheet (~33% larger than the 5 MB sheet cap
  // enforced after decode in gtdPet.importPet), so it needs more than the global 1 MB.
  app.use('/api/gtd/pet/import', signedIn, express.json({ limit: '8mb' }), reloadSession);
  app.use(express.json({ limit: '1mb' }));
  // Return a clean JSON error when the body parser rejects an oversized payload.
  app.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'Request too large. Total attachment size must not exceed 25 MB.' });
    }
    next(err);
  });
}

// Reads off and discards the rest of the body, then calls back, as body-parser does before it
// reports an error. nginx and the Vite dev proxy send Connection: close, and Node closing such a
// socket with body data still unread resets the connection, which can lose the answer before the
// client reads it.
function discardBody(req, callback) {
  if (req.readableEnded || req.destroyed) return callback();
  req.once('end', callback);
  req.resume();
}

// A session store that fails (Redis restarting, say) gets its error answered after the body too.
function loadSessionBeforeParsing(sessionMiddleware) {
  return (req, res, next) => sessionMiddleware(req, res, (err) => (err ? discardBody(req, () => next(err)) : next()));
}

// A signed-out request gets requireAuth's 401 without its body being buffered, inflated or
// parsed. A signed-in request goes on to the parser unchecked here: the router's requireAuth
// looks up its account once the body has been read, so a 401 for an account deleted since
// sign-in is not lost either.
function requireSignInBeforeParsing(req, res, next) {
  if (req.session?.userId) return next();
  discardBody(req, () => requireAuth(req, res, next));
}

// The session was read before the upload, so it is read again now that the body is in: a
// sign-out, a screen lock or a password reset during a long upload still stops the request, as it
// did when these paths read the session after parsing. This is what req.session.reload() does,
// except that a session which has ended is told apart from a store error.
function reloadSession(req, res, next) {
  req.sessionStore.get(req.sessionID, (err, sess) => {
    if (err) return next(err);
    if (sess) {
      req.sessionStore.createSession(req, sess);
      return next();
    }
    // Drop the ended session, as req.session.destroy() does, so no cookie goes out for it, and
    // answer as for any signed-out request.
    delete req.session;
    requireAuth(req, res, next);
  });
}
