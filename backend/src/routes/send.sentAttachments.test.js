import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: 'u1' }; next(); } }));
vi.mock('../services/kvStore.js', () => ({ kv: { get: vi.fn(async () => null), set: vi.fn(async () => 'OK'), del: vi.fn(async () => 1) } }));
vi.mock('../index.js', () => ({
  imapManager: {
    appendToSent: vi.fn(async () => ({ uid: 5 })),
    upsertSentMessageRecord: vi.fn(async () => {}),
    syncFolderOnDemand: vi.fn(async () => {}),
    pluginFacade: {},
  },
}));
vi.mock('../services/smtpTransport.js', () => ({ createAccountSmtpTransport: vi.fn() }));
vi.mock('../utils/mailUtils.js', () => ({ resolveSentFolder: vi.fn(async () => 'Sent') }));
import express from 'express';
import routes from './send.js';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';
import { createAccountSmtpTransport } from '../services/smtpTransport.js';

// The row for a message you sent was recorded without the attachment flag, and sync never set
// it afterwards, so a Sent message with a file attached showed no paperclip.
const account = { id: 'a1', email_address: 'me@example.com', name: 'Me', oauth_provider: null, signature: null };
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
let server, base, n = 0;
beforeAll(async () => {
  query.mockImplementation(async sql => ({ rows: sql.includes('FROM email_accounts') ? [account] : [{ preferences: {}, id: 'book1' }] }));
  createAccountSmtpTransport.mockResolvedValue({ account, transport: { sendMail: vi.fn(async () => ({})) } });
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api/mail', routes);
  await new Promise(resolve => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
beforeEach(() => imapManager.upsertSentMessageRecord.mockClear());

async function sentMeta(fields) {
  const res = await fetch(`${base}/api/mail/send`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': `att${++n}` },
    body: JSON.stringify({ accountId: 'a1', to: ['you@example.com'], subject: 'Hi', body: 'Hello', ...fields }),
  });
  expect(res.status).toBe(200);
  await vi.waitFor(() => expect(imapManager.upsertSentMessageRecord).toHaveBeenCalled());
  return imapManager.upsertSentMessageRecord.mock.calls[0][3];
}

describe('Sent copy attachment flag', () => {
  it('is set for a message sent with a file attached', async () => {
    expect((await sentMeta({ attachments: [{ filename: 'report.pdf', content: PNG, contentType: 'application/pdf' }] })).hasAttachments).toBe(true);
  });

  it('is not set for an image embedded in the body', async () => {
    const meta = await sentMeta({ bodyIsHtml: true, body: `<p>Look</p><img src="data:image/png;base64,${PNG}">` });
    expect(meta.hasAttachments).toBe(false);
  });

  it('is not set for a message with nothing attached', async () => {
    expect((await sentMeta({})).hasAttachments).toBe(false);
  });
});
