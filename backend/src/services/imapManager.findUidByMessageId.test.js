// findUidByMessageId is how a sent message is found in Sent: the post-send metadata upsert and
// scheduled send's recovery both rely on it. The fake server below answers SEARCH from what
// imapflow actually puts on the wire, so a criteria shape imapflow reads differently finds nothing.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('imapflow', () => ({ ImapFlow: vi.fn() }));
vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./messageParser.js', () => ({ parseMessage: vi.fn(), buildSnippetFromHtml: vi.fn(), snippetFromBody: vi.fn(), decodeMimeWords: vi.fn(), detectBulkFromParsedHeaders: vi.fn(), parseRawHeaders: vi.fn(), enrichParsedMetadata: vi.fn((p) => p) }));
vi.mock('../routes/oauth.js', () => ({ refreshMicrosoftToken: vi.fn(), refreshGoogleToken: vi.fn() }));
vi.mock('./emailSanitizer.js', () => ({ sanitizeEmail: vi.fn() }));
vi.mock('./encryption.js', () => ({ decrypt: vi.fn(() => 'pw') }));
vi.mock('./aiProvider.js', () => ({ getAiStatus: vi.fn(), completeText: vi.fn() }));
vi.mock('./pushNotifications.js', () => ({ sendPushToUser: vi.fn() }));
vi.mock('../utils/redact.js', () => ({ redactEmail: vi.fn(() => 'a***@example.com') }));
vi.mock('./hostValidation.js', () => ({ resolveForConnection: vi.fn(), createPinnedLookup: vi.fn() }));
vi.mock('./connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn() }));
vi.mock('./spamPipeline.js', () => ({ classifyAndTagMessage: vi.fn() }));
vi.mock('./mailAccess.js', () => ({ getAccountAddresses: vi.fn(async () => []) }));

import { EventEmitter } from 'node:events';
import { ImapFlow } from 'imapflow';
import { searchCompiler } from 'imapflow/lib/search-compiler.js';
import { ImapManager, evictPool } from './imapManager.js';
import { resolveForConnection } from './hostValidation.js';
import { getConnectionPolicy } from './connectionPolicy.js';

const ACCOUNT = { id: 'acct-1', user_id: 'u1', imap_host: 'imap.example.com', imap_port: 993, imap_tls: true, auth_user: 'u', auth_pass: 'enc' };

// Sent, as the server holds it.
const SENT = [
  { uid: 41, headers: { 'message-id': '<other@example.com>' } },
  { uid: 42, headers: { 'message-id': '<sent-1@example.com>' } },
];

// RFC 3501 HEADER: the named field contains the string, the name matched without case.
function serverSearch(wire) {
  const terms = [];
  for (let i = 0; i < wire.length; i++) {
    if (wire[i] === 'HEADER') { terms.push([wire[i + 1].toLowerCase(), wire[i + 2]]); i += 2; }
  }
  return SENT.filter(m => terms.length && terms.every(([name, value]) => m.headers[name]?.includes(value))).map(m => m.uid);
}

let wires;
beforeEach(() => {
  evictPool(ACCOUNT.id);
  wires = [];
  getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: true, allowInsecureTls: true });
  resolveForConnection.mockResolvedValue({ host: '127.0.0.1', addresses: ['127.0.0.1'], servername: null });
  ImapFlow.mockImplementation(function () {
    return Object.assign(new EventEmitter(), {
      capabilities: new Map([['IMAP4rev1', true]]), enabled: new Set(),
      states: { NOT_AUTHENTICATED: 1, AUTHENTICATED: 2, SELECTED: 3, LOGOUT: 4 }, state: 2, mailbox: false,
      connect: vi.fn(async () => {}), close: vi.fn(), logout: vi.fn(async () => {}), noop: vi.fn(async () => true),
      async getMailboxLock(path) { this.mailbox = { path, exists: SENT.length }; return { release() {} }; },
      async search(criteria) {
        const wire = searchCompiler(this, criteria).map(a => a.value);
        wires.push(wire);
        return serverSearch(wire);
      },
    });
  });
});
afterEach(() => evictPool(ACCOUNT.id));

describe('findUidByMessageId', () => {
  it('searches the Message-ID header and resolves the uid of the message that carries it', async () => {
    const mgr = new ImapManager(null);
    expect(await mgr.findUidByMessageId(ACCOUNT, 'Sent', '<sent-1@example.com>')).toBe(42);
    expect(wires).toEqual([['HEADER', 'MESSAGE-ID', 'sent-1@example.com']]);
  });

  it('resolves null when no message in the folder carries it', async () => {
    const mgr = new ImapManager(null);
    expect(await mgr.findUidByMessageId(ACCOUNT, 'Sent', '<missing@example.com>')).toBe(null);
  });
});
