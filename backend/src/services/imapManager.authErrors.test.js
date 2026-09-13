import { afterEach, describe, expect, it, vi } from 'vitest';
import net from 'node:net';

// Same module isolation as imapManager.test.js, but WITHOUT mocking imapflow: these tests drive
// the real library against an in-process fake server so an ImapFlow upgrade that changes the
// LOGIN/AUTHENTICATE error shape fails here instead of silently reverting to 'Command failed'.
vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./messageParser.js', () => ({ parseMessage: vi.fn(), buildSnippetFromHtml: vi.fn(), snippetFromBody: vi.fn(), decodeMimeWords: vi.fn(), detectBulkFromParsedHeaders: vi.fn(), parseRawHeaders: vi.fn(), enrichParsedMetadata: vi.fn((parsed) => parsed) }));
vi.mock('../routes/oauth.js', () => ({ refreshMicrosoftToken: vi.fn() }));
vi.mock('./emailSanitizer.js', () => ({ sanitizeEmail: vi.fn() }));
vi.mock('./encryption.js', () => ({ decrypt: vi.fn() }));
vi.mock('./aiProvider.js', () => ({ getAiStatus: vi.fn(), completeText: vi.fn() }));
vi.mock('./pushNotifications.js', () => ({ sendPushToUser: vi.fn() }));
vi.mock('../utils/redact.js', () => ({ redactEmail: vi.fn() }));
vi.mock('./hostValidation.js', () => ({ resolveForConnection: vi.fn(), createPinnedLookup: vi.fn() }));
vi.mock('./connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn() }));

import { ImapFlow } from 'imapflow';
import { extractImapError, isImapAuthFailure, isConnectionRefusal } from './imapManager.js';

const ACCESS_TOKEN = 'ya29.a0AfH6SMBx-SECRET_access_token_value';
const PASSWORD = 'hunter2-secret-password';

// Minimal IMAP responder: greeting, CAPABILITY, then one AUTHENTICATE exchange answered with the
// scripted tagged NO. For XOAUTH2 it first sends the base64 JSON error challenge Gmail sends.
function startFakeServer({ tagged, oauthChallenge }) {
  const sockets = new Set();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => {});
    sock.write('* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN AUTH=XOAUTH2] fake ready\r\n');
    let buffer = '';
    let authTag = null;
    sock.on('data', (chunk) => {
      buffer += chunk.toString('latin1');
      let end;
      while ((end = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (authTag) {
          sock.write(`${authTag} ${tagged}\r\n`);
          authTag = null;
          continue;
        }
        const [tag, command = ''] = line.split(' ');
        switch (command.toUpperCase()) {
          case 'CAPABILITY':
            sock.write(`* CAPABILITY IMAP4rev1 AUTH=PLAIN AUTH=XOAUTH2\r\n${tag} OK done\r\n`);
            break;
          case 'AUTHENTICATE':
            authTag = tag;
            sock.write(oauthChallenge
              ? `+ ${Buffer.from(JSON.stringify(oauthChallenge)).toString('base64')}\r\n`
              : '+ \r\n');
            break;
          case 'LOGOUT':
            sock.write(`* BYE\r\n${tag} OK bye\r\n`);
            sock.end();
            break;
          default:
            sock.write(`${tag} BAD unexpected\r\n`);
        }
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      close: () => new Promise((done) => { for (const s of sockets) s.destroy(); server.close(done); }),
    }));
  });
}

let fake;
afterEach(async () => { if (fake) await fake.close(); fake = null; });

async function connectError(serverOpts, auth) {
  fake = await startFakeServer(serverOpts);
  const client = new ImapFlow({
    host: '127.0.0.1', port: fake.port, secure: false, doSTARTTLS: false,
    auth, logger: false, connectionTimeout: 5000, greetingTimeout: 5000,
  });
  client.on('error', () => {});
  try {
    await client.connect();
  } catch (err) {
    return err;
  } finally {
    client.close();
  }
  throw new Error('connect unexpectedly succeeded');
}

function expectNoSecrets(err, detail) {
  expect(detail).not.toContain(ACCESS_TOKEN);
  expect(detail).not.toContain(PASSWORD);
  expect(detail).not.toMatch(/Bearer|scope|mail\.google\.com/i);
  // Neither the XOAUTH2 nor the PLAIN SASL payload may appear in encoded form.
  const xoauth = Buffer.from(`user=u@example.com\x01auth=Bearer ${ACCESS_TOKEN}\x01\x01`).toString('base64');
  const plain = Buffer.from(`\x00u\x00${PASSWORD}`).toString('base64');
  expect(detail).not.toContain(xoauth);
  expect(detail).not.toContain(plain);
  expect(String(err.message)).toBe('Command failed'); // the shape extractImapError has to see through
}

describe('extractImapError / isImapAuthFailure against real ImapFlow errors', () => {
  it('Gmail-style XOAUTH2 rejection', async () => {
    const err = await connectError(
      { tagged: 'NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)', oauthChallenge: { status: '400', schemes: 'Bearer', scope: 'https://mail.google.com/' } },
      { user: 'u@example.com', accessToken: ACCESS_TOKEN },
    );
    const detail = extractImapError(err);
    expect(detail).toBe('[AUTHENTICATIONFAILED] Invalid credentials (Failure) (oauth status 400)');
    expect(isImapAuthFailure(err)).toBe(true);
    expect(isConnectionRefusal(detail)).toBe(false);
    expectNoSecrets(err, detail);
  });

  it('password AUTHENTICATE PLAIN rejection', async () => {
    const err = await connectError(
      { tagged: 'NO [AUTHENTICATIONFAILED] Authentication failed.' },
      { user: 'u', pass: PASSWORD },
    );
    const detail = extractImapError(err);
    expect(detail).toBe('[AUTHENTICATIONFAILED] Authentication failed.');
    expect(isImapAuthFailure(err)).toBe(true);
    expectNoSecrets(err, detail);
  });

  it('login-stage connection limit stays a refusal, not an auth failure', async () => {
    const err = await connectError(
      { tagged: 'NO [LIMIT] Too many simultaneous connections' },
      { user: 'u', pass: PASSWORD },
    );
    const detail = extractImapError(err);
    expect(err.authenticationFailed).toBe(true); // ImapFlow flags it; the classifier must not trust that alone
    expect(detail).toBe('[LIMIT] Too many simultaneous connections');
    expect(isConnectionRefusal(detail)).toBe(true);
    expect(isImapAuthFailure(err)).toBe(false);
    expectNoSecrets(err, detail);
  });
});
