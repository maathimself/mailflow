import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/mailUtils.js', async (importOriginal) => ({
  ...(await importOriginal()),
  adjustFolderCounts: vi.fn(),
}));

import { adjustFolderCounts } from '../utils/mailUtils.js';
import { materializeArchiveReceipt, mergeArchiveRows } from './archiveInbox.js';

const sourceToken = {
  folder: 'INBOX', uid: 7, uidValidity: '101', generation: '4',
};
const destinationToken = {
  folder: 'Archive', uidValidity: '202', generation: '8',
};
const receipt = {
  folder: 'Archive', uid: 88, uidValidity: '202', marker: '$MailFlowOp-test',
  sourceToken, destinationToken,
};
const operation = {
  id: 'operation-1', kind: 'move', accountId: 'acct-1', marker: '$MailFlowOp-test',
  source: sourceToken, destination: destinationToken,
};
const snapshot = {
  id: '00000000-0000-4000-8000-000000000001', account_id: 'acct-1',
  folder: 'INBOX', uid: 7, folder_uid_validity: 101,
};

const sourceRow = {
  ...snapshot,
  read_revision: 3,
  star_revision: 5,
  is_deleted: false,
  metadata_complete: true,
  is_read: false,
  is_starred: true,
  read_changed_at: new Date('2026-08-25T00:00:00Z'),
  star_changed_at: new Date('2026-08-25T00:01:00Z'),
  category: 'primary',
  spam_score_sa: 1,
  spam_score_ml: 2,
  spam_verdict: 'ham',
  spam_analyzed_at: new Date('2026-08-25T00:02:00Z'),
  spam_details: { sourceOnly: true, conflict: 'source' },
  spam_user_override: 'ham',
  unsubscribed_at: new Date('2026-08-25T00:03:00Z'),
  plugin_annotations: {
    gtd: { gist: 'source gist', sourceOnly: true },
    sourcePlugin: { kept: true },
  },
  snippet: 'source snippet',
  snippet_attempted_at: new Date('2026-08-25T00:04:00Z'),
  body_text: 'source body',
  body_html: null,
  attachments: [],
  message_id: '<source@example.test>',
  subject: 'source subject',
  from_name: 'Source Name',
  from_email: 'source@example.test',
  to_addresses: [],
  cc_addresses: [],
  reply_to: [],
  in_reply_to: null,
  thread_references: null,
  thread_id: 'source-thread',
  date: new Date('2026-08-24T00:00:00Z'),
  has_attachments: false,
  flags: ['\\Flagged'],
  is_bulk: false,
  list_unsubscribe: null,
  list_unsubscribe_post: null,
  delivery_addresses: null,
  sender_name: null,
  sender_email: null,
};

const liveOccupant = {
  ...sourceRow,
  id: '00000000-0000-4000-8000-000000000002',
  folder: 'Archive',
  uid: 88,
  is_read: true,
  is_starred: false,
  category: 'promotion',
  spam_score_sa: 9,
  spam_details: { destinationOnly: true, conflict: 'destination' },
  spam_user_override: 'spam',
  unsubscribed_at: new Date('2026-08-26T00:00:00Z'),
  plugin_annotations: {
    gtd: { gist: 'destination gist', destinationOnly: true },
    destinationPlugin: { kept: true },
  },
  snippet: 'destination snippet',
  body_text: null,
  body_html: '<p>destination body</p>',
  attachments: [{ filename: 'receipt.pdf' }],
  message_id: '<destination@example.test>',
  subject: 'destination subject',
  from_name: 'Destination Name',
  from_email: 'destination@example.test',
  to_addresses: [{ address: 'to@example.test' }],
  cc_addresses: [{ address: 'cc@example.test' }],
  reply_to: [{ address: 'reply@example.test' }],
  in_reply_to: '<parent@example.test>',
  thread_references: '<root@example.test>',
  thread_id: 'destination-thread',
  date: new Date('2026-08-26T00:00:00Z'),
  has_attachments: true,
  flags: ['\\Seen', '$MailFlowOp-test'],
  is_bulk: true,
  list_unsubscribe: '<https://example.test/unsubscribe>',
  list_unsubscribe_post: 'List-Unsubscribe=One-Click',
  delivery_addresses: ['alias@example.test'],
  sender_name: 'Submitting Service',
  sender_email: 'submitter@example.test',
};

const folderRows = [
  { path: 'Archive', uid_validity: 202, observation_generation: 8, is_present: true },
  { path: 'INBOX', uid_validity: 101, observation_generation: 4, is_present: true },
];

function transaction({
  source = sourceRow,
  occupant = null,
  folders = folderRows,
  updateRow = null,
  updateRowCount = 1,
  concurrentWinner = null,
  deliveries = [],
  failOn = null,
} = {}) {
  const query = vi.fn(async (sql, params) => {
    if (/SELECT path, uid_validity, observation_generation, is_present/.test(sql)) {
      if (failOn === 'folders') throw new Error('folder lock failed');
      return { rows: folders };
    }
    if (/SELECT m\.\*/.test(sql)) {
      return { rows: [source, occupant].filter(Boolean) };
    }
    if (/FROM message_flag_deliveries/.test(sql)) return { rows: deliveries };
    if (/DELETE FROM messages/.test(sql)) {
      if (failOn === 'delete') throw new Error('duplicate delete failed');
      const deleted = params?.[0] === source?.id ? source : occupant;
      return { rowCount: deleted ? 1 : 0, rows: deleted ? [deleted] : [] };
    }
    if (/UPDATE messages/.test(sql)) {
      if (failOn === 'update') throw new Error('source update failed');
      const row = updateRow || { ...source, folder: 'Archive', uid: 88 };
      return { rowCount: updateRowCount, rows: updateRowCount ? [row] : [] };
    }
    if (/UPDATE message_flag_deliveries/.test(sql)) return { rowCount: 1, rows: [] };
    if (/SELECT id, account_id, folder, uid/.test(sql)) {
      return { rows: concurrentWinner ? [concurrentWinner] : [] };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  return { query };
}

function materialize(tx, overrides = {}) {
  return materializeArchiveReceipt(tx, {
    accountId: 'acct-1', sourceSnapshot: snapshot, destinationFolder: 'Archive',
    receipt, operation, allMail: false, ...overrides,
  });
}

describe('archive receipt validation', () => {
  beforeEach(() => adjustFolderCounts.mockReset());

  it('rejects a receipt for a different exact source before querying', async () => {
    const tx = { query: vi.fn() };

    await expect(materializeArchiveReceipt(tx, {
      accountId: 'acct-1', sourceSnapshot: snapshot, destinationFolder: 'Archive',
      receipt: { ...receipt, sourceToken: { ...sourceToken, uid: 8 } }, operation,
    })).rejects.toMatchObject({
      code: 'PROVIDER_RECEIPT_IDENTITY_MISMATCH', retryable: true, uncertain: true,
    });

    expect(tx.query).not.toHaveBeenCalled();
    expect(adjustFolderCounts).not.toHaveBeenCalled();
  });

  it.each([
    ['operation kind', { operation: { ...operation, kind: 'copy' } }],
    ['operation account', { operation: { ...operation, accountId: 'acct-2' } }],
    ['operation marker', { operation: { ...operation, marker: '$other' } }],
    ['missing persisted marker', {
      operation: { ...operation, marker: undefined }, receipt: { ...receipt, marker: undefined },
    }],
    ['source snapshot account', {
      sourceSnapshot: { ...snapshot, account_id: 'acct-2' },
    }],
    ['destination UIDVALIDITY', { receipt: { ...receipt, uidValidity: '999' } }],
    ['destination generation', {
      receipt: { ...receipt, destinationToken: { ...destinationToken, generation: '9' } },
    }],
  ])('rejects a mismatched %s before locking rows', async (_label, overrides) => {
    const tx = transaction();
    await expect(materialize(tx, overrides)).rejects.toMatchObject({
      code: 'PROVIDER_RECEIPT_IDENTITY_MISMATCH', retryable: true, uncertain: true,
    });
    expect(tx.query).not.toHaveBeenCalled();
  });

  it.each([
    ['missing source folder', folderRows.filter(row => row.path !== 'INBOX')],
    ['absent source folder', folderRows.map(row => row.path === 'INBOX' ? { ...row, is_present: false } : row)],
    ['null destination epoch', folderRows.map(row => row.path === 'Archive' ? { ...row, uid_validity: null } : row)],
    ['superseded destination generation', folderRows.map(row => row.path === 'Archive' ? { ...row, observation_generation: 9 } : row)],
  ])('fails closed on %s before locking messages', async (_label, folders) => {
    const tx = transaction({ folders });
    await expect(materialize(tx)).rejects.toMatchObject({
      code: 'FOLDER_OBSERVATION_SUPERSEDED', retryable: true, uncertain: true,
    });
    expect(tx.query).toHaveBeenCalledOnce();
  });

  it('validates both tokens when source and destination use the same folder', async () => {
    const sameReceipt = {
      ...receipt,
      folder: 'INBOX',
      uidValidity: '101',
      destinationToken: { folder: 'INBOX', uidValidity: '101', generation: '9' },
    };
    const sameOperation = {
      ...operation,
      destination: sameReceipt.destinationToken,
    };
    const tx = transaction({ folders: [folderRows[1]] });

    await expect(materialize(tx, {
      destinationFolder: 'INBOX', receipt: sameReceipt, operation: sameOperation,
    })).rejects.toMatchObject({ code: 'FOLDER_OBSERVATION_SUPERSEDED' });
    expect(tx.query).toHaveBeenCalledOnce();
  });
});

describe('archive identity and annotation merge', () => {
  it('keeps source-local conflicts, destination-only annotations, and live provider enrichment', () => {
    expect(mergeArchiveRows(sourceRow, liveOccupant)).toMatchObject({
      id: sourceRow.id,
      is_read: false,
      is_starred: true,
      read_changed_at: sourceRow.read_changed_at,
      star_changed_at: sourceRow.star_changed_at,
      category: 'primary',
      spam_score_sa: 1,
      spam_user_override: 'ham',
      unsubscribed_at: sourceRow.unsubscribed_at,
      spam_details: {
        sourceOnly: true, destinationOnly: true, conflict: 'source',
      },
      plugin_annotations: {
        gtd: { gist: 'source gist', sourceOnly: true, destinationOnly: true },
        sourcePlugin: { kept: true },
        destinationPlugin: { kept: true },
      },
      snippet: 'source snippet',
      snippet_attempted_at: sourceRow.snippet_attempted_at,
      body_text: 'source body',
      body_html: '<p>destination body</p>',
      attachments: [{ filename: 'receipt.pdf' }],
      message_id: '<destination@example.test>',
      subject: 'destination subject',
      from_email: 'destination@example.test',
      flags: ['\\Seen', '$MailFlowOp-test'],
      delivery_addresses: ['alias@example.test'],
      sender_email: 'submitter@example.test',
      thread_id: 'source-thread',
      metadata_complete: true,
      is_deleted: false,
    });
  });

  it.each([
    ['flags', []],
    ['to_addresses', []],
    ['cc_addresses', []],
    ['reply_to', []],
    ['in_reply_to', null],
    ['thread_references', null],
    ['list_unsubscribe', null],
    ['list_unsubscribe_post', ''],
    ['delivery_addresses', []],
    ['sender_name', null],
    ['sender_email', null],
    ['has_attachments', false],
  ])('uses an authoritative empty destination %s to clear stale source provider data', (
    field, destinationValue,
  ) => {
    const staleSource = {
      ...sourceRow,
      [field]: Array.isArray(destinationValue) ? [{ stale: true }] : 'stale provider value',
    };
    const freshDestination = { ...liveOccupant, [field]: destinationValue };

    const merged = mergeArchiveRows(staleSource, freshDestination);

    expect(merged[field]).toEqual(destinationValue);
    expect(merged.category).toBe(staleSource.category);
    expect(merged.body_text).toBe(staleSource.body_text);
    expect(merged.plugin_annotations.gtd.gist).toBe('source gist');
  });
});

describe('archive occupant materialization', () => {
  beforeEach(() => adjustFolderCounts.mockReset().mockResolvedValue(undefined));

  it('relocates durable desired-flag delivery coordinates with the exact moved row', async () => {
    const tx = transaction();

    await materialize(tx);

    const delivery = tx.query.mock.calls.find(([sql]) => /UPDATE message_flag_deliveries/.test(sql));
    expect(delivery[0]).toMatch(/message_id = \$1/);
    expect(delivery[0]).toMatch(/folder = \$7 AND uid = \$8/);
    expect(delivery[1]).toEqual([
      sourceRow.id, 'acct-1', 'Archive', 88, '202', '8', 'INBOX', 7, '101', '4',
    ]);
  });

  it.each([
    ['no occupant', null, 0],
    ['live complete occupant', liveOccupant, 1],
    ['quarantined occupant', { ...liveOccupant, metadata_complete: false }, 1],
    ['deleted occupant', { ...liveOccupant, is_deleted: true }, 1],
  ])('preserves the source UUID while replacing %s', async (_label, occupant, deletes) => {
    const tx = transaction({ occupant });

    await expect(materialize(tx)).resolves.toMatchObject({
      archived: true, sourceId: sourceRow.id,
    });

    expect(tx.query.mock.calls.filter(([sql]) => /DELETE FROM messages/.test(sql))).toHaveLength(deletes);
    const update = tx.query.mock.calls.find(([sql]) => /UPDATE messages/.test(sql));
    expect(update[0]).toMatch(/WHERE id = \$\d+.*account_id = \$\d+.*folder = \$\d+.*uid = \$\d+/s);
    expect(update[1]).toContain(sourceRow.id);
    expect(update[1]).not.toContain(liveOccupant.id);
  });

  it('treats an exact already-materialized source UUID as an idempotent concurrent winner', async () => {
    const winner = { ...sourceRow, folder: 'Archive', uid: 88 };
    const tx = transaction({ source: winner });

    await expect(materialize(tx)).resolves.toMatchObject({
      archived: true, sourceId: sourceRow.id, concurrentWinner: true,
    });
    expect(tx.query.mock.calls.some(([sql]) => /DELETE FROM messages|UPDATE messages/.test(sql))).toBe(false);
    expect(adjustFolderCounts).not.toHaveBeenCalled();
  });

  it('does not accept a different UUID at the destination when the source disappeared', async () => {
    const tx = transaction({ source: null, occupant: liveOccupant });
    await expect(materialize(tx)).rejects.toMatchObject({ code: 'ARCHIVE_SOURCE_SUPERSEDED' });
    expect(adjustFolderCounts).not.toHaveBeenCalled();
  });

  it('accepts zero-row CAS only after confirming the same source UUID at the exact live tuple', async () => {
    const winner = { ...sourceRow, folder: 'Archive', uid: 88 };
    const tx = transaction({ updateRowCount: 0, concurrentWinner: winner });
    await expect(materialize(tx)).resolves.toMatchObject({ concurrentWinner: true });
    expect(adjustFolderCounts).not.toHaveBeenCalled();
  });

  it('rejects zero-row CAS with a wrong-UUID destination occupant', async () => {
    const tx = transaction({ updateRowCount: 0, concurrentWinner: liveOccupant });
    await expect(materialize(tx)).rejects.toMatchObject({ code: 'ARCHIVE_SOURCE_SUPERSEDED' });
    expect(adjustFolderCounts).not.toHaveBeenCalled();
  });

  it.each([
    [true, 0],
    [false, -1],
  ])('deletes an exact All Mail winner and debits its actual read=%s row state', async (
    isRead, unreadDelta,
  ) => {
    const allMailSource = { ...sourceRow, folder: 'All Mail', uid: 88, is_read: isRead };
    const allMailReceipt = {
      ...receipt,
      folder: 'All Mail',
      destinationToken: { folder: 'All Mail', uidValidity: '202', generation: '8' },
    };
    const allMailOperation = {
      ...operation,
      destination: allMailReceipt.destinationToken,
    };
    const tx = transaction({
      source: allMailSource,
      folders: [
        { path: 'All Mail', uid_validity: 202, observation_generation: 8, is_present: true },
        folderRows[1],
      ],
    });

    await expect(materialize(tx, {
      destinationFolder: 'All Mail', receipt: allMailReceipt,
      operation: allMailOperation, allMail: true,
    })).resolves.toMatchObject({
      archived: true, sourceId: sourceRow.id, concurrentWinner: false,
    });

    const deleted = tx.query.mock.calls.find(([sql]) => /DELETE FROM messages/.test(sql));
    expect(deleted[1]).toEqual([sourceRow.id, 'acct-1', 'All Mail', 88]);
    expect(adjustFolderCounts).toHaveBeenCalledOnce();
    expect(adjustFolderCounts).toHaveBeenCalledWith(
      'acct-1', 'All Mail', -1, unreadDelta, expect.objectContaining({ strict: true }),
    );
  });

  it('applies accepted desired flags to the exact All Mail destination before deleting the source row', async () => {
    const allMailSource = { ...sourceRow, folder: 'All Mail', uid: 88 };
    const allMailReceipt = {
      ...receipt,
      folder: 'All Mail',
      destinationToken: { folder: 'All Mail', uidValidity: '202', generation: '8' },
    };
    const allMailOperation = { ...operation, destination: allMailReceipt.destinationToken };
    const client = {
      mailbox: { path: 'All Mail', uidValidity: 202 },
      messageFlagsAdd: vi.fn().mockResolvedValue(true),
      messageFlagsRemove: vi.fn().mockResolvedValue(true),
    };
    const tx = transaction({
      source: allMailSource,
      folders: [
        { path: 'All Mail', uid_validity: 202, observation_generation: 8, is_present: true },
        folderRows[1],
      ],
      deliveries: [
        {
          flag: 'read', desired_value: true, revision: 3,
          folder: 'All Mail', uid: 88, uid_validity: 202, folder_generation: 8,
        },
        {
          flag: 'star', desired_value: false, revision: 5,
          folder: 'All Mail', uid: 88, uid_validity: 202, folder_generation: 8,
        },
      ],
    });

    await materialize(tx, {
      destinationFolder: 'All Mail', receipt: allMailReceipt,
      operation: allMailOperation, allMail: true,
      providerResource: { client, folder: 'All Mail', uidValidities: new Map([['All Mail', '202']]) },
    });

    expect(client.messageFlagsAdd).toHaveBeenCalledWith('88', ['\\Seen'], { uid: true });
    expect(client.messageFlagsRemove).toHaveBeenCalledWith('88', ['\\Flagged'], { uid: true });
    const deleteCall = tx.query.mock.calls.find(([sql]) => /DELETE FROM messages/.test(sql));
    expect(client.messageFlagsAdd.mock.invocationCallOrder[0]).toBeLessThan(
      tx.query.mock.invocationCallOrder[tx.query.mock.calls.indexOf(deleteCall)],
    );
    expect(client.messageFlagsRemove.mock.invocationCallOrder[0]).toBeLessThan(
      tx.query.mock.invocationCallOrder[tx.query.mock.calls.indexOf(deleteCall)],
    );
  });

  it('keeps the All Mail source row when an accepted flag revision was superseded', async () => {
    const allMailSource = { ...sourceRow, folder: 'All Mail', uid: 88 };
    const allMailReceipt = {
      ...receipt,
      folder: 'All Mail',
      destinationToken: { folder: 'All Mail', uidValidity: '202', generation: '8' },
    };
    const tx = transaction({
      source: allMailSource,
      folders: [
        { path: 'All Mail', uid_validity: 202, observation_generation: 8, is_present: true },
        folderRows[1],
      ],
      deliveries: [{
        flag: 'read', desired_value: true, revision: 4,
        folder: 'All Mail', uid: 88, uid_validity: 202, folder_generation: 8,
      }],
    });

    await expect(materialize(tx, {
      destinationFolder: 'All Mail', receipt: allMailReceipt,
      operation: { ...operation, destination: allMailReceipt.destinationToken }, allMail: true,
      providerResource: {
        client: { mailbox: { path: 'All Mail', uidValidity: 202 } },
        folder: 'All Mail', uidValidities: new Map([['All Mail', '202']]),
      },
    })).rejects.toMatchObject({ code: 'DESIRED_FLAG_SUPERSEDED' });

    expect(tx.query.mock.calls.some(([sql]) => /DELETE FROM messages/.test(sql))).toBe(false);
  });
});

describe('archive count ledger', () => {
  beforeEach(() => adjustFolderCounts.mockReset().mockResolvedValue(undefined));

  it.each([
    [true, null, null, [-1, 0], [1, 0]],
    [false, null, null, [-1, -1], [1, 1]],
    [true, 'live', true, [-1, 0], [0, 0]],
    [true, 'live', false, [-1, 0], [0, -1]],
    [false, 'live', true, [-1, -1], [0, 1]],
    [false, 'live', false, [-1, -1], [0, 0]],
    [false, 'quarantined', false, [-1, -1], [1, 1]],
    [false, 'deleted', false, [-1, -1], [1, 1]],
  ])('derives source=%s occupant=%s/%s deltas from locked row states', async (
    sourceRead, occupantKind, occupantRead, sourceDelta, destinationDelta,
  ) => {
    const source = { ...sourceRow, is_read: sourceRead };
    const occupant = occupantKind ? {
      ...liveOccupant,
      is_read: occupantRead,
      metadata_complete: occupantKind !== 'quarantined',
      is_deleted: occupantKind === 'deleted',
    } : null;
    const tx = transaction({ source, occupant, updateRow: { ...source, folder: 'Archive', uid: 88 } });

    await materialize(tx);

    expect(adjustFolderCounts).toHaveBeenCalledWith(
      'acct-1', 'INBOX', ...sourceDelta, expect.objectContaining({ strict: true }),
    );
    if (destinationDelta[0] === 0 && destinationDelta[1] === 0) {
      expect(adjustFolderCounts).not.toHaveBeenCalledWith(
        'acct-1', 'Archive', expect.anything(), expect.anything(), expect.anything(),
      );
    } else {
      expect(adjustFolderCounts).toHaveBeenCalledWith(
        'acct-1', 'Archive', ...destinationDelta, expect.objectContaining({ strict: true }),
      );
    }
  });

  it('coalesces same-folder source and destination into one exact ledger delta', async () => {
    const sameSourceToken = { ...sourceToken };
    const sameDestinationToken = { folder: 'INBOX', uidValidity: '101', generation: '4' };
    const sameReceipt = {
      ...receipt, folder: 'INBOX', uidValidity: '101',
      sourceToken: sameSourceToken, destinationToken: sameDestinationToken,
    };
    const sameOperation = {
      ...operation, source: sameSourceToken, destination: sameDestinationToken,
    };
    const tx = transaction({
      folders: [folderRows[1]],
      occupant: { ...liveOccupant, folder: 'INBOX', is_read: false },
      updateRow: { ...sourceRow, folder: 'INBOX', uid: 88 },
    });

    await materialize(tx, {
      destinationFolder: 'INBOX', receipt: sameReceipt, operation: sameOperation,
    });

    expect(adjustFolderCounts).toHaveBeenCalledOnce();
    expect(adjustFolderCounts).toHaveBeenCalledWith(
      'acct-1', 'INBOX', -1, -1, expect.objectContaining({ strict: true }),
    );
  });

  it('deletes only the source and decrements only INBOX for All Mail materialization', async () => {
    const tx = transaction();
    await materialize(tx, { allMail: true });
    expect(tx.query.mock.calls.filter(([sql]) => /DELETE FROM messages/.test(sql))).toHaveLength(1);
    expect(tx.query.mock.calls.some(([sql]) => /UPDATE messages/.test(sql))).toBe(false);
    expect(adjustFolderCounts).toHaveBeenCalledOnce();
    expect(adjustFolderCounts).toHaveBeenCalledWith(
      'acct-1', 'INBOX', -1, -1, expect.objectContaining({ strict: true }),
    );
  });

  it.each(['delete', 'update'])('propagates %s failure before count updates', async failOn => {
    const tx = transaction({ occupant: liveOccupant, failOn });
    await expect(materialize(tx)).rejects.toThrow(failOn === 'delete' ? 'duplicate delete failed' : 'source update failed');
    expect(adjustFolderCounts).not.toHaveBeenCalled();
  });

  it('propagates strict count failure to roll back materialization and completion', async () => {
    adjustFolderCounts.mockRejectedValueOnce(new Error('count update failed'));
    const tx = transaction();
    await expect(materialize(tx)).rejects.toThrow('count update failed');
  });
});
