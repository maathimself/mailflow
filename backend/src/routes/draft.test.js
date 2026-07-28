import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import draftRoutes from './draft.js';
import { query } from '../services/db.js';

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_ROW = {
  id: ACCOUNT_ID, email_address: 'matthias@mailflow.sh', name: 'Matt',
  sender_name: null, signature: null, folder_mappings: {},
};

function draftHandler() {
  const layer = draftRoutes.stack.find(item => (
    item.route?.path === '/draft' && item.route.methods.post
  ));
  return layer.route.stack[0].handle;
}

function responseRecorder() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

async function postDraft(body) {
  const req = { body, session: { userId: 'user-1' } };
  const res = responseRecorder();
  await draftHandler()(req, res);
  return res;
}

describe('POST /api/mail/draft — local row persistence', () => {
  beforeEach(() => {
    query.mockReset();
    imapManager.appendToFolder.mockReset();
    imapManager.upsertDraftMessageRecord.mockReset();
    imapManager.permanentDeleteMessage.mockReset();
    // 1) scoped account row, 2) resolveDraftsFolder lookup
    query.mockResolvedValueOnce({ rows: [ACCOUNT_ROW] });
    query.mockResolvedValueOnce({ rows: [{ path: 'Drafts' }] });
    imapManager.appendToFolder.mockResolvedValue({ uid: 5, folder: 'Drafts' });
    imapManager.upsertDraftMessageRecord.mockResolvedValue(undefined);
  });

  it('persists a Drafts row with parsed recipient, subject and body after append', async () => {
    const res = await postDraft({
      accountId: ACCOUNT_ID,
      to: ['Mike Scanlan <mike@scanlan.ai>'],
      cc: [],
      subject: 'Re: MailFlow hero',
      body: 'hello mike',
      bodyIsHtml: false,
      inReplyTo: '<parent@example.com>',
      references: '<root@example.com> <parent@example.com>',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ uid: 5, folder: 'Drafts' });

    expect(imapManager.upsertDraftMessageRecord).toHaveBeenCalledTimes(1);
    const [acct, folder, uid, meta] = imapManager.upsertDraftMessageRecord.mock.calls[0];
    expect(acct.id).toBe(ACCOUNT_ID);
    expect(folder).toBe('Drafts');
    expect(uid).toBe(5);
    expect(meta.to).toEqual([{ name: 'Mike Scanlan', email: 'mike@scanlan.ai' }]);
    expect(meta.subject).toBe('Re: MailFlow hero');
    expect(meta.fromEmail).toBe('matthias@mailflow.sh');
    expect(meta.bodyHtml).toContain('hello mike');
    expect(meta.bodyText).toContain('hello mike');
    expect(meta.inReplyTo).toBe('<parent@example.com>');
    expect(meta.references).toBe('<root@example.com> <parent@example.com>');
    expect(meta.messageId).toMatch(/^<[0-9a-f]+@mailflow\.sh>$/);
  });

  it('still returns success if the local row persistence throws (append already stored it)', async () => {
    imapManager.upsertDraftMessageRecord.mockRejectedValueOnce(new Error('db down'));
    const res = await postDraft({ accountId: ACCOUNT_ID, to: ['a@b.com'], subject: 'x', body: 'y' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ uid: 5, folder: 'Drafts' });
  });

  it('does not persist a row when the append returns no uid (no reliable key)', async () => {
    imapManager.appendToFolder.mockResolvedValueOnce({ uid: null, folder: 'Drafts' });
    const res = await postDraft({ accountId: ACCOUNT_ID, to: ['a@b.com'], subject: 'x', body: 'y' });
    expect(res.statusCode).toBe(200);
    expect(imapManager.upsertDraftMessageRecord).not.toHaveBeenCalled();
  });
});
