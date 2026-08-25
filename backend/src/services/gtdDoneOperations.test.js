import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({
  withTransaction: vi.fn(),
  query: vi.fn(),
}));
vi.mock('../utils/mailUtils.js', () => ({
  resolveArchiveFolder: vi.fn(),
  isAllMailFolder: vi.fn(),
}));

import { withTransaction } from './db.js';
import { resolveArchiveFolder, isAllMailFolder } from '../utils/mailUtils.js';
import {
  advanceGtdDoneOperation,
  claimGtdDoneOperation,
  createOrLoadGtdDoneOperation,
} from './gtdDoneOperations.js';

const label = {
  id: 'label-1', account_id: 'acct-1', thread_key: 'thread-1', folder: 'Watch', uid: 4,
  is_read: true, read_revision: '2', star_revision: '0',
  folder_uid_validity: '20', folder_observation_generation: '3',
  folder_topology_identity: 'watch-incarnation',
};
const inboxA = {
  id: 'inbox-a', account_id: 'acct-1', thread_key: 'thread-1', folder: 'INBOX', uid: 7,
  is_read: false, read_revision: '1', star_revision: '0',
  folder_uid_validity: '10', folder_observation_generation: '5',
  folder_topology_identity: 'inbox-incarnation',
};
const inboxZ = { ...inboxA, id: 'inbox-z', uid: 8 };
const anchor = {
  anchor_id: 'label-1', account_id: 'acct-1', thread_key: 'thread-1',
  account: {
    id: 'acct-1', user_id: 'user-1', enabled: true,
    folder_mappings: {}, mailbox_topology_generation: '9',
  },
  plugin_config: { enabled: true, folders: { watch: 'Watch', delegated: 'Delegated' } },
  plugin_config_updated_at: '2026-08-26T10:00:00.000Z', enabled_plugins: ['gtd'],
};

describe('durable GTD Done plan', () => {
  beforeEach(() => {
    withTransaction.mockReset();
    resolveArchiveFolder.mockReset().mockResolvedValue('Archive');
    isAllMailFolder.mockReset().mockResolvedValue(false);
  });

  it('atomically persists the frozen rows, target folders, archive destination, and deterministic retry anchors', async () => {
    const tx = { query: vi.fn() };
    withTransaction.mockImplementation(callback => callback(tx));
    tx.query.mockImplementation(async (sql, params) => {
      if (sql.startsWith('SET TRANSACTION')) return { rows: [] };
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (sql.startsWith('SELECT * FROM gtd_done_operations')) return { rows: [] };
      if (sql.includes('FROM messages m') && sql.includes('anchor_id')) return { rows: [anchor] };
      if (sql.includes('ORDER BY m.folder')) return { rows: [inboxZ, label, inboxA] };
      if (sql.includes('special_use') && sql.includes('lower(name)')) return { rows: [{
        path: 'Archive', special_use: '\\Archive',
        uid_validity: '456', observation_generation: '8',
        topology_identity: 'archive-incarnation',
      }] };
      if (sql.startsWith('INSERT INTO gtd_done_operations')) return { rows: [{
        operation_key: params[0], user_id: params[1], account_id: params[2],
        acted_message_id: params[3], thread_key: params[4], intent: JSON.parse(params[5]),
        plan_digest: params[6], plan: JSON.parse(params[7]), phase: 'seen', item_index: 0, outcomes: [],
      }] };
      return { rows: [] };
    });

    const created = await createOrLoadGtdDoneOperation({
      userId: 'user-1', actedMessageId: 'label-1', intent: ['watch', 'delegated', 'watch'],
      lifecycleKey: 'done-lifecycle-1',
      deriveTargetFolders: ({ enabled, folders, states }) => {
        expect(enabled).toBe(true);
        expect(states).toEqual(['delegated', 'watch']);
        expect(folders).toMatchObject({ watch: 'Watch', delegated: 'Delegated' });
        return { folders: ['Watch', 'Delegated'] };
      },
    });

    expect(tx.query.mock.calls[0][0]).toBe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    const insertParams = tx.query.mock.calls.find(call => call[0].startsWith('INSERT INTO gtd_done_operations'))[1];
    const plan = JSON.parse(insertParams[7]);
    expect(plan.rows).toEqual([inboxA, inboxZ, label]);
    expect(plan.inboxRows.map(row => row.id)).toEqual(['inbox-z', 'inbox-a']);
    expect(plan.inboxAnchorId).toBe('inbox-a');
    expect(plan.labelRows.map(row => row.id)).toEqual(['label-1']);
    expect(plan.labelAnchorId).toBe('label-1');
    expect(plan.targetFolders).toEqual(['Watch', 'Delegated']);
    expect(plan.archiveFolder).toBe('Archive');
    expect(plan.archiveObservation).toEqual({
      folder: 'Archive', uidValidity: '456', generation: '8',
      topologyIdentity: 'archive-incarnation', isPresent: true,
    });
    expect(plan.inboxRows[0].folder_topology_identity).toBe('inbox-incarnation');
    expect(created.phase).toBe('seen');
  });

  it('loads an unfinished operation before looking up a now-moved or deleted acted row', async () => {
    const stored = {
      operation_key: 'stored-key', user_id: 'user-1', account_id: 'acct-1',
      acted_message_id: 'label-1', thread_key: 'thread-1', intent: ['watch'],
      plan_digest: 'digest', plan: {
        rows: [label],
        archiveObservation: {
          folder: 'Archive', uidValidity: '456', generation: '8', isPresent: true,
        },
      }, phase: 'archive', item_index: 1, outcomes: [],
    };
    const tx = { query: vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [stored] })
      .mockResolvedValueOnce({ rows: [{ id: 'acct-1' }] }) };
    withTransaction.mockImplementation(callback => callback(tx));

    await expect(createOrLoadGtdDoneOperation({
      userId: 'user-1', actedMessageId: 'label-1', intent: ['watch'],
      lifecycleKey: 'done-lifecycle-1',
      deriveTargetFolders: vi.fn(),
    })).resolves.toMatchObject({
      phase: 'archive', itemIndex: 1,
      plan: { archiveObservation: {
        folder: 'Archive', uidValidity: '456', generation: '8', isPresent: true,
      } },
    });
    expect(tx.query).toHaveBeenCalledTimes(4);
  });

  it('advances one item with an exact phase/index CAS and rejects a competing stale runner', async () => {
    const current = {
      key: 'stored-key', phase: 'archive', itemIndex: 0,
      plan: { rows: [] }, outcomes: [],
    };
    const tx = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    withTransaction.mockImplementation(callback => callback(tx));

    await expect(advanceGtdDoneOperation(current, 'archive', 1, { archived: true }))
      .rejects.toMatchObject({ code: 'GTD_DONE_OPERATION_SUPERSEDED', retryable: true });
    expect(tx.query.mock.calls[0][0]).toMatch(/phase = \$2 AND item_index = \$3/);
  });

  it('claims a phase cursor before provider work and refuses a simultaneous live claimant', async () => {
    const current = { key: 'stored-key', phase: 'archive', itemIndex: 0, plan: {}, outcomes: [] };
    const tx = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    withTransaction.mockImplementation(callback => callback(tx));
    await expect(claimGtdDoneOperation(current))
      .rejects.toMatchObject({ code: 'GTD_DONE_OPERATION_BUSY', retryable: true });
    expect(tx.query.mock.calls[0][0]).toMatch(/claim_expires_at IS NULL OR claim_expires_at <= NOW\(\)/);
  });

  it('rejects a missing Archive destination as a terminal configuration outcome before persisting a plan', async () => {
    const tx = { query: vi.fn() };
    withTransaction.mockImplementation(callback => callback(tx));
    tx.query.mockImplementation(async (sql) => {
      if (sql.startsWith('SET TRANSACTION') || sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (sql.startsWith('SELECT * FROM gtd_done_operations')) return { rows: [] };
      if (sql.includes('FROM messages m') && sql.includes('anchor_id')) return { rows: [anchor] };
      if (sql.includes('ORDER BY m.folder')) return { rows: [label, inboxA] };
      if (sql.includes('special_use') && sql.includes('lower(name)')) return { rows: [] };
      return { rows: [] };
    });

    await expect(createOrLoadGtdDoneOperation({
      userId: 'user-1', actedMessageId: 'label-1', intent: ['watch'],
      lifecycleKey: 'missing-archive-1', deriveTargetFolders: () => ({ folders: ['Watch'] }),
    })).rejects.toMatchObject({
      code: 'GTD_DONE_ARCHIVE_UNAVAILABLE', status: 409, retryable: false,
    });
    expect(tx.query.mock.calls.some(call => call[0].startsWith('INSERT INTO gtd_done_operations'))).toBe(false);
  });

  it('fails closed when a resolved GTD target is the frozen physical Archive destination', async () => {
    const tx = { query: vi.fn() };
    withTransaction.mockImplementation(callback => callback(tx));
    tx.query.mockImplementation(async (sql) => {
      if (sql.startsWith('SET TRANSACTION') || sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (sql.startsWith('SELECT * FROM gtd_done_operations')) return { rows: [] };
      if (sql.includes('FROM messages m') && sql.includes('anchor_id')) return { rows: [anchor] };
      if (sql.includes('ORDER BY m.folder')) return { rows: [{ ...label, folder: 'DoneVault' }, inboxA] };
      if (sql.includes('special_use') && sql.includes('lower(name)')) {
        return { rows: [{ path: 'DoneVault', special_use: '\\Archive', uid_validity: '30', observation_generation: '4' }] };
      }
      return { rows: [] };
    });

    await expect(createOrLoadGtdDoneOperation({
      userId: 'user-1', actedMessageId: 'label-1', intent: ['watch'],
      lifecycleKey: 'same-folder-1', deriveTargetFolders: () => ({ folders: ['DoneVault'] }),
    })).rejects.toMatchObject({
      code: 'GTD_DONE_TARGET_IS_ARCHIVE', status: 400, retryable: false,
    });
  });
});
