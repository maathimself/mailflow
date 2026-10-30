import { query } from './db.js';

// How long a sign-in or a "Try again" waits for the account's connection before answering.
// Long enough for a normal IMAP login and the first folder list; a slow server is reported
// as still connecting rather than holding the request open.
export const CONNECT_WAIT_MS = 20000;

// Wait (bounded) for a connect attempt and say how it went, so the UI can tell "connected"
// from "signed in, but the mailbox refused us" (IMAP turned off, say) instead of announcing
// success the moment the tokens are stored.
//   { connection: 'connected' }
//   { connection: 'connecting' }  still trying: the wait ran out, or the attempt ended without
//                                 recording an error (a deferred transient refusal, or another
//                                 connect already in progress); the engine keeps retrying
//   { connection: 'failed', code, error }  the error recorded on the account
//
// isConnected answers as soon as the login has succeeded: connectAccount itself resolves only
// after the first folder and INBOX sync, which on a large mailbox takes longer than the wait.
export async function reportConnect(connectPromise, accountId, { waitMs = CONNECT_WAIT_MS, isConnected = () => false, checkEveryMs = 250 } = {}) {
  let timer;
  let ticker;
  const outcome = await Promise.race([
    Promise.resolve(connectPromise).then(ok => (ok ? 'connected' : 'failed'), () => 'failed'),
    new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), waitMs); }),
    new Promise(resolve => { ticker = setInterval(() => { if (isConnected()) resolve('connected'); }, checkEveryMs); }),
  ]);
  clearTimeout(timer);
  clearInterval(ticker);
  if (outcome === 'connected') return { connection: 'connected' };
  if (outcome === 'timeout') return { connection: 'connecting' };
  const { rows } = await query('SELECT sync_error, sync_error_code FROM email_accounts WHERE id = $1', [accountId]);
  const row = rows[0];
  if (!row?.sync_error) return { connection: 'connecting' };
  return { connection: 'failed', code: row.sync_error_code || 'connection', error: row.sync_error };
}
