import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const imapManager = vi.hoisted(() => ({
  fetchMessageBody: vi.fn(),
  fetchHeaders: vi.fn(),
  fetchAttachment: vi.fn(),
  fetchMultipleAttachments: vi.fn(),
  noteUserActivity: vi.fn(),
  prefetchFolderBodies: vi.fn(),
  broadcast: vi.fn(),
}));

vi.mock('../services/db.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(callback => callback({ query })),
}));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'user-1' }; next(); },
}));
vi.mock('../index.js', () => ({ imapManager }));

import express from 'express';
import mailRoutes from './mail.js';
import { query } from '../services/db.js';

const ID = '11111111-1111-4111-8111-111111111111';
const account = { id: 'acct-1', user_id: 'user-1' };
const row = {
  id: ID, account_id: account.id, uid: 7, folder: 'INBOX',
  folder_uid_validity: '101', folder_observation_generation: '9',
  read_revision: '3', star_revision: '5',
  subject: 'Subject', body_html: null, body_text: null, snippet: '',
  attachments: [{ part: '2', filename: 'a.txt', type: 'text/plain', size: 1 }],
  preferences: {},
};
const snapshot = {
  id: ID, accountId: account.id, uid: 7, folder: 'INBOX', uidValidity: '101',
  folderGeneration: '9', readRevision: 3, starRevision: 5,
};

describe('mail derived reads use exact non-advancing snapshots', () => {
  let server;
  let base;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/mail', mailRoutes);
    await new Promise(resolve => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
  beforeEach(() => {
    query.mockReset();
    for (const fn of Object.values(imapManager)) fn.mockReset();
  });

  it('binds raw header fetches to the authorized row/folder/UID epoch', async () => {
    query
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [account] })
      .mockResolvedValueOnce({ rows: [row] });
    imapManager.fetchHeaders.mockResolvedValue('Subject: Provider subject\r\n');

    const response = await fetch(`${base}/api/mail/messages/${ID}/headers`);

    expect(response.status).toBe(200);
    expect(imapManager.fetchHeaders).toHaveBeenCalledWith(account, 7, 'INBOX', { snapshot });
    const ownershipSql = query.mock.calls[0][0];
    expect(ownershipSql).toMatch(/folder_uid_validity/);
    expect(ownershipSql).toMatch(/folder_observation_generation/);
  });

  it('binds an attachment fetch to the exact authorized row snapshot', async () => {
    query
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [account] })
      .mockResolvedValueOnce({ rows: [row] });
    imapManager.fetchAttachment.mockResolvedValue(Buffer.from('x'));

    const response = await fetch(`${base}/api/mail/messages/${ID}/attachments/2`);

    expect(response.status).toBe(200);
    expect(imapManager.fetchAttachment).toHaveBeenCalledWith(account, 7, 'INBOX', '2', { snapshot });
  });

  it('does not cache or publish a fetched body after the exact snapshot CAS loses ownership', async () => {
    query.mockImplementation(async sql => {
      if (sql.includes('SELECT m.*, a.user_id, u.preferences')) return { rows: [row] };
      if (sql.includes('SELECT * FROM email_accounts')) return { rows: [account] };
      if (sql.includes('UPDATE messages') && sql.includes('body_html')) return { rowCount: 0, rows: [] };
      return { rows: [] };
    });
    imapManager.fetchMessageBody.mockResolvedValue({ html: null, text: 'stale body', attachments: [] });

    const response = await fetch(`${base}/api/mail/messages/${ID}/body`);

    expect(response.status).toBe(409);
    expect(imapManager.fetchMessageBody).toHaveBeenCalledWith(account, 7, 'INBOX', { snapshot });
    expect(await response.json()).toMatchObject({ code: 'MESSAGE_SNAPSHOT_SUPERSEDED' });
  });

  it.each([
    ['headers', async () => {
      imapManager.fetchHeaders.mockResolvedValue('Subject: stale\r\n');
      return fetch(`${base}/api/mail/messages/${ID}/headers`);
    }],
    ['empty body', async () => {
      imapManager.fetchMessageBody.mockResolvedValue({ html: null, text: null, attachments: [] });
      return fetch(`${base}/api/mail/messages/${ID}/body`);
    }],
    ['attachment', async () => {
      imapManager.fetchAttachment.mockResolvedValue(Buffer.from('stale'));
      return fetch(`${base}/api/mail/messages/${ID}/attachments/2`);
    }],
    ['ZIP attachments', async () => {
      imapManager.fetchMultipleAttachments.mockResolvedValue(new Map([['2', Buffer.from('stale')]]));
      return fetch(`${base}/api/mail/messages/${ID}/attachments.zip`);
    }],
  ])('does not publish %s fetched before the source row relocates', async (_label, request) => {
    query.mockImplementation(async sql => {
      if (sql.includes('SELECT m.*, a.user_id')) return { rows: [row] };
      if (sql.includes('SELECT * FROM email_accounts')) return { rows: [account] };
      if (sql.includes('WITH expected AS')) return { rows: [] };
      return { rows: [] };
    });

    const response = await request();

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'MESSAGE_SNAPSHOT_SUPERSEDED' });
  });
});
