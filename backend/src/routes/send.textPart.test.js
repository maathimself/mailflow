import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: 'u1' }; next(); } }));
vi.mock('../services/redis.js', () => ({ redisClient: { get: vi.fn(async () => null), set: vi.fn(async () => 'OK'), del: vi.fn(async () => 1) } }));
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
import { createAccountSmtpTransport } from '../services/smtpTransport.js';

// The text/plain part of a message written in the rich-text composer. It used to strip the tags
// and keep sanitize-html's escaping: `&lt;` for `<`, paragraphs run together on one line.
const account = { id: 'a1', email_address: 'me@example.com', name: 'Me', oauth_provider: null, signature: null };
const sendMail = vi.fn(async () => ({}));
let server, base;
beforeAll(async () => {
  query.mockImplementation(async sql => ({ rows: sql.includes('FROM email_accounts') ? [account] : [{ preferences: {}, id: 'book1' }] }));
  createAccountSmtpTransport.mockResolvedValue({ account, transport: { sendMail } });
  const app = express();
  app.use(express.json());
  app.use('/api/mail', routes);
  await new Promise(resolve => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise(resolve => server.close(resolve)); });

let key = 0;
async function textOf(fields) {
  sendMail.mockClear();
  const res = await fetch(`${base}/api/mail/send`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': `t${++key}` },
    body: JSON.stringify({ accountId: 'a1', to: ['you@example.com'], subject: 'Test', ...fields }),
  });
  expect(res.status).toBe(200);
  return sendMail.mock.calls[0][0].text;
}

describe('the text part of a rich-text message', () => {
  it('keeps the lines and characters the sender wrote', async () => {
    const text = await textOf({
      bodyIsHtml: true,
      body: '<p>Hi Erin,</p><p></p><p>Fish &amp; chips at 5 &lt;ish&gt;, caf&eacute; &mdash; ok?</p>' +
        '<p>R3.</p><hr><p>On Tue, Erin &lt;erin@example.com&gt; wrote:</p><blockquote><p>&gt; Hello</p></blockquote>',
      editedSignature: '<b>Me</b>&nbsp;| Example &amp; Co',
    });
    expect(text).toBe(
      'Hi Erin,\n\nFish & chips at 5 <ish>, café — ok?\nR3.\n---\nOn Tue, Erin <erin@example.com> wrote:\n> Hello' +
      '\n\n-- \nMe | Example & Co');
  });

  it('leaves a plain-text message as written', async () => {
    expect(await textOf({ body: 'Line one\n\nA & B < C' })).toBe('Line one\n\nA & B < C');
  });
});
