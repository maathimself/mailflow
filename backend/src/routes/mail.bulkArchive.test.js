import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: 'owner' }; next(); } }));
vi.mock('../index.js', () => ({ imapManager: {
  _guardMoveUid: vi.fn(), _unguardMoveUid: vi.fn(), bulkMoveMessages: vi.fn(), broadcast: vi.fn(),
} }));
vi.mock('../utils/mailUtils.js', async importOriginal => ({
  ...await importOriginal(),
  resolveArchiveFolder: vi.fn(async () => '[Gmail]/All Mail'),
  adjustFolderCounts: vi.fn(),
}));

import express from 'express';
import routes from './mail.js';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';
import { adjustFolderCounts } from '../utils/mailUtils.js';

const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
const owned = ids.map((id, index) => ({
  id, account_id: 'account-1', uid: index + 7, folder: 'INBOX', is_read: false,
  folder_mappings: {}, message_id: `<m${index}>`,
}));

describe('POST /mail/messages/bulk-archive cached counts', () => {
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
  beforeEach(() => {
    query.mockReset();
    adjustFolderCounts.mockReset();
    imapManager.bulkMoveMessages.mockReset();
  });

  it('increments All Mail only for new rows when an indexed Gmail copy already exists', async () => {
    query.mockImplementation(async sql => {
      if (sql.includes('SELECT m.*, a.user_id')) return { rows: owned };
      if (sql.includes('SELECT * FROM email_accounts')) return { rows: [{ id: 'account-1' }] };
      if (sql.includes('WITH deleted AS')) return { rows: [{ account_id: 'account-1', uid: 202 }] };
      return { rows: [] };
    });
    imapManager.bulkMoveMessages.mockResolvedValue({
      uidMap: new Map([[7, 201], [8, 202]]), succeeded: [7, 8], failed: [],
    });
    const response = await fetch(`${base}/mail/messages/bulk-archive`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).archived).toEqual(ids);
    expect(adjustFolderCounts).toHaveBeenCalledWith('account-1', 'INBOX', -2, -2);
    expect(adjustFolderCounts).toHaveBeenCalledWith('account-1', '[Gmail]/All Mail', 1, 1);
    expect(query.mock.calls.find(([sql]) => sql.includes('WITH deleted AS'))[0]).toContain('RETURNING account_id, uid');
  });
});
