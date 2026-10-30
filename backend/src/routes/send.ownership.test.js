import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// POST /api/mail/send checks the sending account, forwarded attachments and forwarded messages
// through services/ownership.js. Another user's account or message is refused as not found,
// before anything is fetched or sent; the owner's goes out.
const session = vi.hoisted(() => ({ userId: 'owner' }));
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: session.userId }; next(); } }));
vi.mock('../services/redis.js', () => ({ redisClient: { get: vi.fn(async () => null), set: vi.fn(async () => 'OK'), del: vi.fn(async () => 1) } }));
vi.mock('../index.js', () => ({
  imapManager: {
    appendToSent: vi.fn(async () => ({ uid: 5 })),
    upsertSentMessageRecord: vi.fn(async () => {}),
    syncFolderOnDemand: vi.fn(async () => {}),
    fetchRawMessage: vi.fn(async () => Buffer.from('Subject: Original\r\n\r\nBody\r\n')),
    fetchAttachment: vi.fn(async () => Buffer.from('file')),
    pluginFacade: {},
  },
}));
vi.mock('../services/smtpTransport.js', () => ({ createAccountSmtpTransport: vi.fn() }));
vi.mock('../utils/mailUtils.js', () => ({ resolveSentFolder: vi.fn(async () => 'Sent') }));
vi.mock('../services/ownership.js', async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, findOwnedAccount: vi.fn(real.findOwnedAccount), findOwnedMessages: vi.fn(real.findOwnedMessages) };
});

import express from 'express';
import routes from './send.js';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';
import { createAccountSmtpTransport } from '../services/smtpTransport.js';
import { findOwnedAccount, findOwnedMessages } from '../services/ownership.js';

const OWNER = 'owner';
const STRANGER = 'stranger';
const ACCOUNT_ID = 'a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1';
const MESSAGE_ID = 'b2b2b2b2-2222-4222-8222-b2b2b2b2b2b2';
const account = { id: ACCOUNT_ID, user_id: OWNER, email_address: 'me@example.com', name: 'Me', oauth_provider: null };
const STRANGERS_MESSAGE_ID = 'c3c3c3c3-3333-4333-8333-c3c3c3c3c3c3';
const DELETED_MESSAGE_ID = 'e5e5e5e5-5555-4555-8555-e5e5e5e5e5e5';
const message = { id: MESSAGE_ID, account_id: ACCOUNT_ID, uid: 9, folder: 'INBOX', subject: 'Original', attachments: [{ part: '2', size: 4, filename: 'a.txt', type: 'text/plain' }] };
const MESSAGES = {
  [MESSAGE_ID]: { owner: OWNER, row: message },
  [DELETED_MESSAGE_ID]: { owner: OWNER, deleted: true, row: { ...message, id: DELETED_MESSAGE_ID } },
  [STRANGERS_MESSAGE_ID]: { owner: STRANGER, row: { ...message, id: STRANGERS_MESSAGE_ID, account_id: 'd4d4d4d4-4444-4444-8444-d4d4d4d4d4d4' } },
};
const sendMail = vi.fn(async () => ({}));

const flat = sql => sql.replace(/\s+/g, ' ').trim();
function fakeQuery(rawSql, params = []) {
  const sql = flat(rawSql);
  if (/^SELECT .+ FROM email_accounts WHERE id = \$1 AND user_id = \$2/.test(sql)) {
    return { rows: params[0] === ACCOUNT_ID && params[1] === OWNER ? [account] : [] };
  }
  // The owned-message list: users are bound as $1 (shared lookup) or $2 (before it was shared).
  const bulk = sql.match(/FROM messages m JOIN email_accounts a ON m\.account_id = a\.id WHERE m\.id = ANY\(\$(\d)::uuid\[\]\) AND a\.user_id = \$(\d)/);
  if (bulk) {
    const [ids, userId] = [params[bulk[1] - 1], params[bulk[2] - 1]];
    const live = sql.includes('m.is_deleted = false');
    return { rows: ids.filter(id => MESSAGES[id]?.owner === userId && !(live && MESSAGES[id].deleted)).map(id => MESSAGES[id].row) };
  }
  if (sql.startsWith('SELECT * FROM email_accounts WHERE id = ANY')) return { rows: [account] };
  return { rows: [{ preferences: {}, id: 'book1' }] };
}

let server, base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/mail', routes);
  await new Promise(resolve => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
beforeEach(() => {
  sendMail.mockClear();
  imapManager.fetchRawMessage.mockClear();
  imapManager.fetchAttachment.mockClear();
  findOwnedAccount.mockClear();
  findOwnedMessages.mockClear();
  createAccountSmtpTransport.mockReset().mockResolvedValue({ account, transport: { sendMail } });
  query.mockReset().mockImplementation(async (sql, params) => fakeQuery(sql, params));
});

async function send(userId, extra) {
  session.userId = userId;
  const res = await fetch(`${base}/api/mail/send`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': `k-${Math.random()}` },
    body: JSON.stringify({ accountId: ACCOUNT_ID, to: ['you@example.com'], subject: 'Hi', body: 'Hello', ...extra }),
  });
  return { status: res.status, json: await res.json() };
}

const nothingFetchedOrSent = () => {
  expect(imapManager.fetchRawMessage).not.toHaveBeenCalled();
  expect(imapManager.fetchAttachment).not.toHaveBeenCalled();
  expect(sendMail).not.toHaveBeenCalled();
};

describe('POST /api/mail/send ownership', () => {
  it('refuses to send from another user\'s account', async () => {
    expect(await send(STRANGER, {})).toEqual({ status: 404, json: { error: 'Account not found' } });
    nothingFetchedOrSent();
  });

  it('refuses to forward an attachment of another user\'s message', async () => {
    expect(await send(OWNER, { forwardedAttachments: [{ messageId: STRANGERS_MESSAGE_ID, part: '2' }] }))
      .toEqual({ status: 404, json: { error: 'Forwarded message not found' } });
    nothingFetchedOrSent();
  });

  it('refuses to forward another user\'s message', async () => {
    expect(await send(OWNER, { forwardedMessages: [STRANGERS_MESSAGE_ID] }))
      .toEqual({ status: 404, json: { error: 'Forwarded message not found' } });
    nothingFetchedOrSent();
  });

  it('sends from the owner\'s account with the owner\'s forwarded attachment and message', async () => {
    const res = await send(OWNER, { forwardedAttachments: [{ messageId: MESSAGE_ID, part: '2' }], forwardedMessages: [MESSAGE_ID] });
    expect(res.status).toBe(200);
    expect(imapManager.fetchAttachment).toHaveBeenCalledWith(account, 9, 'INBOX', '2');
    expect(imapManager.fetchRawMessage).toHaveBeenCalledWith(account, 9, 'INBOX');
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(findOwnedAccount).toHaveBeenCalledWith(OWNER, ACCOUNT_ID);
    expect(findOwnedMessages).toHaveBeenCalledWith(OWNER, [MESSAGE_ID], { columns: 'm.id, m.uid, m.folder, m.attachments, m.account_id' });
    expect(findOwnedMessages).toHaveBeenCalledWith(OWNER, [MESSAGE_ID], { columns: 'm.id, m.uid, m.folder, m.subject, m.account_id', live: true });
  });

  it('refuses to forward a deleted message, but still forwards a deleted message\'s attachment', async () => {
    expect(await send(OWNER, { forwardedMessages: [DELETED_MESSAGE_ID] }))
      .toEqual({ status: 404, json: { error: 'Forwarded message not found' } });
    nothingFetchedOrSent();
    expect((await send(OWNER, { forwardedAttachments: [{ messageId: DELETED_MESSAGE_ID, part: '2' }] })).status).toBe(200);
  });
});
