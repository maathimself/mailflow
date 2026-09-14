import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'user-1' }; next(); },
}));
const imapManager = vi.hoisted(() => ({
  appendToFolder: vi.fn(),
  upsertDraftMessageRecord: vi.fn(),
  permanentDeleteMessage: vi.fn(),
}));
vi.mock('../index.js', () => ({ imapManager }));

import express from 'express';
import draftRoutes from './draft.js';
import { query } from '../services/db.js';

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_ROW = {
  id: ACCOUNT_ID, email_address: 'matthias@mailexpert.test', name: 'Matt',
  sender_name: null, signature: null, folder_mappings: {},
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/mail', draftRoutes);
  return app;
}

describe('POST /api/mail/draft — local row persistence', () => {
  let server, base;
  beforeAll(async () => {
    await new Promise(r => { server = buildApp().listen(0, r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise(r => server.close(r)); });
  beforeEach(() => {
    query.mockReset();
    imapManager.appendToFolder.mockReset();
    imapManager.upsertDraftMessageRecord.mockReset();
    imapManager.permanentDeleteMessage.mockReset();
    // 1) owner check, 2) buildRawDraft account load, 3) resolveDraftsFolder lookup
    query.mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID }] });
    query.mockResolvedValueOnce({ rows: [ACCOUNT_ROW] });
    query.mockResolvedValueOnce({ rows: [{ path: 'Drafts' }] });
    imapManager.appendToFolder.mockResolvedValue({ uid: 5, folder: 'Drafts' });
    imapManager.upsertDraftMessageRecord.mockResolvedValue(undefined);
  });

  it('persists a Drafts row with parsed recipient, subject and body after append', async () => {
    const res = await fetch(`${base}/api/mail/draft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        accountId: ACCOUNT_ID,
        to: ['Mike Scanlan <mike@scanlan.ai>'],
        cc: [],
        subject: 'Re: MailExpert hero',
        body: 'hello mike',
        bodyIsHtml: false,
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ uid: 5, folder: 'Drafts' });

    expect(imapManager.upsertDraftMessageRecord).toHaveBeenCalledTimes(1);
    const [acct, folder, uid, meta] = imapManager.upsertDraftMessageRecord.mock.calls[0];
    expect(acct.id).toBe(ACCOUNT_ID);
    expect(folder).toBe('Drafts');
    expect(uid).toBe(5);
    expect(meta.to).toEqual([{ name: 'Mike Scanlan', email: 'mike@scanlan.ai' }]);
    expect(meta.subject).toBe('Re: MailExpert hero');
    expect(meta.fromEmail).toBe('matthias@mailexpert.test');
    expect(meta.bodyHtml).toContain('hello mike');
    expect(meta.bodyText).toContain('hello mike');
    expect(meta.messageId).toMatch(/^<[0-9a-f]+@mailexpert\.test>$/);
  });

  it('still returns success if the local row persistence throws (append already stored it)', async () => {
    imapManager.upsertDraftMessageRecord.mockRejectedValueOnce(new Error('db down'));
    const res = await fetch(`${base}/api/mail/draft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: ACCOUNT_ID, to: ['a@b.com'], subject: 'x', body: 'y' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ uid: 5, folder: 'Drafts' });
  });

  it('does not persist a row when the append returns no uid (no reliable key)', async () => {
    imapManager.appendToFolder.mockResolvedValueOnce({ uid: null, folder: 'Drafts' });
    const res = await fetch(`${base}/api/mail/draft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: ACCOUNT_ID, to: ['a@b.com'], subject: 'x', body: 'y' }),
    });
    expect(res.status).toBe(200);
    expect(imapManager.upsertDraftMessageRecord).not.toHaveBeenCalled();
  });
});

describe('POST /api/mail/draft — signature wrapper (#432)', () => {
  let server, base;
  beforeAll(async () => {
    await new Promise(r => { server = buildApp().listen(0, r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise(r => server.close(r)); });
  beforeEach(() => {
    query.mockReset();
    imapManager.appendToFolder.mockReset();
    imapManager.upsertDraftMessageRecord.mockReset();
    // 1) owner check, 2) buildRawDraft account load (with a signature), 3) Drafts folder lookup
    query.mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID }] });
    query.mockResolvedValueOnce({ rows: [{ ...ACCOUNT_ROW, signature: '<b>Sig</b>' }] });
    query.mockResolvedValueOnce({ rows: [{ path: 'Drafts' }] });
    imapManager.appendToFolder.mockResolvedValue({ uid: 7, folder: 'Drafts' });
    imapManager.upsertDraftMessageRecord.mockResolvedValue(undefined);
  });

  const save = async (extra) => {
    const res = await fetch(`${base}/api/mail/draft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: ACCOUNT_ID, to: ['a@b.com'], subject: 'x', body: '<p>hello</p>', bodyIsHtml: true, ...extra }),
    });
    expect(res.status).toBe(200);
    return imapManager.upsertDraftMessageRecord.mock.calls[0][3];
  };

  it('stores the account signature once inside a marked wrapper', async () => {
    const meta = await save({});
    expect(meta.bodyHtml.match(/class="mailexpert-signature"/g)).toHaveLength(1);
    expect(meta.bodyHtml).toContain(
      '<div class="mailexpert-signature" style="margin-top:16px;color:#555;font-size:13px"><b>Sig</b></div>'
    );
    expect(meta.bodyText.match(/\n\n-- \nSig/g)).toHaveLength(1);
  });

  it('keeps ampersands and angle brackets unescaped in the draft text part', async () => {
    const meta = await save({ body: '<p>R&amp;D a &lt; b</p>', editedSignature: '<b>R&amp;D &lt;team&gt;</b>' });
    expect(meta.bodyText).toBe('R&D a < b\n\n-- \nR&D <team>');
    // The appended MIME's text/plain part (the HTML part legitimately keeps &amp;).
    const raw = imapManager.appendToFolder.mock.calls[0][2].toString();
    const textPart = raw.split('Content-Type: text/plain')[1].split('----_')[0];
    expect(textPart).toContain('R&D a < b');
    expect(textPart).not.toContain('&amp;');
  });

  it('uses the edited signature inside the wrapper', async () => {
    const meta = await save({ editedSignature: '<i>Edited</i>' });
    expect(meta.bodyHtml).toContain('<div class="mailexpert-signature" style="margin-top:16px;color:#555;font-size:13px"><i>Edited</i></div>');
    expect(meta.bodyHtml).not.toContain('<b>Sig</b>');
  });

  it('writes no wrapper when the edited signature is empty', async () => {
    const meta = await save({ editedSignature: '' });
    expect(meta.bodyHtml).not.toContain('mailexpert-signature');
    expect(meta.bodyText).not.toContain('-- \n');
  });
});
