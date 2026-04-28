import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { authenticator } from 'otplib';
import { query, pool } from '../services/db.js';
import { imapManager } from '../index.js';
import { decrypt } from '../services/encryption.js';

const router = Router();

// Simple in-memory rate limiter — no extra dependency required.
// Buckets are keyed by IP; entries expire after the window elapses.
const rateBuckets = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets) {
    if (now > bucket.resetAt) rateBuckets.delete(key);
  }
}, 5 * 60 * 1000);

function rateLimit(maxRequests, windowMs) {
  return (req, res, next) => {
    const key = req.ip;
    const now = Date.now();
    const bucket = rateBuckets.get(key);
    if (!bucket || now > bucket.resetAt) {
      rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    if (bucket.count >= maxRequests) {
      res.setHeader('Retry-After', Math.ceil((bucket.resetAt - now) / 1000));
      return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
    }
    bucket.count++;
    next();
  };
}
const authLimiter = rateLimit(10, 15 * 60 * 1000); // 10 attempts per 15 minutes per IP

router.post('/register', authLimiter, async (req, res) => {
  const { username, password, inviteToken } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  // Hash before opening the transaction — bcrypt is intentionally slow and we
  // don't want to hold a DB connection open while it runs.
  const hash = await bcrypt.hash(password, 12);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Advisory lock serializes the "first user becomes admin" check and invite
    // token validation across concurrent registrations.  Released automatically
    // at COMMIT / ROLLBACK.  The magic number is arbitrary but fixed.
    await client.query('SELECT pg_advisory_xact_lock(7936352)');

    const countResult = await client.query('SELECT COUNT(*) as count FROM users');
    const isFirstUser = parseInt(countResult.rows[0].count) === 0;

    if (!isFirstUser) {
      const settingResult = await client.query(
        "SELECT value FROM system_settings WHERE key = 'registration_open'"
      );
      const registrationOpen = settingResult.rows[0]?.value === 'true';

      if (!registrationOpen) {
        if (!inviteToken) {
          await client.query('ROLLBACK');
          return res.status(403).json({ error: 'Registration is currently by invitation only.' });
        }
        // FOR UPDATE locks the invite row so a second concurrent request using
        // the same token blocks until this transaction commits or rolls back.
        const inviteResult = await client.query(
          `SELECT id FROM invites
           WHERE token = $1 AND used_at IS NULL AND expires_at > NOW()
           FOR UPDATE`,
          [inviteToken]
        );
        if (!inviteResult.rows.length) {
          await client.query('ROLLBACK');
          return res.status(403).json({ error: 'Invalid or expired invite link.' });
        }
      } else if (inviteToken) {
        const inviteResult = await client.query(
          `SELECT id FROM invites
           WHERE token = $1 AND used_at IS NULL AND expires_at > NOW()
           FOR UPDATE`,
          [inviteToken]
        );
        if (!inviteResult.rows.length) {
          await client.query('ROLLBACK');
          return res.status(403).json({ error: 'Invalid or expired invite link.' });
        }
      }
    }

    const result = await client.query(
      'INSERT INTO users (username, password_hash, is_admin) VALUES ($1, $2, $3) RETURNING id, username, is_admin',
      [username.toLowerCase().trim(), hash, isFirstUser]
    );
    const newUser = result.rows[0];

    if (isFirstUser) {
      await client.query(
        `INSERT INTO system_settings (key, value, updated_at) VALUES ('registration_open', 'false', NOW())
         ON CONFLICT (key) DO UPDATE SET value = 'false', updated_at = NOW()`
      );
    }

    if (inviteToken) {
      await client.query(
        `UPDATE invites SET used_by = $1, used_at = NOW() WHERE token = $2`,
        [newUser.id, inviteToken]
      );
    }

    await client.query('COMMIT');

    // Regenerate session ID to prevent session fixation before elevating privileges
    await new Promise((resolve, reject) => req.session.regenerate(err => err ? reject(err) : resolve()));
    req.session.userId = newUser.id;
    req.session.username = newUser.username;
    req.session.isAdmin = newUser.is_admin;
    imapManager.connectAllForUser(newUser.id);
    res.json({ user: { id: newUser.id, username: newUser.username, isAdmin: newUser.is_admin } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') return res.status(409).json({ error: 'Username already taken' });
    console.error('Registration error:', err.message);
    res.status(500).json({ error: 'Registration failed' });
  } finally {
    client.release();
  }
});

router.post('/login', authLimiter, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  try {
    const result = await query('SELECT * FROM users WHERE username = $1', [username.toLowerCase().trim()]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    // Regenerate session ID before storing any auth state to prevent session fixation
    await new Promise((resolve, reject) => req.session.regenerate(err => err ? reject(err) : resolve()));

    // If 2FA is enabled, require a TOTP challenge before creating a full session
    if (user.totp_enabled) {
      req.session.pendingUserId = user.id;
      req.session.pendingTOTPExpiry = Date.now() + 5 * 60 * 1000; // 5-minute window
      return res.json({ requiresTOTP: true });
    }

    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.isAdmin = user.is_admin;

    // Start IMAP connections for this user
    imapManager.connectAllForUser(user.id);

    res.json({ user: { id: user.id, username: user.username, isAdmin: user.is_admin } });
  } catch (err) {
    res.status(500).json({ error: 'Login failed' });
  }
});

// Second step of login when 2FA is enabled
router.post('/2fa/challenge', authLimiter, async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Code required' });

  if (!req.session.pendingUserId) {
    return res.status(400).json({ error: 'No pending authentication' });
  }
  if (Date.now() > (req.session.pendingTOTPExpiry || 0)) {
    delete req.session.pendingUserId;
    delete req.session.pendingTOTPExpiry;
    return res.status(400).json({ error: 'Authentication timed out. Please log in again.' });
  }

  const result = await query('SELECT * FROM users WHERE id = $1', [req.session.pendingUserId]);
  const user = result.rows[0];
  if (!user || !user.totp_secret) {
    return res.status(401).json({ error: 'Authentication failed' });
  }

  if (!authenticator.verify({ token: String(code).replace(/\s/g, ''), secret: decrypt(user.totp_secret) })) {
    return res.status(401).json({ error: 'Invalid code' });
  }

  // Regenerate session ID before elevating from pending to fully authenticated
  await new Promise((resolve, reject) => req.session.regenerate(err => err ? reject(err) : resolve()));
  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.isAdmin = user.is_admin;

  imapManager.connectAllForUser(user.id);
  res.json({ user: { id: user.id, username: user.username, isAdmin: user.is_admin } });
});

router.post('/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

router.get('/me', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const result = await query('SELECT id, username, is_admin, totp_enabled FROM users WHERE id = $1', [req.session.userId]);
  const user = result.rows[0];
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  req.session.isAdmin = user.is_admin;
  res.json({ user: { id: user.id, username: user.username, isAdmin: user.is_admin, totpEnabled: user.totp_enabled } });
});

// Public endpoint: check if registration is open (used by login page)
router.get('/registration-status', async (req, res) => {
  const result = await query("SELECT value FROM system_settings WHERE key = 'registration_open'");
  const open = result.rows[0]?.value === 'true';
  res.json({ open });
});

// Public endpoint: validate an invite token before showing the registration form
router.get('/invite/:token', async (req, res) => {
  const result = await query(
    `SELECT email, expires_at FROM invites
     WHERE token = $1 AND used_at IS NULL AND expires_at > NOW()`,
    [req.params.token]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Invalid or expired invite' });
  res.json({ valid: true, email: result.rows[0].email });
});

router.get('/preferences', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const result = await query('SELECT preferences FROM users WHERE id = $1', [req.session.userId]);
  res.json(result.rows[0]?.preferences || {});
});

router.patch('/preferences', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const { theme, font, layout, notificationSound, pageSize, scrollMode, syncInterval,
          blockRemoteImages, imageWhitelist, shortcuts } = req.body;
  // JSONB fields must be serialised to strings for the ::jsonb cast
  const imageWhitelistJson = imageWhitelist != null ? JSON.stringify(imageWhitelist) : null;
  const shortcutsJson      = shortcuts      != null ? JSON.stringify(shortcuts)      : null;
  await query(`
    UPDATE users
    SET preferences = preferences
      || CASE WHEN $2::text IS NOT NULL THEN jsonb_build_object('theme',  $2::text) ELSE '{}'::jsonb END
      || CASE WHEN $3::text IS NOT NULL THEN jsonb_build_object('font',   $3::text) ELSE '{}'::jsonb END
      || CASE WHEN $4::text IS NOT NULL THEN jsonb_build_object('layout', $4::text) ELSE '{}'::jsonb END
      || CASE WHEN $5::text IS NOT NULL THEN jsonb_build_object('notificationSound', $5::text) ELSE '{}'::jsonb END
      || CASE WHEN $6::text IS NOT NULL THEN jsonb_build_object('pageSize', $6::text) ELSE '{}'::jsonb END
      || CASE WHEN $7::text IS NOT NULL THEN jsonb_build_object('scrollMode', $7::text) ELSE '{}'::jsonb END
      || CASE WHEN $8::text IS NOT NULL THEN jsonb_build_object('syncInterval', $8::text) ELSE '{}'::jsonb END
      || CASE WHEN $9::boolean IS NOT NULL THEN jsonb_build_object('blockRemoteImages', $9::boolean) ELSE '{}'::jsonb END
      || CASE WHEN $10::jsonb IS NOT NULL THEN jsonb_build_object('imageWhitelist', $10::jsonb) ELSE '{}'::jsonb END
      || CASE WHEN $11::jsonb IS NOT NULL THEN jsonb_build_object('shortcuts', $11::jsonb) ELSE '{}'::jsonb END
    WHERE id = $1
  `, [req.session.userId, theme ?? null, font ?? null, layout ?? null, notificationSound ?? null,
      pageSize ?? null, scrollMode ?? null, syncInterval ?? null,
      blockRemoteImages ?? null, imageWhitelistJson, shortcutsJson]);

  if (syncInterval != null) {
    const ms = parseInt(syncInterval) * 1000;
    if (ms >= 15000 && ms <= 120000) {
      imapManager.updateSyncIntervalForUser(req.session.userId, ms).catch(console.error);
    }
  }

  res.json({ ok: true });
});

export default router;
