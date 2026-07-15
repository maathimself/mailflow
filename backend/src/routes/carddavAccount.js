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
  getCarddavBookSummaries,
  patchCarddavBookRoles,
  replaceCarddavConnection,
  patchCarddavConnection,
  disconnectCarddavAccount,
  StaleCarddavPlanError,
} from '../services/carddavSync.js';

const router = Router();
router.use(requireAuth);

const clampInterval = (v) => Math.max(15, Math.min(1440, parseInt(v) || 60));

// Public view of the connection — never leaks the stored password. `books` is
// a per-book read-only summary (roles, capabilities, counts); `bookCount`/
// `contactCount` remain as aggregate counts for backward compatibility.
async function publicStatus(config, userId) {
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
    // Absent on every connection made before this setting existed, which must
    // read as OFF — see the export sweep in carddavSync.js.
    publishEmailedContacts: config.publishEmailedContacts === true,
    books: await getCarddavBookSummaries(userId),
  };
}

router.get('/', async (req, res) => {
  res.json(await publicStatus(await getCardavConfig(req.session.userId), req.session.userId));
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
  res.json(await publicStatus(config, req.session.userId));
});

// Update the interval and the publish-emailed-contacts setting (and optionally
// rotate the password).
router.patch('/', async (req, res) => {
  const existing = await getCardavConfig(req.session.userId);
  if (!existing?.serverUrl) return res.status(409).json({ error: 'CardDAV not connected' });

  const patch = {};
  if (req.body.intervalMin != null) patch.intervalMin = clampInterval(req.body.intervalMin);
  // Stored strictly as a boolean: this setting decides whether merely emailing
  // someone publishes them to a shared address book, so a stray truthy value must
  // never turn it on.
  if (req.body.publishEmailedContacts != null) {
    if (typeof req.body.publishEmailedContacts !== 'boolean') {
      return res.status(400).json({ error: 'publishEmailedContacts must be a boolean' });
    }
    patch.publishEmailedContacts = req.body.publishEmailedContacts;
  }
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
  // Turning the setting on widens the export sweep, so publish the contacts it
  // now admits instead of leaving the user waiting for the next interval tick.
  // Like a book-role patch, it leaves the connection generation untouched, so a
  // sync already in flight may have read the old value and be past the sweep:
  // queue an uncoalesced follow-up rather than trusting it to have seen this.
  // Turning it off needs no sync — it publishes nothing new, and contacts already
  // in the address book stay there.
  if (patch.publishEmailedContacts === true) {
    requestCarddavSync(req.session.userId, config.connectionGeneration, { coalesce: false });
  }
  res.json(await publicStatus(config, req.session.userId));
});

// Map a book role-change failure to an HTTP status. A generation fence miss or
// a disconnected connection is a 409 (the connection changed under the client);
// a missing book is 404; a create-denied write-target attempt is 403; an empty
// patch is 400. Anything else propagates to the 500 handler.
function bookPatchError(res, err) {
  if (err instanceof StaleCarddavPlanError) {
    return res.status(409).json({ error: err.message, code: err.reason });
  }
  const status = {
    ERR_CARDDAV_BOOK_PATCH_EMPTY: 400,
    ERR_ADDRESS_BOOK_NOT_FOUND: 404,
    ERR_CARDDAV_READ_ONLY: 403,
    ERR_CARDDAV_WRITE_TARGET_SUBSCRIBED: 409,
  }[err.code];
  if (status) return res.status(status).json({ error: err.message, code: err.code });
  throw err;
}

// Per-book role management: Subscribe / Look-up-senders toggles and the
// write-target radio (see patchCarddavBookRoles). Fenced against the connection
// generation the caller just read, then a background sync applies the pull-side
// effects (a re-subscribed book materializes; an ignored book's ledger drops).
// The role change leaves the generation untouched, so a sync already in flight
// for it may be past the patched book: request an uncoalesced sync, which queues
// a re-run behind that one instead of trusting it to have seen the change.
router.patch('/books/:id', async (req, res) => {
  const config = await getCardavConfig(req.session.userId);
  if (!config?.serverUrl) return res.status(409).json({ error: 'CardDAV not connected' });
  const { isSubscribed, isLookupSource, makeWriteTarget } = req.body || {};
  try {
    await patchCarddavBookRoles(
      req.session.userId,
      req.params.id,
      { isSubscribed, isLookupSource, makeWriteTarget },
      config.connectionGeneration,
    );
  } catch (err) {
    return bookPatchError(res, err);
  }
  requestCarddavSync(req.session.userId, config.connectionGeneration, { coalesce: false });
  res.json(await publicStatus(config, req.session.userId));
});

router.post('/sync', async (req, res) => {
  const config = await getCardavConfig(req.session.userId);
  if (!config?.serverUrl) return res.status(409).json({ error: 'CardDAV not connected' });
  const result = await syncUser(req.session.userId);
  const status = await publicStatus(await getCardavConfig(req.session.userId), req.session.userId);
  res.json({ ...result, status });
});

router.delete('/', async (req, res) => {
  await disconnectCarddavAccount(req.session.userId);
  res.json({ ok: true });
});

export default router;
