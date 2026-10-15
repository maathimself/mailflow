import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'user-1' }; next(); },
}));
vi.mock('../index.js', () => ({ imapManager: { renameFolder: vi.fn(), broadcast: vi.fn() } }));

import express from 'express';
import mailRoutes from './mail.js';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';

const ACCOUNT_ID = 'c3c3c3c3-3333-4333-8333-c3c3c3c3c3c3';
const OTHER_ACCOUNT_ID = 'e5e5e5e5-5555-4555-8555-e5e5e5e5e5e5';

// The messages and snoozed_messages tables. The fake recognises the rename's
// `UPDATE <table> SET <col> = $4 || substr(...)` statement shape and applies its subtree rewrite
// (the folder itself, or anything under oldPath + delimiter, moves to newPath) to that column,
// so the tests assert on the stored paths. A statement of another shape is not applied.
let tables;

function fakeQuery(rawSql, params = []) {
  const sql = rawSql.replace(/\s+/g, ' ').trim();
  if (sql.includes('FROM email_accounts WHERE id = $1 AND user_id = $2')) {
    return Promise.resolve({ rows: [{ id: ACCOUNT_ID, user_id: 'user-1' }] });
  }
  if (sql.startsWith('SELECT delimiter FROM folders')) return Promise.resolve({ rows: [{ delimiter: '.' }] });
  const rewrite = sql.match(
    /^UPDATE (\w+) SET (\w+) = \$4 \|\| substr\(\2, length\(\$2\) \+ 1\) WHERE account_id = \$1 AND \(\2 = \$2 OR substr\(\2, 1, length\(\$3\)\) = \$3\)$/
  );
  if (rewrite && tables[rewrite[1]]) {
    const [, table, col] = rewrite;
    const [accountId, oldPath, childPrefix, newPath] = params;
    let rowCount = 0;
    for (const row of tables[table]) {
      if (row.account_id === accountId && (row[col] === oldPath || row[col].startsWith(childPrefix))) {
        row[col] = newPath + row[col].slice(oldPath.length);
        rowCount++;
      }
    }
    return Promise.resolve({ rows: [], rowCount });
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
}

// The snooze wakeup finds a due message by joining on m.folder = sm.snoozed_folder, then moves
// it back to sm.original_folder, so both paths have to follow a rename.
describe('POST /api/mail/folders/rename — pending snoozes', () => {
  let server, base;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/mail', mailRoutes);
    await new Promise(r => { server = app.listen(0, r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise(r => server.close(r)); });
  beforeEach(() => {
    query.mockReset();
    query.mockImplementation(fakeQuery);
    imapManager.renameFolder.mockReset();
    imapManager.renameFolder.mockResolvedValue(undefined);
  });

  const rename = (oldPath, newName) => fetch(`${base}/api/mail/folders/rename`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountId: ACCOUNT_ID, oldPath, newName }),
  });

  it('keeps a snooze on its message when the Snoozed folder is renamed', async () => {
    tables = {
      messages: [{ account_id: ACCOUNT_ID, message_id: '<a@example.com>', folder: 'INBOX.Snoozed' }],
      snoozed_messages: [
        { account_id: ACCOUNT_ID, message_id_header: '<a@example.com>', original_folder: 'INBOX', snoozed_folder: 'INBOX.Snoozed' },
      ],
    };
    expect((await rename('INBOX.Snoozed', 'Later')).status).toBe(200);
    expect(tables.messages[0].folder).toBe('INBOX.Later');
    expect(tables.snoozed_messages[0]).toMatchObject({ original_folder: 'INBOX', snoozed_folder: 'INBOX.Later' });
  });

  it('sends snoozed mail back to the renamed folder, including one under it', async () => {
    const snooze = (account_id, original_folder) => ({
      account_id, message_id_header: `<${original_folder}@example.com>`, original_folder, snoozed_folder: 'INBOX.Snoozed',
    });
    tables = {
      messages: [],
      snoozed_messages: [
        snooze(ACCOUNT_ID, 'INBOX.Clients'),
        snooze(ACCOUNT_ID, 'INBOX.Clients.Acme'),
        snooze(ACCOUNT_ID, 'INBOX.ClientsOld'),
        snooze(OTHER_ACCOUNT_ID, 'INBOX.Clients'),
      ],
    };
    expect((await rename('INBOX.Clients', 'Customers')).status).toBe(200);
    expect(tables.snoozed_messages.map(s => s.original_folder)).toEqual([
      'INBOX.Customers', 'INBOX.Customers.Acme', 'INBOX.ClientsOld', 'INBOX.Clients',
    ]);
    expect(tables.snoozed_messages.every(s => s.snoozed_folder === 'INBOX.Snoozed')).toBe(true);
  });
});
