import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./gtdConfig.js', () => ({
  getGtdConfig: vi.fn(),
  GTD_STATES: ['todo', 'watch', 'delegated', 'someday', 'reference'],
}));
vi.mock('../utils/mailUtils.js', () => ({ resolveAllDraftsPaths: vi.fn() }));

import { query } from './db.js';
import { getGtdConfig } from './gtdConfig.js';
import { resolveAllDraftsPaths } from '../utils/mailUtils.js';
import { getGtdSections, emitGtdIfRelevant } from './gtdSections.js';

const DEFAULT_FOLDERS = {
  todo: 'Todo', watch: 'Watch', delegated: 'Delegated', someday: 'Someday', reference: 'Reference',
};

// A section-query result row as SECTION_SQL would return it.
const headRow = (over = {}) => ({
  state: 'todo',
  id: 'm1',
  account_id: 'acc-1',
  message_id: '<mid-1@x>',
  thread_key: 't1',
  subject: 'Subject',
  from_name: 'Alice',
  from_email: 'alice@x.com',
  date: '2026-07-01T10:00:00Z',
  snippet: 'hello',
  thread_unread: true,
  is_starred: false,
  uid: 100,
  folder: 'INBOX',
  folders: ['INBOX', 'Todo'],
  in_inbox: true,
  total: 1,
  unread: 1,
  waiting_total: 0,
  waiting_unread: 0,
  ...over,
});

beforeEach(() => {
  query.mockReset();
  getGtdConfig.mockReset();
  resolveAllDraftsPaths.mockReset();
  getGtdConfig.mockResolvedValue({ enabled: true, folders: DEFAULT_FOLDERS });
  resolveAllDraftsPaths.mockResolvedValue(new Set(['Drafts']));
});

describe('getGtdSections — account resolution', () => {
  it('returns empty sections and issues no section query when the user has no GTD accounts', async () => {
    query.mockResolvedValueOnce({ rows: [] }); // accounts

    const { sections } = await getGtdSections({ userId: 'u1' });

    expect(query).toHaveBeenCalledTimes(1);
    for (const st of ['todo', 'watch', 'delegated', 'someday', 'reference']) {
      expect(sections[st]).toEqual({ total: 0, unread: 0, threads: [] });
    }
  });

  it('scopes the accounts query to the user, enabled, and gtd_enabled', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await getGtdSections({ userId: 'u1' });
    const sql = query.mock.calls[0][0];
    expect(sql).toContain('user_id = $1');
    expect(sql).toContain('enabled = true');
    expect(sql).toContain('gtd_enabled = true');
  });

  it('excludes accounts the caller does not own when accountId is supplied', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'acc-1', folder_mappings: null }] }); // accounts

    const { sections } = await getGtdSections({ userId: 'u1', accountId: 'acc-other' });

    // No section query runs — the requested account is not in the owned/enabled set.
    expect(query).toHaveBeenCalledTimes(1);
    expect(sections.todo).toEqual({ total: 0, unread: 0, threads: [] });
  });
});

describe('getGtdSections — section folding', () => {
  it('places a multi-folder thread in every state section it belongs to, once each, preserving in_inbox', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1', folder_mappings: null }] }) // accounts
      .mockResolvedValueOnce({ rows: [
        headRow({ state: 'todo', folders: ['INBOX', 'Todo', 'Reference'], in_inbox: true }),
        headRow({ state: 'reference', folders: ['INBOX', 'Todo', 'Reference'], in_inbox: true }),
      ] });

    const { sections } = await getGtdSections({ userId: 'u1' });

    expect(sections.todo.threads).toHaveLength(1);
    expect(sections.reference.threads).toHaveLength(1);
    expect(sections.todo.threads[0].message_id).toBe('<mid-1@x>');
    expect(sections.todo.threads[0].in_inbox).toBe(true);
    expect(sections.todo.threads[0].folders).toEqual(['INBOX', 'Todo', 'Reference']);
    expect(sections.watch.threads).toHaveLength(0);
  });

  it('surfaces an archived (inbox-absent) thread with in_inbox false', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1', folder_mappings: null }] })
      .mockResolvedValueOnce({ rows: [
        headRow({ state: 'watch', folders: ['Watch'], in_inbox: false, total: 1, unread: 0, thread_unread: false }),
      ] });

    const { sections } = await getGtdSections({ userId: 'u1' });

    expect(sections.watch.threads).toHaveLength(1);
    expect(sections.watch.threads[0].in_inbox).toBe(false);
  });

  it('reports per-section total and unread from the query pass', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1', folder_mappings: null }] })
      .mockResolvedValueOnce({ rows: [
        headRow({ id: 'a', message_id: '<a>', thread_key: 'ta', total: 3, unread: 2, thread_unread: true }),
        headRow({ id: 'b', message_id: '<b>', thread_key: 'tb', total: 3, unread: 2, thread_unread: true, date: '2026-06-30T10:00:00Z' }),
        headRow({ id: 'c', message_id: '<c>', thread_key: 'tc', total: 3, unread: 2, thread_unread: false, date: '2026-06-29T10:00:00Z' }),
      ] });

    const { sections } = await getGtdSections({ userId: 'u1' });

    expect(sections.todo.total).toBe(3);
    expect(sections.todo.unread).toBe(2);
    expect(sections.todo.threads).toHaveLength(3);
    // newest first
    expect(sections.todo.threads.map(t => t.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('getGtdSections — thread-level unread', () => {
  it('surfaces a thread with a read head but an unread sibling copy as unread', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1', folder_mappings: null }] })
      .mockResolvedValueOnce({ rows: [
        // The head is the READ Todo-folder copy; a newer reply exists only in INBOX and
        // is unread, so SECTION_SQL reports thread_unread true. is_read simulates the
        // pre-fix head-level column — mapHead must NOT surface it over the thread truth.
        headRow({ thread_unread: true, is_read: true, total: 1, unread: 1 }),
      ] });

    const { sections } = await getGtdSections({ userId: 'u1' });

    expect(sections.todo.threads[0].is_read).toBe(false);
    expect(sections.todo.unread).toBe(1);
  });

  it('surfaces a thread whose copies are all read as read', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1', folder_mappings: null }] })
      .mockResolvedValueOnce({ rows: [
        headRow({ thread_unread: false, total: 1, unread: 0 }),
      ] });

    const { sections } = await getGtdSections({ userId: 'u1' });

    expect(sections.todo.threads[0].is_read).toBe(true);
    expect(sections.todo.unread).toBe(0);
  });

  it('keeps the waiting rollup unread on the same thread-level basis as the row flag', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1', folder_mappings: null }] })
      .mockResolvedValueOnce({ rows: [
        headRow({ state: 'watch', thread_unread: true, total: 1, unread: 1, waiting_total: 1, waiting_unread: 1 }),
      ] });

    const { sections } = await getGtdSections({ userId: 'u1' });

    // One truth per thread: the rollup badge and the row styling must agree.
    expect(sections.waiting).toEqual({ total: 1, unread: 1 });
    expect(sections.watch.threads[0].is_read).toBe(false);
  });
});

describe('getGtdSections — unified merge', () => {
  it('sums counts and merges heads newest-first across accounts', async () => {
    query
      .mockResolvedValueOnce({ rows: [
        { id: 'acc-1', folder_mappings: null },
        { id: 'acc-2', folder_mappings: null },
      ] })
      .mockResolvedValueOnce({ rows: [
        headRow({ account_id: 'acc-1', id: 'a', message_id: '<a>', thread_key: 'ta', total: 1, unread: 1, date: '2026-07-02T00:00:00Z' }),
      ] })
      .mockResolvedValueOnce({ rows: [
        headRow({ account_id: 'acc-2', id: 'b', message_id: '<b>', thread_key: 'tb', total: 1, unread: 0, thread_unread: false, date: '2026-07-03T00:00:00Z' }),
      ] });

    const { sections } = await getGtdSections({ userId: 'u1' });

    expect(sections.todo.total).toBe(2);
    expect(sections.todo.unread).toBe(1);
    // acc-2's head is newer, so it sorts first
    expect(sections.todo.threads.map(t => t.id)).toEqual(['b', 'a']);
  });

  it('dedupes the same message_id appearing across two accounts', async () => {
    query
      .mockResolvedValueOnce({ rows: [
        { id: 'acc-1', folder_mappings: null },
        { id: 'acc-2', folder_mappings: null },
      ] })
      .mockResolvedValueOnce({ rows: [
        headRow({ account_id: 'acc-1', id: 'a', message_id: '<shared>', thread_key: 'ta', total: 1, unread: 0, thread_unread: false }),
      ] })
      .mockResolvedValueOnce({ rows: [
        headRow({ account_id: 'acc-2', id: 'b', message_id: '<shared>', thread_key: 'ta', total: 1, unread: 0, thread_unread: false }),
      ] });

    const { sections } = await getGtdSections({ userId: 'u1' });

    expect(sections.todo.threads).toHaveLength(1);
  });
});

describe('getGtdSections — query shape and limits', () => {
  it('clamps the per-section limit to the default when absent and caps at 50', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1', folder_mappings: null }] })
      .mockResolvedValueOnce({ rows: [] });
    await getGtdSections({ userId: 'u1' });
    expect(query.mock.calls[1][1][4]).toBe(8); // default limit param ($5)

    query.mockReset();
    getGtdConfig.mockResolvedValue({ enabled: true, folders: DEFAULT_FOLDERS });
    resolveAllDraftsPaths.mockResolvedValue(new Set(['Drafts']));
    query
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1', folder_mappings: null }] })
      .mockResolvedValueOnce({ rows: [] });
    await getGtdSections({ userId: 'u1', limit: 500 });
    expect(query.mock.calls[1][1][4]).toBe(50); // capped ($5)
  });

  it('passes the resolved draft paths and excludes them in the query', async () => {
    resolveAllDraftsPaths.mockResolvedValue(new Set(['Drafts', '[Gmail]/Drafts']));
    query
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1', folder_mappings: null }] })
      .mockResolvedValueOnce({ rows: [] });

    await getGtdSections({ userId: 'u1' });

    const sectionSql = query.mock.calls[1][0];
    expect(sectionSql).toContain('DISTINCT ON');
    expect(sectionSql).toContain('array_agg');
    expect(sectionSql).toContain('is_deleted = false');
    expect(sectionSql).toContain("bool_or(folder = 'INBOX')");
    expect(sectionSql).toContain('<> ALL($4::text[])'); // draft exclusion
    expect(query.mock.calls[1][1][3]).toEqual(['Drafts', '[Gmail]/Drafts']); // draft paths ($4)
  });

  it('picks the thread head from a GTD-label folder so its row id is stable to click', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1', folder_mappings: null }] })
      .mockResolvedValueOnce({ rows: [] });

    await getGtdSections({ userId: 'u1' });

    const sectionSql = query.mock.calls[1][0];
    // The head handed to the client must prefer a row living in a GTD label folder: its PK
    // outlives the thread's transient INBOX copy (which is archived/purged out from under the
    // section feed), so a click never lands on a since-deleted id.
    expect(sectionSql).toContain('folder IN (SELECT folder FROM gtd)');
  });

  it('computes unread thread-level (bool_or over all copies), one truth for counts and rows', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1', folder_mappings: null }] })
      .mockResolvedValueOnce({ rows: [] });

    await getGtdSections({ userId: 'u1' });

    const sectionSql = query.mock.calls[1][0];
    // A thread with a read label-folder head but a newer unread INBOX-only reply is
    // UNREAD: the aggregate spans every non-deleted, non-draft copy, not the head row.
    expect(sectionSql).toContain('bool_or(NOT is_read)');
    // Both unread figures — the per-state window count and the waiting rollup — must
    // read that same aggregate, so badges and row styling can never disagree.
    expect(sectionSql.match(/FILTER \(WHERE fa\.thread_unread\)/g)).toHaveLength(2);
    // The head's own flag must not leak anywhere (one truth per thread).
    expect(sectionSql).not.toContain('h.is_read');
  });

  it('selects is_starred on the head so GTD entries can render a real (two-way) star', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1', folder_mappings: null }] })
      .mockResolvedValueOnce({ rows: [] });

    await getGtdSections({ userId: 'u1' });

    expect(query.mock.calls[1][0]).toContain('is_starred');
  });

  it('ships a deduped Waiting rollup via COUNT(DISTINCT) and passes the waiting states as $6', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1', folder_mappings: null }] })
      .mockResolvedValueOnce({ rows: [] });

    await getGtdSections({ userId: 'u1' });

    const sectionSql = query.mock.calls[1][0];
    // A thread in BOTH watch and delegated must count once — COUNT(DISTINCT thread_key)
    // over the waiting states, computed server-side so it survives past the head window.
    expect(sectionSql).toContain('COUNT(DISTINCT');
    expect(sectionSql).toContain('waiting_total');
    expect(sectionSql).toContain('waiting_unread');
    // $6 carries the waiting states present for the account (subset of the state list).
    expect(query.mock.calls[1][1][5]).toEqual(['watch', 'delegated']);
  });
});

describe('getGtdSections — waiting rollup + star', () => {
  it('surfaces the head is_starred flag on the mapped thread', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1', folder_mappings: null }] })
      .mockResolvedValueOnce({ rows: [headRow({ state: 'todo', is_starred: true })] });

    const { sections } = await getGtdSections({ userId: 'u1' });

    expect(sections.todo.threads[0].is_starred).toBe(true);
  });

  it('folds the query rollup into a deduped sections.waiting count instead of watch+delegated summed', async () => {
    // Account query returns watch + delegated heads for one thread labelled BOTH: the
    // per-state totals sum to 2, but the query's waiting_total (deduped) is 1.
    query
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1', folder_mappings: null }] })
      .mockResolvedValueOnce({ rows: [
        headRow({ state: 'watch', id: 'a', message_id: '<a>', thread_key: 'ta', total: 1, unread: 1, thread_unread: true, waiting_total: 1, waiting_unread: 1 }),
        headRow({ state: 'delegated', id: 'a', message_id: '<a>', thread_key: 'ta', total: 1, unread: 1, thread_unread: true, waiting_total: 1, waiting_unread: 1 }),
      ] });

    const { sections } = await getGtdSections({ userId: 'u1' });

    expect(sections.watch.total).toBe(1);
    expect(sections.delegated.total).toBe(1);
    // Deduped rollup, not watch.total + delegated.total.
    expect(sections.waiting).toEqual({ total: 1, unread: 1 });
  });

  it('sums the waiting rollup across accounts (once per account, from its first row)', async () => {
    query
      .mockResolvedValueOnce({ rows: [
        { id: 'acc-1', folder_mappings: null },
        { id: 'acc-2', folder_mappings: null },
      ] })
      .mockResolvedValueOnce({ rows: [
        headRow({ account_id: 'acc-1', state: 'watch', id: 'a', message_id: '<a>', thread_key: 'ta', waiting_total: 3, waiting_unread: 2 }),
        headRow({ account_id: 'acc-1', state: 'delegated', id: 'b', message_id: '<b>', thread_key: 'tb', waiting_total: 3, waiting_unread: 2 }),
      ] })
      .mockResolvedValueOnce({ rows: [
        headRow({ account_id: 'acc-2', state: 'watch', id: 'c', message_id: '<c>', thread_key: 'tc', waiting_total: 4, waiting_unread: 0, thread_unread: false }),
      ] });

    const { sections } = await getGtdSections({ userId: 'u1' });

    expect(sections.waiting).toEqual({ total: 7, unread: 2 });
  });

  it('returns a zeroed waiting rollup when the user has no GTD accounts', async () => {
    query.mockResolvedValueOnce({ rows: [] }); // accounts

    const { sections } = await getGtdSections({ userId: 'u1' });

    expect(sections.waiting).toEqual({ total: 0, unread: 0 });
  });
});

describe('emitGtdIfRelevant', () => {
  const mgr = { broadcast: vi.fn() };
  beforeEach(() => mgr.broadcast.mockReset());

  it('broadcasts when an acted message has a live sibling in a designated GTD folder', async () => {
    query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }); // EXISTS hit
    await emitGtdIfRelevant(mgr, 'acc-1', 'u1', ['<mid-1@x>', '<mid-2@x>']);

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('message_id = ANY($2::text[])');
    expect(sql).toContain('folder = ANY($3::text[])');
    expect(params[0]).toBe('acc-1');
    expect(params[1]).toEqual(['<mid-1@x>', '<mid-2@x>']);
    expect(params[2]).toEqual(['Todo', 'Watch', 'Delegated', 'Someday', 'Reference']);
    expect(mgr.broadcast).toHaveBeenCalledWith({ type: 'gtd_sections_updated', accountId: 'acc-1' }, 'u1');
  });

  it('runs the EXISTS query but does not broadcast when no sibling lives in a GTD folder', async () => {
    query.mockResolvedValueOnce({ rows: [] }); // no GTD sibling
    await emitGtdIfRelevant(mgr, 'acc-1', 'u1', ['<mid-1@x>']);
    expect(query).toHaveBeenCalledTimes(1);
    expect(mgr.broadcast).not.toHaveBeenCalled();
  });

  it('broadcasts when an acted row was itself in a GTD folder pre-mutation, even with zero post-mutation siblings', async () => {
    query.mockResolvedValueOnce({ rows: [] }); // EXISTS finds nothing — mutation removed the last GTD-folder copy
    await emitGtdIfRelevant(mgr, 'acc-1', 'u1', ['<mid-1@x>'], ['Todo']);
    expect(query).toHaveBeenCalledTimes(1);
    expect(mgr.broadcast).toHaveBeenCalledWith({ type: 'gtd_sections_updated', accountId: 'acc-1' }, 'u1');
  });

  it('does not broadcast when actedFolders has no overlap with the account\'s GTD folders', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await emitGtdIfRelevant(mgr, 'acc-1', 'u1', ['<mid-1@x>'], ['INBOX']);
    expect(mgr.broadcast).not.toHaveBeenCalled();
  });

  it('does no query and no broadcast when GTD is disabled for the account', async () => {
    getGtdConfig.mockResolvedValueOnce({ enabled: false, folders: DEFAULT_FOLDERS });
    await emitGtdIfRelevant(mgr, 'acc-1', 'u1', ['<mid-1@x>']);
    expect(query).not.toHaveBeenCalled();
    expect(mgr.broadcast).not.toHaveBeenCalled();
  });

  it('short-circuits with no query when there are no message ids', async () => {
    await emitGtdIfRelevant(mgr, 'acc-1', 'u1', [null, undefined, '']);
    expect(getGtdConfig).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(mgr.broadcast).not.toHaveBeenCalled();
  });
});
