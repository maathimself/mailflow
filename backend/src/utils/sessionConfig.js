// How long a session survives with no activity. This is an IDLE window, not a fixed lifetime
// from login: see `rolling` below. SESSION_IDLE_DAYS sets it, as whole days from 1 to 365.
export const DEFAULT_SESSION_IDLE_DAYS = 7;
export const MAX_SESSION_IDLE_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

// The days SESSION_IDLE_DAYS asks for: the default when unset or empty, null when invalid.
// Whole days only, so "30d", "1.5" or "1e3" are refused rather than read as something else.
export function parseSessionIdleDays(value) {
  const trimmed = (value ?? '').trim();
  if (trimmed === '') return DEFAULT_SESSION_IDLE_DAYS;
  if (!/^\d+$/.test(trimmed)) return null;
  const days = Number(trimmed);
  return days >= 1 && days <= MAX_SESSION_IDLE_DAYS ? days : null;
}

// An invalid value stops the server at startup (index.js), so the fallback here only covers code
// that imports this module without starting the server, such as tests and scripts.
export const SESSION_IDLE_MS =
  (parseSessionIdleDays(process.env.SESSION_IDLE_DAYS) ?? DEFAULT_SESSION_IDLE_DAYS) * DAY_MS;

// Session options, shared by the server and its tests so the two cannot drift.
export function buildSessionOptions(store, secret) {
  return {
    store,
    secret,
    resave: false,
    saveUninitialized: false,
    // Without this, express-session re-sends the cookie only when the session is MODIFIED,
    // so the browser's copy expired a fixed 7 days (the default window) after login however much the account is
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
