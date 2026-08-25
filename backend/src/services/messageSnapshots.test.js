import { describe, expect, it, vi } from 'vitest';

import {
  MessageSnapshotError,
  assertLiveMessageSnapshots,
  captureLiveMessageSnapshot,
  revalidateLiveMessageSnapshotGroups,
  revalidateLiveMessageSnapshots,
  snapshotFromMessageRow,
} from './messageSnapshots.js';

const row = {
  id: 'row-1', account_id: 'acct-1', uid: '7', folder: 'INBOX',
  folder_uid_validity: '101', folder_observation_generation: '9',
  read_revision: '3', star_revision: '5',
};

describe('non-advancing live message snapshots', () => {
  it('revalidates publication snapshots inside a checked transaction', async () => {
    const snapshot = snapshotFromMessageRow(row);
    const tx = { query: vi.fn().mockResolvedValue({ rows: [row] }) };
    const runTransaction = vi.fn(callback => callback(tx));

    await expect(revalidateLiveMessageSnapshots('acct-1', [snapshot], { runTransaction }))
      .resolves.toEqual([snapshot]);
    expect(runTransaction).toHaveBeenCalledOnce();
    expect(tx.query.mock.calls[0][0]).toMatch(/FOR SHARE OF f, m/);
  });

  it('holds one checked transaction across publication snapshots from multiple accounts', async () => {
    const first = snapshotFromMessageRow(row);
    const second = { ...first, id: 'row-2', accountId: 'acct-2', uid: 8 };
    const tx = { query: vi.fn()
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [{ ...row, id: 'row-2', account_id: 'acct-2', uid: '8' }] }) };
    const runTransaction = vi.fn(callback => callback(tx));

    await expect(revalidateLiveMessageSnapshotGroups(new Map([
      ['acct-1', [first]], ['acct-2', [second]],
    ]), { runTransaction })).resolves.toBeUndefined();
    expect(runTransaction).toHaveBeenCalledOnce();
    expect(tx.query).toHaveBeenCalledTimes(2);
  });

  it('normalizes the stable row, UID epoch, folder generation, and flag revisions', () => {
    expect(snapshotFromMessageRow(row)).toEqual({
      id: 'row-1', accountId: 'acct-1', uid: 7, folder: 'INBOX',
      uidValidity: '101', folderGeneration: '9', readRevision: 3, starRevision: 5,
    });
  });

  it('captures only an owned live metadata-complete row without advancing any generation', async () => {
    const runQuery = vi.fn().mockResolvedValue({ rows: [row] });

    await expect(captureLiveMessageSnapshot('row-1', {
      userId: 'user-1', runQuery,
    })).resolves.toEqual(snapshotFromMessageRow(row));

    const [sql, params] = runQuery.mock.calls[0];
    expect(sql).toMatch(/JOIN email_accounts a/);
    expect(sql).toMatch(/a\.user_id = \$2/);
    expect(sql).toMatch(/JOIN folders f[\s\S]*f\.is_present = true[\s\S]*f\.uid_validity IS NOT NULL/);
    expect(sql).toMatch(/m\.is_deleted = false[\s\S]*m\.metadata_complete = true/);
    expect(sql).not.toMatch(/UPDATE[\s\S]*observation_generation/i);
    expect(params).toEqual(['row-1', 'user-1']);
  });

  it('rejects incomplete, deleted, orphaned, absent, and null-epoch rows', async () => {
    const runQuery = vi.fn().mockResolvedValue({ rows: [] });
    await expect(captureLiveMessageSnapshot('row-1', { accountId: 'acct-1', runQuery }))
      .rejects.toMatchObject({ code: 'MESSAGE_SNAPSHOT_NOT_ACTIONABLE' });
  });

  it('locks and validates the same exact row and folder token around a provider read', async () => {
    const tx = { query: vi.fn().mockResolvedValue({ rows: [row] }) };
    const snapshot = snapshotFromMessageRow(row);

    await expect(assertLiveMessageSnapshots(tx, 'acct-1', [snapshot])).resolves.toEqual([snapshot]);
    const [sql, params] = tx.query.mock.calls[0];
    expect(sql).toMatch(/m\.id = expected\.id/);
    expect(sql).toMatch(/m\.uid = expected\.uid/);
    expect(sql).toMatch(/m\.folder = expected\.folder/);
    expect(sql).toMatch(/f\.uid_validity = expected\.uid_validity/);
    expect(sql).toMatch(/f\.observation_generation = expected\.folder_generation/);
    expect(sql).toMatch(/m\.read_revision = expected\.read_revision/);
    expect(sql).toMatch(/m\.star_revision = expected\.star_revision/);
    expect(sql).toMatch(/FOR SHARE OF f, m/);
    expect(params).toEqual(['acct-1', JSON.stringify([{
      id: 'row-1', uid: 7, folder: 'INBOX', uid_validity: '101', folder_generation: '9',
      read_revision: 3, star_revision: 5,
    }])]);
  });

  it('discards a result when any bulk snapshot row relocated or was superseded', async () => {
    const tx = { query: vi.fn().mockResolvedValue({ rows: [row] }) };
    const snapshots = [
      snapshotFromMessageRow(row),
      { ...snapshotFromMessageRow(row), id: 'row-2', uid: 8 },
    ];

    await expect(assertLiveMessageSnapshots(tx, 'acct-1', snapshots)).rejects.toBeInstanceOf(MessageSnapshotError);
    await expect(assertLiveMessageSnapshots(tx, 'acct-1', snapshots)).rejects.toMatchObject({
      code: 'MESSAGE_SNAPSHOT_SUPERSEDED', retryable: true,
    });
  });
});
