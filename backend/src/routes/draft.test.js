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
  id: ACCOUNT_ID, email_address: 'matthias@mailflow.sh', name: 'Matt',
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

  it('marks the signature block so reopening can lift it back out (#432)', async () => {
    // Without the marker the signature stays in the body on reopen and compose renders a second
    // one, so every save/reopen cycle added another copy.
    const res = await fetch(`${base}/api/mail/draft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        accountId: ACCOUNT_ID, to: ['mike@scanlan.ai'], cc: [], subject: 's',
        body: 'hello mike', bodyIsHtml: false, editedSignature: '<b>Matt</b>',
      }),
    });
    expect(res.status).toBe(200);
    const [, , , meta] = imapManager.upsertDraftMessageRecord.mock.calls[0];
    expect(meta.bodyHtml).toContain('data-mailflow-signature="1"');
    expect(meta.bodyHtml).toContain('<b>Matt</b>');
    // Exactly one marked block: the splitter refuses to lift an ambiguous draft.
    expect(meta.bodyHtml.match(/data-mailflow-signature/g)).toHaveLength(1);
  });

  it('writes no signature block when the draft has no signature', async () => {
    const res = await fetch(`${base}/api/mail/draft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        accountId: ACCOUNT_ID, to: ['mike@scanlan.ai'], cc: [], subject: 's',
        body: 'hello mike', bodyIsHtml: false, editedSignature: '',
      }),
    });
    expect(res.status).toBe(200);
    const [, , , meta] = imapManager.upsertDraftMessageRecord.mock.calls[0];
    expect(meta.bodyHtml).not.toContain('data-mailflow-signature');
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

describe('POST /api/mail/draft — replacing the previous copy', () => {
  let server, base;
  beforeAll(async () => {
    await new Promise(r => { server = buildApp().listen(0, r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise(r => server.close(r)); });
  const OLD_MESSAGE_ID = '<old-draft@mailflow.sh>';
  // Once the queued answers run out: the old copy's local row, whose Message-ID the delete
  // checks the server copy against.
  const oldCopyRow = async (sql) => ({
    rows: sql.includes('SELECT message_id FROM messages') ? [{ message_id: OLD_MESSAGE_ID }] : [],
  });
  beforeEach(() => {
    query.mockReset();
    imapManager.appendToFolder.mockReset();
    imapManager.upsertDraftMessageRecord.mockReset();
    imapManager.permanentDeleteMessage.mockReset();
    // 1) owner check, 2) buildRawDraft account load, 3) resolveDraftsFolder lookup
    query.mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID }] });
    query.mockResolvedValueOnce({ rows: [ACCOUNT_ROW] });
    query.mockResolvedValueOnce({ rows: [{ path: 'Drafts' }] });
    query.mockImplementation(oldCopyRow);
    imapManager.appendToFolder.mockResolvedValue({ uid: 5, folder: 'Drafts' });
    imapManager.upsertDraftMessageRecord.mockResolvedValue(undefined);
    imapManager.permanentDeleteMessage.mockResolvedValue(true);
  });

  const saveDraft = (extra) => fetch(`${base}/api/mail/draft`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accountId: ACCOUNT_ID, to: ['a@b.com'], subject: 'x', body: 'y', ...extra }),
  });
  const deletedRows = () => query.mock.calls.filter(([sql]) => sql.includes('DELETE FROM messages')).map(([, params]) => params);

  it('replaces the previous copy when it is in the Drafts folder it just saved to', async () => {
    const res = await saveDraft({ existingUid: 4, existingFolder: 'Drafts' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ uid: 5, folder: 'Drafts' });
    expect(imapManager.permanentDeleteMessage).toHaveBeenCalledWith(expect.objectContaining({ id: ACCOUNT_ID }), 4, 'Drafts', { expectMessageId: OLD_MESSAGE_ID });
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining('DELETE FROM messages'), [ACCOUNT_ID, 4, 'Drafts']);
  });

  it('accepts a reopened draft (string BIGINT uid) from another canonical Drafts path', async () => {
    query.mockResolvedValueOnce({ rows: [{ path: 'Drafts' }, { path: 'INBOX.Drafts' }] }); // resolveAllDraftsPaths
    const res = await saveDraft({ existingUid: '12', existingFolder: 'INBOX.Drafts' });
    expect(res.status).toBe(200);
    expect(imapManager.permanentDeleteMessage).toHaveBeenCalledWith(expect.anything(), 12, 'INBOX.Drafts', { expectMessageId: OLD_MESSAGE_ID });
  });

  it('replaces its own previous copy even when the drafts mapping is not a synced folder', async () => {
    // resolveDraftsFolder uses the raw mapping, so the new copy lands in 'Custom'; the canonical
    // set would not include it, and every autosave would otherwise leave a duplicate behind.
    query.mockReset();
    query.mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID }] });
    query.mockResolvedValueOnce({ rows: [{ ...ACCOUNT_ROW, folder_mappings: { drafts: 'Custom' } }] });
    query.mockImplementation(oldCopyRow);
    imapManager.appendToFolder.mockResolvedValue({ uid: 5, folder: 'Custom' });
    const res = await saveDraft({ existingUid: 4, existingFolder: 'Custom' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ uid: 5, folder: 'Custom' });
    expect(imapManager.permanentDeleteMessage).toHaveBeenCalledWith(expect.anything(), 4, 'Custom', { expectMessageId: OLD_MESSAGE_ID });
  });

  // A draft reopened from one account and saved after From was switched to another. Both
  // accounts have a folder called Drafts, so the uid alone passes every other check, and it
  // used to be expunged from the saving account, taking whatever message sat there.
  describe('when the previous copy is in another of the user\'s accounts', () => {
    const OTHER_ID = '22222222-2222-4222-8222-222222222222';
    const OTHER_ROW = { ...ACCOUNT_ROW, id: OTHER_ID, email_address: 'other@mailflow.sh' };

    it('deletes it through the account that holds it', async () => {
      query.mockResolvedValueOnce({ rows: [OTHER_ROW] });           // the old copy's account, owned by this user
      query.mockResolvedValueOnce({ rows: [{ path: 'Drafts' }] });  // its own Drafts folder
      const res = await saveDraft({ existingUid: 7, existingFolder: 'Drafts', existingAccountId: OTHER_ID });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ uid: 5, folder: 'Drafts' });
      expect(query).toHaveBeenCalledWith(expect.stringContaining('FROM email_accounts WHERE id = $1 AND user_id = $2'), [OTHER_ID, 'user-1']);
      expect(query).toHaveBeenCalledWith(expect.stringContaining('SELECT message_id FROM messages'), [OTHER_ID, 7, 'Drafts']);
      expect(imapManager.permanentDeleteMessage).toHaveBeenCalledTimes(1);
      expect(imapManager.permanentDeleteMessage).toHaveBeenCalledWith(expect.objectContaining({ id: OTHER_ID }), 7, 'Drafts', { expectMessageId: OLD_MESSAGE_ID });
      expect(deletedRows()).toEqual([[OTHER_ID, 7, 'Drafts']]);
    });

    it('saves the draft but deletes nothing when that account is not the user\'s', async () => {
      query.mockResolvedValueOnce({ rows: [] }); // ownership check fails
      const res = await saveDraft({ existingUid: 7, existingFolder: 'Drafts', existingAccountId: OTHER_ID });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ uid: 5, folder: 'Drafts' });
      expect(imapManager.appendToFolder).toHaveBeenCalledTimes(1);
      expect(imapManager.permanentDeleteMessage).not.toHaveBeenCalled();
      expect(deletedRows()).toEqual([]);
    });
  });

  it('keeps the local row when the server copy at that uid is not the draft being replaced', async () => {
    imapManager.permanentDeleteMessage.mockResolvedValue(false); // Message-ID did not match
    const res = await saveDraft({ existingUid: 4, existingFolder: 'Drafts' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ uid: 5, folder: 'Drafts' });
    expect(imapManager.permanentDeleteMessage).toHaveBeenCalledWith(expect.anything(), 4, 'Drafts', { expectMessageId: OLD_MESSAGE_ID });
    expect(deletedRows()).toEqual([]);
  });

  it('deletes nothing when the old copy has no local row to check the server copy against', async () => {
    query.mockImplementation(async () => ({ rows: [] }));
    const res = await saveDraft({ existingUid: 4, existingFolder: 'Drafts' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ uid: 5, folder: 'Drafts' });
    expect(imapManager.permanentDeleteMessage).not.toHaveBeenCalled();
    expect(deletedRows()).toEqual([]);
  });

  it('checks the old copy against its own row, not the one the new draft has just written', async () => {
    // A uid is unique only within one UIDVALIDITY, so after a reset the new draft can land on
    // the old copy's uid. Its row then carries the new Message-ID, which the server copy matches.
    let written = null;
    imapManager.appendToFolder.mockResolvedValue({ uid: 4, folder: 'Drafts' });
    imapManager.upsertDraftMessageRecord.mockImplementation(async (_acct, _folder, _uid, meta) => { written = meta.messageId; });
    query.mockImplementation(async (sql) => ({
      rows: sql.includes('SELECT message_id FROM messages') ? [{ message_id: written ?? OLD_MESSAGE_ID }] : [],
    }));
    const res = await saveDraft({ existingUid: 4, existingFolder: 'Drafts' });
    expect(res.status).toBe(200);
    expect(imapManager.permanentDeleteMessage).toHaveBeenCalledWith(expect.anything(), 4, 'Drafts', { expectMessageId: OLD_MESSAGE_ID });
  });

  it('saves the draft but never expunges the old uid from a non-Drafts folder', async () => {
    query.mockResolvedValueOnce({ rows: [{ path: 'Drafts' }] }); // resolveAllDraftsPaths
    query.mockResolvedValueOnce({ rows: [] });                   // not the server's \Drafts folder
    const res = await saveDraft({ existingUid: 4, existingFolder: 'INBOX' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ uid: 5, folder: 'Drafts' });
    expect(imapManager.appendToFolder).toHaveBeenCalledTimes(1);
    expect(imapManager.permanentDeleteMessage).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]) => sql.includes('DELETE FROM messages'))).toBe(false);
  });

  it.each([['1:*'], ['1,2,3'], [[1, 2, 3]], ['4abc'], [-1], [1.5]])('never expunges a uid range or non-integer uid %j', async (existingUid) => {
    const res = await saveDraft({ existingUid, existingFolder: 'Drafts' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ uid: 5, folder: 'Drafts' });
    expect(imapManager.permanentDeleteMessage).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/mail/draft/:uid — Drafts folders only', () => {
  let server, base;
  beforeAll(async () => {
    await new Promise(r => { server = buildApp().listen(0, r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise(r => server.close(r)); });
  beforeEach(() => {
    query.mockReset();
    imapManager.permanentDeleteMessage.mockReset();
    imapManager.permanentDeleteMessage.mockResolvedValue(undefined);
  });

  const del = (qs) => fetch(`${base}/api/mail/draft/9?accountId=${ACCOUNT_ID}&${qs}`, { method: 'DELETE' });

  it('deletes a draft from the Drafts folder', async () => {
    query.mockResolvedValueOnce({ rows: [ACCOUNT_ROW] });          // owner check
    query.mockResolvedValueOnce({ rows: [{ path: 'Drafts' }] });   // resolveDraftsFolder
    query.mockResolvedValueOnce({ rows: [] });                     // DELETE FROM messages
    const res = await del('folder=Drafts');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(imapManager.permanentDeleteMessage).toHaveBeenCalledWith(expect.objectContaining({ id: ACCOUNT_ID }), 9, 'Drafts');
  });

  it('deletes from any canonical Drafts path (e.g. a second drafts-named folder)', async () => {
    query.mockResolvedValueOnce({ rows: [ACCOUNT_ROW] });
    query.mockResolvedValueOnce({ rows: [{ path: 'Drafts' }] });
    query.mockResolvedValueOnce({ rows: [{ path: 'Drafts' }, { path: 'INBOX.Drafts' }] }); // resolveAllDraftsPaths
    query.mockResolvedValueOnce({ rows: [] });
    const res = await del('folder=INBOX.Drafts');
    expect(res.status).toBe(200);
    expect(imapManager.permanentDeleteMessage).toHaveBeenCalledWith(expect.anything(), 9, 'INBOX.Drafts');
  });

  it('refuses to expunge from a non-Drafts folder', async () => {
    query.mockResolvedValueOnce({ rows: [ACCOUNT_ROW] });
    query.mockResolvedValueOnce({ rows: [{ path: 'Drafts' }] });   // resolveDraftsFolder
    query.mockResolvedValueOnce({ rows: [{ path: 'Drafts' }] });   // resolveAllDraftsPaths
    query.mockResolvedValueOnce({ rows: [] });                     // not the server's \Drafts folder
    const res = await del('folder=INBOX');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Folder is not a Drafts folder' });
    expect(imapManager.permanentDeleteMessage).not.toHaveBeenCalled();
  });

  it('refuses a repeated folder param (array) without touching IMAP', async () => {
    query.mockResolvedValueOnce({ rows: [ACCOUNT_ROW] });
    const res = await del('folder=Drafts&folder=INBOX');
    expect(res.status).toBe(400);
    expect(imapManager.permanentDeleteMessage).not.toHaveBeenCalled();
  });

  it('with the drafts mapping pointing elsewhere, still deletes from the server\'s own \\Drafts folder', async () => {
    // The message list opens that folder as Drafts through special_use, so a draft opened there
    // must still be discardable.
    query.mockResolvedValueOnce({ rows: [{ ...ACCOUNT_ROW, folder_mappings: { drafts: 'INBOX.Drafts' } }] });
    query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });   // mappedFolderUsable: usable
    query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });   // special_use \Drafts
    query.mockResolvedValueOnce({ rows: [] });                    // DELETE FROM messages
    const res = await del('folder=Drafts');
    expect(res.status).toBe(200);
    expect(imapManager.permanentDeleteMessage).toHaveBeenCalledWith(expect.anything(), 9, 'Drafts');
  });

  it('with the drafts mapping pointing elsewhere, refuses a folder that is neither mapped nor \\Drafts', async () => {
    query.mockResolvedValueOnce({ rows: [{ ...ACCOUNT_ROW, folder_mappings: { drafts: 'INBOX.Drafts' } }] });
    query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });   // mappedFolderUsable: usable
    query.mockResolvedValueOnce({ rows: [] });                    // not the server's \Drafts folder
    const res = await del('folder=Sent');
    expect(res.status).toBe(400);
    expect(imapManager.permanentDeleteMessage).not.toHaveBeenCalled();
  });
});
