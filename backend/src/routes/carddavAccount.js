// CardDAV *client* account management: connect/disconnect a remote CardDAV
// server (e.g. Nextcloud) whose contacts are pulled into MailExpert. Credentials
// live in user_integrations (provider='carddav'), password encrypted. This is
// distinct from routes/carddav.js, which is the CardDAV *server* MailExpert exposes.

import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { encrypt } from '../services/encryption.js';
import { validateHost } from '../services/hostValidation.js';
import { getConnectionPolicy } from '../services/connectionPolicy.js';
import { discoverAddressBooks } from '../services/carddavClient.js';
import { syncUser, scheduleCardavUser, stopCardavUser, getCardavConfig } from '../services/carddavSync.js';

const router = Router();
router.use(requireAuth);

const DUP_MODES = ['separate', 'merge', 'skip'];
const clampInterval = (v) => Math.max(15, Math.min(1440, parseInt(v) || 60));

// Public view of the connection — never leaks the stored password.
function publicStatus(config) {
  if (!config?.serverUrl) return { connected: false };
  return {
    connected: true,
    serverUrl: config.serverUrl,
    username: config.username,
    dupMode: config.dupMode || 'separate',
    intervalMin: config.intervalMin || 60,
    lastSyncAt: config.lastSyncAt || null,
    lastError: config.lastError || null,
    bookCount: config.bookCount ?? null,
    contactCount: config.contactCount ?? null,
  };
}

router.get('/', async (req, res) => {
  res.json(publicStatus(await getCardavConfig(req.session.userId)));
});

router.post('/connect', async (req, res) => {
  const { serverUrl, username, password, dupMode, intervalMin } = req.body || {};
  if (!serverUrl || !username || !password) {
    return res.status(400).json({ error: 'Server URL, username, and password are required' });
  }
  let parsed;
  try { parsed = new URL(serverUrl); }
  catch { return res.status(400).json({ error: 'Invalid server URL' }); }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return res.status(400).json({ error: 'Server URL must be http(s).' });
  }

  const policy = await getConnectionPolicy();
  // Require HTTPS so Basic-auth credentials aren't sent in the clear. Plaintext HTTP is
  // permitted ONLY for a genuinely private/local address, and only when the admin has
  // enabled private hosts — never to a public host (which would leak credentials).
  if (parsed.protocol === 'http:') {
    if (!policy.allowPrivateHosts) {
      return res.status(400).json({ error: 'Server URL must use HTTPS.' });
    }
    const publicErr = await validateHost(parsed.hostname, { allowPrivate: false });
    if (!publicErr) { // resolves to a public address
      return res.status(400).json({ error: 'HTTPS is required for a public host; plaintext HTTP is only allowed for a private/local address.' });
    }
  }
  const hostErr = await validateHost(parsed.hostname, { allowPrivate: policy.allowPrivateHosts });
  if (hostErr) return res.status(400).json({ error: hostErr });

  // Verify credentials + reachability before storing anything.
  try {
    await discoverAddressBooks({ serverUrl, username, password, allowPrivate: policy.allowPrivateHosts });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const config = {
    serverUrl, username,
    password: encrypt(password),
    dupMode: DUP_MODES.includes(dupMode) ? dupMode : 'separate',
    intervalMin: clampInterval(intervalMin),
    lastError: null,
  };
  await query(
    `INSERT INTO user_integrations (user_id, provider, config)
     VALUES ($1, 'carddav', $2::jsonb)
     ON CONFLICT (user_id, provider) DO UPDATE SET config = $2::jsonb, updated_at = NOW()`,
    [req.session.userId, JSON.stringify(config)],
  );

  scheduleCardavUser(req.session.userId, config.intervalMin);
  // Kick off the first sync in the background; the client polls GET / for status.
  syncUser(req.session.userId).catch(() => {});
  res.json(publicStatus(config));
});

// Update duplicate handling / interval (and optionally rotate the password).
router.patch('/', async (req, res) => {
  const existing = await getCardavConfig(req.session.userId);
  if (!existing?.serverUrl) return res.status(409).json({ error: 'CardDAV not connected' });

  const patch = {};
  if (req.body.dupMode && DUP_MODES.includes(req.body.dupMode)) patch.dupMode = req.body.dupMode;
  if (req.body.intervalMin != null) patch.intervalMin = clampInterval(req.body.intervalMin);
  if (req.body.password) patch.password = encrypt(req.body.password);

  await query(
    `UPDATE user_integrations SET config = config || $2::jsonb, updated_at = NOW()
     WHERE user_id = $1 AND provider = 'carddav'`,
    [req.session.userId, JSON.stringify(patch)],
  );
  if (patch.intervalMin) scheduleCardavUser(req.session.userId, patch.intervalMin);
  res.json(publicStatus({ ...existing, ...patch }));
});

router.post('/sync', async (req, res) => {
  const config = await getCardavConfig(req.session.userId);
  if (!config?.serverUrl) return res.status(409).json({ error: 'CardDAV not connected' });
  const result = await syncUser(req.session.userId);
  res.json({ ...result, status: publicStatus(await getCardavConfig(req.session.userId)) });
});

router.delete('/', async (req, res) => {
  stopCardavUser(req.session.userId);
  // Remove the synced (read-only) address books; contacts cascade with them.
  await query(
    "DELETE FROM address_books WHERE user_id = $1 AND source = 'carddav'",
    [req.session.userId],
  );
  await query(
    "DELETE FROM user_integrations WHERE user_id = $1 AND provider = 'carddav'",
    [req.session.userId],
  );
  res.json({ ok: true });
});

export default router;
