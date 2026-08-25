import { createHash, randomUUID } from 'node:crypto';
import { pool } from './db.js';

const STATES = ['ready', 'provider_started', 'provider_applied', 'completed', 'manual_intervention'];

function required(value, label) {
  if (value === undefined || value === null || value === '') {
    throw new Error(`${label} is required`);
  }
  return value;
}

function observation(value, label) {
  if (!value || value.uidValidity === undefined || value.uidValidity === null) {
    throw new Error(`${label} UIDVALIDITY is required`);
  }
  if (value.generation === undefined || value.generation === null) {
    throw new Error(`${label} observation generation is required`);
  }
  return {
    folder: required(value.folder, `${label} folder`),
    ...(value.uid === undefined ? {} : { uid: Number(value.uid) }),
    uidValidity: String(value.uidValidity),
    generation: String(value.generation),
    ...(value.topologyIdentity == null ? {} : {
      topologyIdentity: String(value.topologyIdentity),
    }),
  };
}

function identityMismatch(message) {
  return new ProviderOperationError(message, {
    code: 'PROVIDER_OPERATION_IDENTITY_MISMATCH', retryable: true, uncertain: true,
  });
}

function rebaseToken(persisted, fresh, label, { includeUid = false } = {}) {
  if (!persisted || !fresh || persisted.folder !== fresh.folder ||
      String(persisted.uidValidity) !== String(fresh.uidValidity) ||
      (includeUid && Number(persisted.uid) !== Number(fresh.uid))) {
    throw identityMismatch(`${label} provider observation identity changed`);
  }
  let persistedGeneration;
  let freshGeneration;
  try {
    persistedGeneration = BigInt(persisted.generation);
    freshGeneration = BigInt(fresh.generation);
  } catch {
    throw identityMismatch(`${label} provider observation generation is invalid`);
  }
  if (freshGeneration < persistedGeneration) {
    throw identityMismatch(`${label} provider observation generation moved backward`);
  }
  if (freshGeneration !== persistedGeneration && (
    persisted.topologyIdentity == null || fresh.topologyIdentity == null ||
    String(persisted.topologyIdentity) !== String(fresh.topologyIdentity)
  )) {
    throw identityMismatch(`${label} provider folder incarnation changed`);
  }
  return {
    ...persisted,
    generation: String(fresh.generation),
    ...(fresh.topologyIdentity == null ? {} : {
      topologyIdentity: String(fresh.topologyIdentity),
    }),
  };
}

function rebaseInFlightOperation(operation, intent) {
  if (operation.id !== intent.id || operation.kind !== intent.kind ||
      operation.accountId !== intent.accountId || operation.marker !== intent.marker ||
      (operation.sourceMessageId != null && intent.sourceMessageId != null &&
       operation.sourceMessageId !== intent.sourceMessageId)) {
    throw identityMismatch('Provider operation identity changed during recovery');
  }
  const source = operation.source
    ? rebaseToken(operation.source, intent.source, 'Source', { includeUid: true })
    : null;
  const destination = rebaseToken(operation.destination, intent.destination, 'Destination');
  let receipt = operation.receipt;
  if (receipt) {
    receipt = {
      ...receipt,
      ...(receipt.sourceToken ? {
        sourceToken: rebaseToken(receipt.sourceToken, intent.source, 'Receipt source', {
          includeUid: true,
        }),
      } : {}),
      ...(receipt.destinationToken ? {
        destinationToken: rebaseToken(
          receipt.destinationToken, intent.destination, 'Receipt destination',
        ),
      } : {}),
    };
  }
  return {
    ...operation, source, destination, receipt,
    requestKey: operation.requestKey || intent.requestKey,
    sourceMessageId: operation.sourceMessageId || intent.sourceMessageId || null,
  };
}

export function providerOperationMarker(operationId) {
  const digest = createHash('sha256').update(String(operationId)).digest('base64url');
  return `$MailFlowOp-${digest}`;
}

export function buildProviderOperationId(input) {
  const kind = required(input?.kind, 'operation kind').toLowerCase();
  if (!['move', 'copy', 'append', 'delete'].includes(kind)) {
    throw new Error(`Unsupported provider operation ${kind}`);
  }
  const accountId = required(input.accountId, 'account id');
  const requestKey = required(input.requestKey, `${kind.toUpperCase()} request key`);
  const destinationFolder = required(
    input.destinationFolder ?? input.destination?.folder,
    'destination folder',
  );
  const stableSource = kind === 'append' ? null : {
    folder: required(input.source?.folder, 'source folder'),
    uid: Number(required(input.source?.uid, 'source uid')),
  };
  return createHash('sha256').update(JSON.stringify({
    kind, accountId, source: stableSource, destinationFolder, requestKey,
  })).digest('hex');
}

export function buildProviderOperationIdentity(input) {
  const kind = required(input?.kind, 'operation kind').toLowerCase();
  if (!['move', 'copy', 'append', 'delete'].includes(kind)) throw new Error(`Unsupported provider operation ${kind}`);
  const accountId = required(input.accountId, 'account id');
  const destination = observation(input.destination, 'destination');
  const source = kind === 'append' ? null : observation(input.source, 'source');
  if (source) required(source.uid, 'source uid');
  const requestKey = required(input.requestKey, `${kind.toUpperCase()} request key`);
  // Observation generations and UID epochs fence the provider mutation, but are deliberately
  // not caller identity. A fresh process can read a later observation or changed epoch; hashing
  // either would create a second operation and marker instead of safely rejecting recovery of
  // the original logical action. Persisted observations still validate both epochs and topology.
  const id = buildProviderOperationId({
    kind, accountId, source, destinationFolder: destination.folder, requestKey,
  });
  return {
    id,
    kind,
    accountId,
    source,
    destination,
    requestKey,
    sourceMessageId: input.sourceMessageId == null ? null : String(input.sourceMessageId),
    marker: providerOperationMarker(id),
  };
}

export class ProviderOperationError extends Error {
  constructor(message, {
    code, retryable = true, uncertain = true, details = null, manual = false,
  } = {}) {
    super(message);
    this.name = 'ProviderOperationError';
    this.code = code;
    this.retryable = retryable;
    this.uncertain = uncertain;
    this.details = details;
    this.manual = manual;
  }
}

function recoveryError(result) {
  if (result?.status === 'absent') {
    return new ProviderOperationError('Provider marker is not currently observable', {
      code: 'PROVIDER_MARKER_ABSENT', details: result,
    });
  }
  return new ProviderOperationError('Provider marker recovery is ambiguous', {
    code: 'PROVIDER_MARKER_AMBIGUOUS', details: result,
  });
}

function createSemaphore(limit) {
  let active = 0;
  const waiting = [];
  return async function withSlot(callback) {
    if (active >= limit) await new Promise(resolve => waiting.push(resolve));
    active++;
    try {
      return await callback();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

export function createProviderOperationExecutor({ repository, maxConcurrent = 4 } = {}) {
  if (!repository?.withOwnership) throw new Error('Provider operation repository is required');
  const withSlot = createSemaphore(maxConcurrent);
  return {
    getExisting(operationId) {
      return withSlot(() => repository.withOwnership(operationId, session => session.loadExisting()));
    },

    listPendingCleanup(limit = 20) {
      if (!repository.listPendingCleanup) return Promise.resolve([]);
      return repository.listPendingCleanup(limit);
    },

    findMoveBySource(input) {
      if (!repository.findMoveBySource) return Promise.resolve(null);
      return repository.findMoveBySource(input);
    },

    completeExisting(operationId, spec = {}) {
      return withSlot(() => repository.withOwnership(operationId, async session => {
        let operation = await session.loadExisting();
        if (!operation) return { status: 'missing' };
        if (operation.state === 'provider_applied' && spec.intent) {
          const rebased = rebaseInFlightOperation(operation, spec.intent);
          const changed = JSON.stringify([
            operation.requestKey, operation.sourceMessageId,
            operation.source, operation.destination, operation.receipt,
          ]) !== JSON.stringify([
            rebased.requestKey, rebased.sourceMessageId,
            rebased.source, rebased.destination, rebased.receipt,
          ]);
          if (changed) operation = await session.rebaseInFlightIntent(operation, rebased);
        }
        await spec.validateExisting?.(operation);
        const runPostCommit = async (provider = null, { claimCompleted = false } = {}) => {
          await spec.afterCommit?.(operation.receipt, operation, provider);
          if (!spec.cleanup || operation.cleanupState === 'completed') return;
          if (claimCompleted) {
            operation = await session.claimAttempt(operation, 'completed', randomUUID());
          }
          const attempt = {
            generation: operation.attemptGeneration, owner: operation.attemptOwner,
          };
          try {
            await spec.cleanup(provider, operation.marker, operation.receipt, operation);
            operation = await session.markCleanupCompleted(operation.id, attempt);
          } catch (cause) {
            await session.recordCleanupError(operation.id, attempt, {
              message: cause?.message || String(cause), at: new Date().toISOString(),
            });
            throw cause;
          }
        };
        if (operation.state === 'completed') {
          if (spec.cleanup && operation.cleanupState !== 'completed') {
            if (!spec.acquireProvider) throw new Error('Provider cleanup requires acquisition');
            await spec.acquireProvider(
              provider => runPostCommit(provider, { claimCompleted: true }), operation,
            );
          } else {
            await runPostCommit();
          }
          return {
            status: 'completed', operation, receipt: operation.receipt, replayed: true,
          };
        }
        if (operation.state !== 'provider_applied') {
          return { status: 'pending', operation };
        }

        const finish = async (provider = null) => {
          operation = await session.claimAttempt(operation, 'provider_applied', randomUUID());
          const attempt = {
            generation: operation.attemptGeneration, owner: operation.attemptOwner,
          };
          await session.withMutationFence(async tx => {
            await spec.validateCompletion?.(tx, operation);
            const receipt = spec.complete
              ? await spec.complete(operation.receipt, operation, tx, provider)
              : operation.receipt;
            operation = await session.markCompleted(operation.id, attempt, receipt, tx);
          });
          await runPostCommit(provider);
        };
        if (spec.completeWithProvider || spec.cleanup) {
          if (!spec.acquireProvider) throw new Error('Provider-backed completion requires acquisition');
          await spec.acquireProvider(finish, operation);
        } else {
          await finish();
        }
        return {
          status: 'completed', operation, receipt: operation.receipt, replayed: false,
        };
      }));
    },

    execute(spec) {
      return withSlot(() => repository.withOwnership(spec.intent.id, async session => {
        let operation = await session.loadOrCreate(spec.intent);
        if (operation.state === 'ready') {
          operation = await session.refreshReadyIntent(operation, spec.intent);
        }
        if (['provider_started', 'provider_applied'].includes(operation.state)) {
          const rebased = rebaseInFlightOperation(operation, spec.intent);
          const changed = JSON.stringify([
            operation.requestKey, operation.sourceMessageId,
            operation.source, operation.destination, operation.receipt,
          ]) !== JSON.stringify([
            rebased.requestKey, rebased.sourceMessageId,
            rebased.source, rebased.destination, rebased.receipt,
          ]);
          if (changed) operation = await session.rebaseInFlightIntent(operation, rebased);
        }
        const runPostCommit = async (provider = null, { claimCompleted = false } = {}) => {
          await spec.afterCommit?.(operation.receipt, operation, provider);
          if (!spec.cleanup || operation.cleanupState === 'completed') return;
          if (claimCompleted) {
            operation = await session.claimAttempt(operation, 'completed', randomUUID());
          }
          const attempt = {
            generation: operation.attemptGeneration, owner: operation.attemptOwner,
          };
          try {
            await spec.cleanup(provider, operation.marker, operation.receipt, operation);
            operation = await session.markCleanupCompleted(operation.id, attempt);
          } catch (cause) {
            await session.recordCleanupError(operation.id, attempt, {
              message: cause?.message || String(cause), at: new Date().toISOString(),
            });
            throw cause;
          }
        };
        if (operation.state === 'completed') {
          if (spec.cleanup && operation.cleanupState !== 'completed') {
            await spec.acquireProvider(
              provider => runPostCommit(provider, { claimCompleted: true }), operation,
            );
          } else {
            await runPostCommit();
          }
          return operation.receipt;
        }
        if (operation.state === 'manual_intervention') {
          throw new ProviderOperationError(
            operation.uncertainty?.message || 'Provider operation requires manual integrity review',
            {
              code: operation.uncertainty?.code || 'PROVIDER_INTEGRITY_FAILURE',
              retryable: false,
              uncertain: true,
              details: operation.uncertainty?.details || null,
              manual: true,
            },
          );
        }

        if (operation.state === 'provider_applied') {
          const finish = async (provider = null) => {
            operation = await session.claimAttempt(operation, 'provider_applied', randomUUID());
            const attempt = {
              generation: operation.attemptGeneration, owner: operation.attemptOwner,
            };
            await session.withMutationFence(async tx => {
              await spec.validateCompletion?.(tx, operation);
              const completed = spec.complete
                ? await spec.complete(operation.receipt, operation, tx, provider)
                : operation.receipt;
              operation = await session.markCompleted(operation.id, attempt, completed, tx);
            });
            await runPostCommit(provider);
          };
          if (spec.completeWithProvider || spec.cleanup) {
            await spec.acquireProvider(finish, operation);
          } else {
            await finish();
          }
          return operation.receipt;
        }

        if (operation.state === 'provider_started') {
          operation = await session.claimAttempt(operation, 'provider_started', randomUUID());
        }

        return spec.acquireProvider(async provider => {
          if (operation.state === 'ready') {
            const owner = randomUUID();
            await session.withMutationFence(async tx => {
              await spec.validate?.(provider, tx, operation);
              operation = await session.markProviderStarted(operation.id, owner);
              const attempt = {
                generation: operation.attemptGeneration, owner: operation.attemptOwner,
              };
              try {
                await spec.prepare?.(provider, operation.marker, operation);
                const receipt = await spec.command(provider, operation.marker, operation);
                operation = await session.markProviderApplied(operation.id, attempt, receipt);
              } catch (cause) {
                const error = cause instanceof ProviderOperationError ? cause : new ProviderOperationError(
                  `Provider command outcome is uncertain: ${cause?.message || cause}`,
                  { code: 'PROVIDER_COMMAND_UNCERTAIN', details: { cause: cause?.message || String(cause) } },
                );
                const uncertainty = {
                  code: error.code, message: error.message, details: error.details,
                  at: new Date().toISOString(),
                };
                if (error.manual) {
                  operation = await session.markManualIntervention(operation.id, attempt, uncertainty);
                } else {
                  await session.recordUncertainty(operation.id, attempt, uncertainty);
                }
                throw error;
              }
            });
          } else if (operation.state === 'provider_started') {
            const attempt = {
              generation: operation.attemptGeneration, owner: operation.attemptOwner,
            };
            let recovery;
            try {
              await session.withMutationFence(async tx => {
                await spec.validateRecovery?.(provider, tx, operation);
                recovery = await spec.recover(provider, operation.marker, operation);
              });
            } catch (cause) {
              const error = cause instanceof ProviderOperationError ? cause : new ProviderOperationError(
                `Provider recovery failed: ${cause?.message || cause}`,
                { code: 'PROVIDER_RECOVERY_FAILED', details: { cause: cause?.message || String(cause) } },
              );
              await session.recordUncertainty(operation.id, attempt, {
                code: error.code, message: error.message, at: new Date().toISOString(),
              });
              throw error;
            }
            if (recovery?.status !== 'unique') {
              const error = recoveryError(recovery);
              await session.recordUncertainty(operation.id, attempt, {
                code: error.code, details: recovery, at: new Date().toISOString(),
              });
              throw error;
            }
            const receipt = { ...recovery };
            delete receipt.status;
            operation = await session.markProviderApplied(operation.id, attempt, receipt);
          }

          const completionAttempt = {
            generation: operation.attemptGeneration, owner: operation.attemptOwner,
          };
          await session.withMutationFence(async tx => {
            await spec.validateCompletion?.(tx, operation);
            const completed = spec.complete
              ? await spec.complete(operation.receipt, operation, tx, provider)
              : operation.receipt;
            operation = await session.markCompleted(operation.id, completionAttempt, completed, tx);
          });
          await runPostCommit(provider);
          return operation.receipt;
        }, operation);
      }));
    },
  };
}

function ownershipLost(id) {
  return new ProviderOperationError(`Provider operation ownership was lost for ${id}`, {
    code: 'PROVIDER_OPERATION_OWNERSHIP_LOST', retryable: true, uncertain: true,
  });
}

function fromRow(row) {
  return {
    id: row.operation_key,
    kind: row.kind,
    accountId: row.account_id,
    marker: row.marker,
    requestKey: row.request_key,
    sourceMessageId: row.source_message_id,
    source: row.source_observation,
    destination: row.destination_observation,
    state: row.state,
    attemptGeneration: Number(row.attempt_generation),
    attemptOwner: row.attempt_owner,
    receipt: row.receipt,
    uncertainty: row.uncertainty,
    cleanupState: row.marker_cleanup_state,
    cleanupError: row.marker_cleanup_error,
  };
}

async function inTransaction(client, callback) {
  await client.query('BEGIN');
  try {
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

export function createPostgresProviderOperationRepository(dbPool = pool) {
  return {
    async listPendingCleanup(limit = 20) {
      const bounded = Math.max(1, Math.min(100, Number(limit) || 20));
      const result = await dbPool.query(
        `SELECT * FROM provider_operations
          WHERE state = 'completed' AND marker_cleanup_state = 'pending'
          ORDER BY updated_at, operation_key
          LIMIT $1`,
        [bounded],
      );
      return result.rows.map(fromRow);
    },

    async findMoveBySource({ accountId, sourceMessageId, folder, uid }) {
      const result = await dbPool.query(
        `SELECT * FROM provider_operations
          WHERE account_id = $1 AND kind = 'move'
            AND state IN ('provider_started', 'provider_applied', 'completed')
            AND (
              (source_message_id = $2 AND source_folder = $3 AND source_uid = $4)
              OR (source_message_id IS NULL AND source_folder = $3 AND source_uid = $4)
            )
          ORDER BY updated_at DESC, operation_key
          LIMIT 2`,
        [accountId, sourceMessageId, folder, Number(uid)],
      );
      if (result.rows.length > 1) {
        throw identityMismatch('Multiple provider MOVE operations claim the same source row');
      }
      return result.rows[0] ? fromRow(result.rows[0]) : null;
    },

    async withOwnership(operationId, callback) {
      const client = await dbPool.connect();
      try {
        await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [operationId]);
        const read = async () => {
          const result = await client.query(
            'SELECT * FROM provider_operations WHERE operation_key = $1', [operationId],
          );
          return result.rows[0] ? fromRow(result.rows[0]) : null;
        };
        return await callback({
          async loadExisting() {
            return read();
          },
          async loadOrCreate(intent) {
            await client.query(
              `INSERT INTO provider_operations (
                 operation_key, account_id, kind, marker, source_folder, source_uid,
                 destination_folder, source_observation, destination_observation,
                 request_key, source_message_id
               ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11)
               ON CONFLICT (operation_key) DO NOTHING`,
              [
                intent.id, intent.accountId, intent.kind, intent.marker,
                intent.source?.folder || null, intent.source?.uid || null,
                intent.destination.folder,
                intent.source ? JSON.stringify(intent.source) : null,
                JSON.stringify(intent.destination),
                intent.requestKey, intent.sourceMessageId,
              ],
            );
            return read();
          },
          async withMutationFence(run) {
            // Acquire the observation-lock connection before BEGIN/FOR UPDATE. The caller has
            // already acquired bounded provider/session ownership, so no pool wait occurs while
            // folder rows are locked.
            const fenceClient = await dbPool.connect();
            try {
              return await inTransaction(fenceClient, run);
            } finally {
              fenceClient.release();
            }
          },
          async refreshReadyIntent(expected, intent) {
            const result = await client.query(
              `UPDATE provider_operations
                  SET source_folder = $2, source_uid = $3, destination_folder = $4,
                      source_observation = $5::jsonb,
                      destination_observation = $6::jsonb,
                      request_key = $9, source_message_id = $10, updated_at = NOW()
                WHERE operation_key = $1 AND state = 'ready'
                  AND attempt_generation = $7
                  AND attempt_owner IS NOT DISTINCT FROM $8::uuid`,
              [
                expected.id, intent.source?.folder || null, intent.source?.uid || null,
                intent.destination.folder, intent.source ? JSON.stringify(intent.source) : null,
                JSON.stringify(intent.destination), expected.attemptGeneration, expected.attemptOwner,
                intent.requestKey, intent.sourceMessageId,
              ],
            );
            if (result.rowCount !== 1) throw ownershipLost(expected.id);
            return read();
          },
          async rebaseInFlightIntent(expected, rebased) {
            const result = await client.query(
              `UPDATE provider_operations
                  SET source_observation = $2::jsonb,
                      destination_observation = $3::jsonb,
                      receipt = $4::jsonb,
                      request_key = $8,
                      source_message_id = $9,
                      updated_at = NOW()
                WHERE operation_key = $1 AND state = $5
                  AND attempt_generation = $6
                  AND attempt_owner IS NOT DISTINCT FROM $7::uuid`,
              [
                expected.id, rebased.source ? JSON.stringify(rebased.source) : null,
                JSON.stringify(rebased.destination),
                rebased.receipt ? JSON.stringify(rebased.receipt) : null,
                expected.state, expected.attemptGeneration, expected.attemptOwner,
                rebased.requestKey, rebased.sourceMessageId,
              ],
            );
            if (result.rowCount !== 1) throw ownershipLost(expected.id);
            return read();
          },
          async markProviderStarted(id, owner) {
            const result = await client.query(
              `UPDATE provider_operations
                  SET state = 'provider_started',
                      attempt_generation = attempt_generation + 1,
                      attempt_owner = $2, provider_started_at = NOW(), updated_at = NOW()
                WHERE operation_key = $1 AND state = 'ready'
                  AND attempt_generation = 0 AND attempt_owner IS NULL`,
              [id, owner],
            );
            if (result.rowCount !== 1) throw ownershipLost(id);
            return read();
          },
          async markProviderApplied(id, attempt, receipt) {
            const result = await client.query(
              `UPDATE provider_operations
                  SET state = 'provider_applied', receipt = $2::jsonb,
                      uncertainty = NULL, provider_applied_at = NOW(), updated_at = NOW()
                WHERE operation_key = $1 AND state = 'provider_started'
                  AND attempt_generation = $3 AND attempt_owner = $4`,
              [id, JSON.stringify(receipt), attempt.generation, attempt.owner],
            );
            if (result.rowCount !== 1) throw ownershipLost(id);
            return read();
          },
          async claimAttempt(expected, state, owner) {
            const result = await client.query(
              `UPDATE provider_operations
                  SET attempt_generation = attempt_generation + 1,
                      attempt_owner = $2, updated_at = NOW()
                WHERE operation_key = $1 AND state = $3
                  AND attempt_generation = $4
                  AND attempt_owner IS NOT DISTINCT FROM $5::uuid`,
              [expected.id, owner, state, expected.attemptGeneration, expected.attemptOwner],
            );
            if (result.rowCount !== 1) throw ownershipLost(expected.id);
            return read();
          },
          async markCompleted(id, attempt, receipt, tx) {
            if (!tx?.query) throw new Error('Provider completion requires an observation-fence transaction');
            const result = await tx.query(
              `UPDATE provider_operations
                  SET state = 'completed', receipt = $2::jsonb,
                      completed_at = NOW(), updated_at = NOW()
                WHERE operation_key = $1 AND state = 'provider_applied'
                  AND attempt_generation = $3 AND attempt_owner = $4
                RETURNING *`,
              [id, JSON.stringify(receipt), attempt.generation, attempt.owner],
            );
            if (result.rowCount !== 1) throw ownershipLost(id);
            return fromRow(result.rows[0]);
          },
          async markCleanupCompleted(id, attempt) {
            const result = await client.query(
              `UPDATE provider_operations
                  SET marker_cleanup_state = 'completed', marker_cleanup_error = NULL,
                      marker_cleanup_completed_at = NOW(), updated_at = NOW()
                WHERE operation_key = $1 AND state = 'completed'
                  AND marker_cleanup_state = 'pending'
                  AND attempt_generation = $2 AND attempt_owner = $3`,
              [id, attempt.generation, attempt.owner],
            );
            if (result.rowCount !== 1) throw ownershipLost(id);
            return read();
          },
          async recordCleanupError(id, attempt, cleanupError) {
            const result = await client.query(
              `UPDATE provider_operations
                  SET marker_cleanup_error = $2::jsonb, updated_at = NOW()
                WHERE operation_key = $1 AND state = 'completed'
                  AND marker_cleanup_state = 'pending'
                  AND attempt_generation = $3 AND attempt_owner = $4`,
              [id, JSON.stringify(cleanupError), attempt.generation, attempt.owner],
            );
            if (result.rowCount !== 1) throw ownershipLost(id);
            return read();
          },
          async recordUncertainty(id, attempt, uncertainty) {
            const result = await client.query(
              `UPDATE provider_operations SET uncertainty = $2::jsonb, updated_at = NOW()
                WHERE operation_key = $1
                  AND state IN ('provider_started', 'provider_applied')
                  AND attempt_generation = $3 AND attempt_owner = $4`,
              [id, JSON.stringify(uncertainty), attempt.generation, attempt.owner],
            );
            if (result.rowCount !== 1) throw ownershipLost(id);
            return read();
          },
          async markManualIntervention(id, attempt, uncertainty) {
            const result = await client.query(
              `UPDATE provider_operations
                  SET state = 'manual_intervention', uncertainty = $2::jsonb, updated_at = NOW()
                WHERE operation_key = $1 AND state = 'provider_started'
                  AND attempt_generation = $3 AND attempt_owner = $4`,
              [id, JSON.stringify(uncertainty), attempt.generation, attempt.owner],
            );
            if (result.rowCount !== 1) throw ownershipLost(id);
            return read();
          },
        });
      } finally {
        await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [operationId]).catch(() => {});
        client.release();
      }
    },
  };
}

export const providerOperationExecutor = createProviderOperationExecutor({
  repository: {
    withOwnership(...args) {
      return createPostgresProviderOperationRepository().withOwnership(...args);
    },
    listPendingCleanup(...args) {
      return createPostgresProviderOperationRepository().listPendingCleanup(...args);
    },
    findMoveBySource(...args) {
      return createPostgresProviderOperationRepository().findMoveBySource(...args);
    },
  },
});

export const providerOperationStates = Object.freeze([...STATES]);
