import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./rightSidebarConfig.js', () => ({ getRightSidebarConfig: vi.fn() }));

import { query } from './db.js';
import { getRightSidebarConfig } from './rightSidebarConfig.js';
import { emitSectionUpdatesIfRelevant, groupSectionUpdateInputs } from './sectionUpdates.js';

describe('groupSectionUpdateInputs', () => {
  it('groups ids, thread keys, and folders per account', () => {
    const out = groupSectionUpdateInputs([
      { account_id: 'a', message_id: '<1>', thread_key: 't1', folder: 'INBOX' },
      { account_id: 'a', message_id: '<2>', thread_key: 't2', folder: 'Receipts' },
      { account_id: 'b', message_id: '<3>', thread_key: 't3', folder: 'INBOX' },
    ]);
    expect(out).toHaveLength(2);
    const a = out.find(e => e.accountId === 'a');
    expect(a.messageIds.sort()).toEqual(['<1>', '<2>']);
    expect(a.threadKeys.sort()).toEqual(['t1', 't2']);
    expect(a.actedFolders.sort()).toEqual(['INBOX', 'Receipts']);
  });

  it('adds the destination folder, which moved rows can no longer name', () => {
    const [entry] = groupSectionUpdateInputs([{ account_id: 'a', message_id: '<1>', folder: 'INBOX' }], ['Receipts']);
    expect(entry.actedFolders.sort()).toEqual(['INBOX', 'Receipts']);
  });

  it('skips rows with neither an id, a thread key, nor a folder', () => {
    expect(groupSectionUpdateInputs([{ account_id: 'a' }, null])).toEqual([]);
  });
});

describe('emitSectionUpdatesIfRelevant', () => {
  const mgr = { broadcast: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    query.mockResolvedValue({ rows: [] });
  });

  it('stays silent when the account configured no labels', async () => {
    getRightSidebarConfig.mockResolvedValue([]);
    await emitSectionUpdatesIfRelevant(mgr, 'a', 'u', ['<1>'], ['INBOX'], ['t1']);
    expect(mgr.broadcast).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('stays silent when the acted mail touches no configured folder', async () => {
    getRightSidebarConfig.mockResolvedValue(['Receipts']);
    query.mockResolvedValue({ rows: [] });
    await emitSectionUpdatesIfRelevant(mgr, 'a', 'u', ['<1>'], ['INBOX'], ['t1']);
    expect(mgr.broadcast).not.toHaveBeenCalled();
  });

  it('broadcasts when a same-message copy lives in a configured folder', async () => {
    getRightSidebarConfig.mockResolvedValue(['Receipts']);
    query.mockResolvedValue({ rows: [{ folder: 'Receipts' }] });
    await emitSectionUpdatesIfRelevant(mgr, 'a', 'u', ['<1>'], ['INBOX'], ['t1']);
    expect(mgr.broadcast).toHaveBeenCalledWith({ type: 'right_sidebar_updated', accountId: 'a' }, 'u');
  });

  it('broadcasts when only a thread sibling lives in a configured folder', async () => {
    // No message ids at all: only the thread key can find the sibling row.
    getRightSidebarConfig.mockResolvedValue(['Receipts']);
    query.mockResolvedValue({ rows: [{ folder: 'Receipts' }] });
    await emitSectionUpdatesIfRelevant(mgr, 'a', 'u', [], ['INBOX'], ['t1']);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('message_id = ANY($2::text[]) OR thread_key = ANY($3::text[])');
    expect(params).toEqual(['a', [], ['t1'], ['Receipts']]);
    expect(mgr.broadcast).toHaveBeenCalledWith({ type: 'right_sidebar_updated', accountId: 'a' }, 'u');
  });

  it('broadcasts on an acted folder alone, since a moved row can no longer be found', async () => {
    getRightSidebarConfig.mockResolvedValue(['Receipts']);
    await emitSectionUpdatesIfRelevant(mgr, 'a', 'u', [], ['Receipts'], []);
    expect(mgr.broadcast).toHaveBeenCalledWith({ type: 'right_sidebar_updated', accountId: 'a' }, 'u');
    expect(query).not.toHaveBeenCalled();
  });

  it('does nothing without an account, a user, or anything acted on', async () => {
    await emitSectionUpdatesIfRelevant(mgr, null, 'u', ['<1>'], [], ['t1']);
    await emitSectionUpdatesIfRelevant(mgr, 'a', null, ['<1>'], [], ['t1']);
    await emitSectionUpdatesIfRelevant(mgr, 'a', 'u', [], [], []);
    expect(mgr.broadcast).not.toHaveBeenCalled();
  });
});
