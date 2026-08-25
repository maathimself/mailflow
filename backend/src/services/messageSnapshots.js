import { query, withTransaction } from './db.js';

export class MessageSnapshotError extends Error {
  constructor(message, { code = 'MESSAGE_SNAPSHOT_SUPERSEDED', retryable = true } = {}) {
    super(message);
    this.name = 'MessageSnapshotError';
    this.code = code;
    this.retryable = retryable;
  }
}

export function snapshotFromMessageRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    accountId: row.account_id,
    uid: Number(row.uid),
    folder: row.folder,
    uidValidity: row.folder_uid_validity == null ? null : String(row.folder_uid_validity),
    folderGeneration: row.folder_observation_generation == null
      ? null
      : String(row.folder_observation_generation),
    readRevision: Number(row.read_revision || 0),
    starRevision: Number(row.star_revision || 0),
  };
}

function notActionable(messageId) {
  return new MessageSnapshotError(`Message ${messageId} is not actionable`, {
    code: 'MESSAGE_SNAPSHOT_NOT_ACTIONABLE', retryable: false,
  });
}

export async function captureLiveMessageSnapshot(messageId, {
  accountId,
  userId,
  runQuery = query,
} = {}) {
  if (!accountId && !userId) throw new Error('A message snapshot requires account or user ownership');
  const ownership = userId
    ? 'a.user_id = $2'
    : 'm.account_id = $2';
  const result = await runQuery(
    `SELECT m.id, m.account_id, m.uid, m.folder, m.read_revision, m.star_revision,
            f.uid_validity AS folder_uid_validity,
            f.observation_generation AS folder_observation_generation
       FROM messages m
       JOIN email_accounts a ON a.id = m.account_id
       JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
                     AND f.is_present = true AND f.uid_validity IS NOT NULL
      WHERE m.id = $1 AND ${ownership}
        AND m.is_deleted = false AND m.metadata_complete = true`,
    [messageId, userId || accountId],
  );
  const snapshot = snapshotFromMessageRow(result.rows[0]);
  if (!snapshot || snapshot.uidValidity == null || snapshot.folderGeneration == null) {
    throw notActionable(messageId);
  }
  return snapshot;
}

export async function assertLiveMessageSnapshots(
  tx, accountId, snapshots, {
    includeRevisions = true, includeFolderGeneration = true,
  } = {},
) {
  const unique = new Map();
  for (const snapshot of snapshots || []) {
    if (!snapshot?.id || snapshot.accountId !== accountId || unique.has(snapshot.id)) {
      throw new MessageSnapshotError('Invalid or duplicate exact message snapshot');
    }
    unique.set(snapshot.id, snapshot);
  }
  if (unique.size === 0) return [];
  const payload = [...unique.values()].map(snapshot => ({
    id: snapshot.id,
    uid: Number(snapshot.uid),
    folder: snapshot.folder,
    uid_validity: String(snapshot.uidValidity),
    folder_generation: String(snapshot.folderGeneration),
    read_revision: snapshot.readRevision == null ? null : Number(snapshot.readRevision),
    star_revision: snapshot.starRevision == null ? null : Number(snapshot.starRevision),
  }));
  const result = await tx.query(
    `WITH expected AS (
       SELECT * FROM jsonb_to_recordset($2::jsonb) AS e(
         id uuid, uid bigint, folder text, uid_validity numeric, folder_generation bigint,
         read_revision bigint, star_revision bigint
       )
     )
     SELECT m.id, m.account_id, m.uid, m.folder, m.read_revision, m.star_revision,
            f.uid_validity AS folder_uid_validity,
            f.observation_generation AS folder_observation_generation
       FROM expected
       JOIN messages m ON m.id = expected.id
                      AND m.uid = expected.uid
                      AND m.folder = expected.folder
                      ${includeRevisions ? `AND (expected.read_revision IS NULL OR m.read_revision = expected.read_revision)
                      AND (expected.star_revision IS NULL OR m.star_revision = expected.star_revision)` : ''}
       JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
                     AND f.uid_validity = expected.uid_validity
                     ${includeFolderGeneration
                       ? 'AND f.observation_generation = expected.folder_generation'
                       : ''}
      WHERE m.account_id = $1
        AND m.is_deleted = false AND m.metadata_complete = true
        AND f.is_present = true AND f.uid_validity IS NOT NULL
      ORDER BY m.id
      FOR SHARE OF f, m`,
    [accountId, JSON.stringify(payload)],
  );
  if (result.rows.length !== unique.size) {
    throw new MessageSnapshotError('Message snapshot was relocated or superseded');
  }
  const found = new Set(result.rows.map(row => row.id));
  if ([...unique.keys()].some(id => !found.has(id))) {
    throw new MessageSnapshotError('Message snapshot was relocated or superseded');
  }
  return [...unique.values()];
}

export async function revalidateLiveMessageSnapshots(accountId, snapshots, {
  runTransaction = withTransaction,
} = {}) {
  return runTransaction(tx => assertLiveMessageSnapshots(tx, accountId, snapshots));
}

export async function revalidateLiveMessageSnapshotGroups(groups, {
  runTransaction = withTransaction,
} = {}) {
  return runTransaction(async tx => {
    for (const [accountId, snapshots] of groups || []) {
      await assertLiveMessageSnapshots(tx, accountId, snapshots);
    }
  });
}
