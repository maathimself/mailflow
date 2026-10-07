import { Router } from 'express';
import { once } from 'events';
import { pool, query } from '../services/db.js';
import { requireAdmin } from '../middleware/auth.js';
import { BACKUP_SCOPES, BackupFileError, restoreBackup, unclassifiedTables, writeBackup } from '../services/backup.js';
import { APP_VERSION, imapManager, restartAfterRestore } from '../index.js';

const router = Router();
router.use(requireAdmin);

// The rows a restore writes replace the ones every IMAP connection, scheduler and cache is
// working from, so the process restarts afterwards. Until then, one restore at a time.
let restoring = false;
// A download holds its snapshot's locks until it finishes, and a restore's TRUNCATE would wait
// on them, so the two are kept apart.
let downloads = 0;

// The download is a plain navigation, which the CSRF header cannot guard, so a page on another
// site must not be able to start one. Browsers that send no Sec-Fetch-Site are let through.
const fromAnotherSite = req => ['cross-site', 'same-site'].includes(req.get('Sec-Fetch-Site'));

// Asked before the download starts, so a problem shows on the page instead of as a failed
// download in the browser.
router.get('/check', async (req, res) => {
  if (restoring) return res.status(409).json({ error: 'A restore is running. Try again when MailFlow is back.' });
  const unclassified = await unclassifiedTables({ query });
  if (unclassified.length) return res.status(500).json({ error: `Tables not classified for backup: ${unclassified.join(', ')}` });
  res.json({ ok: true });
});

router.get('/', async (req, res) => {
  const scope = req.query.scope ?? 'setup';
  if (!BACKUP_SCOPES.includes(scope)) return res.status(400).json({ error: 'scope must be "setup" or "full"' });
  if (fromAnotherSite(req)) return res.status(403).json({ error: 'Start a backup from MailFlow settings.' });
  if (restoring) return res.status(409).json({ error: 'A restore is running. Try again when MailFlow is back.' });

  downloads++;
  let client = null;
  try {
    client = await pool.connect();
    const stamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="mailflow-backup-${stamp}-${scope}.json.gz"`);
    res.setHeader('Cache-Control', 'no-store');
    const { rows } = await writeBackup(client, { scope, appVersion: APP_VERSION, out: res });
    console.log(`[admin] ${req.session.username} downloaded a ${scope} backup (${rows} rows)`);
  } catch (err) {
    console.error('Backup failed:', err.message);
    if (!res.headersSent) {
      res.removeHeader('Content-Disposition');
      res.removeHeader('Content-Type');
      res.status(500).json({ error: err.message });
    } else {
      // Once the first bytes are out the only honest signal left is a failed download.
      res.destroy(err);
    }
  } finally {
    client?.release();
    downloads--;
  }
});

// Reads the rest of an upload before answering, so the answer is not lost to the connection
// reset that closing a socket with unread data causes.
async function discardBody(req) {
  req.unpipe();
  if (req.readableEnded || req.destroyed) return;
  req.resume();
  await Promise.race([once(req, 'end'), once(req, 'close')]).catch(() => {});
}

function restoreErrorMessage(err) {
  if (err instanceof BackupFileError) return err.message;
  if (err.code === '55P03') return 'Another connection kept MailFlow’s tables busy for 30 seconds. Nothing was changed; try again.';
  return err.message;
}

router.post('/restore', async (req, res) => {
  if (!/^application\/(x-)?gzip\b/.test(req.get('Content-Type') || '')) {
    await discardBody(req);
    return res.status(415).json({ error: 'Send the backup file as application/gzip.' });
  }
  if (restoring || downloads) {
    await discardBody(req);
    return res.status(409).json({ error: restoring ? 'A restore is already running.' : 'A backup download is running. Try again when it has finished.' });
  }
  restoring = true;
  // Node cuts off a request still arriving after server.requestTimeout (five minutes by default),
  // and a restore upload arrives for as long as the file takes to send and write. nginx in
  // front bounds a stalled client with its own timeouts.
  const server = req.socket.server;
  const requestTimeout = server.requestTimeout;
  server.requestTimeout = 0;
  let client = null;
  let started = false;
  let committed = false;
  let lastProgressAt = 0;
  const line = obj => res.write(JSON.stringify(obj) + '\n');
  try {
    client = await pool.connect();
    const result = await restoreBackup(client, req, {
      beforeWrite: async () => {
        // The file has passed its checks: from here on the outcome is reported inside a
        // streamed reply, one progress line per batch, so a slow restore keeps the
        // connection alive through any proxy in front of MailFlow.
        started = true;
        res.status(200);
        res.setHeader('Content-Type', 'application/x-ndjson');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();
        await quiesceImap();
      },
      onProgress: progress => {
        if (Date.now() - lastProgressAt < 500) return;
        lastProgressAt = Date.now();
        line(progress);
      },
    });
    committed = true;
    console.log(`[admin] ${req.session.username} restored a ${result.scope} backup (${result.rows} rows); restarting`);
    // The restart must not wait on the reply reaching the browser: the accounts are disconnected
    // and would stay so if the connection dropped before the reply went out.
    let restartScheduled = false;
    const restart = () => {
      if (restartScheduled) return;
      restartScheduled = true;
      setTimeout(restartAfterRestore, 250);
    };
    res.once('close', restart);
    setTimeout(restart, 2000);
    line({ ok: true, ...result });
    res.end();
  } catch (err) {
    const message = restoreErrorMessage(err);
    if (err instanceof BackupFileError) console.warn(`[admin] ${req.session.username}'s restore was refused: ${message}`);
    else console.error(`[admin] ${req.session.username}'s restore failed:`, err);
    if (!started) {
      await discardBody(req);
      if (!res.headersSent) res.status(err instanceof BackupFileError ? 400 : 500).json({ error: message });
    } else {
      // Nothing was committed. The accounts were disconnected for the write, so bring them back
      // now rather than after the rest of the upload has been read off.
      line({ error: message });
      resumeImap();
      await discardBody(req);
      res.end();
    }
  } finally {
    client?.release();
    server.requestTimeout = requestTimeout;
    // After a commit the process is about to restart; until then nothing else may start.
    if (!committed) restoring = false;
  }
});

async function userIds() {
  const { rows } = await query('SELECT id FROM users');
  return rows.map(r => r.id);
}

async function quiesceImap() {
  for (const id of await userIds()) await imapManager.disconnectUser(id);
}

function resumeImap() {
  userIds()
    .then(ids => Promise.all(ids.map(id => imapManager.connectAllForUser(id))))
    .catch(err => console.error('Reconnect after a failed restore:', err.message));
}

export default router;
