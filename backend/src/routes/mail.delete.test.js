import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'user-1' }; next(); },
}));
vi.mock('../index.js', () => ({
  imapManager: {
    _guardMoveUid: vi.fn(), _unguardMoveUid: vi.fn(), moveMessage: vi.fn(),
    permanentDeleteMessage: vi.fn(), broadcast: vi.fn(), scheduleCountRefresh: vi.fn(),
  },
}));

import express from 'express';
import mailRoutes from './mail.js';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';

const ACCOUNT_ID = 'a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1';
const MSG_ID = 'b2b2b2b2-2222-4222-8222-b2b2b2b2b2b2';

// `rows` is the messages table by id and `server` is what the IMAP server holds per folder
// (uid -> mail). The fakes mutate both, so a second request sees what the first one left behind.
let rows, server, uidplus, nextTrashUid;

function reset({ trash = {}, withUidplus = true, folder = 'INBOX' } = {}) {
  rows = new Map([[MSG_ID, { id: MSG_ID, account_id: ACCOUNT_ID, uid: 42, folder, is_read: false, message_id: '<a@example.com>' }]]);
  server = { [folder]: new Map([[42, 'MAIL-A']]), Trash: new Map(Object.entries(trash).map(([u, m]) => [Number(u), m])) };
  uidplus = withUidplus;
  nextTrashUid = 900;
}

// The account's folders as syncFolders stores them. Trash and Drafts lookups are answered by
// evaluating each query against them, as Postgres would.
const folderRow = (path, special_use = null) => ({ path, name: path.split('/').pop(), delimiter: '/', special_use });
const FOLDERS = [
  folderRow('INBOX'), folderRow('Trash', '\\Trash'), folderRow('Drafts', '\\Drafts'),
  folderRow('Blog drafts'), folderRow('Deleted clients'), folderRow('Clients/Drafts'), folderRow('Old Account/Trash'),
];

// The same evaluator as mailUtils.test.js: it knows only the conditions the Trash and Drafts
// resolvers use, before and after this change, and throws on anything else.
const FOLDER_CONDITIONS = [
  [/special_use = '(\\\w+)'/y, ([, flag]) => f => f.special_use === flag],
  [/lower\(name\) LIKE '%(\w+)%'/y, ([, word]) => f => f.name.toLowerCase().includes(word)],
  [/lower\(name\) IN \(([^)]*)\)/y, ([, list]) => f => list.split(', ').includes(`'${f.name.toLowerCase()}'`)],
  [/path = name/y, () => f => f.path === f.name],
  [/upper\(path\) = \('INBOX' \|\| delimiter \|\| upper\(name\)\)/y,
    () => f => f.delimiter !== null && f.path.toUpperCase() === `INBOX${f.delimiter}${f.name}`.toUpperCase()],
];

// SQL's AND binds tighter than its OR, as JS's && does ||.
function folderCondition(text) {
  let at = 0;
  const take = (re) => { re.lastIndex = at; const m = re.exec(text); if (m) at = re.lastIndex; return m; };
  const fail = () => { throw new Error(`unrecognised condition at "${text.slice(at)}" in: ${text}`); };
  const term = () => {
    if (take(/\(/y)) { const inner = anyOf(); return take(/\)/y) ? inner : fail(); }
    for (const [re, build] of FOLDER_CONDITIONS) { const m = take(re); if (m) return build(m); }
    return fail();
  };
  const allOf = () => { let t = term(); while (take(/ AND /y)) { const [a, b] = [t, term()]; t = f => a(f) && b(f); } return t; };
  const anyOf = () => { let t = allOf(); while (take(/ OR /y)) { const [a, b] = [t, allOf()]; t = f => a(f) || b(f); } return t; };
  const test = anyOf();
  return at === text.length ? test : fail();
}

function selectFolders(rawSql, folders) {
  const sql = rawSql.replace(/\s+/g, ' ').trim();
  const [, where, first, limit] = sql.match(
    /^SELECT path FROM folders WHERE account_id = \$1 AND (.+?)(?: ORDER BY \(CASE WHEN (.+) THEN 0 ELSE 1 END\))?(?: LIMIT (\d+))?$/
  ) ?? [];
  if (!where) throw new Error(`unrecognised query: ${sql}`);
  let rows = folders.filter(folderCondition(where));
  if (first) {
    const isFirst = folderCondition(first);
    rows = [...rows.filter(isFirst), ...rows.filter(f => !isFirst(f))];
  }
  return rows.slice(0, limit ? Number(limit) : undefined).map(({ path }) => ({ path }));
}

function fakeQuery(rawSql, params = []) {
  const sql = rawSql.replace(/\s+/g, ' ').trim();
  const result = (r, rowCount = r.length) => Promise.resolve({ rows: r, rowCount });
  if (sql.includes('FROM messages m JOIN email_accounts a')) {
    const row = rows.get(params[0]);
    return result(row ? [{ ...row, user_id: 'user-1' }] : []);
  }
  if (sql.startsWith('SELECT * FROM email_accounts')) return result([{ id: ACCOUNT_ID, user_id: 'user-1', folder_mappings: null }]);
  if (sql.startsWith('SELECT path FROM folders')) return result(selectFolders(sql, FOLDERS));
  if (sql.startsWith('DELETE FROM messages WHERE account_id = $1 AND uid = $2 AND folder = $3 AND id != $4')) {
    for (const [id, r] of [...rows]) if (r.uid === params[1] && r.folder === params[2] && id !== params[3]) rows.delete(id);
    return result([]);
  }
  if (sql === 'DELETE FROM messages WHERE id = $1') return result([], rows.delete(params[0]) ? 1 : 0);
  // Any "UPDATE messages SET a = $n, ... WHERE id = $m", so the tests pin behaviour rather than SQL text.
  const update = sql.match(/^UPDATE messages SET (.+) WHERE id = \$(\d+)$/);
  if (update) {
    const row = rows.get(params[Number(update[2]) - 1]);
    if (!row) return result([], 0);
    const next = { ...row };
    for (const assignment of update[1].split(',')) {
      const [col, value] = assignment.split('=').map(s => s.trim());
      next[col] = /^(DEFAULT|gen_random_uuid\(\))$/.test(value) ? randomUUID() : params[Number(value.slice(1)) - 1];
    }
    rows.delete(row.id);
    rows.set(next.id, next);
    return result([], 1);
  }
  return result([]);
}

function wireImap() {
  // A UID MOVE naming a UID that is no longer there is a tagged OK with no COPYUID, which
  // moveMessage reports exactly like a server without UIDPLUS: null.
  imapManager.moveMessage.mockImplementation(async (_account, uid, from, to) => {
    if (!server[from].has(uid)) return null;
    const newUid = nextTrashUid++;
    server[to].set(newUid, server[from].get(uid));
    server[from].delete(uid);
    return uidplus ? newUid : null;
  });
  imapManager.permanentDeleteMessage.mockImplementation(async (_account, uid, folder) => { server[folder].delete(uid); });
}

const trashRow = () => [...rows.values()].find(r => r.folder === 'Trash');
// adjustFolderCounts is fire-and-forget; its params are [totalDelta, unreadDelta, accountId, path].
const countDeltas = (path) => query.mock.calls
  .filter(([sql, p]) => sql.includes('UPDATE folders f') && p?.[3] === path)
  .map(([, p]) => p[0]);

describe('DELETE /api/mail/messages/:id', () => {
  let srv, base;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/mail', mailRoutes);
    await new Promise(r => { srv = app.listen(0, r); });
    base = `http://127.0.0.1:${srv.address().port}`;
  });
  afterAll(async () => { await new Promise(r => srv.close(r)); });
  beforeEach(() => {
    query.mockReset();
    query.mockImplementation(fakeQuery);
    for (const fn of Object.values(imapManager)) fn.mockReset();
    wireImap();
  });

  const del = async (id = MSG_ID) => (await fetch(`${base}/api/mail/messages/${id}`, { method: 'DELETE' })).status;

  it('a repeated DELETE does not expunge the message it moved to Trash', async () => {
    reset();
    expect(await del()).toBe(200);
    const trashed = trashRow();
    expect(trashed).toMatchObject({ uid: 900 });

    expect(await del()).toBe(404);
    expect(imapManager.permanentDeleteMessage).not.toHaveBeenCalled();
    expect(server.Trash.get(900)).toBe('MAIL-A');
    expect(trashed.id).not.toBe(MSG_ID);

    // Deleting it from the Trash view, by the id the Trash listing shows, is still permanent.
    expect(await del(trashed.id)).toBe(200);
    expect(imapManager.permanentDeleteMessage.mock.calls.map(c => c.slice(1))).toEqual([[900, 'Trash']]);
    expect(rows.size).toBe(0);
  });

  it('without UIDPLUS, a repeated DELETE does not expunge whatever holds the stale uid in Trash', async () => {
    reset({ trash: { 42: 'MAIL-OLD' }, withUidplus: false });
    expect(await del()).toBe(200);
    expect(trashRow()).toMatchObject({ uid: 42 }); // stale until the next Trash sync
    expect(await del()).toBe(404);
    expect(imapManager.permanentDeleteMessage).not.toHaveBeenCalled();
    expect(server.Trash.get(42)).toBe('MAIL-OLD');
    expect(server.Trash.get(900)).toBe('MAIL-A');
  });

  it('refuses a second DELETE of the same message while the first is in flight', async () => {
    reset();
    let release;
    const gate = new Promise(r => { release = r; });
    const move = imapManager.moveMessage.getMockImplementation();
    imapManager.moveMessage.mockImplementation(async (...args) => { await gate; return move(...args); });

    const first = del();
    await vi.waitFor(() => expect(imapManager.moveMessage).toHaveBeenCalledTimes(1));
    const second = del();
    const secondWhileParked = await Promise.race([second, new Promise(r => setTimeout(() => r('still waiting on IMAP'), 200))]);
    release();
    const [firstStatus] = await Promise.all([first, second]);

    expect(secondWhileParked).toBe(409);
    expect(firstStatus).toBe(200);
    expect(imapManager.moveMessage).toHaveBeenCalledTimes(1);
    expect(trashRow()).toMatchObject({ uid: 900 });
    expect(countDeltas('INBOX')).toEqual([-1]);
    expect(countDeltas('Trash')).toEqual([1]);
  });

  it('releases the in-flight guard when the move fails, so a retry goes through', async () => {
    reset();
    imapManager.moveMessage.mockRejectedValueOnce(new Error('connection lost'));
    expect(await del()).toBe(500);
    expect([...rows.values()]).toEqual([expect.objectContaining({ id: MSG_ID, folder: 'INBOX', uid: 42 })]);
    expect(await del()).toBe(200);
    expect(server.Trash.get(900)).toBe('MAIL-A');
  });

  it.each(['Blog drafts', 'Deleted clients', 'Clients/Drafts', 'Old Account/Trash'])('moves mail in the user folder %j to Trash instead of expunging it', async (folder) => {
    reset({ folder });
    expect(await del()).toBe(200);
    expect(imapManager.permanentDeleteMessage).not.toHaveBeenCalled();
    expect(server[folder].size).toBe(0);
    expect(server.Trash.get(900)).toBe('MAIL-A');
    expect(trashRow()).toMatchObject({ uid: 900 });
  });
});
