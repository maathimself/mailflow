import express from 'express';
import session from 'express-session';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { createClient } from 'redis';
import RedisStore from 'connect-redis';
import 'dotenv/config';

import sendRoutes from './routes/send.js';
import oauthRoutes from './routes/oauth.js';
import integrationsRoutes, { loadIntegrationConfigs } from './routes/integrations.js';
import authRoutes from './routes/auth.js';
import accountRoutes from './routes/accounts.js';
import mailRoutes from './routes/mail.js';
import searchRoutes from './routes/search.js';
import adminRoutes from './routes/admin.js';
import totpRoutes from './routes/totp.js';
import oidcApiRouter, { oidcBrowserRouter } from './routes/oidc.js';
import { initDb, encryptExistingCredentials, query } from './services/db.js';
import { setupWebSocket } from './services/websocket.js';
import { ImapManager } from './services/imapManager.js';

const app = express();
// Trust the nginx reverse proxy so req.secure reflects HTTPS correctly.
// Without this, express-session sees HTTP (from nginx) and refuses to set
// the Secure cookie, meaning the session cookie is never sent to the browser.
app.set('trust proxy', 1);
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });

// Redis
const redisClient = createClient({ url: process.env.REDIS_URL || 'redis://redis:6379' });
redisClient.on('error', err => console.error('Redis error:', err));
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
    // The app always runs behind nginx which terminates TLS — the backend only
    // ever sees HTTP internally, but the browser connection is HTTPS.
    // secure:true is required so Chrome/Safari don't silently drop the cookie
    // on page refresh over HTTPS. trust proxy:1 above makes this work correctly.
    secure: true,
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
  next();
});
// Raised limit for the send endpoint (signatures with embedded images can be large).
// Increase once attachment support is implemented.
app.use('/api/mail/send', express.json({ limit: '10mb' }));
app.use(express.json({ limit: '1mb' }));
app.use(sessionMiddleware);

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
app.use('/api/search', searchRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/totp', totpRoutes);

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// WebSocket
setupWebSocket(wss, sessionMiddleware, imapManager);

// Init DB then start
await initDb();
console.log('Database initialized');

// Encrypt any plaintext credentials left in the DB from before this feature was added
await encryptExistingCredentials();

// Load OAuth integration configs from DB into process.env
await loadIntegrationConfigs();

// Re-connect all enabled IMAP accounts on startup so mail syncs immediately
// even before any WebSocket client connects (covers cold-start and container restarts)
try {
  const startupResult = await query(
    "SELECT DISTINCT user_id FROM email_accounts WHERE enabled = true AND protocol = 'imap'"
  );
  for (const row of startupResult.rows) {
    imapManager.connectAllForUser(row.user_id).catch(err =>
      console.error(`Startup connect failed for user ${row.user_id}:`, err.message)
    );
  }
  if (startupResult.rows.length) {
    console.log(`Reconnecting accounts for ${startupResult.rows.length} user(s) on startup`);
  }
} catch (err) {
  console.error('Startup account connection error:', err.message);
}

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`MailFlow backend running on port ${PORT}`);
});
