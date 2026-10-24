import { afterEach, describe, expect, it, vi } from 'vitest';
import net from 'node:net';
import { ImapFlow } from 'imapflow';

vi.mock('./db.js', () => ({ query: vi.fn(async () => ({ rows: [] })) }));
// imapManager is imported for its auth-failure tests only; keep its route import inert.
vi.mock('../routes/oauth.js', () => ({ refreshMicrosoftToken: vi.fn(), refreshGoogleToken: vi.fn() }));
import { query } from './db.js';
import { extractImapError } from './imapError.js';
import { isAuthFailure, isAuthFailureFor } from './imapManager.js';
import { classifyAccountError, clearRefreshFailure, noteFreshToken, noteRefreshFailure } from './accountErrorCode.js';
import { reportConnect } from './connectReport.js';

// The failures an Outlook mailbox gives an XOAUTH2 login, produced by the REAL imapflow against a
// minimal IMAP server rather than written by hand: what reaches sync_error and its code must be
// what imapflow actually throws (#674).
//   imapOff   login accepted, then NAMESPACE answered "BAD User is authenticated but not
//             connected." (IMAP turned off in Outlook.com). imapflow throws
//             AuthenticationFailure('Authentication failed') with the text as a string response.
//   rejected  AUTHENTICATE answered "NO AUTHENTICATE failed." (token not accepted).
function fakeOutlook(mode) {
  const server = net.createServer((socket) => {
    socket.write('* OK Fake Outlook IMAP4rev1 ready\r\n');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let i;
      while ((i = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        const [tag, rawCommand] = line.split(' ');
        const command = (rawCommand || '').toUpperCase();
        if (command === 'CAPABILITY') {
          socket.write('* CAPABILITY IMAP4rev1 AUTH=XOAUTH2 SASL-IR ID NAMESPACE\r\n');
          socket.write(`${tag} OK CAPABILITY completed.\r\n`);
        } else if (command === 'ID') {
          socket.write('* ID ("name" "Fake")\r\n');
          socket.write(`${tag} OK ID completed.\r\n`);
        } else if (command === 'AUTHENTICATE') {
          socket.write(mode === 'rejected' ? `${tag} NO AUTHENTICATE failed.\r\n` : `${tag} OK AUTHENTICATE completed.\r\n`);
        } else if (command === 'NAMESPACE') {
          socket.write(`${tag} BAD User is authenticated but not connected.\r\n`);
        } else if (command === 'LOGOUT') {
          socket.write('* BYE\r\n');
          socket.write(`${tag} OK LOGOUT completed.\r\n`);
          socket.end();
        } else {
          socket.write(`${tag} BAD Command not supported.\r\n`);
        }
      }
    });
    socket.on('error', () => {});
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function failureFrom(mode) {
  const server = await fakeOutlook(mode);
  const client = new ImapFlow({
    host: '127.0.0.1', port: server.address().port, secure: false, doSTARTTLS: false,
    auth: { user: 'maria.lopez@outlook.com', accessToken: 'token' }, logger: false,
  });
  client.on('error', () => {});
  try {
    await client.connect();
    throw new Error('expected the login to fail');
  } catch (err) {
    return err;
  } finally {
    try { client.close(); } catch { /* closed */ }
    await new Promise(resolve => server.close(resolve));
  }
}

const outlook = { id: 'a-real-1', email_address: 'maria.lopez@outlook.com', oauth_provider: 'microsoft', oauth_tenant_id: 'consumers' };
const work = { id: 'a-real-2', email_address: 'maria@contoso.example', oauth_provider: 'microsoft', oauth_tenant_id: 'organizations' };

describe('Outlook XOAUTH2 failures from the real imapflow', () => {
  afterEach(() => { for (const a of [outlook, work]) clearRefreshFailure(a.id); });

  it('IMAP turned off keeps the server text, stays an auth failure, and is classified as IMAP off', async () => {
    const err = await failureFrom('imapOff');
    expect(err.authenticationFailed).toBe(true);
    const detail = extractImapError(err);
    expect(detail).toBe('Authentication failed: User is authenticated but not connected.');
    // Still an auth failure, so every path records it and backs off...
    expect(isAuthFailure(detail)).toBe(true);
    // ...but signing in again cannot fix it: the Outlook.com steps can.
    expect(classifyAccountError(outlook, detail, { authFailure: true }).code).toBe('ms_imap_disabled_personal');
    expect(classifyAccountError(work, detail, { authFailure: true }).code).toBe('ms_imap_disabled_work');
    // Even with a refresh failure remembered, IMAP off is what the user has to fix first.
    noteRefreshFailure(outlook.id, { code: 'oauth_reauth', detail: 'AADSTS70008' });
    expect(classifyAccountError(outlook, detail, { authFailure: true }).code).toBe('ms_imap_disabled_personal');
  });

  it('a rejected token is "sign in again" for an old token, but not right after a new one', async () => {
    const err = await failureFrom('rejected');
    const detail = extractImapError(err);
    expect(detail).toMatch(/AUTHENTICATE failed/);
    expect(classifyAccountError(work, detail, { authFailure: isAuthFailure(detail) }).code).toBe('oauth_reauth');
    // Microsoft issued this token minutes ago: signing in again would only loop.
    noteFreshToken(work.id);
    expect(classifyAccountError(work, detail, { authFailure: isAuthFailure(detail) })).toEqual({ code: 'connection', detail });
    // A refresh known to have failed for good wins over freshness.
    noteRefreshFailure(work.id, { code: 'oauth_reauth', detail: 'AADSTS700082: expired' });
    expect(classifyAccountError(work, detail, { authFailure: isAuthFailure(detail) }).code).toBe('oauth_reauth');
  });

  it('a sign-in reports IMAP off as a failure with its code, not as connected or "sign in again"', async () => {
    const err = await failureFrom('imapOff');
    const detail = extractImapError(err);
    const { code } = classifyAccountError(outlook, detail, { authFailure: isAuthFailure(detail) });
    query.mockResolvedValueOnce({ rows: [{ sync_error: detail, sync_error_code: code }] });
    expect(await reportConnect(Promise.resolve(false), outlook.id, { waitMs: 2000 })).toEqual({
      connection: 'failed', code: 'ms_imap_disabled_personal', error: 'Authentication failed: User is authenticated but not connected.',
    });
  });
});

describe('isAuthFailureFor: the long backoff for an OAuth account whose refresh is dead', () => {
  afterEach(() => clearRefreshFailure(outlook.id));

  it('arms on a server-side auth failure, or a remembered terminal refresh failure on an OAuth account', () => {
    expect(isAuthFailureFor(outlook, 'Authentication failed: User is authenticated but not connected.')).toBe(true);
    expect(isAuthFailureFor(outlook, 'AUTHENTICATE failed.')).toBe(false);
    noteRefreshFailure(outlook.id, { code: 'oauth_reauth', detail: 'AADSTS70008' });
    expect(isAuthFailureFor(outlook, 'AUTHENTICATE failed.')).toBe(true);
    // An app the provider rejects is the admin's to fix: it keeps the short retry.
    noteRefreshFailure(outlook.id, { code: 'oauth_app_config', detail: 'AADSTS7000222: expired secret' });
    expect(isAuthFailureFor(outlook, 'AUTHENTICATE failed.')).toBe(false);
    // A password account has no refresh: unchanged.
    expect(isAuthFailureFor({ id: outlook.id, oauth_provider: null }, 'AUTHENTICATE failed.')).toBe(false);
  });
});
