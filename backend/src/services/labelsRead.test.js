import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));
import { query } from './db.js';
import { listThreadHeadsByLabels, notifyOnLabelTouch } from './labelsRead.js';

describe('listThreadHeadsByLabels', () => {
  beforeEach(() => query.mockReset());

  it('runs the thread-aware section query with params in the documented order', async () => {
    query.mockResolvedValueOnce({ rows: [{ state: 'todo', total: 3, unread: 1 }] });
    const rows = await listThreadHeadsByLabels('acct-1', {
      labels: ['todo', 'watch'],
      labelFolders: ['Todo', 'Watch'],
      draftFolders: ['Drafts'],
      limit: 8,
      unionLabels: ['watch'],
    });
    expect(rows).toEqual([{ state: 'todo', total: 3, unread: 1 }]);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('m.metadata_complete = true');
    expect(sql).toMatch(/JOIN folders live_folder/);
    expect(sql).toContain('live_folder.is_present = true');
    expect(sql).toContain('live_folder.uid_validity IS NOT NULL');
    expect(sql).toMatch(/WITH gtd\(state, folder\)/);       // the thread-aware CTE
    expect(sql).toMatch(/bool_or\(NOT is_read\)\s+AS thread_unread/); // thread-level unread
    expect(params).toEqual(['acct-1', ['todo', 'watch'], ['Todo', 'Watch'], ['Drafts'], 8, ['watch']]);
  });
});

describe('notifyOnLabelTouch', () => {
  beforeEach(() => query.mockReset());
  const mgr = () => ({ broadcast: vi.fn() });
  const base = { accountId: 'a1', userId: 'u1', labelFolders: ['Todo', 'Watch'], event: 'gtd_sections_updated' };

  it('broadcasts (scoped to the user) when an acted message has a live sibling in a label folder', async () => {
    query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    const imap = mgr();
    const did = await notifyOnLabelTouch(imap, { ...base, messageIds: ['<m1>', '<m2>'] });
    expect(did).toBe(true);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/message_id = ANY\(\$2::text\[\]\)/);
    expect(params).toEqual(['a1', ['<m1>', '<m2>'], ['Todo', 'Watch']]);
    expect(imap.broadcast).toHaveBeenCalledWith({ type: 'gtd_sections_updated', accountId: 'a1' }, 'u1');
  });

  it('broadcasts on a pre-mutation folder hit even when no post-mutation sibling remains', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const imap = mgr();
    const did = await notifyOnLabelTouch(imap, { ...base, messageIds: ['<m1>'], actedFolders: ['Todo'] });
    expect(did).toBe(true);
    expect(imap.broadcast).toHaveBeenCalledTimes(1);
  });

  it('does not broadcast when neither a sibling nor a pre-mutation folder matches', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const imap = mgr();
    const did = await notifyOnLabelTouch(imap, { ...base, messageIds: ['<m1>'], actedFolders: ['INBOX'] });
    expect(did).toBe(false);
    expect(imap.broadcast).not.toHaveBeenCalled();
  });

  it('short-circuits (no query, no broadcast) on empty ids, empty labels, or a missing event', async () => {
    const imap = mgr();
    expect(await notifyOnLabelTouch(imap, { ...base, messageIds: [null, ''] })).toBe(false);
    expect(await notifyOnLabelTouch(imap, { ...base, messageIds: ['<m1>'], labelFolders: [] })).toBe(false);
    expect(await notifyOnLabelTouch(imap, { ...base, messageIds: ['<m1>'], event: undefined })).toBe(false);
    expect(query).not.toHaveBeenCalled();
    expect(imap.broadcast).not.toHaveBeenCalled();
  });
});
