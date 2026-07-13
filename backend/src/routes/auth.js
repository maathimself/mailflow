import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import { query, pool } from '../services/db.js';
import { imapManager } from '../index.js';
import { decrypt, encrypt } from '../services/encryption.js';
import { pushConfigured } from '../services/pushNotifications.js';
import nodemailer from 'nodemailer';
import { validateHost, resolveForConnection } from '../services/hostValidation.js';
import { getConnectionPolicy } from '../services/connectionPolicy.js';
import { authLimiterConfig } from '../services/authLimiter.js';
import { logAuthEvent } from '../services/authEvents.js';
import { sendSystemEmail } from '../services/mailer.js';
import { invalidateGlobalCategorizationCache } from '../services/categorizer.js';
import { sanitizeGtdPrefs } from '../utils/gtdPrefs.js';
import { sanitizeRightSidebarPrefs } from '../utils/rightSidebarPrefs.js';
import { redisClient } from '../services/redis.js';
import { consume as rlConsume, reset as rlReset } from '../services/rateLimiter.js';

const router = Router();

// A precomputed valid bcrypt hash used to equalize login timing when the account
// doesn't exist or is SSO-only, so response latency doesn't leak account existence.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('mailflow-timing-equalizer', 12);

function maskEmail(email) {
  if (!email) return '';
  const [local, domain] = email.split('@');
  if (!domain) return email;
  const masked = local.length <= 2
    ? local[0] + '*'
    : local[0] + '*'.repeat(Math.min(local.length - 2, 4)) + local[local.length - 1];
  return masked + '@' + domain;
}

function getTrustDurationMs(setting) {
  switch (setting) {
    case '7d': return 7 * 24 * 60 * 60 * 1000;
    case '30d': return 30 * 24 * 60 * 60 * 1000;
    case 'permanent': return 365 * 24 * 60 * 60 * 1000;
    default: return 0; // 'never'
  }
}

// Delete every server-side session belonging to a user (Redis-backed store, keys
// prefixed "sess:"). Used after a password reset so a pre-existing session can't
// outlive a credential change. Best-effort — never throws to the caller.
async function destroyUserSessions(userId) {
  try {
    let cursor = 0;
    do {
      const res = await redisClient.scan(cursor, { MATCH: 'sess:*', COUNT: 200 });
      cursor = res.cursor;
      for (const key of res.keys) {
        const raw = await redisClient.get(key);
        if (!raw) continue;
        try { if (JSON.parse(raw).userId === userId) await redisClient.del(key); } catch { /* not this user / unparsable */ }
      }
    } while (cursor !== 0);
  } catch (err) {
    console.error('destroyUserSessions failed:', err.message);
  }
}

async function createTrustedDevice(userId, req, res) {
  const trustResult = await query(
    "SELECT value FROM system_settings WHERE key = 'mfa_device_trust'"
  );
  const trustSetting = trustResult.rows[0]?.value || '30d';
  const trustMs = getTrustDurationMs(trustSetting);
  if (trustMs === 0) return; // trust=never, don't set cookie

  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + trustMs);

  await query(
    `INSERT INTO trusted_devices (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [userId, tokenHash, expiresAt]
  );

  res.cookie('mf_td', rawToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    path: '/',
    maxAge: trustMs,
  });
}

function rateLimit(config) {
  return async (req, res, next) => {
    const { maxRequests, windowMs } = config;
    const key = `auth:${req.ip}`;
    const { limited, resetMs } = await rlConsume(key, maxRequests, windowMs);
    if (limited) {
      res.setHeader('Retry-After', Math.ceil(resetMs / 1000));
      return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
    }
    res.locals.resetRateLimit = () => rlReset(key);
    next();
  };
}
const authLimiter = rateLimit(authLimiterConfig);

router.post('/register', authLimiter, async (req, res) => {
  const { username, password, inviteToken } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  const trimmedUsername = username.toLowerCase().trim();
  if (trimmedUsername.length < 1 || trimmedUsername.length > 120) {
    return res.status(400).json({ error: 'Username must be between 1 and 120 characters' });
  }
  // eslint-disable-next-line no-control-regex -- intentionally rejecting control characters
  if (/[\x00-\x1f\x7f]/.test(trimmedUsername)) {
    return res.status(400).json({ error: 'Username contains invalid characters' });
  }

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
        "SELECT key, value FROM system_settings WHERE key IN ('registration_open', 'internal_auth_disabled')"
      );
      const settingsMap = {};
      for (const row of settingResult.rows) settingsMap[row.key] = row.value;

      if (settingsMap.internal_auth_disabled === 'true') {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'Password-based registration is disabled. Please sign in with your SSO provider.' });
      }

      const registrationOpen = settingsMap.registration_open === 'true';

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
      const inviteUpdateResult = await client.query(
        `UPDATE invites SET used_by = $1, used_at = NOW() WHERE token = $2 RETURNING email`,
        [newUser.id, inviteToken]
      );
      const inviteEmail = inviteUpdateResult.rows[0]?.email;
      if (inviteEmail) {
        await client.query(
          'UPDATE users SET recovery_email = $1 WHERE id = $2',
          [inviteEmail.toLowerCase().trim(), newUser.id]
        );
      }
    }

    await client.query('COMMIT');

    // Regenerate session ID to prevent session fixation before elevating privileges
    await new Promise((resolve, reject) => req.session.regenerate(err => err ? reject(err) : resolve()));
    req.session.userId = newUser.id;
    req.session.username = newUser.username;
    req.session.isAdmin = newUser.is_admin;
    imapManager.connectAllForUser(newUser.id);
    res.json({ user: { id: newUser.id, username: newUser.username, displayName: null, avatar: null, isAdmin: newUser.is_admin, totpEnabled: false } });
  } catch (err) {
    await client.query('ROLLBACK').catch(rbErr => console.error('Registration ROLLBACK error:', rbErr.message));
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
    const authSetting = await query(
      "SELECT value FROM system_settings WHERE key = 'internal_auth_disabled'"
    );
    if (authSetting.rows[0]?.value === 'true') {
      return res.status(403).json({ error: 'Password login is disabled. Please sign in with your SSO provider.' });
    }

    const result = await query('SELECT * FROM users WHERE username = $1', [username.toLowerCase().trim()]);
    const user = result.rows[0];
    if (!user) {
      // Run a dummy bcrypt compare so the response time doesn't reveal whether the
      // username exists (equalize with the real-user path below).
      await bcrypt.compare(password, DUMMY_PASSWORD_HASH);
      logAuthEvent('login_fail', { username: username.toLowerCase().trim(), ip: req.ip, success: false });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (!user.password_hash) {
      await bcrypt.compare(password, DUMMY_PASSWORD_HASH); // equalize timing for SSO-only accounts
      logAuthEvent('login_fail', { username: user.username, userId: user.id, ip: req.ip, success: false });
      return res.status(401).json({ error: 'This account uses single sign-on. Please sign in with your SSO provider.' });
    }
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      logAuthEvent('login_fail', { username: user.username, userId: user.id, ip: req.ip, success: false });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Regenerate session ID before storing any auth state to prevent session fixation
    await new Promise((resolve, reject) => req.session.regenerate(err => err ? reject(err) : resolve()));

    // Check trusted device cookie — bypass 2FA if valid
    const rawCookies = req.headers.cookie || '';
    const deviceToken = rawCookies.split(';').map(c => c.trim()).find(c => c.startsWith('mf_td='))?.slice(6);
    if (deviceToken) {
      const tokenHash = crypto.createHash('sha256').update(deviceToken).digest('hex');
      const deviceRes = await query(
        `SELECT id FROM trusted_devices
         WHERE user_id = $1 AND token_hash = $2
           AND (expires_at IS NULL OR expires_at > NOW())`,
        [user.id, tokenHash]
      );
      if (deviceRes.rows.length > 0) {
        await query('UPDATE trusted_devices SET last_used_at = NOW() WHERE id = $1', [deviceRes.rows[0].id]);
        req.session.userId = user.id;
        req.session.username = user.username;
        req.session.isAdmin = user.is_admin;
        imapManager.connectAllForUser(user.id);
        logAuthEvent('login_success', { username: user.username, userId: user.id, ip: req.ip, success: true });
        res.locals.resetRateLimit?.();
        return res.json({ user: { id: user.id, username: user.username, displayName: user.display_name, avatar: user.avatar, isAdmin: user.is_admin, totpEnabled: user.totp_enabled } });
      }
    }

    // Load enforcement policy and device trust setting together
    const policyResult = await query(
      "SELECT key, value FROM system_settings WHERE key IN ('mfa_enforcement', 'mfa_device_trust')"
    );
    const policyMap = {};
    for (const row of policyResult.rows) policyMap[row.key] = row.value;
    const enforcement = policyMap.mfa_enforcement || 'off';
    const trustSetting = policyMap.mfa_device_trust || '30d';
    const deviceTrustAvailable = getTrustDurationMs(trustSetting) > 0;

    // If user has TOTP configured, require a TOTP challenge before creating a full session
    if (user.totp_enabled) {
      req.session.pendingUserId = user.id;
      req.session.pendingTOTPExpiry = Date.now() + 5 * 60 * 1000; // 5-minute window
      return res.json({ requiresTOTP: true, deviceTrustAvailable });
    }

    // If MFA is enforced but this user has no TOTP, offer email OTP or force enrollment
    if (enforcement === 'required') {
      req.session.pendingUserId = user.id;
      req.session.pendingTOTPExpiry = Date.now() + 10 * 60 * 1000; // 10-minute window
      if (user.recovery_email) {
        try {
          await sendEmailOtpCode(user.id, user.recovery_email);
          return res.json({ requiresEmailOTP: true, emailHint: maskEmail(user.recovery_email), deviceTrustAvailable });
        } catch (err) {
          console.error('Email OTP auto-send failed, falling back to enrollment:', err.message);
          // Fall through — system email not configured; direct user to TOTP enrollment
        }
      }
      // No TOTP and no usable recovery email — must enroll
      req.session.pendingMFAEnrollment = true;
      return res.json({ requiresMFAEnrollment: true });
    }

    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.isAdmin = user.is_admin;

    // Start IMAP connections for this user
    imapManager.connectAllForUser(user.id);

    logAuthEvent('login_success', { username: user.username, userId: user.id, ip: req.ip, success: true });
    res.locals.resetRateLimit?.();
    res.json({ user: { id: user.id, username: user.username, displayName: user.display_name, avatar: user.avatar, isAdmin: user.is_admin, totpEnabled: user.totp_enabled } });
  } catch {
    res.status(500).json({ error: 'Login failed' });
  }
});

// Second step of login when 2FA is enabled
router.post('/2fa/challenge', authLimiter, async (req, res) => {
  const { code, rememberDevice } = req.body;
  if (!code) return res.status(400).json({ error: 'Code required' });

  if (!req.session.pendingUserId) {
    return res.status(400).json({ error: 'No pending authentication' });
  }
  const now = Date.now();
  if (now > (req.session.pendingTOTPExpiry || 0)) {
    delete req.session.pendingUserId;
    delete req.session.pendingTOTPExpiry;
    return res.status(400).json({ error: 'Authentication timed out. Please log in again.' });
  }

  // Per-user rate limit (5 attempts per 15 min) applied on top of the IP-based authLimiter.
  // Prevents brute-force via IP rotation during the pending TOTP window.
  const uid = req.session.pendingUserId;
  const totpLimit = await rlConsume(`totp:${uid}`, 5, 15 * 60 * 1000);
  if (totpLimit.limited) {
    res.setHeader('Retry-After', Math.ceil(totpLimit.resetMs / 1000));
    return res.status(429).json({ error: 'Too many attempts. Please log in again.' });
  }

  const result = await query('SELECT * FROM users WHERE id = $1', [req.session.pendingUserId]);
  const user = result.rows[0];
  if (!user || !user.totp_secret) {
    logAuthEvent('totp_fail', { userId: req.session.pendingUserId, ip: req.ip, success: false });
    return res.status(401).json({ error: 'Authentication failed' });
  }

  const normalizedCode = String(code).replace(/\s/g, '');
  if (!authenticator.verify({ token: normalizedCode, secret: decrypt(user.totp_secret) })) {
    logAuthEvent('totp_fail', { username: user.username, userId: user.id, ip: req.ip, success: false });
    return res.status(401).json({ error: 'Invalid code' });
  }

  // Prevent replay attacks — TOTP codes are valid for ±30 s (1 period).
  // Store the consumed code in Redis for 90 s (one extra period) as a replay guard.
  const replayKey = `totp_used:${user.id}:${normalizedCode}`;
  const isFirstUse = await redisClient.set(replayKey, '1', { NX: true, EX: 90 });
  if (!isFirstUse) {
    logAuthEvent('totp_fail', { username: user.username, userId: user.id, ip: req.ip, success: false });
    return res.status(401).json({ error: 'Invalid code' });
  }

  // Regenerate session ID before elevating from pending to fully authenticated
  await new Promise((resolve, reject) => req.session.regenerate(err => err ? reject(err) : resolve()));
  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.isAdmin = user.is_admin;

  if (rememberDevice) {
    try { await createTrustedDevice(user.id, req, res); } catch (err) { console.error('createTrustedDevice failed:', err.message); }
  }

  imapManager.connectAllForUser(user.id);
  logAuthEvent('totp_success', { username: user.username, userId: user.id, ip: req.ip, success: true });
  res.locals.resetRateLimit?.();
  rlReset(`totp:${uid}`);
  res.json({ user: { id: user.id, username: user.username, displayName: user.display_name, avatar: user.avatar, isAdmin: user.is_admin, totpEnabled: user.totp_enabled } });
});

// Helper: generate and store an email OTP, send it to the given address
async function sendEmailOtpCode(userId, toEmail) {
  const codeNum = crypto.randomBytes(3).readUIntBE(0, 3) % 900000 + 100000;
  const code = String(codeNum);
  const codeHash = crypto.createHash('sha256').update(code).digest('hex');
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10-minute window

  // Remove any previous unused OTPs for this user to prevent confusion
  await query('DELETE FROM email_otp_tokens WHERE user_id = $1 AND used_at IS NULL', [userId]);
  await query(
    'INSERT INTO email_otp_tokens (user_id, code_hash, expires_at) VALUES ($1, $2, $3)',
    [userId, codeHash, expiresAt]
  );

  await sendSystemEmail({
    to: toEmail,
    subject: 'Your MailFlow sign-in code',
    text: `Your sign-in code is: ${code}\n\nThis code expires in 10 minutes.\n\nIf you did not request this code, you can ignore this email.`,
    html: `
      <div style="font-family:-apple-system,Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px;color:#1a1a1a;">
        <div style="margin-bottom:24px;">
          <span style="font-size:22px;font-weight:700;color:#1a1a1a;">Mail</span><span style="font-size:22px;font-weight:600;color:#7c6af7;">Flow</span>
        </div>
        <h2 style="margin:0 0 12px;font-size:18px;font-weight:600;">Your sign-in code</h2>
        <p style="color:#555;line-height:1.6;margin:0 0 24px;">Use the code below to sign in to MailFlow. It expires in 10 minutes.</p>
        <div style="font-size:36px;font-weight:700;letter-spacing:0.2em;text-align:center;padding:20px;background:#f5f4ff;border-radius:8px;color:#7c6af7;margin-bottom:24px;">${code}</div>
        <p style="color:#999;font-size:12px;margin:0;">If you did not request this code, you can ignore this email.</p>
      </div>
    `,
  });
}

// POST /api/auth/2fa/send-email-otp — (re)send email OTP during pending login
router.post('/2fa/send-email-otp', authLimiter, async (req, res) => {
  if (!req.session.pendingUserId || req.session.pendingMFAEnrollment) {
    return res.status(400).json({ error: 'No pending authentication' });
  }
  if (Date.now() > (req.session.pendingTOTPExpiry || 0)) {
    return res.status(400).json({ error: 'Authentication timed out. Please log in again.' });
  }

  const uid = req.session.pendingUserId;
  const otpSend = await rlConsume(`otp-send:${uid}`, 3, 5 * 60 * 1000);
  if (otpSend.limited) {
    return res.status(429).json({ error: 'Too many code requests. Please wait before requesting another.' });
  }

  const userResult = await query('SELECT recovery_email FROM users WHERE id = $1', [uid]);
  const recoveryEmail = userResult.rows[0]?.recovery_email;
  if (!recoveryEmail) return res.status(400).json({ error: 'No recovery email configured' });

  try {
    await sendEmailOtpCode(uid, recoveryEmail);
    res.json({ ok: true, emailHint: maskEmail(recoveryEmail) });
  } catch (err) {
    console.error('Email OTP send failed:', err.message);
    res.status(500).json({ error: 'Failed to send verification code. Check system email configuration.' });
  }
});

// POST /api/auth/2fa/verify-email-otp — verify email OTP code
router.post('/2fa/verify-email-otp', authLimiter, async (req, res) => {
  const { code, rememberDevice } = req.body;
  if (!code) return res.status(400).json({ error: 'Code required' });
  if (!req.session.pendingUserId || req.session.pendingMFAEnrollment) {
    return res.status(400).json({ error: 'No pending authentication' });
  }
  const now = Date.now();
  if (now > (req.session.pendingTOTPExpiry || 0)) {
    delete req.session.pendingUserId;
    delete req.session.pendingTOTPExpiry;
    return res.status(400).json({ error: 'Authentication timed out. Please log in again.' });
  }

  const uid = req.session.pendingUserId;
  // Reuse TOTP challenge bucket for verify attempts (5 per 15 min per user)
  const totpLimit = await rlConsume(`totp:${uid}`, 5, 15 * 60 * 1000);
  if (totpLimit.limited) {
    res.setHeader('Retry-After', Math.ceil(totpLimit.resetMs / 1000));
    return res.status(429).json({ error: 'Too many attempts. Please log in again.' });
  }

  const codeHash = crypto.createHash('sha256').update(String(code).trim()).digest('hex');
  const tokenResult = await query(
    `SELECT id FROM email_otp_tokens
     WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL AND expires_at > NOW()
     ORDER BY created_at DESC LIMIT 1`,
    [uid, codeHash]
  );
  if (!tokenResult.rows.length) {
    logAuthEvent('totp_fail', { userId: uid, ip: req.ip, success: false });
    return res.status(401).json({ error: 'Invalid or expired code' });
  }

  await query('UPDATE email_otp_tokens SET used_at = NOW() WHERE id = $1', [tokenResult.rows[0].id]);

  const userResult = await query('SELECT * FROM users WHERE id = $1', [uid]);
  const user = userResult.rows[0];
  if (!user) return res.status(401).json({ error: 'Authentication failed' });

  await new Promise((resolve, reject) => req.session.regenerate(err => err ? reject(err) : resolve()));
  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.isAdmin = user.is_admin;

  if (rememberDevice) {
    try { await createTrustedDevice(user.id, req, res); } catch (err) { console.error('createTrustedDevice failed:', err.message); }
  }

  imapManager.connectAllForUser(user.id);
  logAuthEvent('totp_success', { username: user.username, userId: user.id, ip: req.ip, success: true });
  res.locals.resetRateLimit?.();
  rlReset(`totp:${uid}`);
  res.json({ user: { id: user.id, username: user.username, displayName: user.display_name, avatar: user.avatar, isAdmin: user.is_admin, totpEnabled: user.totp_enabled } });
});

// GET /api/auth/2fa/enrollment/setup — generate TOTP QR for forced enrollment
router.get('/2fa/enrollment/setup', async (req, res) => {
  if (!req.session.pendingUserId || !req.session.pendingMFAEnrollment) {
    return res.status(400).json({ error: 'No pending enrollment' });
  }
  if (Date.now() > (req.session.pendingTOTPExpiry || 0)) {
    return res.status(400).json({ error: 'Session expired. Please log in again.' });
  }

  const userResult = await query('SELECT username FROM users WHERE id = $1', [req.session.pendingUserId]);
  const username = userResult.rows[0]?.username || 'user';

  const secret = authenticator.generateSecret(20);
  const otpauthUrl = authenticator.keyuri(username, 'MailFlow', secret);
  const qrCode = await QRCode.toDataURL(otpauthUrl);

  req.session.pendingTOTPSecret = secret;
  req.session.pendingTOTPSetupExpiry = Date.now() + 10 * 60 * 1000;

  res.json({ secret, qrCode });
});

// POST /api/auth/2fa/enrollment/enable — verify TOTP and complete forced enrollment
router.post('/2fa/enrollment/enable', authLimiter, async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Code required' });
  if (!req.session.pendingUserId || !req.session.pendingMFAEnrollment) {
    return res.status(400).json({ error: 'No pending enrollment' });
  }
  const now = Date.now();
  if (now > (req.session.pendingTOTPExpiry || 0)) {
    return res.status(400).json({ error: 'Session expired. Please log in again.' });
  }
  if (!req.session.pendingTOTPSecret || now > (req.session.pendingTOTPSetupExpiry || 0)) {
    return res.status(400).json({ error: 'Setup session expired. Start over.' });
  }

  const uid = req.session.pendingUserId;
  const totpLimit = await rlConsume(`totp:${uid}`, 5, 15 * 60 * 1000);
  if (totpLimit.limited) {
    res.setHeader('Retry-After', Math.ceil(totpLimit.resetMs / 1000));
    return res.status(429).json({ error: 'Too many attempts. Please log in again.' });
  }

  const secret = req.session.pendingTOTPSecret;
  if (!authenticator.verify({ token: String(code).replace(/\s/g, ''), secret })) {
    return res.status(400).json({ error: 'Invalid code — check your device clock and try again.' });
  }

  await query(
    'UPDATE users SET totp_secret = $1, totp_enabled = true WHERE id = $2',
    [encrypt(secret), uid]
  );

  const userResult = await query('SELECT * FROM users WHERE id = $1', [uid]);
  const user = userResult.rows[0];
  if (!user) return res.status(401).json({ error: 'Authentication failed' });

  await new Promise((resolve, reject) => req.session.regenerate(err => err ? reject(err) : resolve()));
  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.isAdmin = user.is_admin;

  imapManager.connectAllForUser(user.id);
  logAuthEvent('totp_success', { username: user.username, userId: user.id, ip: req.ip, success: true });
  res.locals.resetRateLimit?.();
  rlReset(`totp:${uid}`);
  res.json({ user: { id: user.id, username: user.username, displayName: user.display_name, avatar: user.avatar, isAdmin: user.is_admin, totpEnabled: true } });
});

router.post('/logout', async (req, res) => {
  const userId = req.session.userId;
  const rawCookies = req.headers.cookie || '';
  const deviceToken = rawCookies.split(';').map(c => c.trim()).find(c => c.startsWith('mf_td='))?.slice(6);

  // Delete the trusted device record from DB before destroying the session
  if (userId && deviceToken) {
    const tokenHash = crypto.createHash('sha256').update(deviceToken).digest('hex');
    query('DELETE FROM trusted_devices WHERE user_id = $1 AND token_hash = $2', [userId, tokenHash])
      .catch(err => console.error('logout: failed to delete trusted device:', err.message));
  }

  req.session.destroy((err) => {
    if (err) console.error('Session destroy error:', err.message);
    const cookieOpts = { path: '/', sameSite: 'lax', secure: req.secure };
    res.clearCookie('connect.sid', cookieOpts);
    res.clearCookie('mf_td', { ...cookieOpts, httpOnly: true });
    res.json({ ok: true });
  });
  if (userId) imapManager.disconnectUser(userId);
});

router.get('/me', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const result = await query('SELECT id, username, display_name, avatar, is_admin, totp_enabled, password_hash FROM users WHERE id = $1', [req.session.userId]);
  const user = result.rows[0];
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  req.session.isAdmin = user.is_admin;
  res.json({ user: { id: user.id, username: user.username, displayName: user.display_name, avatar: user.avatar, isAdmin: user.is_admin, totpEnabled: user.totp_enabled, hasPassword: !!user.password_hash } });
});

router.post('/unlock', authLimiter, async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password required' });
  const result = await query('SELECT password_hash FROM users WHERE id = $1', [req.session.userId]);
  const user = result.rows[0];
  if (!user || !user.password_hash) return res.status(400).json({ error: 'No password set for this account' });
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Incorrect password' });
  res.json({ ok: true });
});

router.patch('/profile', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const { displayName } = req.body;
  if (displayName === undefined) return res.status(400).json({ error: 'Nothing to update' });
  const trimmed = String(displayName).trim().slice(0, 100);
  await query('UPDATE users SET display_name = $1 WHERE id = $2', [trimmed || null, req.session.userId]);
  res.json({ ok: true, displayName: trimmed || null });
});

router.post('/avatar', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const { avatar } = req.body;
  if (!avatar || typeof avatar !== 'string') return res.status(400).json({ error: 'Invalid avatar' });
  if (!/^data:image\/(jpeg|png|gif|webp);base64,/.test(avatar)) {
    return res.status(400).json({ error: 'Invalid image format' });
  }
  if (avatar.length > 512 * 1024) return res.status(400).json({ error: 'Image too large' });
  await query('UPDATE users SET avatar = $1 WHERE id = $2', [avatar, req.session.userId]);
  res.json({ ok: true });
});

router.delete('/avatar', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  await query('UPDATE users SET avatar = NULL WHERE id = $1', [req.session.userId]);
  res.json({ ok: true });
});

// Public endpoint: check registration and auth settings (used by login page)
router.get('/registration-status', async (req, res) => {
  const result = await query(
    "SELECT key, value FROM system_settings WHERE key IN ('registration_open', 'internal_auth_disabled')"
  );
  const map = {};
  for (const row of result.rows) map[row.key] = row.value;
  res.json({
    open: map.registration_open === 'true',
    internalAuthDisabled: map.internal_auth_disabled === 'true',
  });
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
  const [userResult, cssResult] = await Promise.all([
    query('SELECT preferences FROM users WHERE id = $1', [req.session.userId]),
    query("SELECT value FROM system_settings WHERE key = 'custom_css'"),
  ]);
  const prefs = userResult.rows[0]?.preferences || {};
  const customCss = cssResult.rows[0]?.value;
  if (customCss) prefs.customCss = customCss;
  res.json(prefs);
});

router.patch('/preferences', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const { theme, font, layout, notificationSound, pageSize, scrollMode, syncInterval,
          blockRemoteImages, imageWhitelist, shortcuts, hiddenFolders, language,
          threadedView, plaintextEmail, hoverQuickActions, swipeActions,
          expandedAccounts, collapsedFolders, favoriteFolders, recentFolders, fontSize,
          showAppBadge, showFaviconBadge, replyDefault, sidebarWidth,
          categorizationEnabled, markReadBehavior, markReadDelay, aiActions } = req.body;
  // GTD content and generic right-sidebar layout preferences are independent flat
  // top-level keys with separate allow-lists. gtdEnabled is intentionally NOT a user
  // preference — it lives per-account in email_accounts.gtd_enabled.
  const { gtdCollapsedSections, gtdPetSlug } = sanitizeGtdPrefs(req.body);
  const { rightSidebarWidth, rightSidebarHidden } = sanitizeRightSidebarPrefs(req.body);
  const gtdCollapsedSectionsJson = gtdCollapsedSections != null ? JSON.stringify(gtdCollapsedSections) : null;
  // JSONB fields must be serialised to strings for the ::jsonb cast
  const imageWhitelistJson    = imageWhitelist    != null ? JSON.stringify(imageWhitelist)    : null;
  const shortcutsJson         = shortcuts         != null ? JSON.stringify(shortcuts)         : null;
  const hiddenFoldersJson     = hiddenFolders     != null ? JSON.stringify(hiddenFolders)     : null;
  const swipeActionsJson      = swipeActions      != null ? JSON.stringify(swipeActions)      : null;
  const expandedAccountsJson  = expandedAccounts  != null ? JSON.stringify(expandedAccounts)  : null;
  const collapsedFoldersJson  = collapsedFolders  != null ? JSON.stringify(collapsedFolders)  : null;
  const favoriteFoldersJson   = favoriteFolders   != null ? JSON.stringify(favoriteFolders)   : null;
  const recentFoldersJson     = recentFolders     != null ? JSON.stringify(recentFolders)     : null;
  const fontSizeVal           = fontSize          != null ? String(fontSize)                  : null;
  const replyDefaultVal       = (replyDefault === 'reply' || replyDefault === 'replyAll') ? replyDefault : null;
  const sidebarWidthVal       = (() => { const n = parseInt(sidebarWidth); return (n >= 160 && n <= 400) ? String(n) : null; })();
  const markReadBehaviorVal   = ['immediate', 'delay', 'manual'].includes(markReadBehavior) ? markReadBehavior : null;
  const markReadDelayVal      = (() => { const n = parseInt(markReadDelay); return (n >= 1 && n <= 10) ? String(n) : null; })();
  // User-defined AI actions: bound the array and each field so the JSONB can't grow unbounded.
  const aiActionsJson = (() => {
    if (!Array.isArray(aiActions)) return null;
    const clean = aiActions.slice(0, 30).map(a => ({
      id:     String(a?.id     ?? '').slice(0, 64),
      label:  String(a?.label  ?? '').slice(0, 60),
      prompt: String(a?.prompt ?? '').slice(0, 2000),
    })).filter(a => a.id && a.label && a.prompt);
    return JSON.stringify(clean);
  })();
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
      || CASE WHEN $12::jsonb IS NOT NULL THEN jsonb_build_object('hiddenFolders', $12::jsonb) ELSE '{}'::jsonb END
      || CASE WHEN $13::text IS NOT NULL THEN jsonb_build_object('language', $13::text) ELSE '{}'::jsonb END
      || CASE WHEN $14::boolean IS NOT NULL THEN jsonb_build_object('threadedView', $14::boolean) ELSE '{}'::jsonb END
      || CASE WHEN $15::boolean IS NOT NULL THEN jsonb_build_object('plaintextEmail', $15::boolean) ELSE '{}'::jsonb END
      || CASE WHEN $16::boolean IS NOT NULL THEN jsonb_build_object('hoverQuickActions', $16::boolean) ELSE '{}'::jsonb END
      || CASE WHEN $17::jsonb IS NOT NULL THEN jsonb_build_object('swipeActions', $17::jsonb) ELSE '{}'::jsonb END
      || CASE WHEN $18::jsonb IS NOT NULL THEN jsonb_build_object('expandedAccounts', $18::jsonb) ELSE '{}'::jsonb END
      || CASE WHEN $19::jsonb IS NOT NULL THEN jsonb_build_object('collapsedFolders', $19::jsonb) ELSE '{}'::jsonb END
      || CASE WHEN $20::jsonb IS NOT NULL THEN jsonb_build_object('favoriteFolders', $20::jsonb) ELSE '{}'::jsonb END
      || CASE WHEN $21::jsonb IS NOT NULL THEN jsonb_build_object('recentFolders', $21::jsonb) ELSE '{}'::jsonb END
      || CASE WHEN $22::text IS NOT NULL THEN jsonb_build_object('fontSize', $22::text) ELSE '{}'::jsonb END
      || CASE WHEN $23::boolean IS NOT NULL THEN jsonb_build_object('showAppBadge', $23::boolean) ELSE '{}'::jsonb END
      || CASE WHEN $24::boolean IS NOT NULL THEN jsonb_build_object('showFaviconBadge', $24::boolean) ELSE '{}'::jsonb END
      || CASE WHEN $25::text IS NOT NULL THEN jsonb_build_object('replyDefault', $25::text) ELSE '{}'::jsonb END
      || CASE WHEN $26::text IS NOT NULL THEN jsonb_build_object('sidebarWidth', $26::text) ELSE '{}'::jsonb END
      || CASE WHEN $27::boolean IS NOT NULL THEN jsonb_build_object('categorizationEnabled', $27::boolean) ELSE '{}'::jsonb END
      || CASE WHEN $28::text IS NOT NULL THEN jsonb_build_object('markReadBehavior', $28::text) ELSE '{}'::jsonb END
      || CASE WHEN $29::text IS NOT NULL THEN jsonb_build_object('markReadDelay', $29::text) ELSE '{}'::jsonb END
      || CASE WHEN $30::jsonb IS NOT NULL THEN jsonb_build_object('aiActions', $30::jsonb) ELSE '{}'::jsonb END
      || CASE WHEN $31::int IS NOT NULL THEN jsonb_build_object('rightSidebarWidth', $31::int) ELSE '{}'::jsonb END
      || CASE WHEN $32::boolean IS NOT NULL THEN jsonb_build_object('rightSidebarHidden', $32::boolean) ELSE '{}'::jsonb END
      || CASE WHEN $33::jsonb IS NOT NULL THEN jsonb_build_object('gtdCollapsedSections', $33::jsonb) ELSE '{}'::jsonb END
      || CASE WHEN $34::text IS NOT NULL THEN jsonb_build_object('gtdPetSlug', $34::text) ELSE '{}'::jsonb END
    WHERE id = $1
  `, [req.session.userId, theme ?? null, font ?? null, layout ?? null, notificationSound ?? null,
      pageSize ?? null, scrollMode ?? null, syncInterval ?? null,
      blockRemoteImages ?? null, imageWhitelistJson, shortcutsJson, hiddenFoldersJson,
      language ?? null, threadedView ?? null, plaintextEmail ?? null, hoverQuickActions ?? null,
      swipeActionsJson, expandedAccountsJson, collapsedFoldersJson, favoriteFoldersJson, recentFoldersJson, fontSizeVal,
      showAppBadge ?? null, showFaviconBadge ?? null, replyDefaultVal, sidebarWidthVal,
      categorizationEnabled ?? null, markReadBehaviorVal, markReadDelayVal, aiActionsJson,
      rightSidebarWidth, rightSidebarHidden, gtdCollapsedSectionsJson, gtdPetSlug]);

  if (syncInterval != null) {
    const ms = parseInt(syncInterval) * 1000;
    if (ms >= 15000 && ms <= 120000) {
      imapManager.updateSyncIntervalForUser(req.session.userId, ms).catch(console.error);
    }
  }
  if (categorizationEnabled != null) {
    invalidateGlobalCategorizationCache(req.session.userId);
  }

  res.json({ ok: true });
});

// Atomically appends a single address or domain to the image whitelist.
// Using a single UPDATE with a subquery avoids the read-modify-write race
// that affects concurrent saves via PATCH /preferences.
router.post('/preferences/whitelist-add', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const { type, value } = req.body;
  if ((type !== 'address' && type !== 'domain') || typeof value !== 'string' || !value.trim()) {
    return res.status(400).json({ error: 'type must be "address" or "domain" and value must be a non-empty string' });
  }
  const normalized = value.trim().toLowerCase();
  if (type === 'domain') {
    // Accept bare domains and leading-dot wildcard forms (e.g. "example.com", ".example.com")
    const bare = normalized.startsWith('.') ? normalized.slice(1) : normalized;
    const domainRe = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,}$/i;
    if (!domainRe.test(bare)) {
      return res.status(400).json({ error: 'Invalid domain format' });
    }
  } else {
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRe.test(normalized)) {
      return res.status(400).json({ error: 'Invalid email address format' });
    }
  }
  const key = type === 'address' ? 'addresses' : 'domains';
  await query(`
    UPDATE users
    SET preferences = jsonb_set(
      -- Inner jsonb_set guarantees the imageWhitelist key exists before the outer
      -- one tries to write a child key. jsonb_set silently returns the target
      -- unchanged when an intermediate path element is missing, so without this
      -- the add would be a no-op for users whose preferences predate the feature.
      jsonb_set(
        COALESCE(preferences, '{}'::jsonb),
        '{imageWhitelist}',
        COALESCE(preferences->'imageWhitelist', '{}'::jsonb)
      ),
      ARRAY['imageWhitelist', $2::text],
      (
        SELECT COALESCE(jsonb_agg(DISTINCT val), '[]'::jsonb)
        FROM jsonb_array_elements_text(
          COALESCE(preferences->'imageWhitelist'->$2::text, '[]'::jsonb)
          || jsonb_build_array($3::text)
        ) AS val
      )
    )
    WHERE id = $1
  `, [req.session.userId, key, normalized]);
  res.json({ ok: true });
});

// ── Recovery email ────────────────────────────────────────────────────────────

router.get('/profile/recovery-email', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const result = await query('SELECT recovery_email FROM users WHERE id = $1', [req.session.userId]);
  res.json({ email: result.rows[0]?.recovery_email || null });
});

router.patch('/profile/recovery-email', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const { email } = req.body;
  if (email === undefined) return res.status(400).json({ error: 'email required' });
  const trimmed = email ? String(email).trim().toLowerCase() : null;
  if (trimmed && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    return res.status(400).json({ error: 'Invalid email address' });
  }
  await query('UPDATE users SET recovery_email = $1 WHERE id = $2', [trimmed || null, req.session.userId]);
  res.json({ ok: true });
});

// ── Password reset ────────────────────────────────────────────────────────────

// POST /api/auth/forgot-password — public, rate-limited
// Looks up a user by recovery_email and sends a reset link.
// Always returns 200 to avoid leaking whether a recovery email exists.
router.post('/forgot-password', authLimiter, async (req, res) => {
  const authSetting = await query(
    "SELECT value FROM system_settings WHERE key = 'internal_auth_disabled'"
  );
  if (authSetting.rows[0]?.value === 'true') {
    return res.status(403).json({ error: 'Password login is disabled on this server.' });
  }

  const { email } = req.body;
  if (!email || typeof email !== 'string') return res.status(400).json({ error: 'Email required' });
  const trimmed = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    return res.status(400).json({ error: 'Invalid email address' });
  }

  try {
    const result = await query(
      'SELECT id, password_hash FROM users WHERE recovery_email = $1',
      [trimmed]
    );
    const user = result.rows[0];

    // Only send a reset email if the account exists and has a password.
    // SSO-only accounts (no password_hash) silently skip — we still return 200.
    if (user && user.password_hash) {
      const rawToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1-hour window
      const resetUrl = `${process.env.APP_URL || ''}/?reset_token=${rawToken}`;

      // Send the email before persisting the token. If delivery fails, nothing is
      // saved and the user can retry cleanly.
      // Transport preference: system SMTP → account owner's first personal SMTP account.
      const emailSubject = 'Reset your MailFlow password';
      const emailText = `You requested a password reset for your MailFlow account.\n\nClick the link below to set a new password. This link expires in 1 hour.\n\n${resetUrl}\n\nIf you did not request this, you can ignore this email.`;
      const emailHtml = `
        <div style="font-family:-apple-system,Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px;color:#1a1a1a;">
          <div style="margin-bottom:24px;">
            <span style="font-size:22px;font-weight:700;color:#1a1a1a;">Mail</span><span style="font-size:22px;font-weight:600;color:#7c6af7;">Flow</span>
          </div>
          <h2 style="margin:0 0 12px;font-size:18px;font-weight:600;">Reset your password</h2>
          <p style="color:#555;line-height:1.6;margin:0 0 24px;">Click the button below to set a new password. This link expires in 1 hour.</p>
          <a href="${resetUrl}" style="display:inline-block;padding:12px 24px;background:#7c6af7;color:white;border-radius:8px;text-decoration:none;font-weight:500;font-size:14px;margin-bottom:24px;">Reset password</a>
          <p style="color:#999;font-size:12px;margin:0;">If you did not request a password reset, you can ignore this email. Your password will not change.</p>
        </div>
      `;

      let transport = null;
      let fromHeader = null;

      // 1. Try system SMTP
      try {
        const sysResult = await query("SELECT value FROM system_settings WHERE key = 'system_email_config'");
        if (sysResult.rows.length) {
          const cfg = JSON.parse(sysResult.rows[0].value);
          const pass = cfg.pass ? decrypt(cfg.pass) : null;
          if (cfg.host && cfg.user && pass) {
            const sysResolved = await resolveForConnection(cfg.host);
            const sysTls = { rejectUnauthorized: true };
            if (sysResolved.servername) sysTls.servername = sysResolved.servername;
            transport = nodemailer.createTransport({
              host: sysResolved.host, port: cfg.port || 587,
              secure: (cfg.port || 587) === 465,
              auth: { user: cfg.user, pass }, tls: sysTls,
            });
            fromHeader = `${cfg.fromName || 'MailFlow'} <${cfg.fromEmail || cfg.user}>`;
          }
        }
      } catch { /* fall through to personal account */ }

      // 2. Fall back to the account owner's first personal SMTP account,
      //    then any admin's first SMTP account (mirrors the invite email fallback).
      if (!transport) {
        const accountResult = await query(
          `SELECT ea.* FROM email_accounts ea
           JOIN users u ON ea.user_id = u.id
           WHERE ea.enabled = true AND ea.smtp_host IS NOT NULL
             AND (ea.user_id = $1 OR u.is_admin = true)
           ORDER BY (ea.user_id = $1) DESC, ea.created_at
           LIMIT 1`,
          [user.id]
        );
        if (accountResult.rows.length) {
          const acct = accountResult.rows[0];
          let smtpAuth;
          if ((acct.oauth_provider === 'microsoft' || acct.oauth_provider === 'google') && acct.oauth_access_token) {
            smtpAuth = { type: 'OAuth2', user: acct.auth_user || acct.email_address, accessToken: decrypt(acct.oauth_access_token) };
          } else {
            smtpAuth = { user: acct.auth_user, pass: decrypt(acct.auth_pass) };
          }
          const policy = await getConnectionPolicy();
          const acctResolved = await resolveForConnection(acct.smtp_host, { allowPrivate: policy.allowPrivateHosts });
          const acctTls = { rejectUnauthorized: policy.allowInsecureTls ? !acct.imap_skip_tls_verify : true };
          if (acctResolved.servername) acctTls.servername = acctResolved.servername;
          transport = nodemailer.createTransport({
            host: acctResolved.host, port: acct.smtp_port,
            secure: acct.smtp_port === 465,
            auth: smtpAuth, tls: acctTls,
          });
          fromHeader = `${acct.name} <${acct.email_address}>`;
        }
      }

      if (!transport) throw new Error('No email transport available');
      await transport.sendMail({ from: fromHeader, to: trimmed, subject: emailSubject, text: emailText, html: emailHtml });

      await query('DELETE FROM password_reset_tokens WHERE user_id = $1', [user.id]);
      await query(
        'INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
        [user.id, tokenHash, expiresAt]
      );
    }
  } catch (err) {
    console.error('forgot-password error:', err.message);
    // Don't expose internal errors — fall through to the generic success response
  }

  res.json({ ok: true });
});

// POST /api/auth/reset-password — public, rate-limited
router.post('/reset-password', authLimiter, async (req, res) => {
  const { token, password } = req.body;
  if (!token || typeof token !== 'string') return res.status(400).json({ error: 'Token required' });
  if (!password || typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  const tokenHash = crypto.createHash('sha256').update(token.trim()).digest('hex');
  try {
    // Atomically consume the token — DELETE RETURNING prevents two concurrent resets
    // from both reading a valid token, both updating the password, and only then deleting.
    const tokenResult = await query(
      `DELETE FROM password_reset_tokens
       WHERE token_hash = $1 AND expires_at > NOW()
       RETURNING user_id`,
      [tokenHash]
    );
    if (!tokenResult.rows.length) {
      return res.status(400).json({ error: 'Invalid or expired reset link' });
    }
    const userId = tokenResult.rows[0].user_id;

    const hash = await bcrypt.hash(password, 12);
    await query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, userId]);

    // Revoke all existing sessions and trusted devices so a pre-existing (possibly
    // attacker) session/device can't survive a compromise-driven password reset.
    await destroyUserSessions(userId);
    await query('DELETE FROM trusted_devices WHERE user_id = $1', [userId]);

    res.locals.resetRateLimit?.();
    res.json({ ok: true });
  } catch (err) {
    console.error('reset-password error:', err.message);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// ── Web Push ──────────────────────────────────────────────────────────────────

// Returns the VAPID public key so the frontend can subscribe via PushManager.
router.get('/push/vapid-key', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  if (!pushConfigured) {
    return res.status(503).json({ error: 'Push notifications are not configured on this server.' });
  }
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

// Store a push subscription for the current user/device.
// The browser generates a unique endpoint + encryption keys on subscribe().
// We upsert so that re-subscribing (e.g. after clearing browser data) just
// refreshes the keys rather than creating a duplicate row.
router.post('/push/subscribe', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const { endpoint, keys } = req.body || {};
  if (!endpoint || typeof endpoint !== 'string' ||
      !keys?.p256dh || typeof keys.p256dh !== 'string' ||
      !keys?.auth   || typeof keys.auth   !== 'string') {
    return res.status(400).json({ error: 'Invalid push subscription object.' });
  }
  // Validate the push endpoint — a logged-in user could otherwise register an
  // internal URL and use new-mail events to make the server POST to it (SSRF).
  let endpointUrl;
  try { endpointUrl = new URL(endpoint); } catch {
    return res.status(400).json({ error: 'Push endpoint is not a valid URL.' });
  }
  if (endpointUrl.protocol !== 'https:') {
    return res.status(400).json({ error: 'Push endpoint must use HTTPS.' });
  }
  const hostErr = await validateHost(endpointUrl.hostname);
  if (hostErr) return res.status(400).json({ error: 'Push endpoint host is not allowed.' });
  try {
    await query(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, endpoint) DO UPDATE SET p256dh = $3, auth = $4`,
      [req.session.userId, endpoint, keys.p256dh, keys.auth]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('push/subscribe error:', err.message);
    res.status(500).json({ error: 'Failed to save push subscription.' });
  }
});

// Remove a push subscription when the user disables notifications.
router.post('/push/unsubscribe', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const { endpoint } = req.body || {};
  if (!endpoint || typeof endpoint !== 'string') {
    return res.status(400).json({ error: 'endpoint required.' });
  }
  try {
    await query(
      'DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2',
      [req.session.userId, endpoint]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('push/unsubscribe error:', err.message);
    res.status(500).json({ error: 'Failed to remove push subscription.' });
  }
});

export default router;
