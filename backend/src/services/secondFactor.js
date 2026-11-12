// The second step of signing in, shared by password login (routes/auth.js) and single
// sign-on (routes/oidc.js).
//
// After the first factor (a password, or the identity provider), beginSecondFactor() decides
// what this sign-in still needs and records it in the session as `pendingSecondFactor`:
//   'totp'   the user turned on an authenticator app: only /2fa/challenge completes it
//   'email'  an admin requires 2FA and the user has no authenticator yet: only the emailed
//            code (/2fa/verify-email-otp) completes it
//   'enroll' an admin requires 2FA and the user has no recovery email: the user sets up an
//            authenticator (/2fa/enrollment/*)
// When the emailed code cannot be sent, the sign-in still waits for one ('email', with
// sendFailed): it fails closed rather than letting whoever passed the first factor set up an
// authenticator of their own. The user can resend, or an admin can issue a code from the
// server (src/cli/authRecovery.js). With no system email configured at all, no code could ever
// arrive, so that user sets up an authenticator ('enroll'), as one without a recovery email does.
// Each completion endpoint accepts only its own method. Before this, the emailed-code
// endpoints accepted any pending sign-in, so an account with an authenticator could be
// signed in with a code sent to its recovery email instead (GHSA-v67x-j275-jpxj).
import crypto from 'crypto';
import { query } from './db.js';
import { sendSystemEmail, SystemEmailNotConfigured } from './mailer.js';
import { newSignInCode, storeSignInCode } from './signInCodes.js';

export function maskEmail(email) {
  if (!email) return '';
  const [local, domain] = email.split('@');
  if (!domain) return email;
  const masked = local.length <= 2
    ? local[0] + '*'
    : local[0] + '*'.repeat(Math.min(local.length - 2, 4)) + local[local.length - 1];
  return masked + '@' + domain;
}

export function getTrustDurationMs(setting) {
  switch (setting) {
    case '7d': return 7 * 24 * 60 * 60 * 1000;
    case '30d': return 30 * 24 * 60 * 60 * 1000;
    case 'permanent': return 365 * 24 * 60 * 60 * 1000;
    default: return 0; // 'never'
  }
}

export async function createTrustedDevice(userId, req, res) {
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

// True when the request carries a valid "remember this device" cookie for this user, which
// skips the second step as it always has for password login. Marks the device as used.
export async function isTrustedDevice(userId, req) {
  const rawCookies = req.headers.cookie || '';
  const deviceToken = rawCookies.split(';').map(c => c.trim()).find(c => c.startsWith('mf_td='))?.slice(6);
  if (!deviceToken) return false;
  const tokenHash = crypto.createHash('sha256').update(deviceToken).digest('hex');
  const deviceRes = await query(
    `SELECT id FROM trusted_devices
     WHERE user_id = $1 AND token_hash = $2
       AND (expires_at IS NULL OR expires_at > NOW())`,
    [userId, tokenHash]
  );
  if (!deviceRes.rows.length) return false;
  await query('UPDATE trusted_devices SET last_used_at = NOW() WHERE id = $1', [deviceRes.rows[0].id]);
  return true;
}

// Generate and store an email OTP, and send it to the given address.
// The code is stored, replacing the unused one, only once the email is out: a send that fails
// leaves the code an admin issued from the server (src/cli/authRecovery.js) working.
export async function sendEmailOtpCode(userId, toEmail) {
  const signInCode = newSignInCode();
  const { code } = signInCode;

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
  await storeSignInCode(userId, signInCode);
}

// Decide the second step for `user`, who has just passed the first factor on a freshly
// regenerated session. Returns one of
//   { step: 'none' }                                   sign the user in now
//   { step: 'totp',  deviceTrustAvailable }
//   { step: 'email', deviceTrustAvailable, emailHint, sendFailed? }
//   { step: 'enroll' }
// and, for every step but 'none', records the pending sign-in in the session.
// `sso` ({ providerId, idToken }) is carried through a pending step so that the session the
// second step creates still knows its provider (SSO logout). `idpEnforcesMfa` is the
// provider's "already enforces MFA" setting: such a sign-in needs no second step here.
// A user's own authenticator always applies; the admin's "2FA required" policy applies to
// single sign-on only while password sign-in is on, which is when Settings offers it.
export async function beginSecondFactor(req, user, { sso = null, idpEnforcesMfa = false } = {}) {
  if (idpEnforcesMfa) return { step: 'none' };
  if (await isTrustedDevice(user.id, req)) return { step: 'none' };

  const policyResult = await query(
    "SELECT key, value FROM system_settings WHERE key IN ('mfa_enforcement', 'mfa_device_trust', 'internal_auth_disabled')"
  );
  const policyMap = {};
  for (const row of policyResult.rows) policyMap[row.key] = row.value;
  // With password sign-in turned off, the admin's policy is not offered (Settings shows it as
  // not applicable: the identity provider runs MFA), so a value saved before then is ignored.
  const policyOffered = !(sso && policyMap.internal_auth_disabled === 'true');
  const enforcement = policyOffered ? (policyMap.mfa_enforcement || 'off') : 'off';
  const deviceTrustAvailable = getTrustDurationMs(policyMap.mfa_device_trust || '30d') > 0;

  const pend = (method, windowMs, prompt = {}) => {
    req.session.pendingUserId = user.id;
    req.session.pendingTOTPExpiry = Date.now() + windowMs;
    req.session.pendingSecondFactor = method;
    // What the login page shows for this step when it arrives from a single sign-on redirect
    // (GET /api/auth/2fa/pending): nothing secret, the email is masked.
    req.session.pendingPrompt = prompt;
    if (sso) req.session.pendingSso = { providerId: sso.providerId, idToken: sso.idToken || null };
  };

  // A user with an authenticator always uses it.
  if (user.totp_enabled) {
    pend('totp', 5 * 60 * 1000, { deviceTrustAvailable });
    return { step: 'totp', deviceTrustAvailable };
  }

  if (enforcement !== 'required') return { step: 'none' };

  // 2FA is required and this user has no authenticator: an emailed code, or, with no recovery
  // email to send one to, setting up an authenticator.
  // A server with no system email configured can never send one, so those users set up an
  // authenticator, as users without a recovery email do. A configured one that fails to send
  // fails closed.
  if (user.recovery_email) {
    const emailHint = maskEmail(user.recovery_email);
    let sendFailed = false;
    let noSystemEmail = false;
    try {
      await sendEmailOtpCode(user.id, user.recovery_email);
    } catch (err) {
      if (err instanceof SystemEmailNotConfigured) noSystemEmail = true;
      else {
        console.error(`Sign-in code email to user ${user.id} failed:`, err.message);
        sendFailed = true;
      }
    }
    if (!noSystemEmail) {
      pend('email', 10 * 60 * 1000, { deviceTrustAvailable, emailHint, ...(sendFailed ? { sendFailed } : {}) });
      return { step: 'email', deviceTrustAvailable, emailHint, ...(sendFailed ? { sendFailed } : {}) };
    }
  }
  pend('enroll', 10 * 60 * 1000);
  return { step: 'enroll' };
}

// The pending sign-in, if there is one that has not expired and is waiting for `method`.
// Returns { userId } or { error } with the message the endpoints have always returned.
export function pendingSignIn(req, method) {
  if (!req.session.pendingUserId || req.session.pendingSecondFactor !== method) {
    return { error: method === 'enroll' ? 'No pending enrollment' : 'No pending authentication' };
  }
  if (Date.now() > (req.session.pendingTOTPExpiry || 0)) {
    return { error: 'expired' };
  }
  return { userId: req.session.pendingUserId };
}

// Turn the pending sign-in into a signed-in session for `user`: a new session ID (so the
// pending one cannot be reused), and the SSO provider carried over when it was a single
// sign-on.
export async function completePendingLogin(req, user) {
  const sso = req.session.pendingSso || null;
  await new Promise((resolve, reject) => req.session.regenerate(err => err ? reject(err) : resolve()));
  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.isAdmin = user.is_admin;
  if (sso?.providerId) {
    req.session.oidcProviderId = sso.providerId;
    if (sso.idToken) req.session.oidcIdToken = sso.idToken;
  }
}
