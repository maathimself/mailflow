import { randomUUID } from 'node:crypto';
import { query, withSession, withTransaction } from './db.js';

const FLAG_DEFINITIONS = Object.freeze({
  read: Object.freeze({ value: 'is_read', revision: 'read_revision', imap: '\\Seen' }),
  star: Object.freeze({ value: 'is_starred', revision: 'star_revision', imap: '\\Flagged' }),
});

// ImapFlow commands are bounded at 30 seconds. Renewing a three-minute durable
// lease immediately before STORE leaves enough room for STORE plus the checked
// post-observation without permitting an abandoned attempt to block forever.
export const DESIRED_FLAG_LEASE_MS = 180_000;

export class DesiredFlagError extends Error {
  constructor(message, { code, retryable = false, uncertain = false, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'DesiredFlagError';
    this.code = code;
    this.retryable = retryable;
    this.uncertain = uncertain;
  }
}

export function normalizeDesiredFlag(flag) {
  if (flag === 'read' || flag === '\\Seen') return 'read';
  if (flag === 'star' || flag === '\\Flagged') return 'star';
  throw new DesiredFlagError(`Unsupported durable desired flag ${flag}`, {
    code: 'DESIRED_FLAG_UNSUPPORTED',
  });
}

export function flagColumn(flag) {
  const logical = normalizeDesiredFlag(flag);
  const { value, revision } = FLAG_DEFINITIONS[logical];
  return { value, revision };
}

export function desiredFlagImapName(flag) {
  return FLAG_DEFINITIONS[normalizeDesiredFlag(flag)].imap;
}

export function createImapDesiredFlagSession(client, delivery) {
  const logical = normalizeDesiredFlag(delivery.flag);
  const imapFlag = desiredFlagImapName(logical);
  const uid = String(delivery.uid);
  const condstore = client.enabled?.has?.('CONDSTORE') === true &&
    client.mailbox?.noModseq !== true;
  return {
    condstore,
    async observe() {
      const message = await client.fetchOne(
        uid,
        { uid: true, flags: true, modseq: true },
        { uid: true },
      );
      if (!message || Number(message.uid) !== Number(delivery.uid)) {
        throw new DesiredFlagError(`Desired flag UID ${uid} is no longer present`, {
          code: 'DESIRED_FLAG_UID_NOT_FOUND', retryable: true, uncertain: true,
        });
      }
      return {
        value: message.flags?.has?.(imapFlag) === true,
        modseq: condstore && message.modseq != null ? String(message.modseq) : null,
      };
    },
    async store(value, { unchangedSince } = {}) {
      const options = { uid: true };
      if (condstore && unchangedSince != null) options.unchangedSince = BigInt(unchangedSince);
      return value
        ? client.messageFlagsAdd(uid, [imapFlag], options)
        : client.messageFlagsRemove(uid, [imapFlag], options);
    },
  };
}

function ownershipLost(err) {
  return err?.code === 'DESIRED_FLAG_OWNERSHIP_LOST';
}

function deliveryUncertain(err) {
  if (err instanceof DesiredFlagError && err.uncertain) return err;
  return new DesiredFlagError(`Desired flag delivery is uncertain: ${err?.message || 'provider failure'}`, {
    code: 'DESIRED_FLAG_DELIVERY_UNCERTAIN',
    retryable: true,
    uncertain: true,
    cause: err,
  });
}

export function createDesiredFlagExecutor({
  repository,
  ownerFactory = randomUUID,
} = {}) {
  if (!repository) throw new Error('Desired flag repository is required');

  return {
    async accept({ messageId, flag, value, ...snapshot }) {
      const logical = normalizeDesiredFlag(flag);
      const desiredValue = value === true;
      const accepted = await repository.acceptIntent({
        messageId,
        flag: logical,
        value: desiredValue,
        ...snapshot,
      });
      return {
        ...accepted,
        unreadDelta: logical === 'read' && accepted.changed
          ? (desiredValue ? -1 : 1)
          : 0,
      };
    },

    async deliver(messageId, flag, provider) {
      const logical = normalizeDesiredFlag(flag);
      if (!provider?.withSession) {
        throw deliveryUncertain(new Error('Desired flag provider session is required'));
      }
      if (!repository.withDeliveryLease) {
        throw deliveryUncertain(new Error('Desired flag repository delivery lease is required'));
      }
      let candidate;
      try {
        candidate = await repository.load(messageId, logical);
      } catch (err) {
        throw deliveryUncertain(err);
      }
      if (!candidate || candidate.state === 'confirmed') return candidate;

      // Acquire the provider connection before the DB advisory lease. The lease
      // then serializes claim, observation, STORE, and checked completion across
      // processes without holding row locks or a transaction during provider I/O.
      try {
        return await provider.withSession(candidate, session =>
          repository.withDeliveryLease(messageId, logical, async lease => {
            const attempt = await repository.claim(messageId, logical, ownerFactory(), lease);
            if (!attempt || attempt.state === 'confirmed') return attempt;
            let baselineRecorded = false;
            let providerCommandStarted = false;
            try {
              const before = await session.observe();
              const condstore = session.condstore === true && before.modseq != null;
              const owned = await repository.recordBaseline(
                attempt,
                before.modseq == null ? null : String(before.modseq),
                condstore,
              );
              baselineRecorded = true;

              const mustReassert = owned.uncertaintyTombstones?.length > 0 ||
                before.value !== owned.desiredValue;
              if (mustReassert) {
                await lease.assertActive();
                await repository.renewLease(attempt);
                await lease.assertActive();
                await repository.markProviderStarted(attempt);
                providerCommandStarted = true;
                const stored = await session.store(owned.desiredValue, {
                  unchangedSince: condstore ? String(before.modseq) : undefined,
                });
                if (stored === false) {
                  throw new DesiredFlagError('Provider did not confirm desired flag STORE', {
                    code: 'DESIRED_FLAG_STORE_UNCONFIRMED', retryable: true, uncertain: true,
                  });
                }
              }

              const after = mustReassert ? await session.observe() : before;
              await lease.assertActive();
              await repository.renewLease(attempt);
              await lease.assertActive();
              return repository.complete(attempt, {
                value: after.value,
                modseq: after.modseq == null ? null : String(after.modseq),
                condstore,
              });
            } catch (err) {
              if (ownershipLost(err)) throw err;
              const uncertain = deliveryUncertain(err);
              try {
                if (!providerCommandStarted) {
                  await repository.releasePending(attempt, {
                    code: uncertain.code,
                    message: uncertain.message,
                    at: new Date().toISOString(),
                  });
                } else {
                  await repository.markUncertain(attempt, {
                    code: uncertain.code,
                    message: uncertain.message,
                    baselineRecorded,
                    at: new Date().toISOString(),
                  });
                }
              } catch (markErr) {
                if (ownershipLost(markErr)) throw markErr;
                throw new DesiredFlagError('Could not persist desired flag uncertainty', {
                  code: 'DESIRED_FLAG_UNCERTAINTY_PERSIST_FAILED',
                  retryable: true,
                  uncertain: true,
                  cause: markErr,
                });
              }
              throw uncertain;
            }
          })
        );
      } catch (err) {
        throw deliveryUncertain(err);
      }
    },
  };
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function deliveryFromRow(row) {
  if (!row) return null;
  return {
    messageId: row.message_id,
    flag: row.flag,
    accountId: row.account_id,
    uid: Number(row.uid),
    folder: row.folder,
    uidValidity: String(row.uid_validity),
    folderGeneration: String(row.folder_generation),
    revision: Number(row.revision),
    desiredValue: row.desired_value === true,
    state: row.state,
    capturedModseq: row.captured_modseq == null ? null : String(row.captured_modseq),
    condstore: row.condstore === true,
    uncertaintyTombstones: parseJsonArray(row.uncertainty_tombstones),
    attemptGeneration: Number(row.attempt_generation),
    attemptOwner: row.attempt_owner,
    leaseExpiresAt: row.lease_expires_at == null ? null : String(row.lease_expires_at),
    providerStartedAt: row.provider_started_at == null ? null : String(row.provider_started_at),
  };
}

function rowSuperseded(messageId) {
  return new DesiredFlagError(`Desired flag row ${messageId} is no longer actionable`, {
    code: 'DESIRED_FLAG_ROW_SUPERSEDED', retryable: true, uncertain: true,
  });
}

function lostOwnership() {
  return new DesiredFlagError('Desired flag ownership was lost', {
    code: 'DESIRED_FLAG_OWNERSHIP_LOST', retryable: true, uncertain: true,
  });
}

function sameFact(expected, actual) {
  return expected === undefined || expected === null || String(expected) === String(actual);
}

function checkedDeliveryParams(attempt) {
  return [
    attempt.messageId,
    normalizeDesiredFlag(attempt.flag),
    attempt.revision,
    attempt.attemptGeneration,
    attempt.attemptOwner,
  ];
}

export function createPostgresDesiredFlagRepository({
  runQuery = query,
  runTransaction = withTransaction,
  runSession = withSession,
} = {}) {
  const activeLeaseTokens = new WeakSet();
  const loadChecked = async (tx, attempt, { requireLease = false } = {}) => {
    const current = await tx.query(
      `SELECT * FROM message_flag_deliveries
        WHERE message_id = $1 AND flag = $2
          AND revision = $3 AND attempt_generation = $4 AND attempt_owner = $5
          ${requireLease ? "AND state = 'delivering' AND lease_expires_at > NOW()" : ''}
        FOR UPDATE`,
      checkedDeliveryParams(attempt),
    );
    if (!current.rows[0]) throw lostOwnership();
    return deliveryFromRow(current.rows[0]);
  };

  return {
    async withDeliveryLease(messageId, flag, callback) {
      const key = `${messageId}:${normalizeDesiredFlag(flag)}`;
      return runSession(async client => {
        await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [key]);
        const lease = {
          key,
          async assertActive() {
            if (!activeLeaseTokens.has(lease)) {
              throw new DesiredFlagError('Desired flag advisory lease is no longer active', {
                code: 'DESIRED_FLAG_LEASE_SESSION_LOST', retryable: true, uncertain: true,
              });
            }
            let result;
            try {
              result = await client.query(
                `SELECT EXISTS (
                   SELECT 1 FROM pg_locks
                    WHERE pid = pg_backend_pid() AND locktype = 'advisory' AND granted = true
                      AND objsubid = 1
                      AND classid = (((hashtextextended($1, 0) >> 32) & 4294967295)::oid)
                      AND objid = ((hashtextextended($1, 0) & 4294967295)::oid)
                 ) AS held`,
                [key],
              );
            } catch (cause) {
              throw new DesiredFlagError('Desired flag advisory session was lost', {
                code: 'DESIRED_FLAG_LEASE_SESSION_LOST', retryable: true, uncertain: true, cause,
              });
            }
            if (result.rows[0]?.held !== true) {
              throw new DesiredFlagError('Desired flag advisory lock was lost', {
                code: 'DESIRED_FLAG_LEASE_SESSION_LOST', retryable: true, uncertain: true,
              });
            }
          },
        };
        activeLeaseTokens.add(lease);
        try {
          return await callback(lease);
        } finally {
          activeLeaseTokens.delete(lease);
          await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [key])
            .catch(() => {});
        }
      });
    },

    async acceptIntent({
      messageId, flag, value, accountId, uid, folder, uidValidity, folderGeneration,
    }) {
      const logical = normalizeDesiredFlag(flag);
      const columns = flagColumn(logical);
      return runTransaction(async tx => {
        const locked = await tx.query(
          `SELECT m.id, m.account_id, m.uid, m.folder, m.is_read, m.is_starred,
                  m.read_revision, m.star_revision,
                  f.uid_validity, f.observation_generation
             FROM messages m
             JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
                            AND f.is_present = true AND f.uid_validity IS NOT NULL
            WHERE m.id = $1 AND m.is_deleted = false AND m.metadata_complete = true
            FOR UPDATE OF f, m`,
          [messageId],
        );
        const message = locked.rows[0];
        if (!message ||
            !sameFact(accountId, message.account_id) ||
            !sameFact(uid, message.uid) ||
            !sameFact(folder, message.folder) ||
            !sameFact(uidValidity, message.uid_validity) ||
            !sameFact(folderGeneration, message.observation_generation)) {
          throw rowSuperseded(messageId);
        }

        const previousResult = await tx.query(
          `SELECT * FROM message_flag_deliveries
            WHERE message_id = $1 AND flag = $2
            FOR UPDATE`,
          [messageId, logical],
        );
        const previous = deliveryFromRow(previousResult.rows[0]);
        const previousValue = logical === 'read' ? message.is_read === true : message.is_starred === true;
        const changed = previousValue !== (value === true);
        const updated = await tx.query(
          `UPDATE messages
              SET ${columns.value} = $2,
                  ${columns.revision} = ${columns.revision} + 1,
                  ${logical === 'read' ? 'read_changed_at' : 'star_changed_at'} = NOW()
            WHERE id = $1
            RETURNING ${columns.revision} AS revision, ${columns.value} AS visible_value`,
          [messageId, value === true],
        );
        if (!updated.rows[0]) throw rowSuperseded(messageId);

        if (logical === 'read' && changed) {
          const unreadDelta = value === true ? -1 : 1;
          const count = await tx.query(
            `UPDATE folders
                SET unread_count = GREATEST(0, unread_count + $1)
              WHERE account_id = $2 AND path = $3`,
            [unreadDelta, message.account_id, message.folder],
          );
          if (count.rowCount !== 1) throw rowSuperseded(messageId);
        }

        const tombstones = [...(previous?.uncertaintyTombstones || [])];
        if (previous && (previous.state === 'uncertain' ||
            (previous.state === 'delivering' && previous.providerStartedAt != null)) &&
            !tombstones.some(item => Number(item.revision) === previous.revision)) {
          tombstones.push({
            revision: previous.revision,
            value: previous.desiredValue,
            baseline: previous.capturedModseq,
            attemptGeneration: previous.attemptGeneration,
            reason: 'superseded',
          });
        }
        const revision = updated.rows[0].revision;
        const inserted = await tx.query(
          `INSERT INTO message_flag_deliveries (
             message_id, flag, account_id, folder, uid, uid_validity, folder_generation,
             revision, desired_value, state, captured_modseq, condstore,
             uncertainty_tombstones, attempt_generation, attempt_owner, updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', NULL, NULL,
                     $10::jsonb, $11, NULL, NOW())
           ON CONFLICT (message_id, flag) DO UPDATE SET
             account_id = EXCLUDED.account_id,
             folder = EXCLUDED.folder,
             uid = EXCLUDED.uid,
             uid_validity = EXCLUDED.uid_validity,
             folder_generation = EXCLUDED.folder_generation,
             revision = EXCLUDED.revision,
             desired_value = EXCLUDED.desired_value,
             state = 'pending',
             captured_modseq = NULL,
             condstore = NULL,
             uncertainty_tombstones = EXCLUDED.uncertainty_tombstones,
             attempt_generation = EXCLUDED.attempt_generation,
             attempt_owner = NULL,
             lease_expires_at = NULL,
             provider_started_at = NULL,
             confirmed_at = NULL,
             updated_at = NOW()
           RETURNING *`,
          [
            messageId, logical, message.account_id, message.folder, message.uid,
            message.uid_validity, message.observation_generation, revision, value === true,
            JSON.stringify(tombstones), previous?.attemptGeneration || 0,
          ],
        );
        return { delivery: deliveryFromRow(inserted.rows[0]), changed };
      });
    },

    async claim(messageId, flag, owner, lease) {
      const logical = normalizeDesiredFlag(flag);
      if (!activeLeaseTokens.has(lease) || lease.key !== `${messageId}:${logical}`) {
        throw new DesiredFlagError('Desired flag claim requires its active delivery lease', {
          code: 'DESIRED_FLAG_LEASE_REQUIRED', retryable: true, uncertain: true,
        });
      }
      return runTransaction(async tx => {
        const locked = await tx.query(
          `SELECT * FROM message_flag_deliveries
            WHERE message_id = $1 AND flag = $2
            FOR UPDATE`,
          [messageId, logical],
        );
        const current = deliveryFromRow(locked.rows[0]);
        if (!current || current.state === 'confirmed') return current;
        const tombstones = [...current.uncertaintyTombstones];
        if (current.state === 'delivering' && current.providerStartedAt != null &&
            !tombstones.some(item => Number(item.revision) === current.revision &&
              Number(item.attemptGeneration) === current.attemptGeneration)) {
          tombstones.push({
            revision: current.revision,
            value: current.desiredValue,
            baseline: current.capturedModseq,
            attemptGeneration: current.attemptGeneration,
            reason: 'ownership-takeover',
          });
        }
        const claimed = await tx.query(
          `UPDATE message_flag_deliveries
              SET state = 'delivering',
                  attempt_generation = attempt_generation + 1,
                  attempt_owner = $3,
                  uncertainty_tombstones = $4::jsonb,
                  lease_expires_at = NOW() + ($6::bigint * INTERVAL '1 millisecond'),
                  captured_modseq = NULL,
                  condstore = NULL,
                  provider_started_at = NULL,
                  updated_at = NOW()
            WHERE message_id = $1 AND flag = $2 AND revision = $5
              AND (state <> 'delivering' OR lease_expires_at IS NULL OR lease_expires_at <= NOW())
            RETURNING *`,
          [
            messageId, logical, owner, JSON.stringify(tombstones), current.revision,
            DESIRED_FLAG_LEASE_MS,
          ],
        );
        if (!claimed.rows[0]) {
          if (current.state === 'delivering') {
            throw new DesiredFlagError('Desired flag delivery lease is still active', {
              code: 'DESIRED_FLAG_LEASE_ACTIVE', retryable: true, uncertain: true,
            });
          }
          throw lostOwnership();
        }
        return deliveryFromRow(claimed.rows[0]);
      });
    },

    async renewLease(attempt) {
      return runTransaction(async tx => {
        const renewed = await tx.query(
          `UPDATE message_flag_deliveries
              SET lease_expires_at = NOW() + ($6::bigint * INTERVAL '1 millisecond'),
                  updated_at = NOW()
            WHERE message_id = $1 AND flag = $2
              AND revision = $3 AND attempt_generation = $4 AND attempt_owner = $5
              AND state = 'delivering' AND lease_expires_at > NOW()
            RETURNING *`,
          [...checkedDeliveryParams(attempt), DESIRED_FLAG_LEASE_MS],
        );
        if (!renewed.rows[0]) throw lostOwnership();
        return deliveryFromRow(renewed.rows[0]);
      });
    },

    async recordBaseline(attempt, baseline, condstore) {
      return runTransaction(async tx => {
        const result = await tx.query(
          `UPDATE message_flag_deliveries
              SET captured_modseq = $6,
                  condstore = $7,
                  updated_at = NOW()
            WHERE message_id = $1 AND flag = $2
              AND revision = $3 AND attempt_generation = $4 AND attempt_owner = $5
              AND state = 'delivering' AND lease_expires_at > NOW()
            RETURNING *`,
          [...checkedDeliveryParams(attempt), baseline, condstore],
        );
        if (!result.rows[0]) throw lostOwnership();
        return deliveryFromRow(result.rows[0]);
      });
    },

    async markProviderStarted(attempt) {
      return runTransaction(async tx => {
        const result = await tx.query(
          `UPDATE message_flag_deliveries
              SET provider_started_at = NOW(), updated_at = NOW()
            WHERE message_id = $1 AND flag = $2
              AND revision = $3 AND attempt_generation = $4 AND attempt_owner = $5
              AND state = 'delivering' AND lease_expires_at > NOW()
              AND condstore IS NOT NULL
            RETURNING *`,
          checkedDeliveryParams(attempt),
        );
        if (!result.rows[0]) throw lostOwnership();
        return deliveryFromRow(result.rows[0]);
      });
    },

    async complete(attempt, result) {
      return runTransaction(async tx => {
        const current = await loadChecked(tx, attempt, { requireLease: true });
        const tombstones = [...current.uncertaintyTombstones];
        const strictProof = tombstones.length > 0 && result.condstore === true &&
          result.modseq != null && tombstones.every(item =>
            item.baseline != null && BigInt(result.modseq) > BigInt(item.baseline));
        const confirmed = result.value === current.desiredValue &&
          (tombstones.length === 0 || strictProof);
        if (!confirmed && tombstones.length === 0) {
          tombstones.push({
            revision: current.revision,
            value: current.desiredValue,
            baseline: current.capturedModseq,
            attemptGeneration: current.attemptGeneration,
            reason: 'post-store-mismatch',
          });
        }
        const updated = await tx.query(
          `UPDATE message_flag_deliveries
              SET state = $6,
                  uncertainty_tombstones = $7::jsonb,
                  attempt_owner = NULL,
                  lease_expires_at = NULL,
                  provider_started_at = NULL,
                  confirmed_at = CASE WHEN $6 = 'confirmed' THEN NOW() ELSE NULL END,
                  updated_at = NOW()
            WHERE message_id = $1 AND flag = $2
              AND revision = $3 AND attempt_generation = $4 AND attempt_owner = $5
            RETURNING *`,
          [
            ...checkedDeliveryParams(attempt), confirmed ? 'confirmed' : 'uncertain',
            JSON.stringify(confirmed ? [] : tombstones),
          ],
        );
        if (!updated.rows[0]) throw lostOwnership();
        return deliveryFromRow(updated.rows[0]);
      });
    },

    async markUncertain(attempt, uncertainty) {
      return runTransaction(async tx => {
        const current = await loadChecked(tx, attempt);
        const tombstones = [...current.uncertaintyTombstones];
        if (!tombstones.some(item => Number(item.revision) === current.revision &&
            Number(item.attemptGeneration) === current.attemptGeneration)) {
          tombstones.push({
            revision: current.revision,
            value: current.desiredValue,
            baseline: current.capturedModseq,
            attemptGeneration: current.attemptGeneration,
            uncertainty,
          });
        }
        const updated = await tx.query(
          `UPDATE message_flag_deliveries
              SET state = 'uncertain', uncertainty_tombstones = $6::jsonb,
                  attempt_owner = NULL, lease_expires_at = NULL,
                  provider_started_at = NULL, updated_at = NOW()
            WHERE message_id = $1 AND flag = $2
              AND revision = $3 AND attempt_generation = $4 AND attempt_owner = $5
            RETURNING *`,
          [...checkedDeliveryParams(attempt), JSON.stringify(tombstones)],
        );
        if (!updated.rows[0]) throw lostOwnership();
        return deliveryFromRow(updated.rows[0]);
      });
    },

    async releasePending(attempt) {
      return runTransaction(async tx => {
        const current = await loadChecked(tx, attempt);
        const state = current.uncertaintyTombstones.length > 0 ? 'uncertain' : 'pending';
        const updated = await tx.query(
          `UPDATE message_flag_deliveries
              SET state = $6, attempt_owner = NULL, lease_expires_at = NULL,
                  provider_started_at = NULL, updated_at = NOW()
            WHERE message_id = $1 AND flag = $2
              AND revision = $3 AND attempt_generation = $4 AND attempt_owner = $5
            RETURNING *`,
          [...checkedDeliveryParams(attempt), state],
        );
        if (!updated.rows[0]) throw lostOwnership();
        return deliveryFromRow(updated.rows[0]);
      });
    },

    async load(messageId, flag) {
      const result = await runQuery(
        'SELECT * FROM message_flag_deliveries WHERE message_id = $1 AND flag = $2',
        [messageId, normalizeDesiredFlag(flag)],
      );
      return deliveryFromRow(result.rows[0]);
    },

    async listPending(limit = 100) {
      const result = await runQuery(
        `SELECT d.*
           FROM message_flag_deliveries d
           JOIN messages m ON m.id = d.message_id
           JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
          WHERE d.state IN ('pending', 'delivering', 'uncertain')
            AND (d.state <> 'delivering' OR d.lease_expires_at IS NULL
                 OR d.lease_expires_at <= NOW())
            AND (d.state <> 'delivering' OR NOT EXISTS (
              SELECT 1
                FROM pg_locks l
               WHERE l.locktype = 'advisory' AND l.granted = true
                 AND l.objsubid = 1
                 AND l.classid = (((hashtextextended(d.message_id::text || ':' || d.flag, 0) >> 32)
                                    & 4294967295)::oid)
                 AND l.objid = ((hashtextextended(d.message_id::text || ':' || d.flag, 0)
                                 & 4294967295)::oid)
            ))
            AND m.is_deleted = false AND m.metadata_complete = true
            AND f.is_present = true AND f.uid_validity IS NOT NULL
            AND m.account_id = d.account_id
            AND m.uid = d.uid AND m.folder = d.folder
            AND f.uid_validity = d.uid_validity
            AND f.observation_generation = d.folder_generation
          ORDER BY d.updated_at, d.message_id, d.flag
          LIMIT $1`,
        [limit],
      );
      return result.rows.map(deliveryFromRow);
    },

    async applyPull({ accountId, folder, uidValidity, folderGeneration, rows }) {
      if (!rows?.length) return 0;
      return runTransaction(async tx => {
        const observed = await tx.query(
          `SELECT uid_validity, observation_generation, is_present
             FROM folders
            WHERE account_id = $1 AND path = $2
            FOR SHARE`,
          [accountId, folder],
        );
        const state = observed.rows[0];
        if (!state || state.is_present === false || state.uid_validity == null ||
            String(state.uid_validity) !== String(uidValidity) ||
            String(state.observation_generation) !== String(folderGeneration)) {
          throw rowSuperseded(`folder:${folder}`);
        }
        const payload = rows.map(row => ({
          id: row.id,
          uid: Number(row.uid),
          read_revision: Number(row.readRevision),
          star_revision: Number(row.starRevision),
          is_read: row.isRead === true,
          is_starred: row.isStarred === true,
          modseq: row.modseq == null ? null : String(row.modseq),
        }));
        const result = await tx.query(
          `WITH pulled AS (
             SELECT * FROM jsonb_to_recordset($3::jsonb) AS p(
               id uuid, uid bigint, read_revision bigint, star_revision bigint,
               is_read boolean, is_starred boolean, modseq numeric
             )
           ), candidates AS (
             SELECT m.id, m.is_read AS old_is_read, m.is_starred AS old_is_starred,
                    pulled.is_read, pulled.is_starred, pulled.modseq,
                    m.read_revision = pulled.read_revision AND NOT EXISTS (
                      SELECT 1 FROM message_flag_deliveries d
                       WHERE d.message_id = m.id AND d.flag = 'read'
                         AND d.state IN ('pending', 'delivering', 'uncertain')
                    ) AS apply_read,
                    m.star_revision = pulled.star_revision AND NOT EXISTS (
                      SELECT 1 FROM message_flag_deliveries d
                       WHERE d.message_id = m.id AND d.flag = 'star'
                         AND d.state IN ('pending', 'delivering', 'uncertain')
                    ) AS apply_star
               FROM messages m
               JOIN pulled ON m.id = pulled.id AND m.uid = pulled.uid
              WHERE m.account_id = $1 AND m.folder = $2
                AND m.is_deleted = false AND m.metadata_complete = true
           )
           UPDATE messages m
              SET is_read = CASE WHEN candidates.apply_read THEN candidates.is_read ELSE m.is_read END,
                  is_starred = CASE WHEN candidates.apply_star THEN candidates.is_starred ELSE m.is_starred END,
                  provider_modseq = CASE
                    WHEN candidates.modseq IS NULL THEN m.provider_modseq
                    WHEN m.provider_modseq IS NULL OR candidates.modseq > m.provider_modseq
                    THEN candidates.modseq ELSE m.provider_modseq END
             FROM candidates
            WHERE m.id = candidates.id
            RETURNING m.folder, candidates.old_is_read, m.is_read,
                      candidates.old_is_starred, m.is_starred`,
          [accountId, folder, JSON.stringify(payload)],
        );
        const changedRows = result.rows.filter(row =>
          row.old_is_read !== row.is_read || row.old_is_starred !== row.is_starred);
        const unreadDelta = result.rows.reduce((sum, row) => {
          if (row.old_is_read === row.is_read) return sum;
          return sum + (row.is_read === true ? -1 : 1);
        }, 0);
        if (unreadDelta !== 0) {
          const count = await tx.query(
            `UPDATE folders
                SET unread_count = GREATEST(0, unread_count + $1)
              WHERE account_id = $2 AND path = $3`,
            [unreadDelta, accountId, folder],
          );
          if (count.rowCount !== 1) throw rowSuperseded(`folder:${folder}`);
        }
        return changedRows.length;
      });
    },
  };
}

export const desiredFlagRepository = createPostgresDesiredFlagRepository();
export const desiredFlagExecutor = createDesiredFlagExecutor({ repository: desiredFlagRepository });
