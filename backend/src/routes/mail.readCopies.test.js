import 'express-async-errors';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
vi.mock('imapflow', () => ({ ImapFlow: vi.fn() }));
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: 'reader' }; next(); } }));
vi.mock('../plugins/registry.js', () => ({ pluginRegistry: { hasActiveAsync: vi.fn(), collectHook: vi.fn(), runHook: vi.fn() } }));
vi.mock('../index.js', () => ({ imapManager: {} }));
vi.mock('../services/aiProvider.js', () => ({ getAiStatus: vi.fn(), completeText: vi.fn() }));
vi.mock('../services/encryption.js', () => ({ decrypt: () => 'test-password', encrypt: () => 'enc' }));
vi.mock('../services/hostValidation.js', () => ({ resolveForConnection: vi.fn(async () => ({ host: '127.0.0.1', servername: null })), createPinnedLookup: vi.fn() }));
vi.mock('../services/connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn(async () => ({ allowPrivateHosts: true, allowInsecureTls: true })) }));
vi.mock('./oauth.js', () => ({ refreshMicrosoftToken: vi.fn(), refreshGoogleToken: vi.fn() }));
vi.mock('../plugins/gtd/gtdConfig.js', async importOriginal => ({ ...(await importOriginal()), getGtdConfig: vi.fn(async () => ({ enabled: true, folders: { watch: 'Watch', todo: 'Todo' } })) }));
import express from 'express';
import gtdRoutes from '../plugins/gtd/routes.js';
import { setMailEngine } from '../plugins/mailEngine.js';
import mailRoutes from './mail.js';
import { imapManager } from '../index.js';
import { ImapManager } from '../services/imapManager.js';
import { markThreadRead } from '../services/labels.js';
import { ImapFlow } from 'imapflow';
import { query } from '../services/db.js';
import { pluginRegistry } from '../plugins/registry.js';
const A = 'a0000000-0000-4000-8000-000000000001', B = 'b0000000-0000-4000-8000-000000000002', C = 'c0000000-0000-4000-8000-000000000003';
const MID = '<copy@example.test>';
let account, rows, wire, hold, releaseHold, gtd, labels, failFolder, selectionError, selectionChange, selectionHold, releaseSelection, otherAccounts, events, serial = 0;
class Mailbox extends EventEmitter {
  constructor() { super(); this.usable = true; this.capabilities = new Set(['MOVE', 'UIDPLUS']); }
  async connect() {}
  close() { this.usable = false; }
  async logout() { this.close(); }
  async noop() { return true; }
  async getMailboxLock(folder) { this.mailbox = { path: folder, exists: 3 }; return { release() {} }; }
  async messageFlagsAdd(uid, flags, options) { return this.store(uid, flags, options, true); }
  async messageFlagsRemove(uid, flags, options) { return this.store(uid, flags, options, false); }
  async store(uid, flags, options, value) {
    const folder = this.mailbox.path;
    expect(options).toEqual({ uid: true });
    if (flags[0] === '\\Deleted') return true;
    expect(flags).toEqual(['\\Seen']);
    if (folder === hold) await new Promise(resolve => { releaseHold = resolve; });
    if (folder === failFolder) throw new Error('fake STORE refusal');
    wire.push([folder, String(uid), value]); events.push(['seen', folder]); return true;
  }
  async messageMove(uid, destination, options) {
    expect(options).toEqual({ uid: true }); events.push(['move', this.mailbox.path, destination]);
    return { uidMap: new Map([[Number(uid), Number(uid) + 100]]) };
  }
  async messageDelete(uid, options) {
    expect(options).toEqual({ uid: true }); events.push(['delete', this.mailbox.path, String(uid)]); return true;
  }
  async *fetch(uid, _projection, options) {
    expect(options).toEqual({ uid: true });
    const found = rows.find(r => r.folder === this.mailbox.path && Number(r.uid) === Number(uid));
    if (found) yield { uid: Number(uid), envelope: { messageId: found.message_id } };
  }
}
// SQL projections reflect production RETURNING; fake rows cannot hide missing columns.
async function database(sql, params = []) {
  if (sql.includes('FROM folders')) return { rows: sql.includes('special_use =') && !sql.includes('LIMIT 1') ? [] : sql.includes('LIMIT 1') ? [{ path: 'Archive' }] : [] };
  if (sql.startsWith('SELECT DISTINCT folder FROM messages')) return { rows: rows.filter(r => !r.is_deleted).map(r => ({ folder: r.folder })) };
  if (sql.startsWith('SELECT uid FROM messages')) return { rows: rows.filter(r => r.account_id === params[0] && r.folder === params[1] && r.message_id === params[2] && !r.is_deleted).map(r => ({ uid: r.uid })) };
  if (sql.startsWith('DELETE FROM messages WHERE account_id')) {
    const removed = rows.filter(r => r.account_id === params[0] && Number(r.uid) === Number(params[1]) && r.folder === params[2]);
    rows = rows.filter(r => !removed.includes(r)); return { rows: removed, rowCount: removed.length };
  }
  if (sql.startsWith('UPDATE messages SET folder = $1, uid = $2')) {
    const target = rows.find(r => r.id === params[2] && r.folder === params[3]);
    if (target) Object.assign(target, { folder: params[0], uid: params[1] });
    return { rows: [], rowCount: target ? 1 : 0 };
  }
  if (sql.startsWith('SELECT message_id, date, subject, from_email FROM messages WHERE account_id = $1 AND uid = $2 AND folder = $3')) {
    return { rows: rows.filter(r => r.account_id === params[0] && Number(r.uid) === Number(params[1]) && r.folder === params[2]).map(r => ({ message_id: r.message_id, date: r.date, subject: r.subject, from_email: r.from_email })) };
  }
  if (sql.startsWith('SELECT id, uid, is_read FROM messages')) return { rows: rows.filter(r => r.folder === params[1] && r.message_id === params[2] && !r.is_deleted).map(r => ({ ...r })) };
  if (sql.includes('FROM email_accounts')) return { rows: [otherAccounts.find(a => a.id === params[0]) || account] };
  if (sql.includes('FROM messages m') && sql.includes('JOIN email_accounts')) {
    const ids = Array.isArray(params[1]) ? params[1] : [params[0]];
    return { rows: rows.filter(r => ids.includes(r.id)).map(r => ({ ...r, user_id: 'reader', sibling_count: rows.length })) };
  }
  if (sql.trimStart().startsWith('SELECT') && sql.includes('FROM messages')) {
    if (sql.includes('from_email')) {
      if (selectionError) throw new Error('copy selection unavailable');
      if (selectionHold) await new Promise(resolve => { releaseSelection = resolve; });
      selectionChange?.(); selectionChange = null;
    }
    return { rows: rows.filter(r => r.account_id === params[0] && r.message_id === params[1] && !r.is_deleted).slice(0, 65).map(r => ({ ...r, body_hash: r.body_text == null && r.body_html == null ? null : createHash('md5').update(JSON.stringify([r.body_text ?? null, r.body_html ?? null])).digest('hex') })) };
  }
  if (sql.includes('UPDATE messages') && sql.includes('is_read = $1')) {
    const targets = sql.includes('FROM (')
      ? rows.filter(r => !params[1].includes(r.id) && r.is_read !== params[0] && rows.some(a => params[1].includes(a.id) && a.message_id === r.message_id && a.account_id === r.account_id))
      : sql.includes('message_id = $3')
      ? rows.filter(r => r.account_id === params[1] && r.message_id === params[2] && r.is_read !== params[0])
      : rows.filter(r => (Array.isArray(params[1]) ? params[1] : [params[1]]).includes(r.id));
    for (const r of targets) r.is_read = params[0];
    const returning = sql.split('RETURNING')[1];
    return { rows: returning ? targets.map(r => Object.fromEntries(Object.entries(r).filter(([k]) => new RegExp(`\\b${k}\\b`).test(returning)))) : [] };
  }
  return { rows: [] };
}
const row = (id, folder, uid, extra = {}) => ({ id, account_id: account.id, message_id: MID, from_email: 'sender@example.test', date: '2026-10-20T12:00:00.000Z', subject: 'Same copied message', body_text: 'Original copied body', body_html: null, to_addresses: ['reader@example.test'], cc_addresses: [], folder, uid, is_read: false, is_deleted: false, ...extra });
const settle = async () => { for (let n = 0; n < 30; n++) await new Promise(resolve => setImmediate(resolve)); };
let server, url;
beforeAll(async () => {
  const app = express(); app.use(express.json()); app.use('/mail', mailRoutes); app.use('/gtd', gtdRoutes); setMailEngine(imapManager);
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  url = `http://127.0.0.1:${server.address().port}/mail/messages`;
});
afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
beforeEach(() => {
  vi.clearAllMocks();
  account = { id: `copies-${++serial}`, user_id: 'reader', imap_host: 'imap.example.test', imap_port: 993, imap_tls: true, auth_user: 'reader', auth_pass: 'enc' };
  wire = []; events = []; otherAccounts = []; selectionHold = false; releaseSelection = null; hold = null; failFolder = null; selectionError = false; selectionChange = null; releaseHold = null; gtd = true; labels = ['Watch', 'Todo'];
  Object.setPrototypeOf(imapManager, ImapManager.prototype); Object.assign(imapManager, new ImapManager({ clients: new Set() }));
  clearInterval(imapManager._folderStatusTimer);
  const idle = new Mailbox(); idle.mailbox = { path: 'INBOX', exists: 3 }; imapManager.connections.set(account.id, idle);
  ImapFlow.mockImplementation(function () { return new Mailbox(); });
  pluginRegistry.hasActiveAsync.mockImplementation(async () => gtd);
  pluginRegistry.collectHook.mockImplementation(async () => [labels]); pluginRegistry.runHook.mockResolvedValue([]);
  query.mockImplementation(async (sql, params) => database(sql, params)); rows = [row(A, 'INBOX', 11), row(B, 'Watch', 42)];
});
afterEach(async () => { hold = null; selectionHold = false; releaseHold?.(); releaseSelection?.(); await settle(); await imapManager.disconnectAccount(account.id); for (const a of otherAccounts) await imapManager.disconnectAccount(a.id); });
const read = (id, value) => fetch(`${url}/${id}/read`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ read: value }) });
const bulk = (ids, value) => fetch(`${url}/bulk-read`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids, read: value }) });
describe('read-copy production routes and IMAP', () => {
  for (const fromLabel of [false, true]) for (const value of [false, true]) {
    it(`pushes read=${value} from ${fromLabel ? 'label' : 'ordinary'} copy to both copies`, async () => {
      rows = [row(A, 'Sent', 11, { is_read: !value }), row(B, 'Watch', 42, { is_read: !value })];
      expect((await read(fromLabel ? B : A, value)).status).toBe(200); await settle();
      expect(wire).toEqual(expect.arrayContaining([['Sent', '11', value], ['Watch', '42', value]])); expect(wire).toHaveLength(2);
    });
  }
  it('pushes the unselected bulk sibling too', async () => {
    expect((await bulk([A], true)).status).toBe(200); await settle();
    expect(wire).toEqual([['INBOX', '11', true], ['Watch', '42', true]]);
  });
  it('propagates bulk unread to the unselected copy', async () => {
    for (const r of rows) r.is_read = true;
    expect((await bulk([A], false)).status).toBe(200); await settle();
    expect(wire).toEqual([['INBOX', '11', false], ['Watch', '42', false]]);
  });
  it('responds while added bulk selection is stalled', async () => {
    selectionHold = true;
    const response = await Promise.race([bulk([A], true), new Promise(resolve => setTimeout(() => resolve('blocked'), 250))]);
    expect(response).not.toBe('blocked'); expect(response.status).toBe(200);
    await settle(); expect(releaseSelection).toBeTypeOf('function');
    selectionHold = false; releaseSelection(); await settle(); expect(wire).toHaveLength(2);
  });
  it('confirms a later bulk account despite earlier added-copy selection failure', async () => {
    const second = { ...account, id: `${account.id}-second`, imap_host: 'imap.gmail.com' }; otherAccounts.push(second);
    rows.push(row(C, 'Sent', 66, { account_id: second.id })); selectionError = true;
    expect((await bulk([A, C], true)).status).toBe(200); await settle();
    expect(wire).toEqual([['INBOX', '11', true], ['Sent', '66', true]]);
  });
  for (const count of [64, 65]) it(`bounds eligible groups at ${count} live candidates`, async () => {
    for (let n = 2; n < count; n++) rows.push(row(`extra-${n}`, `Folder${n}`, n + 100));
    expect((await read(A, true)).status).toBe(200); await settle();
    expect(wire).toHaveLength(count === 64 ? 64 : 1);
  });
  for (const uid of [0, -1, 1.5, 'invalid', '9007199254740992']) it(`rejects sibling UID ${uid}`, async () => {
    rows[1].uid = uid;
    expect((await read(A, true)).status).toBe(200); await settle(); expect(wire).toEqual([['INBOX', '11', true]]);
  });
  it('drops an old detached push whose delayed selection sees a newer confirmed state', async () => {
    selectionHold = true;
    expect((await read(A, true)).status).toBe(200); await settle();
    const releaseOldSelection = releaseSelection; expect(releaseOldSelection).toBeTypeOf('function');
    selectionHold = false;
    expect((await read(A, false)).status).toBe(200); await settle();
    releaseOldSelection(); await settle();
    expect(wire.filter(([folder]) => folder === 'Watch')).toEqual([['Watch', '42', false]]);
    expect(rows.every(r => r.is_read === false)).toBe(true);
  });
  it('pushes bulk siblings once when both copies are selected', async () => {
    expect((await bulk([A, B], true)).status).toBe(200); await settle();
    expect(wire).toEqual([['INBOX', '11', true], ['Watch', '42', true]]);
  });
  it('does not wait for an added sibling STORE before responding', async () => {
    hold = 'Watch';
    const response = await Promise.race([read(A, true), new Promise(resolve => setTimeout(() => resolve('blocked'), 250))]);
    expect(response).not.toBe('blocked'); expect(response.status).toBe(200);
    await settle(); expect(releaseHold).toBeTypeOf('function');
    hold = null; releaseHold(); await settle();
    expect(wire).toEqual([['INBOX', '11', true], ['Watch', '42', true]]);
  });
  for (const id of [null, '', '<>', '  <>  ', '<@>']) {
    it(`does not propagate degenerate Message-ID ${JSON.stringify(id)}`, async () => {
      for (const r of rows) r.message_id = id;
      expect((await read(A, true)).status).toBe(200); await settle(); expect(wire).toEqual([['INBOX', '11', true]]);
    });
  }
  it('does not propagate an ID reused by two ordinary messages', async () => {
    rows.push(row(C, 'INBOX', 12)); expect((await read(A, true)).status).toBe(200); await settle(); expect(wire).toEqual([['INBOX', '11', true]]);
  });
  it('includes already-read duplicates when deciding eligibility', async () => {
    rows.push(row(C, 'INBOX', 12, { is_read: true }));
    expect((await read(A, true)).status).toBe(200); await settle(); expect(wire).toEqual([['INBOX', '11', true]]);
  });
  for (const field of ['from_email', 'date', 'subject']) it(`rejects conflicting ${field} evidence`, async () => {
    rows[0][field] = 'first'; rows[1][field] = 'second';
    expect((await read(A, true)).status).toBe(200); await settle(); expect(wire).toEqual([['INBOX', '11', true]]);
  });
  it('does not propagate between ordinary messages with no label copies', async () => {
    rows[1].folder = 'Archive'; expect((await read(A, true)).status).toBe(200); await settle(); expect(wire).toEqual([['INBOX', '11', true]]);
  });
  it('honors configured label folders and skips soft-deleted copies', async () => {
    labels = ['Projects/Waiting']; rows[1].folder = labels[0]; rows.push(row(C, 'Todo', 99, { is_deleted: true }));
    expect((await read(A, true)).status).toBe(200); await settle(); expect(wire).toEqual([['INBOX', '11', true], ['Projects/Waiting', '42', true]]);
  });
  it('still confirms the clicked write when sibling selection fails', async () => {
    selectionError = true;
    expect((await read(A, true)).status).toBe(200); await settle(); expect(wire).toEqual([['INBOX', '11', true]]);
  });
  it('uses the live sibling address if it moves after fan-out', async () => {
    selectionChange = () => { rows[1].uid = 88; rows[1].folder = 'Todo'; };
    expect((await read(A, true)).status).toBe(200); await settle(); expect(wire).toEqual([['INBOX', '11', true], ['Todo', '88', true]]);
  });
  it('does not propagate if the acted row is removed before selection', async () => {
    selectionChange = () => { rows[0].is_deleted = true; rows.push(row(C, 'Sent', 90)); };
    expect((await read(A, true)).status).toBe(200); await settle(); expect(wire).toEqual([['INBOX', '11', true]]);
  });
  for (const field of ['to_addresses', 'cc_addresses']) it(`does not propagate contradictory ${field}`, async () => {
    rows[1][field] = ['another@example.test'];
    expect((await read(A, true)).status).toBe(200); await settle(); expect(wire).toEqual([['INBOX', '11', true]]);
  });
  it('keeps genuine copies eligible after a display-body cache repair', async () => {
    rows[0].body_html = '<html><head><style>body{color:red}</style></head><body><a href="https://example.test">Mail</a></body></html>';
    rows[1].body_html = '<html><body><a href="https://example.test/">Mail</a></body></html>';
    expect((await read(A, true)).status).toBe(200); await settle(); expect(wire).toHaveLength(2);
  });
  it('does not authorize an all-null identity fingerprint', async () => {
    for (const r of rows) Object.assign(r, {from_email:null,date:null,subject:null,body_hash:null,to_addresses:null,cc_addresses:null});
    expect((await read(A, true)).status).toBe(200); await settle(); expect(wire).toEqual([['INBOX', '11', true]]);
  });
  it('supports copies living only in configured label folders', async () => {
    rows[0].folder = 'Todo';
    expect((await read(A, true)).status).toBe(200); await settle(); expect(wire).toEqual([['Todo', '11', true], ['Watch', '42', true]]);
  });
  it('supports an identical INBOX, Archive and label copy', async () => {
    rows.push(row(C, 'Archive', 99));
    expect((await read(A, true)).status).toBe(200); await settle();
    expect(wire).toEqual([['INBOX', '11', true], ['Watch', '42', true], ['Archive', '99', true]]);
  });
  it('preserves non-GTD writes', async () => {
    gtd = false; expect((await read(A, true)).status).toBe(200); await settle(); expect(wire).toEqual([['INBOX', '11', true]]);
  });
  it('preserves Gmail single-copy writes', async () => {
    account.imap_host = 'imap.gmail.com'; expect((await read(A, true)).status).toBe(200); await settle(); expect(wire).toEqual([['INBOX', '11', true]]);
  });
});


describe('Done read-copy lifecycle through real engine', () => {
  it('awaits surviving copy writes, excludes strip targets, and reports confirmed IDs', async () => {
    rows = [row(A, 'Sent', 11), row(B, 'Watch', 42), row(C, 'Todo', 99)];
    const result = await markThreadRead(imapManager, account, rows[1], { excludeFolders: ['Watch'] });
    expect(wire).toEqual([['Sent', '11', true], ['Todo', '99', true]]);
    expect(result.pushedIds.sort()).toEqual([A, C].sort());
    expect(imapManager._pendingFlagPush.size).toBe(0);
  });
  it('queues surviving failures without reporting them as confirmed or as synchronous errors', async () => {
    rows = [row(A, 'Sent', 11), row(B, 'Watch', 42)]; failFolder = 'Sent';
    const result = await markThreadRead(imapManager, account, rows[1], { excludeFolders: ['Watch'] });
    expect(result.pushedIds).toEqual([]); expect(result.error).toBeUndefined();
    expect(imapManager._pendingFlagPush.get(account.id).get(`${A}:\\Seen`).value).toBe(true);
    expect(wire).toEqual([]);
  });
  it('keeps a failing INBOX write best-effort because the next operation may move it', async () => {
    failFolder = 'INBOX';
    const result = await markThreadRead(imapManager, account, rows[1], { excludeFolders: ['Watch'] });
    expect(result.pushedIds).toEqual([]); expect(result.error).toBeInstanceOf(Error);
    expect(imapManager._pendingFlagPush.size).toBe(0);
  });
});

const done = (id, states = ['watch']) => fetch(url.replace('/mail/messages', '/gtd/done'), {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, states }),
});
describe('Done route through plugin API and real mail engine', () => {
  it('keeps the directly known INBOX Seen attempt when added-copy selection fails', async () => {
    selectionError = true;
    const response = await done(A); expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ archived: true });
    expect(events).toEqual([['seen', 'INBOX'], ['delete', 'Watch', '42'], ['move', 'INBOX', 'Archive']]);
    expect(imapManager._pendingFlagPush.size).toBe(0);
  });
  it('awaits a surviving copy before strip/archive, without STORE or retry for the stripped label', async () => {
    rows.push(row(C, 'Todo', 99)); hold = 'Todo'; let finished = false;
    const response = done(B).then(r => { finished = true; return r; });
    for (let n = 0; n < 100 && !releaseHold; n++) await new Promise(resolve => setTimeout(resolve, 1));
    expect(releaseHold).toBeTypeOf('function'); expect(finished).toBe(false);
    expect(events).toEqual([['seen', 'INBOX']]);
    hold = null; releaseHold(); expect((await response).status).toBe(200);
    expect(events).toEqual([['seen', 'INBOX'], ['seen', 'Todo'], ['delete', 'Watch', '42'], ['move', 'INBOX', 'Archive']]);
    expect(imapManager._pendingFlagPush.size).toBe(0);
  });
  it('writes the kept only copy exactly once before archiving it', async () => {
    rows = [row(B, 'Watch', 42)];
    expect((await done(B)).status).toBe(200);
    expect(events).toEqual([['seen', 'Watch'], ['move', 'Watch', 'Archive']]);
    expect(wire).toHaveLength(1);
  });
  // Done archives the INBOX copy whether or not copy selection vouches for it, so its Seen is
  // written regardless; otherwise a sidebar Done files it into Archive unread.
  const inboxCases = {
    'the copies disagree on cc_addresses': () => { rows[0].cc_addresses = null; },
    'INBOX holds a duplicate delivery': () => { rows.push(row(C, 'INBOX', 12)); },
    'copy selection fails': () => { selectionError = true; },
  };
  for (const [name, setup] of Object.entries(inboxCases)) it(`marks the archived INBOX copy Seen on a sidebar Done when ${name}`, async () => {
    setup(); const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect((await done(B)).status).toBe(200);
      expect(events).toEqual([['seen', 'INBOX'], ['delete', 'Watch', '42'], ['move', 'INBOX', 'Archive']]);
      expect(wire).toEqual([['INBOX', '11', true]]);
    } finally { warning.mockRestore(); }
  });
  it('passes concrete selection errors through the actual wrapper and still archives after the known write', async () => {
    selectionError = true; const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect((await done(A)).status).toBe(200);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('degraded'), 'copy selection unavailable');
      expect(wire).toEqual([['INBOX', '11', true]]);
    } finally { warning.mockRestore(); }
  });
});
