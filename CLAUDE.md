# MailFlow

A self-hosted, unified webmail client. Dual-licensed: AGPL-3.0, plus a paid commercial
license for use that AGPL does not suit. Node/Express backend, React frontend, PostgreSQL,
shipped as Docker images.

This file is context for coding agents and for anyone new to the project. It says what
MailFlow is for and how to decide what belongs in it. The mechanics live elsewhere and are
linked rather than repeated.

## What this project is for

**The goal is a rock solid unified webmail client.** Everything else is secondary.

Other features are welcome, but not at the expense of that. A change that makes mail sync,
sending or reading less reliable is not worth the feature it buys, however good the feature
is. When a trade-off appears between "more capable" and "more dependable", dependable wins.

Two consequences worth stating plainly, because they are easy to get wrong:

- **Silent degradation is the worst failure mode here.** Mail that quietly stops syncing, or
  a connection that reconnects forever, looks fine from the outside. Prefer a loud failure,
  a warning in the log, or a health check that asserts the invariant, over something that
  limps.
- **Data loss is unacceptable.** IMAP expunge is permanent. Anything that deletes, moves or
  rewrites a user's mail needs to be sure it is acting on the message it thinks it is.

## Priorities

The roadmap lives on the website in a Now / Next / Later format, with no dates and no
commitments: mailflow.sh/#roadmap. It is deliberately kept in one place, so check it there
rather than trusting a copy.

What does not change with it: polish and stability come first. Bug fixes and reliability
work take precedence over new features.

## Core or plugin?

A feature belongs in a **plugin** if it can do its job through the capability surface in
`backend/src/plugins/api.js`. It belongs in **core** only if it genuinely cannot.

This matters because the boundary is what makes review tractable: a plugin cannot reach
core, the database, the network, or another user's data, and `eslint.plugins-boundary.js`
enforces that in CI. So a plugin PR can be reviewed for whether the feature works, rather
than for whether it could compromise the application.

GTD is the reference plugin. See `backend/src/plugins/README.md` for the surface, the rules
and the directory layout. When it is ambiguous, ask rather than guess.

## Layout

| | Path |
|---|---|
| Backend (Express routes, services) | `backend/src/` |
| IMAP engine | `backend/src/services/imapManager.js` |
| Message parsing and sanitizing | `backend/src/services/messageParser.js`, `emailSanitizer.js` |
| Migrations | `backend/migrations/` |
| Frontend (React) | `frontend/src/` |
| Plugins | `backend/src/plugins/<name>/`, `frontend/src/plugins/<name>/` |
| Desktop and mobile shells | `frontend/packages/` |

## How it fits together

- **One process owns every IMAP connection.** `index.js` creates a single `ImapManager`,
  gives it to routes as `app.get('imapManager')` and to the plugin platform through
  `setMailEngine`; plugin hooks only ever see `mailEngineFacade.js`. Each account holds a
  persistent IDLE connection plus a small pool (`acquirePooledClient`, `withFreshClient`) for
  commands. Accounts beyond `IMAP_MAX_PERSISTENT_PER_HOST` run poll-only instead: open, sync,
  close on each tick.
- **Postgres is the read model.** Sync writes headers and flags into `messages` and
  `folders`, and message lists, threads and search are served from those rows. A body is
  fetched from IMAP when first needed, sanitized by `emailSanitizer.js` before it is stored
  (`messageBodyStore.js`), and served from the row after that. Flag changes, moves and
  deletes go back to IMAP through the engine; sending goes out over SMTP from `routes/send.js`.
- **The WebSocket only pushes.** `websocket.js` authenticates the upgrade with the same
  session as the REST API (sessions live in Postgres, `services/sessionStore.js`). The engine
  broadcasts per-user events (`sync_complete`, `flags_synced`, `folders_synced`, …), and the
  client sends nothing but pings. A socket connecting also reconnects that user's accounts, which is how they come
  back after a restart.
- **The frontend is one Zustand store.** `frontend/src/store/index.js` holds the state,
  `utils/api.js` is the REST client, and `hooks/useWebSocket.js` applies pushed events to the
  store.
- **Every `/api` request passes one middleware chain**, `middleware/apiChain.js`, which
  `index.js` mounts ahead of the routers: API token auth, body parsers, session, the CSRF
  check, the screen lock, then the token guards. A mutating request from the browser needs an
  `X-Requested-With` header, which `api.js` adds; one authenticated by an API token does not.
  A token can call only the routes listed in `services/apiTokenAllowlist.js`, so a new route
  stays closed to tokens until it is added there on purpose.
- **Migrations** are numbered `NNNN_name.sql` files that `services/migrations.js` applies at
  startup, in order, under an advisory lock, each in its own transaction. One marked
  `-- no-transaction` runs statement by statement outside a transaction and must be
  idempotent, because a crash before it is recorded runs it again.
- **Tests sit next to the code** as `<module>.test.js` or `<module>.<topic>.test.js`. Most
  backend tests mock `db.js` with `vi.mock`. Frontend tests are plain `node:test`; the
  `*.render.test.js` files transform JSX with `sucrase` in a `node:module` `registerHooks`
  loader, stub modules such as `react-i18next` there, and render into `jsdom`. `sucrase` is
  not a direct dependency: it is installed only because `tailwindcss` depends on it.

## Commands

Node 22 (`.nvmrc`).

```bash
cd backend
npm test              # vitest
npm run lint          # eslint, zero warnings allowed
npm run lint:plugins  # plugin import boundary, must be 0 violations
npx vitest run src/services/folderStatus.test.js   # one file
npx vitest run -t "part of a test name"            # one test by name

cd frontend
npm test              # node --test
npm run lint          # eslint, zero warnings allowed
npm run build
node --test src/utils/listSort.test.js             # one file
```

Both suites and both lints must pass. CI runs them on every PR, together with
`node --check src/index.js` and `npm audit --omit=dev --audit-level=high` on both sides, so a
dependency with a high-severity advisory fails the build.

Suites that need a real database (`*.postgres.test.js` and a few others) are skipped unless
`MAILFLOW_TEST_DATABASE_URL` points at a disposable PostgreSQL, so a green local `npm test`
may not have run them. CI runs them against `postgres:16`:

```bash
MAILFLOW_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/mailflow_test npm test
```

`npm run dev` in `backend/` is `node --watch`. Startup exits unless `SESSION_SECRET` (at
least 32 characters), `DB_PASSWORD` and a 64-hex-character `ENCRYPTION_KEY` are set, and it
applies pending migrations before it listens. Postgres defaults to the compose hostname
(`DB_HOST` overrides it). The Vite dev server on port 5173 proxies `/api` and `/ws` to
`http://backend:3000`, which is hard-coded, so outside compose `backend` has to resolve.

## Working on this codebase

- **Write the test that fails without the fix.** Then revert the fix and confirm it fails.
  A test that passes either way is worse than no test, because it looks like coverage.
- **Keep PRs small and focused.** One fix or feature. Follow-ups go in their own PR rather
  than growing the current one.
- **Open an issue before large work** so the approach can be agreed first. A large PR that
  arrives unannounced may be unmergeable no matter how good it is.
- **Match the surrounding code.** Comments are for the reason behind something surprising,
  not for narrating what the code already says.
- **No half-finished implementations** and no feature flags for hypothetical futures.
- Frontend styling is inline `style={{...}}` objects plus a few shared classes in
  `index.css`. Tailwind is configured but is not the prevailing convention.
- Avoid new dependencies on either side without discussing it first.

See `CONTRIBUTING.md` for commit format, branch naming and PR requirements.

## Paths that need maintainer review

`.github/CODEOWNERS` lists them and GitHub requests review automatically. They are the
places where a mistake is expensive, invisible until much later, or both:

- `emailSanitizer.js`, the boundary that stops untrusted mail executing script
- encryption, sessions and the auth routes
- `backend/migrations/`, which run against live user data and are not reversible in practice
- the connection lifecycle in `imapManager.js`: budgets, IDLE, reconnect, health checks
- workflows, the release script, Dockerfiles and compose, which decide what ships to every
  self-hosted install

## Sharp edges

Things that will bite you if you do not know them.

- **Matching counts are not proof of a healthy sync.** `folderStatus.js` asks IMAP `STATUS`
  about once a minute, and the API serves those server numbers with `counts_known` and
  `counts_stale`. A disagreement with the cached rows queues a resync, but equal counts
  cannot prove equal UID sets, so `folderNeedsSync()` also re-checks membership every 15
  minutes. Counts derived from MailFlow's own rows are a cache, and reading them as
  reassurance has already hidden missing mail. `backend/scripts/verify-count-integrity.mjs`
  exercises this against a disposable database. Change it deliberately, not in passing.
- **Defensive code around connections and errors is not redundant.** An unhandled
  EventEmitter error on the PostgreSQL pool or the WebSocket server takes the process down,
  so those listeners matter even though they look inert. LOGOUT is just another queued IMAP
  command and cannot rescue a hung transport, which is why failed connections are
  force-closed instead. Removing any of it because it looks like it does nothing has
  already been a bug.
- **IMAP IDLE is easy to break silently.** `maxIdleTime` controls how long an IDLE lasts;
  `autoIdleDelay` controls whether one starts at all. A sync interval equal to the arming
  delay cancels IDLE forever, and mail still arrives by polling, so nothing looks wrong. A
  health check now asserts that IDLE-capable accounts are actually idling.
- **Mail is not UTF-8.** Header encoded-words declare their own charset, and plenty of
  senders put raw 8-bit bytes in headers. Decode what the message says, not what is
  convenient.
- **There are two email renderers.** The default renders the sanitized body in an iframe; an
  experimental div-based renderer sits behind `VITE_EMAIL_DIV_RENDER`, default false, and
  compiles away when it is off. Anything touching body rendering has to hold for both.
- **The attachment extension list exists twice.** `backend/src/services/attachmentExtensions.js`
  is canonical and feeds antispam. The frontend image cannot import from `backend/`, so
  `frontend/src/utils/attachmentExtensions.js` keeps a copy for the download warning, and
  `attachmentExtensions.test.js` fails CI when the two differ. Change both together. Keep the
  frontend copy free of imports, because the backend CI job loads it without
  `frontend/node_modules`.
- **A host with no provider profile is not a host without quirks.** `providerProfile()` in
  `imapManager.js` has entries for google, yahoo, apple, microsoft, purelymail and strato.
  Everything else, Zoho included, falls through to `generic`.
