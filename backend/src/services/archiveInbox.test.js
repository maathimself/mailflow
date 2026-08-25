import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => {
  const query = vi.fn();
  const lockQuery = vi.fn();
  return {
    query,
    lockQuery,
    withTransaction: vi.fn(callback => callback({
      query: (sql, params) => /SELECT path, uid_validity, observation_generation/.test(sql)
        ? lockQuery(sql, params)
        : query(sql, params),
    })),
  };
});
vi.mock('../utils/mailUtils.js', async (importOriginal) => ({
  ...(await importOriginal()),
  resolveArchiveFolder: vi.fn(),
  isAllMailFolder: vi.fn(),
  adjustFolderCounts: vi.fn(),
}));

import { query, lockQuery, withTransaction } from './db.js';
import { resolveArchiveFolder, isAllMailFolder, adjustFolderCounts } from '../utils/mailUtils.js';
import { archiveInboxCopy } from './archiveInbox.js';

const account = { id: 'acct-1', folder_mappings: {} };
const row = {
  id: 'row-1', account_id: 'acct-1', uid: 7, folder: 'INBOX',
  message_id: '<m@x>', folder_uid_validity: 123,
  folder_observation_generation: 4, read_revision: 2, star_revision: 3,
  folder_topology_identity: 'inbox-incarnation',
};

function manager() {
  const moveMessage = vi.fn();
  return {
    moveMessage,
    moveMessageWithReceipt: vi.fn(async (...args) => {
      const moved = await moveMessage(...args);
      if (moved && typeof moved === 'object') return moved;
      return {
        folder: args[3], uid: moved, uidValidity: '456',
        sourceToken: { folder: 'INBOX', uid: 7, uidValidity: '123', generation: '4' },
        destinationToken: { folder: args[3], uidValidity: '456', generation: '8' },
      };
    }),
    findUidByRecoveryKeyword: vi.fn(),
    clearMoveRecoveryKeyword: vi.fn(),
    _guardMoveUid: vi.fn(),
    _unguardMoveUid: vi.fn(),
  };
}

beforeEach(() => {
  query.mockReset();
  lockQuery.mockReset().mockResolvedValue({ rows: [
    { path: 'Archive', uid_validity: 456, observation_generation: 8 },
    { path: 'INBOX', uid_validity: 123, observation_generation: 4 },
  ] });
  withTransaction.mockReset();
  withTransaction.mockImplementation(callback => callback({
    query: (sql, params) => /SELECT path, uid_validity, observation_generation/.test(sql)
      ? lockQuery(sql, params)
      : query(sql, params),
  }));
  resolveArchiveFolder.mockReset().mockResolvedValue('Archive');
  isAllMailFolder.mockReset().mockResolvedValue(false);
  adjustFolderCounts.mockReset();
});

describe('archiveInboxCopy race outcomes', () => {
  it('reports missing archive configuration as a skipped target', async () => {
    resolveArchiveFolder.mockResolvedValueOnce(null);
    await expect(archiveInboxCopy(manager(), account, row)).resolves.toEqual({
      archived: false,
      alreadyGone: false,
      noArchiveFolder: true,
    });
  });

  it('fails before provider work when the source snapshot has no exact UIDVALIDITY', async () => {
    const imap = manager();
    const epochless = { ...row };
    delete epochless.folder_uid_validity;

    await expect(archiveInboxCopy(imap, account, epochless)).rejects.toMatchObject({
      code: 'ARCHIVE_SOURCE_OBSERVATION_REQUIRED', retryable: true, uncertain: true,
    });
    expect(imap.moveMessage).not.toHaveBeenCalled();
    expect(imap.moveMessageWithReceipt).not.toHaveBeenCalled();
  });

  it('fails before provider work when the source snapshot has no folder generation', async () => {
    const imap = manager();
    const generationless = { ...row };
    delete generationless.folder_observation_generation;

    await expect(archiveInboxCopy(imap, account, generationless)).rejects.toMatchObject({
      code: 'ARCHIVE_SOURCE_OBSERVATION_REQUIRED', retryable: true, uncertain: true,
    });
    expect(imap.moveMessage).not.toHaveBeenCalled();
    expect(imap.moveMessageWithReceipt).not.toHaveBeenCalled();
  });

  it('never turns provider uncertainty into success from DB source disappearance', async () => {
    const imap = manager();
    const providerError = new Error('messageMove returned false');
    imap.moveMessage.mockRejectedValueOnce(providerError);
    query.mockResolvedValueOnce({ rows: [] });

    await expect(archiveInboxCopy(imap, account, row)).rejects.toBe(providerError);
    expect(query).not.toHaveBeenCalled();
  });

  it('never suppresses a snapshot epoch change as concurrent completion', async () => {
    const imap = manager();
    const err = Object.assign(new Error('Snapshot UIDVALIDITY changed'), {
      code: 'SNAPSHOT_UIDVALIDITY_CHANGED',
    });
    imap.moveMessage.mockRejectedValueOnce(err);
    query.mockResolvedValue({ rows: [] });

    await expect(archiveInboxCopy(imap, account, row)).rejects.toBe(err);
    expect(query).not.toHaveBeenCalled();
  });

  it('does not accept an IMAP failure when the same row id remains in INBOX under a healed UID', async () => {
    const imap = manager();
    imap.moveMessage.mockRejectedValueOnce(new Error('no matching uid 7'));
    query.mockImplementation(async (sql) => ({
      rows: sql.includes('uid = $3') ? [] : [{ id: 'row-1' }],
    }));

    await expect(archiveInboxCopy(imap, account, row)).rejects.toThrow('no matching uid 7');
  });

  it('keeps a real IMAP failure visible while the exact snapshot row remains in INBOX', async () => {
    const imap = manager();
    imap.moveMessage.mockRejectedValueOnce(new Error('provider down'));
    query.mockResolvedValue({ rows: [{ id: 'row-1' }] });
    await expect(archiveInboxCopy(imap, account, row)).rejects.toThrow('provider down');
  });

  it('does not poll DB disappearance to promote an uncertain provider move', async () => {
    const imap = manager();
    const providerError = new Error('messageMove returned false');
    imap.moveMessage.mockRejectedValueOnce(providerError);
    query
      .mockResolvedValueOnce({ rows: [{ id: 'row-1' }] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(archiveInboxCopy(imap, account, row)).rejects.toBe(providerError);
    expect(query).not.toHaveBeenCalled();
  });

  it('uses the durable operation receipt when Message-ID is absent', async () => {
    const imap = manager();
    const headerless = { ...row, message_id: null };
    imap.moveMessage.mockResolvedValueOnce(77);
    query.mockResolvedValueOnce({ rowCount: 1 });

    await expect(archiveInboxCopy(imap, account, headerless)).resolves.toEqual({
      archived: true,
      alreadyGone: false,
      noArchiveFolder: false,
    });

    expect(imap.moveMessageWithReceipt).toHaveBeenCalledWith(
      account, 7, 'INBOX', 'Archive', {
        expectedUidValidity: 123, operationKey: 'archive:row-1',
        snapshot: {
          id: 'row-1', accountId: 'acct-1', uid: 7, folder: 'INBOX',
          uidValidity: '123', folderGeneration: '4', readRevision: 2, starRevision: 3,
        },
        materialize: expect.any(Function),
      },
    );
    expect(imap.findUidByRecoveryKeyword).not.toHaveBeenCalled();
    expect(imap.clearMoveRecoveryKeyword).not.toHaveBeenCalled();
  });

  it('carries frozen folder incarnation identities into GTD archive recovery tokens', async () => {
    const imap = manager();
    imap.moveMessage.mockResolvedValueOnce(77);

    await archiveInboxCopy(imap, account, row, {
      archiveFolder: 'Archive', archiveAllMail: false,
      archiveObservation: {
        folder: 'Archive', uidValidity: '456', generation: '8',
        topologyIdentity: 'archive-incarnation', isPresent: true,
      },
    });

    expect(imap.moveMessageWithReceipt).toHaveBeenCalledWith(
      account, 7, 'INBOX', 'Archive', expect.objectContaining({
        operationTokens: [
          {
            folder: 'INBOX', uidValidity: '123', generation: '4',
            topologyIdentity: 'inbox-incarnation', isPresent: true,
          },
          {
            folder: 'Archive', uidValidity: '456', generation: '8',
            topologyIdentity: 'archive-incarnation', isPresent: true,
          },
        ],
      }),
    );
  });

  it('does not require a recovery keyword for a headerless Gmail All Mail archive', async () => {
    const imap = manager();
    const headerless = { ...row, message_id: null };
    isAllMailFolder.mockResolvedValueOnce(true);
    imap.moveMessage.mockResolvedValueOnce({
      uid: 91,
      sourceToken: { folder: 'INBOX', uid: 7, uidValidity: '123', generation: '4' },
    });
    query.mockResolvedValueOnce({ rowCount: 1 });

    await expect(archiveInboxCopy(imap, account, headerless)).resolves.toMatchObject({ archived: true });

    expect(imap.moveMessage).toHaveBeenCalledWith(
      account, 7, 'INBOX', 'Archive', {
        expectedUidValidity: 123, operationKey: 'archive:row-1', returnReceipt: true,
        snapshot: {
          id: 'row-1', accountId: 'acct-1', uid: 7, folder: 'INBOX',
          uidValidity: '123', folderGeneration: '4', readRevision: 2, starRevision: 3,
        },
        materialize: expect.any(Function),
      }
    );
    expect(imap.findUidByRecoveryKeyword).not.toHaveBeenCalled();
    expect(imap.clearMoveRecoveryKeyword).not.toHaveBeenCalled();
  });
});
