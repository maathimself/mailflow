import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'user-1' }; next(); },
}));
const imapManager = vi.hoisted(() => ({
  appendToFolder: vi.fn(),
  upsertDraftMessageRecord: vi.fn(),
  permanentDeleteMessage: vi.fn(),
  removeMessageCopy: vi.fn(),
}));
vi.mock('../index.js', () => ({ imapManager }));

import express from 'express';
import draftRoutes from './draft.js';
import { query } from '../services/db.js';

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_ROW = {
  id: ACCOUNT_ID, email_address: 'matthias@mailflow.sh', name: 'Matt',
  sender_name: null, signature: null, folder_mappings: {},
};
const DRAFT_HEADERS = {
  'content-type': 'application/json',
  'x-idempotency-key': 'draft-save-1',
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
    imapManager.removeMessageCopy.mockReset();
    // 1) owner check, 2) buildRawDraft account load, 3) resolveDraftsFolder lookup
    query.mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID }] });
    query.mockResolvedValueOnce({ rows: [ACCOUNT_ROW] });
    query.mockResolvedValueOnce({ rows: [{ path: 'Drafts' }] });
    imapManager.appendToFolder.mockImplementation(async (_account, folder, _raw, _flags, options) => {
      await options.materialize({ uid: 5, uidValidity: '202', folder });
      return { uid: 5, uidValidity: '202', folder };
    });
    imapManager.upsertDraftMessageRecord.mockResolvedValue(undefined);
  });

  it('persists a Drafts row with parsed recipient, subject and body after append', async () => {
    const res = await fetch(`${base}/api/mail/draft`, {
      method: 'POST',
      headers: DRAFT_HEADERS,
      body: JSON.stringify({
        accountId: ACCOUNT_ID,
        to: ['Mike Scanlan <mike@scanlan.ai>'],
        cc: [],
        subject: 'Re: MailFlow hero',
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
    expect(meta.subject).toBe('Re: MailFlow hero');
    expect(meta.fromEmail).toBe('matthias@mailflow.sh');
    expect(meta.bodyHtml).toContain('hello mike');
    expect(meta.bodyText).toContain('hello mike');
    expect(meta.messageId).toMatch(/^<[0-9a-f]+@mailflow\.sh>$/);
  });

  it('keeps a provider-applied draft recoverable when local row persistence throws', async () => {
    imapManager.upsertDraftMessageRecord.mockRejectedValueOnce(new Error('db down'));
    const res = await fetch(`${base}/api/mail/draft`, {
      method: 'POST',
      headers: DRAFT_HEADERS,
      body: JSON.stringify({ accountId: ACCOUNT_ID, to: ['a@example.com'], subject: 'x', body: 'y' }),
    });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/db down/i);
    expect(imapManager.permanentDeleteMessage).not.toHaveBeenCalled();
  });

  it('does not persist a row when APPEND remains causally uncertain', async () => {
    imapManager.appendToFolder.mockRejectedValueOnce(
      Object.assign(new Error('marker absent'), { code: 'PROVIDER_MARKER_ABSENT' }),
    );
    const res = await fetch(`${base}/api/mail/draft`, {
      method: 'POST',
      headers: DRAFT_HEADERS,
      body: JSON.stringify({ accountId: ACCOUNT_ID, to: ['a@example.com'], subject: 'x', body: 'y' }),
    });
    expect(res.status).toBe(500);
    expect(imapManager.upsertDraftMessageRecord).not.toHaveBeenCalled();
  });

  it('materializes the new draft inside durable APPEND completion before deleting the old draft', async () => {
    const events = [];
    imapManager.appendToFolder.mockImplementationOnce(async (_account, folder, _raw, _flags, options) => {
      expect(options.operationKey).toMatch(/^draft:user-1:draft-save-1:[a-f0-9]{64}$/);
      expect(options.operationKey).not.toContain('@');
      events.push('append-receipt');
      await options.materialize({ uid: 9, uidValidity: '202', folder });
      events.push('append-completed');
      return { uid: 9, uidValidity: '202', folder };
    });
    imapManager.upsertDraftMessageRecord.mockImplementationOnce(async () => { events.push('row'); });
    imapManager.removeMessageCopy.mockImplementationOnce(async () => { events.push('delete-old'); });
    query.mockResolvedValueOnce({ rows: [{
      id: 'old-row', account_id: ACCOUNT_ID, uid: 4, folder: 'Drafts',
      folder_uid_validity: '101', folder_observation_generation: '3',
    }] });

    const res = await fetch(`${base}/api/mail/draft`, {
      method: 'POST',
      headers: DRAFT_HEADERS,
      body: JSON.stringify({
        accountId: ACCOUNT_ID, to: ['a@example.com'], subject: 'x', body: 'y',
        existingUid: 4, existingFolder: 'Drafts',
      }),
    });

    expect(res.status).toBe(200);
    expect(events).toEqual(['append-receipt', 'row', 'append-completed', 'delete-old']);
  });

  it('accepts legacy headerless saves with unique compatibility identities while preserving client keys', async () => {
    const body = JSON.stringify({ accountId: ACCOUNT_ID, subject: 'same', body: 'same' });
    const keys = [];
    imapManager.appendToFolder.mockImplementation(async (_account, folder, _raw, _flags, options) => {
      keys.push(options.operationKey);
      return { uid: keys.length, uidValidity: '202', folder };
    });
    const missing = await fetch(`${base}/api/mail/draft`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    });
    expect(missing.status).toBe(200);

    for (const key of ['new-draft-1', 'new-draft-2']) {
      query.mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID }] });
      query.mockResolvedValueOnce({ rows: [ACCOUNT_ROW] });
      query.mockResolvedValueOnce({ rows: [{ path: 'Drafts' }] });
      const response = await fetch(`${base}/api/mail/draft`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-idempotency-key': key },
        body,
      });
      expect(response.status).toBe(200);
    }
    expect(keys[0]).toMatch(/^draft:user-1:compat-[0-9a-f-]{36}:[a-f0-9]{64}$/);
    expect(keys[1]).toMatch(/^draft:user-1:new-draft-1:[a-f0-9]{64}$/);
    expect(keys[2]).toMatch(/^draft:user-1:new-draft-2:[a-f0-9]{64}$/);
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[0].split(':').at(-1)).toBe(keys[1].split(':').at(-1));
    expect(keys[1].split(':').at(-1)).toBe(keys[2].split(':').at(-1));
  });

  it('binds a reused client key to payload content so edit-after-failure is a new APPEND', async () => {
    query.mockReset().mockImplementation(async sql => {
      if (sql.includes('SELECT id FROM email_accounts')) return { rows: [{ id: ACCOUNT_ID }] };
      if (sql.includes('SELECT * FROM email_accounts')) return { rows: [ACCOUNT_ROW] };
      if (sql.includes('SELECT path FROM folders')) return { rows: [{ path: 'Drafts' }] };
      return { rows: [] };
    });
    const operationKeys = [];
    imapManager.appendToFolder.mockImplementation(async (_account, folder, _raw, _flags, options) => {
      operationKeys.push(options.operationKey);
      await options.materialize({ uid: operationKeys.length, uidValidity: '202', folder });
      return { uid: operationKeys.length, uidValidity: '202', folder };
    });
    const save = body => fetch(`${base}/api/mail/draft`, {
      method: 'POST', headers: DRAFT_HEADERS,
      body: JSON.stringify({ accountId: ACCOUNT_ID, subject: 'draft', body }),
    });

    expect((await save('first')).status).toBe(200);
    expect((await save('first')).status).toBe(200);
    expect((await save('edited')).status).toBe(200);

    expect(operationKeys[1]).toBe(operationKeys[0]);
    expect(operationKeys[2]).not.toBe(operationKeys[1]);
    const messageIds = imapManager.upsertDraftMessageRecord.mock.calls.map(([, , , meta]) => (
      meta.messageId
    ));
    expect(messageIds[1]).toBe(messageIds[0]);
    expect(messageIds[2]).not.toBe(messageIds[1]);
  });
});
