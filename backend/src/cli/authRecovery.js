// Sign-in recovery from the server, for when no admin can get in through the web.
//
//   docker compose exec backend node src/cli/authRecovery.js sign-in-code <username>
//   docker compose exec backend node src/cli/authRecovery.js disable-2fa <username>
//   (a native install: run `node src/cli/authRecovery.js ...` in the backend directory, with
//   the same environment as the service)
//
// sign-in-code prints a one-time code for a user whose sign-in is waiting for an emailed code,
// as it does when two-factor is required and the email cannot be sent (services/secondFactor.js
// fails closed there). The user enters it on that screen within 10 minutes.
// disable-2fa turns off a user's authenticator, as Settings → Users does, for someone who has
// lost it when no other admin can sign in. Their API tokens go too, as they do there.
// Both are written to the security log, by "server console".
import { query, pool, withTransaction } from '../services/db.js';
import { issueSignInCode } from '../services/signInCodes.js';

const ACTOR = 'server console';
const USAGE = `Usage:
  node src/cli/authRecovery.js sign-in-code <username>   one-time code for the emailed-code sign-in step
  node src/cli/authRecovery.js disable-2fa <username>    turn off the user's authenticator app`;

const log = (eventType, user) => query(
  `INSERT INTO auth_events (event_type, username, user_id, actor_username, ip, success)
   VALUES ($1, $2, $3, $4, NULL, true)`,
  [eventType, user.username, user.id, ACTOR]
);

async function findUser(raw) {
  const username = String(raw || '').toLowerCase().trim();
  if (!username) throw new Error(USAGE);
  const { rows: [user] } = await query(
    'SELECT id, username, totp_enabled, recovery_email FROM users WHERE username = $1',
    [username]
  );
  if (!user) throw new Error(`No user named "${username}".`);
  return user;
}

async function signInCode(user) {
  if (user.totp_enabled) {
    throw new Error(`${user.username} signs in with an authenticator app, which a code cannot replace. If it is lost, run disable-2fa first.`);
  }
  if (!user.recovery_email) {
    throw new Error(`${user.username} has no recovery email, so their sign-in asks them to set up an authenticator app, not for a code.`);
  }
  const { code, expiresAt } = await issueSignInCode(user.id);
  await log('admin_sign_in_code', user);
  console.log(`Sign-in code for ${user.username}: ${code}`);
  console.log(`Valid until ${expiresAt.toISOString()}, once. Any earlier unused code no longer works.`);
  console.log('They sign in with their password (or single sign-on), then enter it on the "Check your email" screen.');
}

async function disableTwoFactor(user) {
  if (!user.totp_enabled) {
    console.log(`${user.username} has no authenticator app turned on. Nothing changed.`);
    return;
  }
  const revoked = await withTransaction(async client => {
    await client.query('UPDATE users SET totp_secret = NULL, totp_enabled = false WHERE id = $1', [user.id]);
    return (await client.query('DELETE FROM api_tokens WHERE user_id = $1', [user.id])).rowCount;
  });
  await log('admin_totp_disable', user);
  console.log(`Turned off the authenticator app for ${user.username}${revoked ? `, and deleted their ${revoked} API token${revoked === 1 ? '' : 's'}` : ''}.`);
  console.log('If two-factor is required, they set up a new one, or get an emailed code, at their next sign-in.');
}

const COMMANDS = { 'sign-in-code': signInCode, 'disable-2fa': disableTwoFactor };

const [command, username] = process.argv.slice(2);
let exitCode = 0;
try {
  const run = COMMANDS[command];
  if (!run) throw new Error(USAGE);
  await run(await findUser(username));
} catch (err) {
  console.error(err.message);
  exitCode = 1;
} finally {
  await pool.end().catch(() => {});
}
process.exit(exitCode);
