// CardDAV *client* account management: connect/disconnect a remote CardDAV
// server (e.g. Nextcloud) whose contacts are pulled into MailFlow. Credentials
// live in user_integrations (provider='carddav'), password encrypted. This is
// distinct from routes/carddav.js, which is the CardDAV *server* MailFlow exposes.

import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { encrypt } from '../services/encryption.js';
import { validateHost } from '../services/hostValidation.js';
import { getConnectionPolicy } from '../services/connectionPolicy.js';
import { discoverAddressBooks } from '../services/carddavClient.js';
import {
  syncUser,
  requestCarddavSync,
  scheduleCardavUser,
  getCardavConfig,
  replaceCarddavConnection,
  patchCarddavConnection,
  disconnectCarddavAccount,
} from '../services/carddavSync.js';

const router = Router();
router.use(requireAuth);

const clampInterval = (v) => Math.max(15, Math.min(1440, parseInt(v) || 60));

// Public view of the connection — never leaks the stored password.
function publicStatus(config) {
  if (!config?.serverUrl) return { connected: false };
  return {
    connected: true,
    serverUrl: config.serverUrl,
    username: config.username,
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
  const { serverUrl, username, password, intervalMin } = req.body || {};
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

  const connection = {
    serverUrl, username,
    password: encrypt(password),
    intervalMin: clampInterval(intervalMin),
  };
  const config = await replaceCarddavConnection(req.session.userId, connection);

  scheduleCardavUser(req.session.userId, config.intervalMin);
  // Kick off the first sync in the background; the client polls GET / for status.
  requestCarddavSync(req.session.userId, config.connectionGeneration);
  res.json(publicStatus(config));
});

// Update the interval (and optionally rotate the password).
router.patch('/', async (req, res) => {
  const existing = await getCardavConfig(req.session.userId);
  if (!existing?.serverUrl) return res.status(409).json({ error: 'CardDAV not connected' });

  const patch = {};
  if (req.body.intervalMin != null) patch.intervalMin = clampInterval(req.body.intervalMin);
  if (req.body.password) {
    const policy = await getConnectionPolicy();
    try {
      await discoverAddressBooks({
        serverUrl: existing.serverUrl,
        username: existing.username,
        password: req.body.password,
        allowPrivate: policy.allowPrivateHosts,
      });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    patch.password = encrypt(req.body.password);
  }

  const config = patch.password
    ? await patchCarddavConnection(req.session.userId, patch, existing.connectionGeneration)
    : await patchCarddavConnection(req.session.userId, patch);
  if (patch.intervalMin) scheduleCardavUser(req.session.userId, patch.intervalMin);
  if (patch.password) requestCarddavSync(req.session.userId, config.connectionGeneration);
  res.json(publicStatus(config));
});

router.post('/sync', async (req, res) => {
  const config = await getCardavConfig(req.session.userId);
  if (!config?.serverUrl) return res.status(409).json({ error: 'CardDAV not connected' });
  const result = await syncUser(req.session.userId);
  res.json({ ...result, status: publicStatus(await getCardavConfig(req.session.userId)) });
});

router.delete('/', async (req, res) => {
  await disconnectCarddavAccount(req.session.userId);
  res.json({ ok: true });
});

export default router;
