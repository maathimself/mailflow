// One-time codes for the emailed-code sign-in step (services/secondFactor.js). On its own, with
// nothing but the database, so that src/cli/authRecovery.js can issue one without loading the
// mailer, whose imports start the whole server.
import crypto from 'crypto';
import { query } from './db.js';

// A new one-time sign-in code, not stored yet. Valid for 10 minutes from now.
export function newSignInCode() {
  const codeNum = crypto.randomBytes(3).readUIntBE(0, 3) % 900000 + 100000;
  const code = String(codeNum);
  return { code, expiresAt: new Date(Date.now() + 10 * 60 * 1000) };
}

// Store `signInCode` for the user, replacing any unused one. Only its hash is stored.
export async function storeSignInCode(userId, { code, expiresAt }) {
  const codeHash = crypto.createHash('sha256').update(code).digest('hex');
  // Remove any previous unused OTPs for this user to prevent confusion
  await query('DELETE FROM email_otp_tokens WHERE user_id = $1 AND used_at IS NULL', [userId]);
  await query(
    'INSERT INTO email_otp_tokens (user_id, code_hash, expires_at) VALUES ($1, $2, $3)',
    [userId, codeHash, expiresAt]
  );
}

// Generate and store a code: what src/cli/authRecovery.js sign-in-code hands an admin.
export async function issueSignInCode(userId) {
  const signInCode = newSignInCode();
  await storeSignInCode(userId, signInCode);
  return signInCode;
}
