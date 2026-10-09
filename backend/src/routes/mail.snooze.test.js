import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (_req, _res, next) => next() }));
vi.mock('../index.js', () => ({ imapManager: {} }));

import { gatherSnoozeConversation, LIVE_SNOOZE_SQL } from './mail.js';
import { query } from '../services/db.js';

// Column subset that the pool query selects.
function row(id, message_id, { in_reply_to = null, thread_references = null, folder = 'INBOX', is_read = true } = {}) {
  return { id, uid: id.charCodeAt(0), account_id: 'acct', folder, message_id, in_reply_to, thread_references, is_read };
}
const ids = (rows) => rows.map(r => r.message_id).sort();

const A = row('A', '<a>');                                              // root, in inbox
const B = row('B', '<b>', { in_reply_to: '<a>', thread_references: '<a>' });
const C = row('C', '<c>', { in_reply_to: '<b>', thread_references: '<a> <b>' });
// Unrelated messages sharing thread_id only through subject collision (no header links).
const X = row('X', '<x>');
const Y = row('Y', '<y>');

const msgOf = (r) => ({ ...r, thread_id: 't' });

// gatherSnoozeConversation issues: (1) the thread pool query, (2) the already-snoozed lookup.
function mockPool(rows, alreadySnoozed = []) {
  query.mockResolvedValueOnce({ rows });
  query.mockResolvedValueOnce({ rows: alreadySnoozed.map(m => ({ message_id_header: m })) });
}

describe('gatherSnoozeConversation', () => {
  beforeEach(() => query.mockReset());

  it('returns only the message when it has no thread_id (and never queries)', async () => {
    const out = await gatherSnoozeConversation({ ...A, thread_id: null });
    expect(ids(out)).toEqual(['<a>']);
    expect(query).not.toHaveBeenCalled();
  });

  it('snoozes the full reply chain when messages are header-linked', async () => {
    mockPool([A, B, C]);
    const out = await gatherSnoozeConversation(msgOf(A));
    expect(ids(out)).toEqual(['<a>', '<b>', '<c>']);
  });

  it('returns the acted-on message first (fatal-on-self before touching siblings)', async () => {
    mockPool([B, C, A]); // acted-on message A last in pool order
    const out = await gatherSnoozeConversation(msgOf(A));
    expect(out[0].message_id).toBe('<a>');
  });

  it('does NOT sweep in subject-collision siblings that share no header link', async () => {
    mockPool([A, X, Y]);
    const out = await gatherSnoozeConversation(msgOf(A));
    expect(ids(out)).toEqual(['<a>']);
  });

  it('selects only the real conversation from a mixed pool', async () => {
    mockPool([A, B, X, Y]);
    const out = await gatherSnoozeConversation(msgOf(A));
    expect(ids(out)).toEqual(['<a>', '<b>']);
  });

  it('reaches the root when acting on a reply (undirected walk)', async () => {
    mockPool([A, B, C]);
    const out = await gatherSnoozeConversation(msgOf(C));
    expect(ids(out)).toEqual(['<a>', '<b>', '<c>']);
  });

  it('uses out-of-folder messages as connectors but snoozes only the source folder', async () => {
    // The link between the two inbox messages runs through a Sent-folder reply.
    const sent = row('S', '<s>', { in_reply_to: '<a>', thread_references: '<a>', folder: 'Sent' });
    const inboxReply = row('R', '<r>', { in_reply_to: '<s>', thread_references: '<a> <s>' });
    mockPool([A, sent, inboxReply]);
    const out = await gatherSnoozeConversation(msgOf(A));
    // A (inbox) and R (inbox) are one conversation via the Sent connector; Sent copy is not snoozed.
    expect(ids(out)).toEqual(['<a>', '<r>']);
  });

  it('excludes members already snoozed', async () => {
    mockPool([A, B, C], ['<b>']);
    const out = await gatherSnoozeConversation(msgOf(A));
    expect(ids(out)).toEqual(['<a>', '<c>']);
  });

  it('counts a member as snoozed only while it still sits in its Snoozed folder (#269)', async () => {
    // A message moved out of Snoozed by hand keeps its record until the wake-up sweep; that
    // leftover must not keep it out of a new snooze. The SQL itself is checked against a
    // migrated PostgreSQL; this guards that the lookup keeps applying it.
    mockPool([A, B, C], []);
    await gatherSnoozeConversation(msgOf(A));
    const [sql] = query.mock.calls[1];
    expect(sql).toContain(LIVE_SNOOZE_SQL);
    expect(LIVE_SNOOZE_SQL).toMatch(/m\.folder = sm\.snoozed_folder/);
    expect(LIVE_SNOOZE_SQL).toMatch(/m\.is_deleted = false/);
  });

  it('dedupes by Message-ID so a doubled source row is snoozed once', async () => {
    const Adup = row('A2', '<a>'); // same Message-ID, different row id, same folder
    mockPool([A, Adup, B]);
    const out = await gatherSnoozeConversation(msgOf(A));
    expect(ids(out)).toEqual(['<a>', '<b>']);
    expect(out.filter(r => r.message_id === '<a>')).toHaveLength(1);
  });

  it('includes the triggering message even if the pool query misses it', async () => {
    // Transient read skew: pool omits A, but B references it.
    mockPool([B]);
    const out = await gatherSnoozeConversation(msgOf(A));
    expect(ids(out)).toEqual(['<a>', '<b>']);
  });
});
