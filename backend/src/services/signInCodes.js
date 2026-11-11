// One-time codes for the emailed-code sign-in step (services/secondFactor.js). On its own, with
// nothing but the database, so that src/cli/authRecovery.js can issue one without loading the
// mailer, whose imports start the whole server.
import crypto from 'crypto';
import { query } from './db.js';

// Generate and store a one-time sign-in code for the emailed-code step, replacing any unused
// one, and return it. Only its hash is stored. Valid for 10 minutes.
export async function issueSignInCode(userId) {
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
  return { code, expiresAt };
}
