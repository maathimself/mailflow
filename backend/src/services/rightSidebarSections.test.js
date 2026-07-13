import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./rightSidebarConfig.js', () => ({ getRightSidebarConfig: vi.fn() }));
vi.mock('../utils/mailUtils.js', () => ({ resolveAllDraftsPaths: vi.fn() }));

import { query } from './db.js';
import { getRightSidebarConfig } from './rightSidebarConfig.js';
import { resolveAllDraftsPaths } from '../utils/mailUtils.js';
import { getRightSidebarSections } from './rightSidebarSections.js';

const headRow = (over = {}) => ({
  section_path: 'Projects',
  available: true,
  id: 'm1',
  account_id: 'a1',
  message_id: '<1>',
  thread_key: 't1',
  subject: 'Project update',
  from_name: 'Alice',
  from_email: 'alice@example.com',
  date: '2026-07-12T10:00:00Z',
  snippet: 'Latest update',
  thread_unread: true,
  is_starred: false,
  uid: 10,
  folder: 'Projects',
  folders: ['INBOX', 'Projects'],
  in_inbox: true,
  total: 2,
  unread: 1,
  ...over,
});

beforeEach(() => {
  query.mockReset();
  getRightSidebarConfig.mockReset();
  resolveAllDraftsPaths.mockReset();
  resolveAllDraftsPaths.mockResolvedValue(new Set(['Drafts']));
});

describe('getRightSidebarSections', () => {
  it('uses account sort order when composing unified sections', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    await getRightSidebarSections({ userId: 'u1' });

    expect(query.mock.calls[0][0]).toContain('ORDER BY sort_order, created_at');
  });

  it('returns sections in configured order with thread-level unread and stable heads', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'a1', folder_mappings: {} }] })
      .mockResolvedValueOnce({ rows: [
        headRow(),
        { section_path: 'Receipts', available: true, id: null, total: null, unread: null },
      ] });
    getRightSidebarConfig.mockResolvedValue(['Projects', 'Receipts']);

    const result = await getRightSidebarSections({ userId: 'u1', limit: 8 });

    expect(result.sections.map(section => section.path)).toEqual(['Projects', 'Receipts']);
    expect(result.sections[0]).toMatchObject({ total: 2, unread: 1 });
    expect(result.sections[0].threads[0]).toMatchObject({ id: 'm1', is_read: false });
    expect(result.sections[1]).toEqual({ path: 'Receipts', name: 'Receipts', available: true, total: 0, unread: 0, threads: [] });
  });

  it('keeps a configured folder that is no longer detected as unavailable', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'a1', folder_mappings: {} }] })
      .mockResolvedValueOnce({ rows: [
        { section_path: 'Missing label', available: false, id: null, total: null, unread: null },
      ] });
    getRightSidebarConfig.mockResolvedValue(['Missing label']);

    const result = await getRightSidebarSections({ userId: 'u1' });

    expect(result.sections).toEqual([
      { path: 'Missing label', name: 'Missing label', available: false, total: 0, unread: 0, threads: [] },
    ]);
  });

  it('scopes to an owned account and returns no targets for a foreign account', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'owned', folder_mappings: {} }] });

    expect(await getRightSidebarSections({ userId: 'u1', accountId: 'foreign' })).toEqual({ sections: [] });
    expect(getRightSidebarConfig).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('merges the same configured path but keeps identical messages actionable per account', async () => {
    query
      .mockResolvedValueOnce({ rows: [
        { id: 'a1', folder_mappings: {} },
        { id: 'a2', folder_mappings: {} },
      ] })
      .mockResolvedValueOnce({ rows: [headRow({ account_id: 'a1', available: false, total: 1, unread: 1 })] })
      .mockResolvedValueOnce({ rows: [headRow({ account_id: 'a2', id: 'm2', available: true, total: 1, unread: 0, thread_unread: false })] });
    getRightSidebarConfig.mockResolvedValue(['Projects']);

    const { sections } = await getRightSidebarSections({ userId: 'u1' });

    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({ path: 'Projects', available: true, total: 2, unread: 1 });
    expect(sections[0].threads.map(thread => thread.id)).toEqual(['m1', 'm2']);
  });

  it('clamps the limit, excludes drafts, bounds the rollup to label threads, and uses a set-based section query', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'a1', folder_mappings: {} }] })
      .mockResolvedValueOnce({ rows: [] });
    getRightSidebarConfig.mockResolvedValue(['Projects']);
    resolveAllDraftsPaths.mockResolvedValue(new Set(['Drafts', '[Gmail]/Drafts']));

    await getRightSidebarSections({ userId: 'u1', limit: 500 });

    const [sql, params] = query.mock.calls[1];
    expect(sql).toContain('unnest($2::text[], $3::int[])');
    expect(sql).toContain('DISTINCT ON');
    expect(sql).toContain('bool_or(NOT is_read)');
    expect(sql).toContain('<> ALL($4::text[])');
    expect(sql).toContain('LEFT JOIN folders');
    // The rollup never scans the whole mailbox: only threads seen in a configured folder.
    expect(sql).toContain('label_threads');
    expect(sql).toContain('m.folder = ANY($2::text[])');
    expect(sql).toContain('JOIN label_threads lt ON lt.thread_key = m.thread_key');
    expect(params).toEqual(['a1', ['Projects'], [0], ['Drafts', '[Gmail]/Drafts'], 50]);
  });

  it('drops configured labels from the drafts-exclusion list so a "%draft%"-named section still aggregates', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'a1', folder_mappings: {} }] })
      .mockResolvedValueOnce({ rows: [] });
    getRightSidebarConfig.mockResolvedValue(['Draft Proposals']);
    // The name heuristic catches "Draft Proposals", but it is a configured section, so $4
    // must keep only the real Drafts folder — otherwise the section renders permanently empty.
    resolveAllDraftsPaths.mockResolvedValue(new Set(['Drafts', 'Draft Proposals']));

    await getRightSidebarSections({ userId: 'u1' });

    const [, params] = query.mock.calls[1];
    expect(params[3]).toEqual(['Drafts']);
  });
});
