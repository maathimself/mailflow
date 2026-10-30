import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'user-1' }; next(); },
}));
vi.mock('../index.js', () => ({
  imapManager: {
    _guardMoveUid: vi.fn(), _unguardMoveUid: vi.fn(), moveMessage: vi.fn(),
    permanentDeleteMessage: vi.fn(), bulkPermanentDelete: vi.fn(), syncFolderOnDemand: vi.fn(),
    broadcast: vi.fn(), scheduleCountRefresh: vi.fn(),
  },
}));

import express from 'express';
import mailRoutes from './mail.js';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';
import { isRowsMessage } from '../services/imapManager.js';

const ACCOUNT_ID = 'a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1';
const MSG_ID = 'b2b2b2b2-2222-4222-8222-b2b2b2b2b2b2';
const OTHER_ID = 'c3c3c3c3-3333-4333-8333-c3c3c3c3c3c3';

// What each server copy carries: its Message-ID, INTERNALDATE, subject and sender.
const mail = (messageId, minute, subject, from = 'sender@example.com') => ({ messageId, internalDate: new Date(Date.UTC(2026, 9, 20, 9, minute)), subject, from });
const MAILS = {
  'MAIL-A': mail('<a@example.com>', 1, 'A'), 'MAIL-OLD': mail('<old@example.com>', 2, 'Old'),
  'MAIL-Y': mail('<y@example.com>', 3, 'Y'), 'MAIL-NOID': mail(null, 4, 'No ID'),
  'MAIL-FIRST': mail('<first@example.com>', 5, 'First'), 'MAIL-SECOND': mail('<second@example.com>', 6, 'Second'),
  'MAIL-FIRST-NOID': mail(null, 7, 'First'), 'MAIL-SECOND-NOID': mail(null, 8, 'Second'),
  // No Message-ID and the same time: only the sender, or nothing, tells them apart.
  'MAIL-FIRST-SAME': mail(null, 10, 'Same', 'first@example.com'), 'MAIL-SECOND-SAME': mail(null, 10, 'Same', 'second@example.com'),
  'MAIL-FIRST-BLANK': mail(null, 10, '', 'first@example.com'), 'MAIL-SECOND-BLANK': mail(null, 10, '', 'second@example.com'),
  'MAIL-TWIN-1': mail(null, 10, 'Same', 'twin@example.com'), 'MAIL-TWIN-2': mail(null, 10, 'Same', 'twin@example.com'),
};
// The identity sync files a server copy's row with: the INTERNALDATE becomes the row's date, and
// an empty subject '(no subject)'.
const synced = (name) => ({
  message_id: MAILS[name].messageId, date: MAILS[name].internalDate,
  subject: MAILS[name].subject || '(no subject)', from_email: MAILS[name].from,
});

// `rows` is the messages table by id and `server` is what the IMAP server holds per folder
// (uid -> mail). The fakes mutate both, so a second request sees what the first one left behind.
let rows, server, uidplus, nextTrashUid;

function reset({ trash = {}, withUidplus = true, folder = 'INBOX' } = {}) {
  rows = new Map([[MSG_ID, { id: MSG_ID, account_id: ACCOUNT_ID, uid: 42, folder, is_read: false, ...synced('MAIL-A') }]]);
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
  if (sql.includes('FROM messages m JOIN email_accounts a') && sql.includes('m.id = ANY($2::uuid[])')) {
    return result(params[1].map(id => rows.get(id)).filter(Boolean).map(r => ({ ...r, user_id: 'user-1', folder_mappings: null })));
  }
  if (sql.includes('FROM messages m JOIN email_accounts a')) {
    const row = rows.get(params[0]);
    return result(row ? [{ ...row, user_id: 'user-1' }] : []);
  }
  if (sql === 'DELETE FROM messages WHERE id = ANY($1::uuid[])') {
    return result([], params[0].filter(id => rows.delete(id)).length);
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
  // As the real ones: with an expected row, a uid whose server copy is another message (by the
  // real isRowsMessage) is left alone, as is one whose row has no Message-ID and also matches
  // another message in the folder. A uid nothing holds counts as deleted.
  const copyOf = (name) => ({
    envelope: { messageId: MAILS[name].messageId, subject: MAILS[name].subject, from: [{ address: MAILS[name].from }] },
    internalDate: MAILS[name].internalDate,
  });
  const hasNoMessageId = (row) => !String(row.message_id ?? '').replace(/[<>]/g, '').trim();
  const isOther = (folder, uid, row) => {
    const name = server[folder].get(Number(uid));
    if (!name) return false;
    if (!isRowsMessage(row, copyOf(name))) return true;
    return hasNoMessageId(row) && [...server[folder]].some(([u, other]) => u !== Number(uid) && isRowsMessage(row, copyOf(other)));
  };
  imapManager.permanentDeleteMessage.mockImplementation(async (_account, uid, folder, { expectMessageId, expectRow } = {}) => {
    const expected = expectRow ?? (expectMessageId === undefined ? undefined : { message_id: expectMessageId });
    if (expected && isOther(folder, uid, expected)) return false;
    server[folder].delete(Number(uid));
    return true;
  });
  imapManager.bulkPermanentDelete.mockImplementation(async (_account, uids, folder, { expectRows } = {}) => {
    const mismatched = expectRows ? uids.filter(uid => isOther(folder, uid, expectRows.get(Number(uid)))) : [];
    const succeeded = uids.filter(uid => !mismatched.includes(uid));
    for (const uid of succeeded) server[folder].delete(Number(uid));
    return { succeeded, failed: [], mismatched };
  });
  imapManager.syncFolderOnDemand.mockResolvedValue(undefined);
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
    expect(imapManager.permanentDeleteMessage.mock.calls.map(c => c.slice(1)))
      .toEqual([[900, 'Trash', { expectRow: expect.objectContaining({ message_id: '<a@example.com>', subject: 'A' }) }]]);
    expect(rows.size).toBe(0);
  });

  // Without UIDPLUS, and with the moved message not found in Trash afterwards, the row is dropped:
  // its INBOX uid can belong to another message in Trash (#665).
  it('without UIDPLUS, a delete whose new uid is not known drops the row and pulls Trash, rather than keep its source uid', async () => {
    reset({ trash: { 42: 'MAIL-OLD' }, withUidplus: false });
    expect(await del()).toBe(200);
    expect(rows.size).toBe(0);
    expect(server.Trash.get(900)).toBe('MAIL-A');
    expect(imapManager.syncFolderOnDemand).toHaveBeenCalledWith(expect.objectContaining({ id: ACCOUNT_ID }), 'Trash');
    expect(countDeltas('INBOX')).toEqual([-1]);
    expect(countDeltas('Trash')).toEqual([]);
  });

  // Before that, such a row kept its INBOX uid, and in Trash that uid can belong to another
  // message. Sync never corrects a row whose uid is taken that way, so rows left like this remain.
  const staleTrashRow = (name, uid) => ({ id: randomUUID(), account_id: ACCOUNT_ID, uid, folder: 'Trash', is_read: true, ...synced(name) });

  it('deleting a Trash row left on a stale uid does not expunge the message holding that uid', async () => {
    reset({ trash: { 42: 'MAIL-OLD', 900: 'MAIL-A' } });
    const trashed = staleTrashRow('MAIL-A', 42);
    rows = new Map([[trashed.id, trashed]]);

    expect(await del(trashed.id)).toBe(409);
    expect(server.Trash.get(42)).toBe('MAIL-OLD');
    expect(server.Trash.get(900)).toBe('MAIL-A');
    // The row that named the wrong message is dropped and Trash pulled, so a sync files what the
    // server holds at those uids.
    expect(rows.has(trashed.id)).toBe(false);
    expect(imapManager.syncFolderOnDemand).toHaveBeenCalledWith(expect.objectContaining({ id: ACCOUNT_ID }), 'Trash');
  });

  it.each([
    ['both carry a Message-ID', 'MAIL-FIRST', 'MAIL-SECOND'],
    ['only Second carries one', 'MAIL-FIRST-NOID', 'MAIL-SECOND'],
    ['neither carries one', 'MAIL-FIRST-NOID', 'MAIL-SECOND-NOID'],
    ['neither carries one, and only their senders differ', 'MAIL-FIRST-SAME', 'MAIL-SECOND-SAME'],
    ['neither carries one nor a subject, and their senders differ', 'MAIL-FIRST-BLANK', 'MAIL-SECOND-BLANK'],
    ['neither carries one, and nothing else differs', 'MAIL-TWIN-1', 'MAIL-TWIN-2'],
  ])('two Trash rows left on swapped stale uids do not make Delete forever expunge the other message: %s', async (_case, firstMail, secondMail) => {
    // As two deletes without UIDPLUS left them: on the server Trash is {10: First, 11: Second};
    // the rows say {10: Second, 11: First}.
    reset({ trash: { 10: firstMail, 11: secondMail } });
    const first = staleTrashRow(firstMail, 11);
    const second = staleTrashRow(secondMail, 10);
    rows = new Map([[first.id, first], [second.id, second]]);

    expect(await del(first.id)).toBe(409);
    expect([...server.Trash]).toEqual([[10, firstMail], [11, secondMail]]);
  });

  it.each([[null], ['<>']])('permanently deletes a Trash row with Message-ID %j whose server copy has none and the same INTERNALDATE, sender and subject', async (messageId) => {
    reset({ folder: 'Trash' });
    Object.assign(rows.get(MSG_ID), synced('MAIL-NOID'), { message_id: messageId });
    server.Trash.set(42, 'MAIL-NOID');
    expect(await del()).toBe(200);
    expect(server.Trash.has(42)).toBe(false);
    expect(rows.size).toBe(0);
  });

  const bulkDelete = (ids) => fetch(`${base}/api/mail/messages/bulk-delete`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }),
  });

  it('bulk delete from Trash expunges only the rows whose server copy is their message', async () => {
    reset({ trash: { 42: 'MAIL-OLD', 900: 'MAIL-A', 7: 'MAIL-Y', 8: 'MAIL-NOID' } });
    const trashed = staleTrashRow('MAIL-A', 42);
    rows = new Map([[trashed.id, trashed]]);
    rows.set(OTHER_ID, { id: OTHER_ID, account_id: ACCOUNT_ID, uid: 7, folder: 'Trash', is_read: true, ...synced('MAIL-Y') });
    const NOID_ID = randomUUID();
    rows.set(NOID_ID, { id: NOID_ID, account_id: ACCOUNT_ID, uid: 8, folder: 'Trash', is_read: true, ...synced('MAIL-NOID') });

    const res = await bulkDelete([trashed.id, OTHER_ID, NOID_ID]);
    expect(res.status).toBe(200);
    expect((await res.json()).deleted).toEqual([OTHER_ID, NOID_ID]);
    expect(server.Trash.get(42)).toBe('MAIL-OLD');
    expect(server.Trash.get(900)).toBe('MAIL-A');
    expect(server.Trash.has(7)).toBe(false);
    expect(server.Trash.has(8)).toBe(false);
    expect(rows.size).toBe(0);
    expect(imapManager.syncFolderOnDemand).toHaveBeenCalledWith(expect.objectContaining({ id: ACCOUNT_ID }), 'Trash');
  });

  it('bulk delete from Trash leaves a row with no Message-ID whose stale uid holds a message that has one', async () => {
    reset({ trash: { 42: 'MAIL-OLD', 900: 'MAIL-NOID' } });
    const trashed = staleTrashRow('MAIL-NOID', 42);
    rows = new Map([[trashed.id, trashed]]);
    expect(trashed).toMatchObject({ message_id: null });

    const res = await bulkDelete([trashed.id]);
    expect(res.status).toBe(200);
    expect((await res.json()).deleted).toEqual([]);
    expect(server.Trash.get(42)).toBe('MAIL-OLD');
    expect(server.Trash.get(900)).toBe('MAIL-NOID');
    expect(rows.size).toBe(0);
  });

  it('permanently deletes a Drafts row, checking that its server copy is its message', async () => {
    reset({ folder: 'Drafts' });
    expect(await del()).toBe(200);
    expect(server.Drafts.has(42)).toBe(false);
    expect(rows.size).toBe(0);
    expect(imapManager.permanentDeleteMessage.mock.calls.map(c => c.slice(1)))
      .toEqual([[42, 'Drafts', { expectRow: expect.objectContaining({ id: MSG_ID, message_id: '<a@example.com>' }) }]]);
  });

  it('does not expunge the uid of a Drafts row when another message holds it', async () => {
    reset({ folder: 'Drafts' });
    server.Drafts.set(42, 'MAIL-OLD');
    expect(await del()).toBe(409);
    expect(server.Drafts.get(42)).toBe('MAIL-OLD');
    // As in Trash: the row is dropped and the folder pulled, so a sync files what the uid holds.
    expect(rows.size).toBe(0);
    expect(imapManager.syncFolderOnDemand).toHaveBeenCalledWith(expect.objectContaining({ id: ACCOUNT_ID }), 'Drafts');
  });

  it('without UIDPLUS, a repeated DELETE does not expunge whatever holds the stale uid in Trash', async () => {
    reset({ trash: { 42: 'MAIL-OLD' }, withUidplus: false });
    expect(await del()).toBe(200);
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
