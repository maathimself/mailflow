import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: 'owner' }; next(); } }));
vi.mock('../index.js', () => ({ imapManager: { copyMessage: vi.fn() } }));

import express from 'express';
import routes from './mail.js';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';

const ID = '11111111-1111-4111-8111-111111111111';
const source = { id: ID, account_id: 'account-1', uid: 7, folder: 'INBOX', enabled: true };

describe('POST /mail/messages/:id/copy', () => {
  let server;
  let base;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/mail', routes);
    server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
  beforeEach(() => { query.mockReset(); imapManager.copyMessage.mockReset(); });

  it('copies an owned source to a selectable folder in its account without deleting source', async () => {
    query.mockResolvedValueOnce({ rows: [source] })
      .mockResolvedValueOnce({ rows: [{ path: 'Projects', name: 'Projects', special_use: null }] });
    imapManager.copyMessage.mockResolvedValueOnce(91);
    const response = await fetch(`${base}/mail/messages/${ID}/copy`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ folder: 'Projects' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, uid: 91 });
    expect(imapManager.copyMessage).toHaveBeenCalledWith('account-1', 7, 'INBOX', 'Projects');
    expect(query.mock.calls[0][1]).toContain('owner');
    expect(query.mock.calls[1][1]).toEqual(['account-1', 'Projects']);
    expect(query.mock.calls.some(([sql]) => /^\s*DELETE\s/i.test(sql))).toBe(false);
  });

  it('rejects unowned source and system destinations', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const unowned = await fetch(`${base}/mail/messages/${ID}/copy`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ folder: 'Projects' }),
    });
    expect(unowned.status).toBe(404);
    query.mockResolvedValueOnce({ rows: [source] })
      .mockResolvedValueOnce({ rows: [{ path: 'Trash', name: 'Trash', special_use: '\\Trash' }] });
    const system = await fetch(`${base}/mail/messages/${ID}/copy`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ folder: 'Trash' }),
    });
    expect(system.status).toBe(400);
    expect(imapManager.copyMessage).not.toHaveBeenCalled();
  });

});
