import { getAccountRow } from './accountAdapter.js';
import { errorResult, jsonResult } from './result.js';
import {
  countMessagesIn,
  createFolder,
  deleteFolder,
  listFolders,
  renameFolder,
} from '../services/mailbox/folders.js';
import {
  bulkMoveToFolder,
  resolveMovedIds,
} from '../services/mailbox/move.js';
import { bulkArchive } from '../services/mailbox/archive.js';
import { bulkTrash } from '../services/mailbox/trash.js';
import { bulkSetRead, setStarred } from '../services/mailbox/flags.js';
import { runInBatches } from '../services/mailbox/batch.js';
import { markNotSpam, markSpam } from '../services/mailbox/spamLabel.js';
import {
  snoozeConversation,
  unsnoozeConversation,
} from '../services/mailbox/snooze.js';
import { setCategory } from '../services/mailbox/category.js';
import {
  gtdClassify,
  gtdDone,
  gtdUnclassify,
} from '../services/gtd/actions.js';
import { GTD_STATES } from '../services/gtdConfig.js';
import {
  areValidUUIDs,
  isValidFolderName,
  UUID_RE,
} from '../utils/validation.js';

function annotations({
  readOnlyHint = false,
  destructiveHint = false,
  idempotentHint = false,
} = {}) {
  return Object.freeze({
    readOnlyHint,
    destructiveHint,
    idempotentHint,
    openWorldHint: false,
  });
}

const READ_ONLY_ANNOTATIONS = annotations({
  readOnlyHint: true,
  idempotentHint: true,
});
const CREATE_ANNOTATIONS = annotations();
const IDEMPOTENT_WRITE_ANNOTATIONS = annotations({ idempotentHint: true });
const DESTRUCTIVE_WRITE_ANNOTATIONS = annotations({ destructiveHint: true });
const DESTRUCTIVE_IDEMPOTENT_ANNOTATIONS = annotations({
  destructiveHint: true,
  idempotentHint: true,
});

export function messageIdsArg(args) {
  const ids = args.message_ids;
  if (!Array.isArray(ids) || ids.length === 0) {
    return { error: 'message_ids must contain at least one id' };
  }
  if (ids.length > 500) return { error: 'Too many ids — maximum 500 per request' };
  if (!areValidUUIDs(ids)) return { error: 'Invalid message id format' };
  return { value: ids };
}

export function messageIdArg(args) {
  const id = args.message_id;
  if (!id || typeof id !== 'string') return { error: 'message_id parameter is required' };
  if (!UUID_RE.test(id)) return { error: 'Invalid message id format' };
  return { value: id };
}

export const listFoldersDef = {
  name: 'list_folders',
  description: 'List folders and live message counts for scoped accounts. Pass account to narrow the result to one account.',
  annotations: READ_ONLY_ANNOTATIONS,
  inputSchema: {
    type: 'object',
    properties: {
      account: { type: 'string' },
    },
  },
};

export const createFolderDef = {
  name: 'create_folder',
  description: 'Create a folder in one scoped account. The name must be an explicit valid folder component.',
  annotations: CREATE_ANNOTATIONS,
  inputSchema: {
    type: 'object',
    required: ['account', 'name'],
    properties: {
      account: { type: 'string' },
      name: { type: 'string' },
      parent_path: { type: 'string' },
    },
  },
};

export const renameFolderDef = {
  name: 'rename_folder',
  description: 'Rename the final component of an existing folder path. Both the account and source path must be explicit.',
  annotations: DESTRUCTIVE_WRITE_ANNOTATIONS,
  inputSchema: {
    type: 'object',
    required: ['account', 'path', 'new_name'],
    properties: {
      account: { type: 'string' },
      path: { type: 'string' },
      new_name: { type: 'string' },
    },
  },
};

export const deleteFolderDef = {
  name: 'delete_folder',
  description: 'Delete a folder and its tracked messages. The live message count must exactly match expected_message_count.',
  annotations: DESTRUCTIVE_IDEMPOTENT_ANNOTATIONS,
  inputSchema: {
    type: 'object',
    required: ['account', 'path', 'expected_message_count'],
    properties: {
      account: { type: 'string' },
      path: { type: 'string' },
      expected_message_count: { type: 'integer', minimum: 0 },
    },
  },
};

const messageIdsSchema = {
  type: 'array',
  items: { type: 'string' },
  minItems: 1,
  maxItems: 500,
};

export const moveMessagesDef = {
  name: 'move_messages',
  description: 'Move explicit messages to a destination folder and return their replacement ids. Message ids change on move, and non-UIDPLUS servers may report resync_pending.',
  annotations: DESTRUCTIVE_WRITE_ANNOTATIONS,
  inputSchema: {
    type: 'object',
    required: ['message_ids', 'folder'],
    properties: {
      message_ids: messageIdsSchema,
      folder: { type: 'string' },
    },
  },
};

export const archiveMessagesDef = {
  name: 'archive_messages',
  description: 'Archive explicit messages and return their replacement ids. Gmail All Mail destinations are reported as destination_untracked.',
  annotations: IDEMPOTENT_WRITE_ANNOTATIONS,
  inputSchema: {
    type: 'object',
    required: ['message_ids'],
    properties: {
      message_ids: messageIdsSchema,
    },
  },
};

export const trashMessagesDef = {
  name: 'trash_messages',
  description: 'Move explicit messages to Trash and return their replacement ids. Messages requiring permanent deletion are refused.',
  annotations: DESTRUCTIVE_IDEMPOTENT_ANNOTATIONS,
  inputSchema: {
    type: 'object',
    required: ['message_ids'],
    properties: {
      message_ids: messageIdsSchema,
    },
  },
};

function messageFlagDef(name, description) {
  return {
    name,
    description,
    annotations: IDEMPOTENT_WRITE_ANNOTATIONS,
    inputSchema: {
      type: 'object',
      required: ['message_ids'],
      properties: {
        message_ids: messageIdsSchema,
      },
    },
  };
}

export const markReadDef = messageFlagDef(
  'mark_read',
  'Mark explicit messages as read. The updated receipt excludes messages already read.',
);
export const markUnreadDef = messageFlagDef(
  'mark_unread',
  'Mark explicit messages as unread. The updated receipt excludes messages already unread.',
);
export const starMessageDef = messageFlagDef(
  'star_message',
  'Star explicit messages. The updated receipt excludes messages already starred.',
);
export const unstarMessageDef = messageFlagDef(
  'unstar_message',
  'Unstar explicit messages. The updated receipt excludes messages already unstarred.',
);

function singleMessageDef(name, description, extraProperties = {}, extraRequired = []) {
  return {
    name,
    description,
    annotations: IDEMPOTENT_WRITE_ANNOTATIONS,
    inputSchema: {
      type: 'object',
      required: ['message_id', ...extraRequired],
      properties: {
        message_id: { type: 'string' },
        ...extraProperties,
      },
    },
  };
}

export const markSpamDef = singleMessageDef(
  'mark_spam',
  'Mark one explicit message as spam and move it to the configured spam folder.',
);
export const markNotSpamDef = singleMessageDef(
  'mark_not_spam',
  'Mark one explicit spam-folder message as not spam and move it to Inbox.',
);
export const snoozeMessageDef = singleMessageDef(
  'snooze_message',
  'Snooze one message and its reply-chain siblings to the Snoozed folder for up to 30 days.',
  { until: { type: 'string', format: 'date-time' } },
  ['until'],
);
export const unsnoozeMessageDef = singleMessageDef(
  'unsnooze_message',
  'Restore one snoozed message and its reply-chain siblings to their original folder.',
  { mark_unread: { type: 'boolean', default: false } },
);
const CATEGORIES = [
  'primary',
  'newsletter',
  'promotion',
  'automated',
  'social',
];
export const setCategoryDef = singleMessageDef(
  'set_category',
  'Set the category of one explicit message.',
  { category: { type: 'string', enum: CATEGORIES } },
  ['category'],
);
export const gtdClassifyDef = singleMessageDef(
  'gtd_classify',
  'Apply or remove one GTD state label from an explicit message.',
  {
    state: { type: 'string', enum: GTD_STATES },
    remove: { type: 'boolean', default: false },
  },
  ['state'],
);
export const gtdDoneDef = singleMessageDef(
  'gtd_done',
  'Remove GTD state labels and archive the Inbox copy of one explicit message.',
  {
    states: {
      type: 'array',
      items: { type: 'string', enum: GTD_STATES },
      minItems: 1,
    },
  },
);

function folderWire(row) {
  return {
    path: row.path,
    name: row.name,
    delimiter: row.delimiter,
    special_use: row.special_use,
    total_count: Number(row.total_count || 0),
    unread_count: Number(row.unread_count || 0),
    message_count: Number(row.total_count || 0),
  };
}

async function scopedAccountIds(accountId, scope) {
  if (!accountId) return scope.accountIds;
  const account = await getAccountRow(accountId, scope.accountIds);
  return account ? [account.id] : null;
}

async function requireAccount(accountId, scope) {
  if (!accountId || typeof accountId !== 'string') {
    return { error: 'account parameter is required' };
  }
  const account = await getAccountRow(accountId, scope.accountIds);
  if (!account) return { error: `account not found: ${accountId}` };
  return { account };
}

function serviceError(result) {
  return errorResult(result.error || 'Mailbox operation failed');
}

export async function handleListFolders(args, scope, deps) {
  const accountIds = await scopedAccountIds(args.account, scope);
  if (!accountIds) return errorResult(`account not found: ${args.account}`);

  const results = await Promise.all(accountIds.map(accountId => listFolders(deps.imapManager, {
    userId: scope.userId,
    accountIds: scope.accountIds,
    accountId,
  })));
  const failed = results.find(result => !result.ok);
  if (failed) return errorResult(failed.error);
  return jsonResult({ folders: results.flatMap(result => result.folders.map(folderWire)) });
}

export async function handleCreateFolder(args, scope, deps) {
  if (!isValidFolderName(args.name?.trim())) return errorResult('Invalid folder name');
  if (args.parent_path !== undefined && !isValidFolderName(args.parent_path)) {
    return errorResult('Invalid parent folder path');
  }
  const scoped = await requireAccount(args.account, scope);
  if (scoped.error) return errorResult(scoped.error);
  const result = await createFolder(deps.imapManager, {
    userId: scope.userId,
    accountIds: scope.accountIds,
    accountId: scoped.account.id,
    name: args.name.trim(),
    parentPath: args.parent_path,
  });
  if (!result.ok) return serviceError(result);
  return jsonResult({ ok: true, path: result.path });
}

export async function handleRenameFolder(args, scope, deps) {
  if (!isValidFolderName(args.path)) return errorResult('Invalid folder path');
  if (!isValidFolderName(args.new_name?.trim())) return errorResult('Invalid folder name');
  const scoped = await requireAccount(args.account, scope);
  if (scoped.error) return errorResult(scoped.error);
  const result = await renameFolder(deps.imapManager, {
    userId: scope.userId,
    accountIds: scope.accountIds,
    accountId: scoped.account.id,
    oldPath: args.path,
    newName: args.new_name.trim(),
  });
  if (!result.ok) return serviceError(result);
  return jsonResult({ ok: true, old_path: args.path, new_path: result.newPath });
}

export async function handleDeleteFolder(args, scope, deps) {
  if (!isValidFolderName(args.path)) return errorResult('Invalid folder path');
  if (!Number.isInteger(args.expected_message_count) || args.expected_message_count < 0) {
    return errorResult('expected_message_count must be a non-negative integer');
  }
  const scoped = await requireAccount(args.account, scope);
  if (scoped.error) return errorResult(scoped.error);

  const listed = await listFolders(deps.imapManager, {
    userId: scope.userId,
    accountIds: scope.accountIds,
    accountId: scoped.account.id,
  });
  if (!listed.ok) return serviceError(listed);
  if (!listed.folders.some(folder => folder.path === args.path)) {
    return errorResult(`folder not found: ${args.path}`);
  }

  const count = await countMessagesIn(scoped.account.id, args.path);
  if (args.expected_message_count !== count) {
    return errorResult(
      `folder "${args.path}" holds ${count} messages, not ${args.expected_message_count}; ` +
      're-check with list_folders and pass the current count to confirm',
    );
  }

  const result = await deleteFolder(deps.imapManager, {
    userId: scope.userId,
    accountIds: scope.accountIds,
    accountId: scoped.account.id,
    path: args.path,
  });
  if (!result.ok) return serviceError(result);
  return jsonResult({ ok: true, deleted: args.path, message_count: count });
}

export async function handleMoveMessages(args, scope, deps) {
  const ids = messageIdsArg(args);
  if (ids.error) return errorResult(ids.error);
  if (!isValidFolderName(args.folder)) return errorResult('Invalid destination folder');

  const result = await bulkMoveToFolder(deps.imapManager, {
    userId: scope.userId,
    accountIds: scope.accountIds,
    ids: ids.value,
    folder: args.folder,
  });
  if (!result.ok) return serviceError(result);

  const movedDetails = result.movedDetails || [];
  const failed = result.failed || [];
  const skippedAccounts = result.skippedAccounts || [];
  if (movedDetails.length === 0 && failed.length === 0 && skippedAccounts.length > 0) {
    const accountIds = skippedAccounts.map(item => item.account_id).join(', ');
    return errorResult(
      `destination folder not found for account ${accountIds}: ${args.folder}`,
    );
  }

  const resolvedByAccount = new Map();
  for (const detail of movedDetails) {
    if (detail.uid == null) continue;
    if (!resolvedByAccount.has(detail.accountId)) resolvedByAccount.set(detail.accountId, []);
    resolvedByAccount.get(detail.accountId).push(detail.uid);
  }
  const newIds = new Map();
  await Promise.all([...resolvedByAccount].map(async ([accountId, uids]) => {
    const rows = await resolveMovedIds(accountId, args.folder, uids);
    for (const row of rows) newIds.set(`${accountId}:${String(row.uid)}`, row.id);
  }));

  const moved = movedDetails.map(detail => ({
    id: detail.id,
    new_id: detail.uid == null
      ? null
      : (newIds.get(`${detail.accountId}:${String(detail.uid)}`) || null),
    uid: detail.uid,
    folder: args.folder,
  }));
  const resyncPending = movedDetails.some((detail, index) => (
    detail.uid == null || moved[index].new_id == null
  ));
  return jsonResult({
    ok: true,
    moved,
    failed,
    skipped_accounts: skippedAccounts,
    resync_pending: resyncPending,
    note: 'message ids change on move; use new_id for follow-up calls',
  });
}

async function resolveDestinationIds(details) {
  const grouped = new Map();
  for (const detail of details) {
    if (detail.uid == null || detail.destinationUntracked) continue;
    const key = `${detail.accountId}:${detail.folder}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        accountId: detail.accountId,
        folder: detail.folder,
        uids: [],
      });
    }
    grouped.get(key).uids.push(detail.uid);
  }

  const resolved = new Map();
  await Promise.all([...grouped.values()].map(async ({ accountId, folder, uids }) => {
    const rows = await resolveMovedIds(accountId, folder, uids);
    for (const row of rows) {
      resolved.set(`${accountId}:${folder}:${String(row.uid)}`, row.id);
    }
  }));
  return resolved;
}

export async function handleArchiveMessages(args, scope, deps) {
  const ids = messageIdsArg(args);
  if (ids.error) return errorResult(ids.error);

  const result = await bulkArchive(deps.imapManager, {
    userId: scope.userId,
    accountIds: scope.accountIds,
    ids: ids.value,
  });
  if (!result.ok) return serviceError(result);

  const details = result.archivedDetails || [];
  const resolved = await resolveDestinationIds(details);
  const archived = details.map(detail => ({
    id: detail.id,
    new_id: detail.destinationUntracked || detail.uid == null
      ? null
      : (resolved.get(
          `${detail.accountId}:${detail.folder}:${String(detail.uid)}`,
        ) || null),
    uid: detail.uid,
    folder: detail.folder,
    destination_untracked: Boolean(detail.destinationUntracked),
  }));
  const resyncPending = details.some((detail, index) => (
    !detail.destinationUntracked
    && (detail.uid == null || archived[index].new_id == null)
  ));

  return jsonResult({
    ok: true,
    archived,
    failed: result.failed || [],
    no_archive_folder: result.noArchiveFolder || [],
    resync_pending: resyncPending,
    note: 'message ids change on archive; use new_id for follow-up calls',
  });
}

export async function handleTrashMessages(args, scope, deps) {
  const ids = messageIdsArg(args);
  if (ids.error) return errorResult(ids.error);

  const result = await bulkTrash(deps.imapManager, {
    userId: scope.userId,
    accountIds: scope.accountIds,
    ids: ids.value,
    allowPermanent: false,
  });
  if (!result.ok) return serviceError(result);

  const details = result.trashedDetails || [];
  const resolved = await resolveDestinationIds(details);
  const trashed = details.map(detail => ({
    id: detail.id,
    new_id: detail.uid == null
      ? null
      : (resolved.get(
          `${detail.accountId}:${detail.folder}:${String(detail.uid)}`,
        ) || null),
    folder: detail.folder,
  }));
  const resyncPending = details.some((detail, index) => (
    detail.uid == null || trashed[index].new_id == null
  ));

  return jsonResult({
    ok: true,
    trashed,
    failed: result.failed || [],
    refused: result.refused || [],
    resync_pending: resyncPending,
    next_step: 'use stage_deletion for permanent removal',
  });
}

function createFlagHandler({ kind, value }) {
  return async function handleFlag(args, scope, deps) {
    const ids = messageIdsArg(args);
    if (ids.error) return errorResult(ids.error);

    if (kind === 'read') {
      const result = await bulkSetRead(deps.imapManager, {
        userId: scope.userId,
        accountIds: scope.accountIds,
        ids: ids.value,
        read: value,
      });
      if (!result.ok) return serviceError(result);
      return jsonResult({ ok: true, updated: result.updated || [] });
    }

    const results = await runInBatches(ids.value, 3, id => setStarred(
      deps.imapManager,
      {
        userId: scope.userId,
        accountIds: scope.accountIds,
        id,
        starred: value,
      },
    ));
    const updated = [];
    results.forEach((result, index) => {
      if (
        result.status === 'fulfilled'
        && result.value.ok
        && result.value.updated
      ) {
        updated.push(ids.value[index]);
      }
    });
    return jsonResult({ ok: true, updated });
  };
}

export const handleMarkRead = createFlagHandler({ kind: 'read', value: true });
export const handleMarkUnread = createFlagHandler({ kind: 'read', value: false });
export const handleStarMessage = createFlagHandler({ kind: 'starred', value: true });
export const handleUnstarMessage = createFlagHandler({ kind: 'starred', value: false });

function createSpamHandler(service) {
  return async function handleSpamLabel(args, scope, deps) {
    const id = messageIdArg(args);
    if (id.error) return errorResult(id.error);

    const result = await service(deps.imapManager, {
      userId: scope.userId,
      accountIds: scope.accountIds,
      id: id.value,
    });
    if (!result.ok) return serviceError(result);
    return jsonResult({
      ok: true,
      folder: result.body.folder,
      new_uid: result.body.newUid ?? null,
      already_in_folder: Boolean(result.body.alreadyInFolder),
    });
  };
}

export const handleMarkSpam = createSpamHandler(markSpam);
export const handleMarkNotSpam = createSpamHandler(markNotSpam);

export async function handleSnoozeMessage(args, scope, deps) {
  const id = messageIdArg(args);
  if (id.error) return errorResult(id.error);
  if (!args.until) return errorResult('until is required');

  const until = new Date(args.until);
  if (Number.isNaN(until.getTime())) {
    return errorResult('until must be a valid ISO date');
  }
  const now = Date.now();
  if (until.getTime() <= now) return errorResult('until must be in the future');
  if (until.getTime() > now + 30 * 86_400_000) {
    return errorResult('until must be within 30 days');
  }

  const result = await snoozeConversation(deps.imapManager, {
    userId: scope.userId,
    accountIds: scope.accountIds,
    id: id.value,
    until,
  });
  if (!result.ok) return serviceError(result);
  return jsonResult({
    ok: true,
    moved_count: result.movedCount,
    sibling_ids: (result.movedIds || []).filter(movedId => movedId !== id.value),
    folder: result.folder,
  });
}

export async function handleUnsnoozeMessage(args, scope, deps) {
  const id = messageIdArg(args);
  if (id.error) return errorResult(id.error);
  if (
    args.mark_unread !== undefined
    && typeof args.mark_unread !== 'boolean'
  ) {
    return errorResult('mark_unread must be a boolean');
  }

  const result = await unsnoozeConversation(deps.imapManager, {
    userId: scope.userId,
    accountIds: scope.accountIds,
    id: id.value,
    markUnread: args.mark_unread ?? false,
  });
  if (!result.ok) return serviceError(result);
  return jsonResult({
    ok: true,
    restored: result.restored,
    folder: result.folder,
  });
}

export async function handleSetCategory(args, scope, deps) {
  const id = messageIdArg(args);
  if (id.error) return errorResult(id.error);
  if (!CATEGORIES.includes(args.category)) return errorResult('Invalid category');

  const result = await setCategory(deps.imapManager, {
    userId: scope.userId,
    accountIds: scope.accountIds,
    id: id.value,
    category: args.category,
  });
  if (!result.ok) return serviceError(result);
  return jsonResult({ ok: true, category: result.category });
}

export async function handleGtdClassify(args, scope, deps) {
  const id = messageIdArg(args);
  if (id.error) return errorResult(id.error);
  if (!GTD_STATES.includes(args.state)) {
    return errorResult(`Unknown GTD state: ${args.state}`);
  }
  if (args.remove !== undefined && typeof args.remove !== 'boolean') {
    return errorResult('remove must be a boolean');
  }

  const remove = args.remove ?? false;
  const service = remove ? gtdUnclassify : gtdClassify;
  const result = await service(deps.imapManager, {
    userId: scope.userId,
    accountIds: scope.accountIds,
    messageId: id.value,
    state: args.state,
  });
  if (!result.ok) return serviceError(result);

  const receipt = {
    ok: true,
    state: args.state,
    folder: result.folder ?? null,
  };
  if (remove) receipt.removed = Boolean(result.removed);
  return jsonResult(receipt);
}

export async function handleGtdDone(args, scope, deps) {
  const id = messageIdArg(args);
  if (id.error) return errorResult(id.error);

  let states = 'all';
  if (args.states !== undefined) {
    if (!Array.isArray(args.states) || args.states.length === 0) {
      return errorResult('states must be a non-empty array');
    }
    const unknown = args.states.find(state => !GTD_STATES.includes(state));
    if (unknown) return errorResult(`Unknown GTD state: ${unknown}`);
    states = args.states;
  }

  const result = await gtdDone(deps.imapManager, {
    userId: scope.userId,
    accountIds: scope.accountIds,
    id: id.value,
    states,
  });
  if (!result.ok) return serviceError(result);
  return jsonResult({
    ok: true,
    removed: result.removed,
    archived: result.archived,
    no_archive_folder: result.noArchiveFolder,
    archive_failed: result.archiveFailed,
  });
}
