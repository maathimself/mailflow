// How long a session survives with no activity. This is an IDLE window, not a fixed lifetime
// from login: see `rolling` below.
export const SESSION_IDLE_MS = 7 * 24 * 60 * 60 * 1000;

// Session options, shared by the server and its tests so the two cannot drift.
export function buildSessionOptions(store, secret) {
  return {
    store,
    secret,
    resave: false,
    saveUninitialized: false,
    // Without this, express-session re-sends the cookie only when the session is MODIFIED,
    // so the browser's copy expires a fixed 7 days after login however much the account is
    // used. Reading mail is all GETs that modify nothing, so an active user was signed out
    // every week (#465) while the server-side session was still alive, because store.touch()
    // kept refreshing the stored session's expiry that nothing was reading any more.
    //
    // `rolling` re-sends the cookie on every response, so the window above is measured from
    // last activity rather than from login.
    rolling: true,
    cookie: {
      // 'auto' sets Secure based on req.secure, which Express derives from the
      // X-Forwarded-Proto header (trust proxy is set on the app). This makes cookies work
      // correctly regardless of whether the client connects via HTTPS (port 443), HTTP
      // behind a TLS-terminating reverse proxy, or plain HTTP on port 80.
      secure: 'auto',
      httpOnly: true,
      sameSite: 'lax',
      maxAge: SESSION_IDLE_MS,
    },
  };
}
