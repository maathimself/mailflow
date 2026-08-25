import { createHash, randomUUID } from 'node:crypto';
import { withTransaction } from './db.js';
import { readPluginThreadSnapshot } from './mailAccess.js';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function operationKey(userId, actedMessageId, intent, lifecycleKey) {
  return `gtd-done:${digest({ userId, actedMessageId, intent, lifecycleKey })}`;
}

function normalizeIntent(intent) {
  if (!Array.isArray(intent)) return intent;
  return [...new Set(intent)].sort();
}

function normalizeOperation(row) {
  if (!row) return null;
  return {
    key: row.operation_key,
    userId: row.user_id,
    accountId: row.account_id,
    actedMessageId: row.acted_message_id,
    threadKey: row.thread_key,
    intent: row.intent,
    planDigest: row.plan_digest,
    plan: row.plan,
    phase: row.phase,
    itemIndex: Number(row.item_index || 0),
    outcomes: Array.isArray(row.outcomes) ? row.outcomes : [],
    response: row.response || null,
    claimOwner: row.claim_owner || null,
  };
}

function rowOrder(left, right) {
  return String(left.folder).localeCompare(String(right.folder)) ||
    Number(left.uid) - Number(right.uid) || String(left.id).localeCompare(String(right.id));
}

function anchorLast(rows, anchorId) {
  return [...rows.filter(row => row.id !== anchorId), ...rows.filter(row => row.id === anchorId)];
}

function buildPlan(snapshot, targetFolders, archive) {
  const rows = [...snapshot.rows].sort(rowOrder);
  const inbox = rows.filter(row => row.folder === 'INBOX');
  const labels = rows.filter(row => targetFolders.includes(row.folder));
  const inboxAnchor = inbox.find(row => row.id === snapshot.anchorId) || inbox[0] || null;
  const labelAnchor = labels.find(row => row.id === snapshot.anchorId) || labels[0] || null;
  return {
    snapshotVersion: snapshot.version,
    config: snapshot.config,
    configUpdatedAt: snapshot.configUpdatedAt,
    activated: snapshot.activated,
    accountTopologyGeneration: snapshot.account?.mailbox_topology_generation ?? null,
    rows,
    targetFolders,
    archiveFolder: archive?.path || null,
    archiveAllMail: archive?.special_use === '\\All',
    archiveObservation: archive ? {
      folder: archive.path,
      uidValidity: String(archive.uid_validity),
      generation: String(archive.observation_generation),
      topologyIdentity: String(archive.topology_identity),
      isPresent: true,
    } : null,
    inboxAnchorId: inboxAnchor?.id || null,
    labelAnchorId: labelAnchor?.id || null,
    inboxRows: anchorLast(inbox, inboxAnchor?.id),
    labelRows: anchorLast(labels, labelAnchor?.id),
  };
}

function operationError(message, code, status = 409, retryable = status >= 409) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.retryable = retryable;
  return error;
}

const RESERVED_TARGETS = new Set(['inbox', 'sent', 'drafts', 'trash', 'junk', 'spam', 'archive']);
function unsafeTarget(folder) {
  const lower = String(folder || '').toLowerCase();
  return RESERVED_TARGETS.has(lower) || lower.startsWith('[gmail]/');
}

async function resolveFrozenArchiveFolder(tx, accountId, folderMappings) {
  const mapped = folderMappings?.archive;
  if (typeof mapped === 'string' && mapped) {
    const result = await tx.query(
      `SELECT path, special_use, uid_validity, observation_generation, topology_identity FROM folders
        WHERE account_id = $1 AND path = $2
          AND is_present = true AND no_select = false AND uid_validity IS NOT NULL`,
      [accountId, mapped],
    );
    if (result.rows[0]) return result.rows[0];
  }
  const result = await tx.query(
    `SELECT path, special_use, uid_validity, observation_generation, topology_identity FROM folders
      WHERE account_id = $1 AND is_present = true AND no_select = false AND uid_validity IS NOT NULL
        AND (special_use = '\\Archive' OR lower(name) LIKE '%archive%' OR special_use = '\\All')
      ORDER BY CASE
        WHEN special_use = '\\Archive' THEN 0
        WHEN lower(name) LIKE '%archive%' THEN 1
        ELSE 2
      END
      LIMIT 1`,
    [accountId],
  );
  return result.rows[0] || null;
}

export async function createOrLoadGtdDoneOperation({
  userId, actedMessageId, intent, lifecycleKey, deriveTargetFolders,
}) {
  if (typeof lifecycleKey !== 'string' || !lifecycleKey.trim()) {
    throw operationError('X-Idempotency-Key required', 'GTD_DONE_IDEMPOTENCY_KEY_REQUIRED', 400);
  }
  const normalizedIntent = normalizeIntent(intent);
  const stableLifecycleKey = lifecycleKey.trim();
  const key = operationKey(userId, actedMessageId, normalizedIntent, stableLifecycleKey);
  return withTransaction(async tx => {
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
    const existing = await tx.query(
      'SELECT * FROM gtd_done_operations WHERE operation_key = $1 FOR UPDATE',
      [key],
    );
    if (existing.rows[0]) {
      const owned = await tx.query(
        `SELECT id FROM email_accounts
          WHERE id = $1 AND user_id = $2 AND enabled = true`,
        [existing.rows[0].account_id, userId],
      );
      if (!owned.rows[0]) throw operationError('GTD Done account is no longer owned', 'GTD_DONE_NOT_OWNED', 404);
      return normalizeOperation(existing.rows[0]);
    }

    const snapshot = await readPluginThreadSnapshot(tx, userId, actedMessageId, 'gtd');
    if (!snapshot) throw operationError('Message not found', 'GTD_DONE_MESSAGE_NOT_FOUND', 404);
    if (snapshot.account?.enabled === false) {
      throw operationError('Account is disabled', 'GTD_DONE_ACCOUNT_DISABLED', 400);
    }
    const fullFolders = snapshot.config?.folders || {};
    const derived = deriveTargetFolders({
      enabled: snapshot.config?.enabled === true && snapshot.activated,
      folders: fullFolders,
      states: normalizedIntent,
      existing: snapshot.rows.map(row => row.folder),
    });
    if (derived?.error) throw operationError(derived.error, 'GTD_DONE_INVALID_INTENT', derived.status || 400);
    const targetFolders = [...new Set(derived?.folders || [])];
    if (targetFolders.some(unsafeTarget)) {
      throw operationError('A GTD Done label cannot be a system folder', 'GTD_DONE_UNSAFE_TARGET', 400);
    }
    const archive = await resolveFrozenArchiveFolder(
      tx, snapshot.account.id, snapshot.account.folder_mappings,
    );
    const archiveFolder = archive?.path || null;
    if (!archive && snapshot.rows.some(row => row.folder === 'INBOX')) {
      throw operationError(
        'No Archive destination is configured',
        'GTD_DONE_ARCHIVE_UNAVAILABLE',
        409,
        false,
      );
    }
    if (String(archiveFolder || '').toLowerCase() === 'inbox') {
      throw operationError('Archive destination cannot be INBOX', 'GTD_DONE_UNSAFE_ARCHIVE', 400);
    }
    if (archiveFolder && targetFolders.includes(archiveFolder)) {
      throw operationError(
        'A GTD Done label cannot be the Archive destination',
        'GTD_DONE_TARGET_IS_ARCHIVE',
        400,
      );
    }
    const plan = buildPlan(snapshot, targetFolders, archive);
    const planDigest = digest(plan);
    const inserted = await tx.query(
      `INSERT INTO gtd_done_operations (
         operation_key, user_id, account_id, acted_message_id, thread_key,
         intent, plan_digest, plan
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb)
       ON CONFLICT (operation_key) DO UPDATE
         SET operation_key = gtd_done_operations.operation_key
       RETURNING *`,
      [
        key, userId, snapshot.account.id, actedMessageId, snapshot.threadKey,
        JSON.stringify(normalizedIntent), planDigest, JSON.stringify(plan),
      ],
    );
    const stored = normalizeOperation(inserted.rows[0]);
    if (!stored || stored.planDigest !== planDigest) {
      throw operationError('GTD Done operation key collided with another plan', 'GTD_DONE_PLAN_COLLISION');
    }
    return stored;
  });
}

export async function advanceGtdDoneOperation(operation, nextPhase, nextIndex, outcome = null, plan = null) {
  return withTransaction(async tx => {
    const updated = await tx.query(
      `UPDATE gtd_done_operations
          SET phase = $4, item_index = $5,
              outcomes = outcomes || $6::jsonb,
              plan = COALESCE($8::jsonb, plan),
              completed_at = CASE WHEN $4 = 'completed' THEN NOW() ELSE completed_at END,
              claim_expires_at = CASE WHEN $4 = 'completed' THEN NULL ELSE NOW() + INTERVAL '30 minutes' END,
              claim_owner = CASE WHEN $4 = 'completed' THEN NULL ELSE claim_owner END,
              updated_at = NOW()
        WHERE operation_key = $1 AND phase = $2 AND item_index = $3
          AND claim_owner = $7
        RETURNING *`,
      [
        operation.key, operation.phase, operation.itemIndex, nextPhase, Number(nextIndex),
        JSON.stringify(outcome == null ? [] : [outcome]), operation.claimOwner,
        plan == null ? null : JSON.stringify(plan),
      ],
    );
    if (!updated.rows[0]) {
      throw operationError('GTD Done operation cursor was superseded', 'GTD_DONE_OPERATION_SUPERSEDED');
    }
    return normalizeOperation(updated.rows[0]);
  });
}

export async function claimGtdDoneOperation(operation) {
  const owner = randomUUID();
  return withTransaction(async tx => {
    const claimed = await tx.query(
      `UPDATE gtd_done_operations
          SET claim_owner = $4, claim_expires_at = NOW() + INTERVAL '30 minutes', updated_at = NOW()
        WHERE operation_key = $1 AND phase = $2 AND item_index = $3
          AND (claim_expires_at IS NULL OR claim_expires_at <= NOW())
        RETURNING *`,
      [operation.key, operation.phase, operation.itemIndex, owner],
    );
    if (!claimed.rows[0]) {
      throw operationError('GTD Done operation is already running', 'GTD_DONE_OPERATION_BUSY');
    }
    return normalizeOperation(claimed.rows[0]);
  });
}

export async function releaseGtdDoneOperation(operation) {
  if (!operation?.claimOwner) return;
  await withTransaction(tx => tx.query(
    `UPDATE gtd_done_operations
        SET claim_owner = NULL, claim_expires_at = NULL, updated_at = NOW()
      WHERE operation_key = $1 AND claim_owner = $2`,
    [operation.key, operation.claimOwner],
  ));
}

export async function renewGtdDoneOperation(operation) {
  return withTransaction(async tx => {
    const renewed = await tx.query(
      `UPDATE gtd_done_operations
          SET claim_expires_at = NOW() + INTERVAL '30 minutes', updated_at = NOW()
        WHERE operation_key = $1 AND phase = $2 AND item_index = $3
          AND claim_owner = $4 AND claim_expires_at > NOW()
        RETURNING *`,
      [operation.key, operation.phase, operation.itemIndex, operation.claimOwner],
    );
    if (!renewed.rows[0]) {
      throw operationError('GTD Done operation claim was lost', 'GTD_DONE_OPERATION_SUPERSEDED');
    }
    return normalizeOperation(renewed.rows[0]);
  });
}
