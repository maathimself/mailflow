import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(callback => callback({ query })),
}));

import { query, withTransaction } from './db.js';
import {
  getMessagesByThreadKeys,
  listLiveThreadRows,
  loadOwnedMessage,
  loadPluginThreadSnapshot,
  validatePluginThreadSnapshot,
} from './mailAccess.js';
import * as mailAccess from './mailAccess.js';

describe('loadOwnedMessage', () => {
  beforeEach(() => query.mockReset());

  it('hides deleted or metadata-incomplete anchors from plugin mutations', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    await expect(loadOwnedMessage('user-1', 'row-1')).resolves.toBeNull();

    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/m\.is_deleted = false/);
    expect(sql).toMatch(/m\.metadata_complete = true/);
    expect(sql).toMatch(/JOIN folders f/);
    expect(sql).toMatch(/f\.is_present = true/);
    expect(sql).toMatch(/f\.uid_validity IS NOT NULL/);
    expect(sql).toMatch(/f\.uid_validity AS folder_uid_validity/);
    expect(sql).toMatch(/f\.observation_generation AS folder_observation_generation/);
    expect(sql).toMatch(/m\.read_revision/);
    expect(sql).toMatch(/m\.star_revision/);
    expect(params).toEqual(['row-1', 'user-1']);
  });
});

describe('getMessagesByThreadKeys', () => {
  beforeEach(() => query.mockReset());

  it('returns only complete rows backed by a present epochful folder', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await getMessagesByThreadKeys('acct-1', ['thread-1']);
    const [sql] = query.mock.calls[0];
    expect(sql).toMatch(/JOIN folders f/);
    expect(sql).toMatch(/metadata_complete = true/);
    expect(sql).toMatch(/f\.is_present = true/);
    expect(sql).toMatch(/f\.uid_validity IS NOT NULL/);
    expect(sql).toMatch(/folder_observation_generation/);
  });
});

describe('listLiveThreadRows', () => {
  beforeEach(() => query.mockReset());

  it('loads only live rows from the acted account and thread with a bounded field set', async () => {
    const rows = [{
      id: 'row-1', account_id: 'acct-1', thread_key: 'thread-1', uid: 7,
      folder: 'INBOX', message_id: null, is_read: false, folder_uid_validity: 123,
    }];
    query.mockResolvedValueOnce({ rows });

    await expect(listLiveThreadRows('acct-1', 'thread-1')).resolves.toEqual(rows);

    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/account_id = \$1/);
    expect(sql).toMatch(/thread_key = \$2/);
    expect(sql).toMatch(/is_deleted = false/);
    expect(sql).toMatch(/metadata_complete = true/);
    expect(sql).toMatch(/JOIN folders f/);
    expect(sql).toMatch(/f\.uid_validity AS folder_uid_validity/);
    expect(sql).toMatch(/f\.observation_generation AS folder_observation_generation/);
    expect(sql).toMatch(/m\.read_revision/);
    expect(sql).toMatch(/m\.star_revision/);
    expect(sql).toMatch(/f\.is_present = true/);
    expect(sql).toMatch(/f\.uid_validity IS NOT NULL/);
    expect(sql).not.toMatch(/SELECT \*/);
    expect(params).toEqual(['acct-1', 'thread-1']);
    expect(sql).toMatch(/ORDER BY m\.folder, m\.uid, m\.id/);
  });

  it('returns an empty immutable worklist when the thread no longer has live rows', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await expect(listLiveThreadRows('acct-1', 'thread-1')).resolves.toEqual([]);
  });
});

describe('GTD gist message-field snapshots', () => {
  const snapshot = {
    id: 'row-1', uid: '7', folder: 'Watch', subject: 'Subject',
    from_name: 'Alice', from_email: 'alice@example.com', content: 'Body',
    read_revision: '4', star_revision: '2',
    folder_uid_validity: '88', folder_observation_generation: '6',
  };

  beforeEach(() => query.mockReset());

  it('loads only live metadata-complete rows and returns the exact row and folder revisions', async () => {
    query.mockResolvedValueOnce({ rows: [snapshot] });

    await expect(mailAccess.getMessageFields('acct-1', ['row-1'])).resolves.toEqual([snapshot]);

    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/JOIN folders f/);
    expect(sql).toMatch(/m\.is_deleted = false/);
    expect(sql).toMatch(/m\.metadata_complete = true/);
    expect(sql).toMatch(/f\.is_present = true/);
    expect(sql).toMatch(/f\.uid_validity IS NOT NULL/);
    expect(sql).toMatch(/m\.uid/);
    expect(sql).toMatch(/m\.folder/);
    expect(sql).toMatch(/m\.read_revision/);
    expect(sql).toMatch(/m\.star_revision/);
    expect(sql).toMatch(/f\.uid_validity AS folder_uid_validity/);
    expect(sql).toMatch(/f\.observation_generation AS folder_observation_generation/);
    expect(params).toEqual([['row-1'], 'acct-1']);
  });

  it('revalidates every exact identity, revision, epoch, and summarized field fail closed', async () => {
    expect(mailAccess.validateMessageFieldsSnapshot).toBeTypeOf('function');
    query.mockResolvedValueOnce({ rows: [] });

    await expect(mailAccess.validateMessageFieldsSnapshot('acct-1', snapshot)).resolves.toBe(false);

    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/m\.is_deleted = false/);
    expect(sql).toMatch(/m\.metadata_complete = true/);
    expect(sql).toMatch(/f\.is_present = true/);
    expect(sql).toMatch(/f\.uid_validity IS NOT NULL/);
    expect(sql).toMatch(/m\.uid = \$3/);
    expect(sql).toMatch(/m\.folder = \$4/);
    expect(sql).toMatch(/m\.read_revision = \$5/);
    expect(sql).toMatch(/m\.star_revision = \$6/);
    expect(sql).toMatch(/f\.uid_validity = \$7/);
    expect(sql).toMatch(/f\.observation_generation = \$8/);
    expect(sql).toMatch(/m\.subject IS NOT DISTINCT FROM \$9/);
    expect(sql).toMatch(/COALESCE\(NULLIF\(m\.body_text, ''\), m\.snippet\) IS NOT DISTINCT FROM \$12/);
    expect(params).toEqual([
      'acct-1', 'row-1', '7', 'Watch', '4', '2', '88', '6',
      'Subject', 'Alice', 'alice@example.com', 'Body',
    ]);
  });

  it('writes a plugin annotation only while the exact live snapshot still matches', async () => {
    expect(mailAccess.setMessageAnnotationForSnapshot).toBeTypeOf('function');
    query.mockResolvedValueOnce({ rowCount: 0 });

    await expect(mailAccess.setMessageAnnotationForSnapshot(
      'acct-1', snapshot, 'gtd', { gist: 'Waiting' },
    )).resolves.toBe(0);

    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/UPDATE messages m/);
    expect(sql).toMatch(/FROM folders f/);
    expect(sql).toMatch(/m\.is_deleted = false/);
    expect(sql).toMatch(/m\.metadata_complete = true/);
    expect(sql).toMatch(/f\.is_present = true/);
    expect(sql).toMatch(/f\.uid_validity IS NOT NULL/);
    expect(sql).toMatch(/m\.read_revision = \$7/);
    expect(sql).toMatch(/f\.observation_generation = \$10/);
    expect(sql).toMatch(/m\.subject IS NOT DISTINCT FROM \$11/);
    expect(sql).toMatch(/COALESCE\(NULLIF\(m\.body_text, ''\), m\.snippet\) IS NOT DISTINCT FROM \$14/);
    expect(params).toEqual([
      'acct-1', 'row-1', 'gtd', JSON.stringify({ gist: 'Waiting' }),
      '7', 'Watch', '4', '2', '88', '6', 'Subject', 'Alice', 'alice@example.com', 'Body',
    ]);
  });
});

describe('plugin thread mutation snapshot', () => {
  const anchor = {
    anchor_id: 'row-1', account_id: 'acct-1', thread_key: 'thread-1',
    account: { id: 'acct-1', user_id: 'user-1', mailbox_topology_generation: '7', folder_mappings: {} },
    plugin_config: { enabled: true, folders: { watch: 'Waiting' } },
    plugin_config_updated_at: '2026-08-26T12:00:00.000Z',
    enabled_plugins: ['gtd'],
  };
  const rows = [{
    id: 'row-1', account_id: 'acct-1', thread_key: 'thread-1', uid: 9,
    folder: 'Waiting', message_id: '<x@example>', is_read: false,
    read_revision: '4', star_revision: '2', folder_uid_validity: '88',
    folder_observation_generation: '6',
  }];

  beforeEach(() => {
    query.mockReset();
    withTransaction.mockReset();
    withTransaction.mockImplementation(callback => callback({ query }));
  });

  it('freezes ownership, plugin config, thread identity, and exact rows in one repeatable-read snapshot', async () => {
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [anchor] })
      .mockResolvedValueOnce({ rows });

    const snapshot = await loadPluginThreadSnapshot('user-1', 'row-1', 'gtd');

    expect(withTransaction).toHaveBeenCalledOnce();
    expect(query.mock.calls[0][0]).toBe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(query.mock.calls[1][0]).toMatch(/a\.user_id = \$2/);
    expect(query.mock.calls[1][0]).toMatch(/pac\.plugin_id = \$3/);
    expect(query.mock.calls[1][0]).toMatch(/f\.is_present = true/);
    expect(query.mock.calls[2][0]).toMatch(/m\.metadata_complete = true/);
    expect(query.mock.calls[2][0]).toMatch(/ORDER BY m\.folder, m\.uid, m\.id/);
    expect(snapshot).toMatchObject({
      userId: 'user-1', pluginId: 'gtd', anchorId: 'row-1',
      account: anchor.account, config: anchor.plugin_config, activated: true, rows,
    });
    expect(snapshot.version).toEqual(expect.any(String));
  });

  it('rejects a config, thread-row revision, or folder-epoch change before destructive work', async () => {
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [anchor] })
      .mockResolvedValueOnce({ rows })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        ...anchor,
        plugin_config_updated_at: '2026-08-26T12:01:00.000Z',
      }] })
      .mockResolvedValueOnce({ rows: [{
        ...rows[0], read_revision: '5', folder_observation_generation: '7',
      }] });

    const snapshot = await loadPluginThreadSnapshot('user-1', 'row-1', 'gtd');
    await expect(validatePluginThreadSnapshot(snapshot)).rejects.toMatchObject({
      code: 'PLUGIN_THREAD_SNAPSHOT_SUPERSEDED', retryable: true,
    });
  });
});
