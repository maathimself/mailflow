import { resolveArchiveFolder, isAllMailFolder, adjustFolderCounts, folderCountDeltasInLockOrder } from '../utils/mailUtils.js';
import { snapshotFromMessageRow } from './messageSnapshots.js';

function archiveMaterializationError(message, code = 'ARCHIVE_MATERIALIZATION_RETRY') {
  const error = new Error(message);
  error.code = code;
  error.retryable = true;
  error.uncertain = true;
  return error;
}

function sameObservation(left, right, { includeUid = false } = {}) {
  return Boolean(left && right) &&
    left.folder === right.folder &&
    String(left.uidValidity) === String(right.uidValidity) &&
    String(left.generation) === String(right.generation) &&
    (!includeUid || Number(left.uid) === Number(right.uid));
}

function deepMerge(destination, source) {
  if (!destination || typeof destination !== 'object' || Array.isArray(destination)) {
    return source;
  }
  if (!source || typeof source !== 'object' || Array.isArray(source)) return source;
  const merged = { ...destination };
  for (const [key, value] of Object.entries(source)) {
    merged[key] = key in merged ? deepMerge(merged[key], value) : value;
  }
  return merged;
}

function usefulProviderValue(value) {
  if (value === undefined || value === null || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function providerValue(source, destination, key) {
  return destination && Object.prototype.hasOwnProperty.call(destination, key)
    ? destination[key]
    : source[key];
}

function sourceValue(source, destination, key) {
  return source[key] === undefined || source[key] === null ? destination?.[key] : source[key];
}

// Message-row inventory for archive dedupe:
// - provider/envelope fields refresh from a later live complete destination observation;
// - body/snippet/thread caches retain source work and accept destination-only enrichment;
// - user/local classifiers, flag conflict timestamps, unsubscribe state, spam state, and
//   plugin annotations retain the original source row's decisions.
// Unknown/future columns are deliberately untouched by the narrow UPDATE below, which also
// preserves Task 5 desired-flag state when that schema lands.
export function mergeArchiveRows(source, destination) {
  if (!destination) return { ...source, is_deleted: false, metadata_complete: true };
  return {
    ...source,
    message_id: providerValue(source, destination, 'message_id'),
    subject: providerValue(source, destination, 'subject'),
    from_name: providerValue(source, destination, 'from_name'),
    from_email: providerValue(source, destination, 'from_email'),
    to_addresses: providerValue(source, destination, 'to_addresses'),
    cc_addresses: providerValue(source, destination, 'cc_addresses'),
    reply_to: providerValue(source, destination, 'reply_to'),
    in_reply_to: providerValue(source, destination, 'in_reply_to'),
    date: providerValue(source, destination, 'date'),
    flags: providerValue(source, destination, 'flags'),
    has_attachments: providerValue(source, destination, 'has_attachments'),
    thread_references: providerValue(source, destination, 'thread_references'),
    list_unsubscribe: providerValue(source, destination, 'list_unsubscribe'),
    list_unsubscribe_post: providerValue(source, destination, 'list_unsubscribe_post'),
    delivery_addresses: providerValue(source, destination, 'delivery_addresses'),
    sender_name: providerValue(source, destination, 'sender_name'),
    sender_email: providerValue(source, destination, 'sender_email'),
    snippet: usefulProviderValue(source.snippet) ? source.snippet : destination.snippet,
    body_text: usefulProviderValue(source.body_text) ? source.body_text : destination.body_text,
    body_html: usefulProviderValue(source.body_html) ? source.body_html : destination.body_html,
    attachments: usefulProviderValue(source.attachments) ? source.attachments : destination.attachments,
    thread_id: sourceValue(source, destination, 'thread_id'),
    is_bulk: sourceValue(source, destination, 'is_bulk'),
    category: sourceValue(source, destination, 'category'),
    spam_score_sa: sourceValue(source, destination, 'spam_score_sa'),
    spam_score_ml: sourceValue(source, destination, 'spam_score_ml'),
    spam_verdict: sourceValue(source, destination, 'spam_verdict'),
    spam_analyzed_at: sourceValue(source, destination, 'spam_analyzed_at'),
    spam_details: deepMerge(destination.spam_details || {}, source.spam_details || {}),
    spam_user_override: sourceValue(source, destination, 'spam_user_override'),
    unsubscribed_at: sourceValue(source, destination, 'unsubscribed_at'),
    plugin_annotations: deepMerge(
      destination.plugin_annotations || {}, source.plugin_annotations || {},
    ),
    snippet_attempted_at: sourceValue(source, destination, 'snippet_attempted_at'),
    is_read: source.is_read,
    is_starred: source.is_starred,
    read_changed_at: source.read_changed_at,
    star_changed_at: source.star_changed_at,
    is_deleted: false,
    metadata_complete: true,
  };
}

const ARCHIVE_UPDATE_COLUMNS = [
  'message_id', 'subject', 'from_name', 'from_email', 'to_addresses', 'cc_addresses',
  'reply_to', 'in_reply_to', 'date', 'snippet', 'body_text', 'body_html',
  'has_attachments', 'attachments', 'flags', 'thread_references', 'thread_id', 'is_bulk',
  'read_changed_at', 'star_changed_at', 'spam_score_sa', 'spam_score_ml', 'spam_verdict',
  'spam_analyzed_at', 'spam_details', 'spam_user_override', 'category', 'list_unsubscribe',
  'list_unsubscribe_post', 'unsubscribed_at', 'delivery_addresses', 'plugin_annotations',
  'snippet_attempted_at', 'sender_name', 'sender_email', 'is_read', 'is_starred',
];

function counted(row) {
  return Boolean(row && row.is_deleted === false && row.metadata_complete === true);
}

function unread(row) {
  return counted(row) && row.is_read === false ? 1 : 0;
}

function assertExactFolderObservations(rows, receipt) {
  const byPath = new Map(rows.map(row => [row.path, row]));
  for (const token of [receipt.sourceToken, receipt.destinationToken]) {
    const row = byPath.get(token.folder);
    if (!row || row.is_present !== true || row.uid_validity == null ||
        String(row.uid_validity) !== String(token.uidValidity) ||
        String(row.observation_generation) !== String(token.generation)) {
      throw archiveMaterializationError(
        `Folder observation changed before archive materialization for ${token.folder}`,
        'FOLDER_OBSERVATION_SUPERSEDED',
      );
    }
  }
}

function exactLiveWinner(row, { accountId, sourceSnapshot, receipt }) {
  return Boolean(row && row.id === sourceSnapshot.id && row.account_id === accountId &&
    row.folder === receipt.folder && Number(row.uid) === Number(receipt.uid) && counted(row));
}

function assertAllMailProviderReceipt(providerResource, receipt) {
  const selectedFolder = providerResource?.client?.mailbox?.path || providerResource?.folder;
  const selectedUidValidity = providerResource?.client?.mailbox?.uidValidity ??
    providerResource?.uidValidities?.get?.(receipt.folder);
  if (!providerResource?.client || selectedFolder !== receipt.folder ||
      selectedUidValidity == null ||
      String(selectedUidValidity) !== String(receipt.destinationToken.uidValidity)) {
    throw archiveMaterializationError(
      'All Mail desired flags require the exact destination provider epoch',
      'FOLDER_OBSERVATION_SUPERSEDED',
    );
  }
}

async function applyAllMailDesiredFlags(tx, providerResource, source, receipt) {
  const pending = await tx.query(
    `SELECT flag, desired_value, revision, folder, uid, uid_validity, folder_generation
       FROM message_flag_deliveries
      WHERE message_id = $1 AND account_id = $2
        AND state IN ('pending', 'delivering', 'uncertain')
      ORDER BY flag
      FOR UPDATE`,
    [source.id, source.account_id],
  );
  if (!(pending.rows || []).length) return;
  assertAllMailProviderReceipt(providerResource, receipt);
  for (const delivery of pending.rows || []) {
    const revisionColumn = delivery.flag === 'read' ? 'read_revision' :
      delivery.flag === 'star' ? 'star_revision' : null;
    const observation = delivery.folder === receipt.sourceToken.folder
      ? receipt.sourceToken
      : delivery.folder === receipt.destinationToken.folder
        ? { ...receipt.destinationToken, uid: receipt.uid }
        : null;
    if (!revisionColumn || Number(source[revisionColumn]) !== Number(delivery.revision) ||
        !observation || Number(delivery.uid) !== Number(source.uid) ||
        String(delivery.uid_validity) !== String(observation.uidValidity) ||
        String(delivery.folder_generation) !== String(observation.generation)) {
      throw archiveMaterializationError(
        'An accepted desired flag was superseded before All Mail completion',
        'DESIRED_FLAG_SUPERSEDED',
      );
    }
    const imapFlag = delivery.flag === 'read' ? '\\Seen' : '\\Flagged';
    const result = delivery.desired_value
      ? await providerResource.client.messageFlagsAdd(String(receipt.uid), [imapFlag], { uid: true })
      : await providerResource.client.messageFlagsRemove(String(receipt.uid), [imapFlag], { uid: true });
    if (result === false) {
      throw archiveMaterializationError(
        `Provider did not confirm ${delivery.flag} on the All Mail receipt`,
        'DESIRED_FLAG_PROVIDER_UNCONFIRMED',
      );
    }
  }
}

export async function materializeArchiveReceipt(tx, {
  accountId, sourceSnapshot, destinationFolder, receipt, operation, allMail = false,
  providerResource = null,
}) {
  const valid = operation?.kind === 'move' && operation.accountId === accountId &&
    sourceSnapshot?.account_id === accountId &&
    typeof receipt?.marker === 'string' && receipt.marker.length > 0 &&
    operation.marker === receipt.marker && receipt.folder === destinationFolder &&
    Number.isSafeInteger(Number(receipt?.uid)) && Number(receipt.uid) > 0 &&
    sameObservation(operation.source, receipt?.sourceToken, { includeUid: true }) &&
    sameObservation(operation.destination, receipt?.destinationToken) &&
    receipt.sourceToken.folder === sourceSnapshot?.folder &&
    Number(receipt.sourceToken.uid) === Number(sourceSnapshot?.uid) &&
    String(receipt.sourceToken.uidValidity) === String(sourceSnapshot?.folder_uid_validity) &&
    receipt.destinationToken.folder === destinationFolder &&
    String(receipt.destinationToken.uidValidity) === String(receipt.uidValidity);
  if (!valid) {
    throw archiveMaterializationError(
      'Provider receipt does not identify the exact archive operation',
      'PROVIDER_RECEIPT_IDENTITY_MISMATCH',
    );
  }

  const paths = [...new Set([receipt.sourceToken.folder, destinationFolder])].sort();
  const folderLock = await tx.query(
    `SELECT path, uid_validity, observation_generation, is_present
       FROM folders
      WHERE account_id = $1 AND path = ANY($2::text[])
      ORDER BY path
      FOR UPDATE`,
    [accountId, paths],
  );
  assertExactFolderObservations(folderLock.rows || [], receipt);

  const locked = await tx.query(
    `SELECT m.*
       FROM messages m
      WHERE m.account_id = $1
        AND (m.id = $2 OR (m.folder = $3 AND m.uid = $4))
      ORDER BY m.id
      FOR UPDATE`,
    [accountId, sourceSnapshot.id, destinationFolder, Number(receipt.uid)],
  );
  const source = (locked.rows || []).find(row => row.id === sourceSnapshot.id);
  const occupant = (locked.rows || []).find(row => (
    row.id !== sourceSnapshot.id && row.folder === destinationFolder &&
    Number(row.uid) === Number(receipt.uid)
  ));

  const sourceAtDestination = exactLiveWinner(source, { accountId, sourceSnapshot, receipt });
  if (!sourceAtDestination && (
    !source || source.account_id !== accountId || source.folder !== receipt.sourceToken.folder ||
      Number(source.uid) !== Number(receipt.sourceToken.uid) || !counted(source)
  )) {
    throw archiveMaterializationError(
      'The exact archive source row was superseded', 'ARCHIVE_SOURCE_SUPERSEDED',
    );
  }

  const options = { strict: true, query: tx.query.bind(tx) };
  if (allMail) {
    await applyAllMailDesiredFlags(tx, providerResource, source, receipt);
    const removed = await tx.query(
      `DELETE FROM messages
        WHERE id = $1 AND account_id = $2 AND folder = $3 AND uid = $4
        RETURNING id, account_id, folder, uid, is_read, is_deleted, metadata_complete`,
      [source.id, accountId, source.folder, source.uid],
    );
    if (removed.rowCount !== 1) {
      throw archiveMaterializationError(
        'The exact All Mail archive source row was superseded', 'ARCHIVE_SOURCE_SUPERSEDED',
      );
    }
    const deleted = removed.rows[0];
    if (counted(deleted)) {
      await adjustFolderCounts(
        accountId, source.folder, -1, unread(deleted) ? -1 : 0, options,
      );
    }
    return { archived: true, sourceId: source.id, concurrentWinner: false };
  }
  if (sourceAtDestination) {
    return { archived: true, sourceId: sourceSnapshot.id, concurrentWinner: true };
  }

  const liveOccupant = counted(occupant) ? occupant : null;
  let removedOccupant = null;
  if (occupant) {
    const removed = await tx.query(
      `DELETE FROM messages
        WHERE id = $1 AND account_id = $2 AND folder = $3 AND uid = $4
        RETURNING id, account_id, folder, uid, is_read, is_deleted, metadata_complete`,
      [occupant.id, accountId, destinationFolder, Number(receipt.uid)],
    );
    if (removed.rowCount !== 1) {
      throw archiveMaterializationError(
        'The exact archive destination occupant was superseded',
        'ARCHIVE_DESTINATION_SUPERSEDED',
      );
    }
    removedOccupant = removed.rows[0];
  }

  const merged = mergeArchiveRows(source, liveOccupant);
  const values = ARCHIVE_UPDATE_COLUMNS.map(column => merged[column]);
  const assignments = ARCHIVE_UPDATE_COLUMNS.map((column, index) => `${column} = $${index + 1}`);
  const identityStart = values.length + 1;
  const moved = await tx.query(
    `UPDATE messages
        SET ${assignments.join(', ')}, folder = $${identityStart}, uid = $${identityStart + 1},
            is_deleted = false, metadata_complete = true, synced_at = NOW()
      WHERE id = $${identityStart + 2} AND account_id = $${identityStart + 3}
        AND folder = $${identityStart + 4} AND uid = $${identityStart + 5}
      RETURNING id, account_id, folder, uid, is_read, is_deleted, metadata_complete`,
    [
      ...values, destinationFolder, Number(receipt.uid), source.id, accountId,
      receipt.sourceToken.folder, Number(receipt.sourceToken.uid),
    ],
  );
  if (moved.rowCount !== 1) {
    const winner = await tx.query(
      `SELECT id, account_id, folder, uid, is_read, is_deleted, metadata_complete
         FROM messages
        WHERE id = $1 AND account_id = $2 AND folder = $3 AND uid = $4
        FOR UPDATE`,
      [sourceSnapshot.id, accountId, destinationFolder, Number(receipt.uid)],
    );
    if (exactLiveWinner(winner.rows?.[0], { accountId, sourceSnapshot, receipt })) {
      return { archived: true, sourceId: sourceSnapshot.id, concurrentWinner: true };
    }
    throw archiveMaterializationError(
      'The exact archive source row was superseded during materialization',
      'ARCHIVE_SOURCE_SUPERSEDED',
    );
  }

  const post = moved.rows[0];
  if (!exactLiveWinner(post, { accountId, sourceSnapshot, receipt })) {
    throw archiveMaterializationError(
      'Archive materialization did not return the exact live source row',
      'ARCHIVE_MATERIALIZATION_INVALID',
    );
  }
  // A desired flag accepted after provider MOVE but before local completion still belongs
  // to this stable row id. Move its durable delivery coordinates atomically with the row so
  // reconciliation cannot strand it against the now-absent source UID.
  await tx.query(
    `UPDATE message_flag_deliveries
        SET folder = $3, uid = $4, uid_validity = $5, folder_generation = $6,
            updated_at = NOW()
      WHERE message_id = $1 AND account_id = $2
        AND folder = $7 AND uid = $8
        AND uid_validity = $9 AND folder_generation = $10`,
    [
      source.id, accountId, destinationFolder, Number(receipt.uid),
      String(receipt.destinationToken.uidValidity),
      String(receipt.destinationToken.generation),
      receipt.sourceToken.folder, Number(receipt.sourceToken.uid),
      String(receipt.sourceToken.uidValidity), String(receipt.sourceToken.generation),
    ],
  );
  const deltas = folderCountDeltasInLockOrder([
    { path: source.folder, totalDelta: counted(source) ? -1 : 0, unreadDelta: -unread(source) },
    {
      path: destinationFolder,
      totalDelta: (counted(post) ? 1 : 0) - (counted(removedOccupant) ? 1 : 0),
      unreadDelta: unread(post) - unread(removedOccupant),
    },
  ]);
  for (const delta of deltas) {
    await adjustFolderCounts(
      accountId, delta.path, delta.totalDelta, delta.unreadDelta, options,
    );
  }
  return { archived: true, sourceId: source.id, concurrentWinner: false };
}

// Archive one exact INBOX row. The provider executor owns command/recovery serialization and
// invokes `materialize` inside the same fenced transaction as its checked `completed` update.
// Missing archive configuration remains a soft outcome. Every provider, receipt, folder,
// source, destination, dedupe, count, or completion uncertainty throws and stays retryable.
// Gmail All Mail keeps no local destination row, so its completion deletes only the exact
// source row. The source guard prevents delete reconciliation from racing the provider phase.
export async function archiveInboxCopy(imapManager, account, inboxCopy, frozen = null) {
  const accountId = account.id;
  const archiveFolder = frozen && Object.prototype.hasOwnProperty.call(frozen, 'archiveFolder')
    ? frozen.archiveFolder
    : await resolveArchiveFolder(accountId, account.folder_mappings);
  if (!archiveFolder) return { archived: false, alreadyGone: false, noArchiveFolder: true };
  if (!inboxCopy?.id || inboxCopy.account_id !== accountId || inboxCopy.folder !== 'INBOX' ||
      !Number.isSafeInteger(Number(inboxCopy.uid)) || Number(inboxCopy.uid) <= 0 ||
      inboxCopy.folder_uid_validity == null || inboxCopy.folder_observation_generation == null ||
      (frozen?.archiveObservation && inboxCopy.folder_topology_identity == null)) {
    throw archiveMaterializationError(
      'Archive requires an exact persisted INBOX source observation',
      'ARCHIVE_SOURCE_OBSERVATION_REQUIRED',
    );
  }

  const allMail = frozen && typeof frozen.archiveAllMail === 'boolean'
    ? frozen.archiveAllMail
    : await isAllMailFolder(accountId, archiveFolder);
  imapManager._guardMoveUid(accountId, 'INBOX', inboxCopy.uid);
  try {
    const materialize = (providerReceipt, operation, tx, providerResource) => materializeArchiveReceipt(tx, {
      accountId,
      sourceSnapshot: inboxCopy,
      destinationFolder: archiveFolder,
      receipt: providerReceipt,
      operation,
      allMail,
      providerResource,
    });
    const moveOptions = {
      operationKey: `archive:${inboxCopy.id}`,
      expectedUidValidity: inboxCopy.folder_uid_validity,
      snapshot: snapshotFromMessageRow(inboxCopy),
      materialize,
      ...(frozen?.archiveObservation ? { operationTokens: [{
        folder: inboxCopy.folder,
        uidValidity: String(inboxCopy.folder_uid_validity),
        generation: String(inboxCopy.folder_observation_generation),
        topologyIdentity: String(inboxCopy.folder_topology_identity),
        isPresent: true,
      }, frozen.archiveObservation] } : {}),
    };
    if (allMail) {
      await imapManager.moveMessage(
        account,
        inboxCopy.uid,
        'INBOX',
        archiveFolder,
        { ...moveOptions, returnReceipt: true },
      );
    } else {
      await imapManager.moveMessageWithReceipt(
        account,
        inboxCopy.uid,
        'INBOX',
        archiveFolder,
        moveOptions,
      );
    }
    return { archived: true, alreadyGone: false, noArchiveFolder: false };
  } finally {
    imapManager._unguardMoveUid(accountId, 'INBOX', inboxCopy.uid);
  }
}
