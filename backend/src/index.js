import express from 'express';
import 'express-async-errors'; // route a rejected async handler to the error middleware (Express 4 doesn't)
import session from 'express-session';
import cors from 'cors';
import { createServer } from 'http';
import { readFileSync } from 'fs';
import { WebSocketServer } from 'ws';
import RedisStore from 'connect-redis';
import 'dotenv/config';
import { redisClient } from './services/redis.js';

import sendRoutes from './routes/send.js';
import draftRoutes from './routes/draft.js';
import oauthRoutes from './routes/oauth.js';
import integrationsRoutes, { loadIntegrationConfigs } from './routes/integrations.js';
import authRoutes from './routes/auth.js';
import accountRoutes from './routes/accounts.js';
import mailRoutes from './routes/mail.js';
import searchRoutes from './routes/search.js';
import adminRoutes from './routes/admin.js';
import totpRoutes from './routes/totp.js';
import oidcApiRouter, { oidcBrowserRouter } from './routes/oidc.js';
import rulesRoutes from './routes/rules.js';
import blockListRoutes from './routes/blockList.js';
import contactsRoutes from './routes/contacts.js';
import todoistRoutes from './routes/todoist.js';
import aiRoutes from './routes/ai.js';
import categoriesRoutes from './routes/categories.js';
import gtdRoutes from './routes/gtd.js';
import carddavRouter from './routes/carddav.js';
import carddavAccountRouter from './routes/carddavAccount.js';
import { startCardavScheduler } from './services/carddavSync.js';
import { encryptExistingCredentials, query } from './services/db.js';
import { runMigrations } from './services/migrations.js';
import { parseVCard } from './utils/vcard.js';
import { reloadAuthSettings } from './services/authLimiter.js';
import { setupWebSocket } from './services/websocket.js';
import { ImapManager } from './services/imapManager.js';

const packageMeta = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
let buildMeta = {};
try {
  buildMeta = JSON.parse(readFileSync(new URL('../build-meta.json', import.meta.url), 'utf-8'));
} catch {
  // Local dev runs may not have build metadata yet.
}
const APP_VERSION = (process.env.APP_VERSION || buildMeta.version || packageMeta.version).replace(/^v[.]?/, '');

const app = express();
// Trust the nginx reverse proxy so req.secure reflects HTTPS correctly.
// Without this, express-session sees HTTP (from nginx) and refuses to set
// the Secure cookie, meaning the session cookie is never sent to the browser.
app.set('trust proxy', 1);
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });

// Redis — connect the shared client before any route or session middleware uses it.
await redisClient.connect();

// Fail fast if required secrets are missing
if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
  console.error('FATAL: SESSION_SECRET must be set and at least 32 characters. Exiting.');
  process.exit(1);
}
if (!process.env.DB_PASSWORD) {
  console.error('FATAL: DB_PASSWORD must be set. Exiting.');
  process.exit(1);
}
if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY.length !== 64) {
  console.error('FATAL: ENCRYPTION_KEY must be set and exactly 64 hex characters (32 bytes). Generate one with: openssl rand -hex 32');
  process.exit(1);
}
// APP_URL is required in production: without it every browser WebSocket connection
// is rejected (websocket.js closes connections that send an Origin header when
// ALLOWED_ORIGIN is null), and OIDC redirect URIs become malformed.
if (process.env.NODE_ENV === 'production' && !process.env.APP_URL) {
  console.error('FATAL: APP_URL must be set in production (e.g. https://mail.example.com). WebSocket connections and OIDC depend on it.');
  process.exit(1);
}

// Session
const sessionMiddleware = session({
  store: new RedisStore({ client: redisClient }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    // 'auto' sets Secure based on req.secure, which Express derives from the
    // X-Forwarded-Proto header (trust proxy: 1 above). This makes cookies work
    // correctly regardless of whether the client connects via HTTPS (port 443),
    // HTTP behind a TLS-terminating reverse proxy, or plain HTTP on port 80.
    secure: 'auto',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
  }
});

app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true
}));

// Security headers on every response
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
// 25 MB attachment limit → ~34 MB base64 on the wire; add headroom for the rest of the payload.
app.use('/api/mail/send', express.json({ limit: '35mb' }));
app.use('/api/mail/draft', express.json({ limit: '35mb' }));
// A pet-import body carries a base64 spritesheet (~33% larger than the 5 MB sheet cap
// enforced after decode in gtdPet.importPet), so it needs more than the global 1 MB.
app.use('/api/gtd/pet/import', express.json({ limit: '8mb' }));
app.use(express.json({ limit: '1mb' }));
// Return a clean JSON error when the body parser rejects an oversized payload.
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request too large. Total attachment size must not exceed 25 MB.' });
  }
  next(err);
});
app.use(sessionMiddleware);

// CSRF defense-in-depth for the cookie-authenticated /api surface. A mutating
// request must carry a custom header that a cross-site <form> cannot set and a
// cross-origin fetch cannot send without a CORS preflight — which the CORS policy
// above restricts to FRONTEND_URL. SameSite=lax cookies are the primary defense;
// this closes same-site/subdomain and legacy-browser gaps. The external DAV server
// (/carddav) and OAuth flows (/oauth) are mounted outside /api and use their own
// auth, so they are intentionally not gated here.
const CSRF_SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
app.use('/api', (req, res, next) => {
  if (CSRF_SAFE_METHODS.has(req.method)) return next();
  if (req.get('X-Requested-With')) return next();
  return res.status(403).json({ error: 'Missing required X-Requested-With header' });
});

// Make imap manager available globally
export const imapManager = new ImapManager(wss);
app.set('imapManager', imapManager);

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/auth/oidc', oidcApiRouter);
app.use('/auth/oidc', oidcBrowserRouter);
app.use('/oauth', oauthRoutes);
app.use('/api/integrations', integrationsRoutes);
app.use('/api/accounts', accountRoutes);
app.use('/api/mail', mailRoutes);
app.use('/api/mail', sendRoutes);
app.use('/api/mail', draftRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/totp', totpRoutes);
app.use('/api/rules', rulesRoutes);
app.use('/api/block-list', blockListRoutes);
app.use('/api/contacts', contactsRoutes);
app.use('/api/todoist', todoistRoutes);
app.use('/api/carddav', carddavAccountRouter);
app.use('/api', aiRoutes);
app.use('/api', categoriesRoutes);
// Mounted at the /api/gtd subtree (not bare /api) so gtd.js's router-level
// requireAuth cannot intercept the unauthenticated /api/health and /api/version
// probes registered below. Its routes drop the gtd/ path prefix accordingly.
app.use('/api/gtd', gtdRoutes);

// CardDAV server — body is read lazily inside each handler via rawBody()
app.use('/carddav', carddavRouter);
// RFC 6764 well-known redirect — handle all methods so PROPFIND probes also redirect
app.all('/.well-known/carddav', (req, res) => res.redirect(308, '/carddav/'));

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
app.get('/api/version', (_req, res) => res.json({ version: APP_VERSION, sha: process.env.BUILD_SHA || 'dev' }));

// Catch unhandled errors thrown (or rejected) inside async route handlers.
// The `express-async-errors` import above patches Express 4 to forward async
// rejections here; without both pieces, a thrown DB error hangs the request.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  console.error('Unhandled route error:', err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Internal server error' });
});

// WebSocket
setupWebSocket(wss, sessionMiddleware, imapManager);

// Run pending schema migrations then start
await runMigrations();

// One-time backfill: populate photo_data from existing vcard column for contacts
// that were synced before CardDAV PUT started persisting photo_data.
async function backfillContactPhotos() {
  const { rows } = await query(
    `SELECT id, vcard FROM contacts WHERE vcard IS NOT NULL AND photo_data IS NULL`
  );
  if (!rows.length) return;

  let count = 0;
  for (const row of rows) {
    const parsed = parseVCard(row.vcard);
    if (!parsed.photoData) continue;
    await query('UPDATE contacts SET photo_data = $1 WHERE id = $2', [parsed.photoData, row.id]);
    count++;
  }
  if (count > 0) console.log(`Backfilled contact photos for ${count} contact(s)`);
}
await backfillContactPhotos();

// Load configurable auth rate limit values from DB (seeded by migration above).
await reloadAuthSettings();

// Encrypt any plaintext credentials left in the DB from before this feature was added
await encryptExistingCredentials();

// Load OAuth integration configs from DB into process.env
await loadIntegrationConfigs();

// Start background snooze watcher — polls every 60 seconds to restore snoozed messages
imapManager.startSnoozeWatcher();

// Schedule periodic CardDAV contact sync for any connected accounts.
startCardavScheduler();

// Re-connect all enabled IMAP accounts on startup with bounded concurrency so a
// large user base doesn't hammer IMAP servers and the DB connection pool at once.
try {
  const startupResult = await query(
    "SELECT DISTINCT user_id FROM email_accounts WHERE enabled = true AND protocol = 'imap'"
  );
  if (startupResult.rows.length) {
    console.log(`Reconnecting accounts for ${startupResult.rows.length} user(s) on startup`);
    const MAX_CONCURRENT = 3;
    const queue = [...startupResult.rows];
    function connectNext() {
      if (!queue.length) return;
      const { user_id } = queue.shift();
      imapManager.connectAllForUser(user_id)
        .catch(err => console.error(`Startup connect failed for user ${user_id}:`, err.message))
        .finally(connectNext);
    }
    for (let i = 0; i < Math.min(MAX_CONCURRENT, queue.length); i++) connectNext();
  }
} catch (err) {
  console.error('Startup account connection error:', err.message);
}

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`MailFlow backend running on port ${PORT}`);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received — shutting down gracefully');
  httpServer.close(async () => {
    try { await redisClient.quit(); } catch { /* ignore */ }
    process.exit(0);
  });
  // Force exit if graceful shutdown takes more than 10 s
  setTimeout(() => process.exit(1), 10_000).unref();
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});
