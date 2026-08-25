import { describe, expect, it, vi } from 'vitest';

import {
  buildProviderOperationId,
  buildProviderOperationIdentity,
  createPostgresProviderOperationRepository,
  createProviderOperationExecutor,
  ProviderOperationError,
  providerOperationMarker,
} from './providerOperations.js';

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

function memoryRepository(initial = null) {
  let row = initial;
  let tail = Promise.resolve();
  const assertOwner = (attempt) => {
    if (row.attemptGeneration !== attempt.generation || row.attemptOwner !== attempt.owner) {
      throw new ProviderOperationError('Provider operation ownership was lost', {
        code: 'PROVIDER_OPERATION_OWNERSHIP_LOST', retryable: true, uncertain: true,
      });
    }
  };
  return {
    get row() { return row; },
    stealOwnership(owner = 'new-owner') {
      row = { ...row, attemptGeneration: row.attemptGeneration + 1, attemptOwner: owner };
    },
    async withOwnership(operationId, callback) {
      const previous = tail;
      const turn = deferred();
      tail = turn.promise;
      await previous;
      try {
        return await callback({
          async loadExisting() {
            return row?.id === operationId ? structuredClone(row) : null;
          },
          async loadOrCreate(intent) {
            row ||= {
              ...intent, state: 'ready', attemptGeneration: 0, receipt: null,
              cleanupState: 'pending',
            };
            return structuredClone(row);
          },
          async refreshReadyIntent(expected, intent) {
            if (row.state === 'ready' && row.attemptGeneration === expected.attemptGeneration &&
                row.attemptOwner === expected.attemptOwner) {
              row = { ...row, source: intent.source, destination: intent.destination };
            }
            return structuredClone(row);
          },
          async rebaseInFlightIntent(expected, intent) {
            if (row.state === expected.state &&
                row.attemptGeneration === expected.attemptGeneration &&
                row.attemptOwner === expected.attemptOwner) {
              const rebaseToken = (persisted, fresh) => ({
                ...persisted,
                generation: fresh.generation,
                topologyIdentity: fresh.topologyIdentity,
              });
              row = {
                ...row,
                requestKey: intent.requestKey,
                sourceMessageId: intent.sourceMessageId,
                source: row.source ? rebaseToken(row.source, intent.source) : null,
                destination: rebaseToken(row.destination, intent.destination),
                receipt: row.receipt ? {
                  ...row.receipt,
                  ...(row.receipt.sourceToken ? {
                    sourceToken: rebaseToken(row.receipt.sourceToken, intent.source),
                  } : {}),
                  ...(row.receipt.destinationToken ? {
                    destinationToken: rebaseToken(
                      row.receipt.destinationToken, intent.destination,
                    ),
                  } : {}),
                } : null,
              };
            }
            return structuredClone(row);
          },
          async withMutationFence(callback) {
            return callback({});
          },
          async markProviderStarted(_id, owner) {
            if (row.state !== 'ready') return structuredClone(row);
            row = {
              ...row,
              state: 'provider_started',
              attemptGeneration: row.attemptGeneration + 1,
              attemptOwner: owner,
            };
            return structuredClone(row);
          },
          async markProviderApplied(_id, attempt, receipt) {
            assertOwner(attempt);
            if (row.state === 'provider_started') row = { ...row, state: 'provider_applied', receipt };
            return structuredClone(row);
          },
          async claimAttempt(_id, state, owner) {
            if (row.state === state) {
              row = {
                ...row,
                attemptGeneration: row.attemptGeneration + 1,
                attemptOwner: owner,
              };
            }
            return structuredClone(row);
          },
          async markCompleted(_id, attempt, receipt) {
            assertOwner(attempt);
            if (row.state === 'provider_applied') row = { ...row, state: 'completed', receipt };
            return structuredClone(row);
          },
          async markCleanupCompleted(_id, attempt) {
            assertOwner(attempt);
            row = { ...row, cleanupState: 'completed' };
            return structuredClone(row);
          },
          async recordCleanupError(_id, attempt, cleanupError) {
            assertOwner(attempt);
            row = { ...row, cleanupError };
            return structuredClone(row);
          },
          async recordUncertainty(_id, attempt, uncertainty) {
            assertOwner(attempt);
            row = { ...row, uncertainty };
            return structuredClone(row);
          },
          async markManualIntervention(_id, attempt, uncertainty) {
            assertOwner(attempt);
            row = { ...row, state: 'manual_intervention', uncertainty };
            return structuredClone(row);
          },
        });
      } finally {
        turn.resolve();
      }
    },
  };
}

const moveIntent = buildProviderOperationIdentity({
  kind: 'move',
  accountId: 'account-1',
  requestKey: 'archive-row-1',
  source: { folder: 'INBOX', uid: 7, uidValidity: '101', generation: '4' },
  destination: { folder: 'Archive', uidValidity: '202', generation: '8' },
});

describe('provider operation identity', () => {
  it('derives the exact persisted operation id from stable archive request facts alone', () => {
    expect(buildProviderOperationId({
      kind: 'move', accountId: 'account-1', requestKey: 'archive-row-1',
      source: { folder: 'INBOX', uid: 7, uidValidity: '101' },
      destinationFolder: 'Archive',
    })).toBe(moveIntent.id);
  });

  it('derives one deterministic IMAP-atom-safe marker without Message-ID causality', () => {
    const headerful = buildProviderOperationIdentity({
      ...moveIntent,
      messageId: '<duplicate@example.com>',
    });
    const headerless = buildProviderOperationIdentity({ ...moveIntent, messageId: null });

    expect(headerful.id).toBe(headerless.id);
    expect(headerful.marker).toBe(headerless.marker);
    expect(headerful.marker).toMatch(/^\$MailFlowOp-[A-Za-z0-9_-]{43}$/);
    expect(providerOperationMarker(headerful.id)).toBe(headerful.marker);
  });

  it('requires authoritative source and destination epochs for UID-addressed transitions', () => {
    expect(() => buildProviderOperationIdentity({
      kind: 'copy', accountId: 'account-1',
      source: { folder: 'INBOX', uid: 7, uidValidity: '101', generation: '4' },
      destination: { folder: 'Todo', uidValidity: null, generation: '8' },
    })).toThrow(/destination uidvalidity/i);
  });

  it.each(['move', 'copy'])('keeps %s identity stable across fresh observation generations', kind => {
    const first = buildProviderOperationIdentity({
      kind, accountId: 'account-1', requestKey: 'request-1',
      source: { folder: 'INBOX', uid: 7, uidValidity: '101', generation: '4' },
      destination: { folder: 'Archive', uidValidity: '202', generation: '8' },
    });
    const fresh = buildProviderOperationIdentity({
      kind, accountId: 'account-1', requestKey: 'request-1',
      source: { folder: 'INBOX', uid: 7, uidValidity: '101', generation: '40' },
      destination: { folder: 'Archive', uidValidity: '999', generation: '80' },
    });

    expect(fresh.id).toBe(first.id);
    expect(fresh.marker).toBe(first.marker);
  });

  it('creates a new COPY lifecycle when the caller supplies a new durable request key', () => {
    const shared = {
      kind: 'copy', accountId: 'account-1',
      source: { folder: 'INBOX', uid: 7, uidValidity: '101', generation: '4' },
      destination: { folder: 'Todo', uidValidity: '202', generation: '8' },
    };
    const applied = buildProviderOperationIdentity({ ...shared, requestKey: 'label-apply-1' });
    const reapplied = buildProviderOperationIdentity({ ...shared, requestKey: 'label-apply-2' });

    expect(reapplied.id).not.toBe(applied.id);
    expect(reapplied.marker).not.toBe(applied.marker);
  });

  it.each(['move', 'copy'])('requires an explicit durable request key for %s', kind => {
    expect(() => buildProviderOperationIdentity({
      kind, accountId: 'account-1',
      source: { folder: 'INBOX', uid: 7, uidValidity: '101', generation: '4' },
      destination: { folder: 'Archive', uidValidity: '202', generation: '8' },
    })).toThrow(/request key/i);
  });

  it('keeps APPEND identity stable across a fresh destination observation', () => {
    const first = buildProviderOperationIdentity({
      kind: 'append', accountId: 'account-1', requestKey: 'send-1',
      destination: { folder: 'Sent', uidValidity: '202', generation: '8' },
    });
    const fresh = buildProviderOperationIdentity({
      kind: 'append', accountId: 'account-1', requestKey: 'send-1',
      destination: { folder: 'Sent', uidValidity: '999', generation: '80' },
    });

    expect(fresh.id).toBe(first.id);
    expect(fresh.marker).toBe(first.marker);
  });
});

describe('durable provider operation executor', () => {
  it.each(['provider_started', 'provider_applied'])(
    'rebases fresh advancing observations for %s when epochs and topology identities match',
    async state => {
      const persistedIntent = buildProviderOperationIdentity({
        ...moveIntent,
        source: {
          ...moveIntent.source, generation: '4', topologyIdentity: 'source-incarnation',
        },
        destination: {
          ...moveIntent.destination, generation: '8', topologyIdentity: 'dest-incarnation',
        },
      });
      const freshIntent = buildProviderOperationIdentity({
        ...moveIntent,
        sourceMessageId: '11111111-1111-4111-8111-111111111111',
        source: {
          ...moveIntent.source, generation: '40', topologyIdentity: 'source-incarnation',
        },
        destination: {
          ...moveIntent.destination, generation: '80', topologyIdentity: 'dest-incarnation',
        },
      });
      const receipt = state === 'provider_applied' ? {
        uid: 88, uidValidity: '202', sourceToken: persistedIntent.source,
        destinationToken: persistedIntent.destination,
      } : null;
      const repository = memoryRepository({
        ...persistedIntent, requestKey: null, sourceMessageId: null,
        state, attemptGeneration: 1,
        attemptOwner: 'old-owner', receipt, cleanupState: 'pending',
      });
      const executor = createProviderOperationExecutor({ repository });
      const observed = [];

      await executor.execute({
        intent: freshIntent,
        acquireProvider: callback => callback({}),
        validateRecovery: (_provider, _tx, operation) => observed.push(operation),
        recover: vi.fn().mockResolvedValue({
          status: 'unique', uid: 88, uidValidity: '202',
          sourceToken: freshIntent.source, destinationToken: freshIntent.destination,
        }),
        validateCompletion: (_tx, operation) => observed.push(operation),
        complete: receiptValue => receiptValue,
      });

      expect(repository.row.source.generation).toBe('40');
      expect(repository.row.destination.generation).toBe('80');
      expect(repository.row.requestKey).toBe(moveIntent.requestKey);
      expect(repository.row.sourceMessageId).toBe('11111111-1111-4111-8111-111111111111');
      expect(observed.at(-1).destination.generation).toBe('80');
      if (state === 'provider_applied') {
        expect(repository.row.receipt.sourceToken.generation).toBe('40');
        expect(repository.row.receipt.destinationToken.generation).toBe('80');
      }
    },
  );

  it.each([
    ['source UIDVALIDITY', { source: { uidValidity: '999' } }],
    ['destination topology identity', { destination: { topologyIdentity: 'recreated' } }],
  ])('rejects in-flight observation rebasing across %s changes', async (_case, change) => {
    const persisted = buildProviderOperationIdentity({
      ...moveIntent,
      source: { ...moveIntent.source, topologyIdentity: 'source-incarnation' },
      destination: { ...moveIntent.destination, topologyIdentity: 'dest-incarnation' },
    });
    const fresh = buildProviderOperationIdentity({
      ...persisted,
      source: { ...persisted.source, generation: '40', ...(change.source || {}) },
      destination: { ...persisted.destination, generation: '80', ...(change.destination || {}) },
    });
    const repository = memoryRepository({
      ...persisted, state: 'provider_started', attemptGeneration: 1,
      attemptOwner: 'old-owner', receipt: null, cleanupState: 'pending',
    });
    const executor = createProviderOperationExecutor({ repository });

    expect(fresh.id).toBe(persisted.id);

    await expect(executor.execute({
      intent: fresh, acquireProvider: callback => callback({}),
      validateRecovery: vi.fn(), recover: vi.fn(), validateCompletion: vi.fn(),
    })).rejects.toMatchObject({ code: 'PROVIDER_OPERATION_IDENTITY_MISMATCH' });
  });

  it('runs post-commit work and marker cleanup only after the completion transaction commits', async () => {
    const events = [];
    const base = memoryRepository({
      ...moveIntent, state: 'provider_applied', attemptGeneration: 1,
      attemptOwner: 'old-owner', receipt: { uid: 88 }, cleanupState: 'pending',
    });
    const repository = {
      ...base,
      get row() { return base.row; },
      withOwnership(id, callback) {
        return base.withOwnership(id, session => callback({
          ...session,
          async withMutationFence(run) {
            events.push('begin');
            const result = await run({});
            events.push('commit');
            return result;
          },
        }));
      },
    };
    const executor = createProviderOperationExecutor({ repository });

    await executor.execute({
      intent: moveIntent,
      acquireProvider: callback => callback({}),
      validateCompletion: vi.fn(),
      complete: receipt => { events.push('materialize'); return receipt; },
      afterCommit: () => events.push('afterCommit'),
      cleanup: () => events.push('cleanup'),
    });

    expect(events).toEqual(['begin', 'materialize', 'commit', 'afterCommit', 'cleanup']);
    expect(base.row.cleanupState).toBe('completed');
  });

  it('retries pending marker cleanup on completed receipt replay without rematerializing', async () => {
    const repository = memoryRepository({
      ...moveIntent, state: 'completed', attemptGeneration: 2,
      attemptOwner: 'old-owner', receipt: { uid: 88 }, cleanupState: 'pending',
    });
    const executor = createProviderOperationExecutor({ repository });
    const cleanup = vi.fn();
    const complete = vi.fn();

    await executor.execute({
      intent: moveIntent, acquireProvider: callback => callback({}), cleanup, complete,
    });

    expect(cleanup).toHaveBeenCalledOnce();
    expect(complete).not.toHaveBeenCalled();
    expect(repository.row.cleanupState).toBe('completed');
  });

  it('recovery-only lookup never creates or advances a provider_started operation', async () => {
    const repository = memoryRepository({
      ...moveIntent, state: 'provider_started', attemptGeneration: 1,
      attemptOwner: 'dead-worker', receipt: null,
    });
    const executor = createProviderOperationExecutor({ repository });
    const complete = vi.fn();

    await expect(executor.completeExisting(moveIntent.id, { complete })).resolves.toMatchObject({
      status: 'pending', operation: { id: moveIntent.id, state: 'provider_started' },
    });

    expect(repository.row.state).toBe('provider_started');
    expect(repository.row.attemptGeneration).toBe(1);
    expect(complete).not.toHaveBeenCalled();
  });

  it('recovery-only lookup atomically completes only the exact provider_applied operation', async () => {
    const repository = memoryRepository({
      ...moveIntent, state: 'provider_applied', attemptGeneration: 1,
      attemptOwner: 'old-worker', receipt: { uid: 88, uidValidity: '202' },
    });
    const executor = createProviderOperationExecutor({ repository });
    const validateExisting = vi.fn();
    const validateCompletion = vi.fn();
    const complete = vi.fn(receipt => ({ ...receipt, materialized: true }));

    await expect(executor.completeExisting(moveIntent.id, {
      validateExisting, validateCompletion, complete,
    })).resolves.toMatchObject({
      status: 'completed', receipt: { uid: 88, uidValidity: '202', materialized: true },
      replayed: false,
    });

    expect(repository.row.state).toBe('completed');
    expect(validateExisting).toHaveBeenCalledOnce();
    expect(validateCompletion).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledOnce();
  });

  it('recovery-only provider_applied replay rebases fresh observations and retries cleanup post-commit', async () => {
    const persisted = buildProviderOperationIdentity({
      ...moveIntent,
      source: { ...moveIntent.source, topologyIdentity: 'source-incarnation' },
      destination: { ...moveIntent.destination, topologyIdentity: 'dest-incarnation' },
    });
    const fresh = buildProviderOperationIdentity({
      ...persisted,
      source: { ...persisted.source, generation: '40' },
      destination: { ...persisted.destination, generation: '80' },
    });
    const repository = memoryRepository({
      ...persisted, state: 'provider_applied', attemptGeneration: 1,
      attemptOwner: 'old-owner', cleanupState: 'pending',
      receipt: {
        uid: 88, sourceToken: persisted.source, destinationToken: persisted.destination,
      },
    });
    const executor = createProviderOperationExecutor({ repository });
    const cleanup = vi.fn();

    await executor.completeExisting(persisted.id, {
      intent: fresh, acquireProvider: callback => callback({}), cleanup,
      validateCompletion: (_tx, operation) => {
        expect(operation.source.generation).toBe('40');
        expect(operation.destination.generation).toBe('80');
      },
      complete: receipt => receipt,
    });

    expect(cleanup).toHaveBeenCalledOnce();
    expect(repository.row.cleanupState).toBe('completed');
    expect(repository.row.receipt.destinationToken.generation).toBe('80');
  });

  it('recovery-only lookup replays completed and rejects a different operation id without callbacks', async () => {
    const repository = memoryRepository({
      ...moveIntent, state: 'completed', attemptGeneration: 1,
      receipt: { uid: 88, uidValidity: '202' },
    });
    const executor = createProviderOperationExecutor({ repository });
    const validateExisting = vi.fn();
    const complete = vi.fn();

    await expect(executor.completeExisting(moveIntent.id, {
      validateExisting, complete,
    })).resolves.toMatchObject({
      status: 'completed', receipt: { uid: 88, uidValidity: '202' }, replayed: true,
    });
    await expect(executor.completeExisting('different-operation', {
      validateExisting, complete,
    })).resolves.toEqual({ status: 'missing' });

    expect(validateExisting).toHaveBeenCalledOnce();
    expect(complete).not.toHaveBeenCalled();
  });

  it.each(['copy', 'append'])(
    'rolls back %s materialization and completed state together when fence COMMIT fails',
    async kind => {
      const intent = kind === 'append' ? buildProviderOperationIdentity({
        kind, accountId: 'account-1', requestKey: 'request-1',
        destination: { folder: 'Drafts', uidValidity: '202', generation: '8' },
      }) : buildProviderOperationIdentity({
        kind, accountId: 'account-1', requestKey: 'request-1',
        source: { folder: 'INBOX', uid: 7, uidValidity: '101', generation: '4' },
        destination: { folder: 'Todo', uidValidity: '202', generation: '8' },
      });
      let durable = {
        ...intent, state: 'provider_applied', attemptGeneration: 1,
        attemptOwner: 'old-owner', receipt: { uid: 88, uidValidity: '202' },
      };
      let materialized = false;
      let failCommit = true;
      const repository = {
        get row() { return durable; },
        get materialized() { return materialized; },
        async withOwnership(_id, callback) {
          return callback({
            async loadOrCreate() { return structuredClone(durable); },
            async refreshReadyIntent() { throw new Error('not ready'); },
            async claimAttempt(expected, state, owner) {
              expect(durable.state).toBe(state);
              durable = {
                ...durable, attemptGeneration: expected.attemptGeneration + 1,
                attemptOwner: owner,
              };
              return structuredClone(durable);
            },
            async withMutationFence(run) {
              const staged = { row: structuredClone(durable), materialized };
              const tx = {
                staged,
                materialize() { staged.materialized = true; },
              };
              const result = await run(tx);
              if (failCommit) {
                failCommit = false;
                throw new Error('COMMIT failed');
              }
              durable = staged.row;
              materialized = staged.materialized;
              return result;
            },
            async markCompleted(_id, _attempt, receipt, tx) {
              const completed = { ...durable, state: 'completed', receipt };
              if (tx) tx.staged.row = completed;
              else durable = completed;
              return structuredClone(completed);
            },
          });
        },
      };
      const complete = vi.fn(async (receipt, _operation, tx) => {
        tx.materialize();
        return { ...receipt, materialized: true };
      });
      const executor = createProviderOperationExecutor({ repository });
      const spec = {
        intent, acquireProvider: vi.fn(), validateCompletion: vi.fn(), complete,
      };

      await expect(executor.execute(spec)).rejects.toThrow('COMMIT failed');
      expect(repository.row.state).toBe('provider_applied');
      expect(repository.materialized).toBe(false);

      await expect(executor.execute(spec)).resolves.toMatchObject({ materialized: true });
      expect(repository.row.state).toBe('completed');
      expect(repository.materialized).toBe(true);
      expect(complete).toHaveBeenCalledTimes(2);
      expect(spec.acquireProvider).not.toHaveBeenCalled();
    },
  );

  it('serializes simultaneous first attempts and replays the completed receipt', async () => {
    const repository = memoryRepository();
    const command = vi.fn().mockResolvedValue({ uid: 88, uidValidity: '202' });
    const executor = createProviderOperationExecutor({ repository, maxConcurrent: 2 });
    const run = () => executor.execute({
      intent: moveIntent,
      acquireProvider: callback => callback({}),
      validate: vi.fn().mockResolvedValue(undefined),
      prepare: vi.fn().mockResolvedValue(undefined),
      command,
      recover: vi.fn(),
      complete: receipt => ({ ...receipt, materialized: true }),
    });

    const [first, second] = await Promise.all([run(), run()]);

    expect(command).toHaveBeenCalledOnce();
    expect(first).toEqual(second);
    expect(first).toMatchObject({ uid: 88, uidValidity: '202', materialized: true });
    expect(repository.row.state).toBe('completed');
    expect(repository.row.attemptGeneration).toBe(1);
  });

  it('takes over provider_started by marker recovery and never repeats the command', async () => {
    const repository = memoryRepository({
      ...moveIntent, state: 'provider_started', attemptGeneration: 1,
      attemptOwner: 'dead-worker', receipt: null,
    });
    const command = vi.fn();
    const recover = vi.fn().mockResolvedValue({ status: 'unique', uid: 88, uidValidity: '202' });
    const executor = createProviderOperationExecutor({ repository });

    await expect(executor.execute({
      intent: moveIntent,
      acquireProvider: callback => callback({}),
      validate: vi.fn(), validateRecovery: vi.fn(), prepare: vi.fn(), command, recover,
      complete: receipt => receipt,
    })).resolves.toMatchObject({ uid: 88, uidValidity: '202' });

    expect(command).not.toHaveBeenCalled();
    expect(recover).toHaveBeenCalledOnce();
    expect(repository.row.state).toBe('completed');
    expect(repository.row.attemptGeneration).toBe(2);
    expect(repository.row.attemptOwner).not.toBe('dead-worker');
  });

  it.each([
    ['absent', { status: 'absent' }, 'PROVIDER_MARKER_ABSENT'],
    ['ambiguous', { status: 'ambiguous', uids: [88, 89] }, 'PROVIDER_MARKER_AMBIGUOUS'],
  ])('keeps provider_started uncertain when the marker is %s', async (_name, recovery, code) => {
    const repository = memoryRepository({
      ...moveIntent, state: 'provider_started', attemptGeneration: 3,
      attemptOwner: 'dead-worker', receipt: null,
    });
    const command = vi.fn();
    const executor = createProviderOperationExecutor({ repository });

    await expect(executor.execute({
      intent: moveIntent,
      acquireProvider: callback => callback({}),
      validate: vi.fn(), validateRecovery: vi.fn(), prepare: vi.fn(), command,
      recover: vi.fn().mockResolvedValue(recovery),
      complete: vi.fn(),
    })).rejects.toMatchObject({ code, retryable: true, uncertain: true });

    expect(command).not.toHaveBeenCalled();
    expect(repository.row.state).toBe('provider_started');
    expect(repository.row.uncertainty.code).toBe(code);
  });

  it('keeps SEARCH failure typed and uncertain without repeating provider command', async () => {
    const repository = memoryRepository({
      ...moveIntent, state: 'provider_started', attemptGeneration: 1,
      attemptOwner: 'dead-worker', receipt: null,
    });
    const command = vi.fn();
    const executor = createProviderOperationExecutor({ repository });

    await expect(executor.execute({
      intent: moveIntent,
      acquireProvider: callback => callback({}),
      validate: vi.fn(), validateRecovery: vi.fn(), prepare: vi.fn(), command,
      recover: vi.fn().mockRejectedValue(new Error('IMAP SEARCH failed')),
      complete: vi.fn(),
    })).rejects.toMatchObject({
      code: 'PROVIDER_RECOVERY_FAILED', retryable: true, uncertain: true,
    });
    expect(command).not.toHaveBeenCalled();
    expect(repository.row.state).toBe('provider_started');
    expect(repository.row.uncertainty.code).toBe('PROVIDER_RECOVERY_FAILED');
  });

  it('replays provider_applied and completed receipts without provider acquisition', async () => {
    for (const state of ['provider_applied', 'completed']) {
      const repository = memoryRepository({
        ...moveIntent, state, attemptGeneration: 1,
        receipt: { uid: 88, uidValidity: '202' },
      });
      const acquireProvider = vi.fn(callback => callback({}));
      const complete = vi.fn(receipt => ({ ...receipt, materialized: true }));
      const validateCompletion = vi.fn();
      const executor = createProviderOperationExecutor({ repository });

      const result = await executor.execute({
        intent: moveIntent, acquireProvider,
        validate: vi.fn(), validateCompletion, prepare: vi.fn(), command: vi.fn(), recover: vi.fn(), complete,
      });

      expect(acquireProvider).not.toHaveBeenCalled();
      expect(result).toMatchObject({ uid: 88, uidValidity: '202' });
      expect(complete).toHaveBeenCalledTimes(state === 'provider_applied' ? 1 : 0);
      expect(validateCompletion).toHaveBeenCalledTimes(state === 'provider_applied' ? 1 : 0);
    }
  });

  it('reacquires the provider for an opted-in provider_applied completion replay', async () => {
    const repository = memoryRepository({
      ...moveIntent, state: 'provider_applied', attemptGeneration: 1,
      receipt: { uid: 88, uidValidity: '202' },
    });
    const provider = { client: { id: 'destination-client' } };
    const acquireProvider = vi.fn(callback => callback(provider));
    const complete = vi.fn((receipt, _operation, _tx, resource) => {
      expect(resource).toBe(provider);
      return receipt;
    });
    const executor = createProviderOperationExecutor({ repository });

    await expect(executor.execute({
      intent: moveIntent, acquireProvider, completeWithProvider: true,
      validate: vi.fn(), validateCompletion: vi.fn(), prepare: vi.fn(),
      command: vi.fn(), recover: vi.fn(), complete,
    })).resolves.toMatchObject({ uid: 88, uidValidity: '202' });

    expect(acquireProvider).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledOnce();
    expect(repository.row.state).toBe('completed');
  });

  it('recovery-only completion reacquires the provider when materialization requires it', async () => {
    const repository = memoryRepository({
      ...moveIntent, state: 'provider_applied', attemptGeneration: 1,
      receipt: { uid: 88, uidValidity: '202' },
    });
    const provider = { client: { id: 'destination-client' } };
    const acquireProvider = vi.fn(callback => callback(provider));
    const complete = vi.fn((receipt, _operation, _tx, resource) => {
      expect(resource).toBe(provider);
      return receipt;
    });
    const executor = createProviderOperationExecutor({ repository });

    await expect(executor.completeExisting(moveIntent.id, {
      acquireProvider, completeWithProvider: true, complete,
    })).resolves.toMatchObject({ status: 'completed' });

    expect(acquireProvider).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledOnce();
  });

  it.each(['first command', 'provider_applied replay'])(
    'fences completion and refuses a superseded destination on %s',
    async phase => {
      let fenced = false;
      const initial = phase === 'provider_applied replay' ? {
        ...moveIntent, state: 'provider_applied', attemptGeneration: 1,
        attemptOwner: 'old-owner', receipt: { uid: 88, uidValidity: '202' },
      } : null;
      const base = memoryRepository(initial);
      const repository = {
        ...base,
        withOwnership(id, callback) {
          return base.withOwnership(id, session => callback({
            ...session,
            async withMutationFence(run) {
              fenced = true;
              try { return await run({}); } finally { fenced = false; }
            },
          }));
        },
      };
      const complete = vi.fn();
      const executor = createProviderOperationExecutor({ repository });

      await expect(executor.execute({
        intent: moveIntent,
        acquireProvider: callback => callback({}),
        validate: vi.fn(), prepare: vi.fn(),
        command: vi.fn().mockResolvedValue({ uid: 88, uidValidity: '202' }),
        recover: vi.fn(),
        validateCompletion: () => {
          expect(fenced).toBe(true);
          throw Object.assign(new Error('destination superseded'), {
            code: 'FOLDER_OBSERVATION_SUPERSEDED',
          });
        },
        complete,
      })).rejects.toMatchObject({ code: 'FOLDER_OBSERVATION_SUPERSEDED' });

      expect(complete).not.toHaveBeenCalled();
      expect(base.row.state).toBe('provider_applied');
    },
  );

  it('refreshes a still-ready operation to the caller\'s current validated observations', async () => {
    const stale = {
      ...moveIntent,
      source: { ...moveIntent.source, generation: '1' },
      destination: { ...moveIntent.destination, generation: '2' },
      state: 'ready', attemptGeneration: 0, attemptOwner: null, receipt: null,
    };
    const repository = memoryRepository(stale);
    const validate = vi.fn((_provider, _tx, operation) => {
      expect(operation.source.generation).toBe('4');
      expect(operation.destination.generation).toBe('8');
    });
    const executor = createProviderOperationExecutor({ repository });

    await executor.execute({
      intent: moveIntent, acquireProvider: callback => callback({}), validate,
      prepare: vi.fn(), command: vi.fn().mockResolvedValue({ uid: 88 }), recover: vi.fn(),
      validateCompletion: vi.fn(), complete: receipt => receipt,
    });

    expect(validate).toHaveBeenCalledOnce();
  });

  it('bounds concurrent ownership before provider acquisition', async () => {
    let active = 0;
    let maximum = 0;
    const release = deferred();
    const repositories = Array.from({ length: 5 }, () => memoryRepository());
    const executor = createProviderOperationExecutor({
      repository: {
        withOwnership(id, callback) {
          return repositories[Number(id.slice(-1))].withOwnership(id, callback);
        },
      },
      maxConcurrent: 2,
    });
    const runs = repositories.map((_repo, index) => executor.execute({
      intent: { ...moveIntent, id: `${moveIntent.id.slice(0, -1)}${index}`, marker: `${moveIntent.marker}${index}` },
      acquireProvider: async callback => {
        active++;
        maximum = Math.max(maximum, active);
        await release.promise;
        try { return await callback({}); } finally { active--; }
      },
      validate: vi.fn(), prepare: vi.fn(),
      command: vi.fn().mockResolvedValue({ uid: 80 + index, uidValidity: '202' }),
      recover: vi.fn(), complete: receipt => receipt,
    }));

    await new Promise(resolve => setImmediate(resolve));
    expect(maximum).toBe(2);
    release.resolve();
    await Promise.all(runs);
  });

  it('holds the observation fence across marker preparation and the provider command', async () => {
    let fenced = false;
    let releaseCommand;
    const commandBlocked = new Promise(resolve => { releaseCommand = resolve; });
    const base = memoryRepository();
    const repository = {
      ...base,
      withOwnership(id, callback) {
        return base.withOwnership(id, session => callback({
          ...session,
          async withMutationFence(run) {
            fenced = true;
            try { return await run({}); } finally { fenced = false; }
          },
        }));
      },
    };
    const executor = createProviderOperationExecutor({ repository });
    const run = executor.execute({
      intent: moveIntent,
      acquireProvider: callback => callback({}),
      validate: () => expect(fenced).toBe(true),
      prepare: () => expect(fenced).toBe(true),
      command: async () => {
        expect(fenced).toBe(true);
        await commandBlocked;
        return { uid: 88, uidValidity: '202' };
      },
      recover: vi.fn(), complete: receipt => receipt,
    });
    await new Promise(resolve => setImmediate(resolve));
    expect(fenced).toBe(true);
    releaseCommand();
    await run;
    expect(fenced).toBe(false);
  });

  it('validates the persisted destination observation before marker recovery', async () => {
    const repository = memoryRepository({
      ...moveIntent, state: 'provider_started', attemptGeneration: 1,
      attemptOwner: 'dead-worker', receipt: null,
    });
    const recover = vi.fn();
    const superseded = Object.assign(new Error('destination superseded'), {
      code: 'FOLDER_OBSERVATION_SUPERSEDED',
    });
    const executor = createProviderOperationExecutor({ repository });

    await expect(executor.execute({
      intent: { ...moveIntent, destination: { ...moveIntent.destination, generation: '99' } },
      acquireProvider: callback => callback({}),
      validate: vi.fn(),
      validateRecovery: (_provider, _tx, operation) => {
        expect(operation.destination.generation).toBe('8');
        throw superseded;
      },
      prepare: vi.fn(), command: vi.fn(), recover, complete: vi.fn(),
    })).rejects.toMatchObject({ code: 'PROVIDER_OPERATION_IDENTITY_MISMATCH' });

    expect(recover).not.toHaveBeenCalled();
    expect(repository.row.state).toBe('provider_started');
  });

  it('rejects a stale attempt owner from provider_applied and uncertainty transitions', async () => {
    for (const outcome of ['receipt', 'uncertainty']) {
      const repository = memoryRepository();
      const executor = createProviderOperationExecutor({ repository });
      const commandError = new Error('connection lost');

      const promise = executor.execute({
        intent: moveIntent,
        acquireProvider: callback => callback({}),
        validate: vi.fn(), prepare: vi.fn(),
        command: async () => {
          repository.stealOwnership();
          if (outcome === 'uncertainty') throw commandError;
          return { uid: 88, uidValidity: '202' };
        },
        recover: vi.fn(), complete: vi.fn(),
      });

      await expect(promise).rejects.toMatchObject({
        code: 'PROVIDER_OPERATION_OWNERSHIP_LOST',
      });
      expect(repository.row.state).toBe('provider_started');
    }
  });

  it('makes UIDPLUS-marker disagreement durable and non-promotable on replay', async () => {
    const repository = memoryRepository();
    const executor = createProviderOperationExecutor({ repository });
    const mismatch = new ProviderOperationError('UIDPLUS disagrees with marker', {
      code: 'PROVIDER_RECEIPT_MISMATCH', retryable: false, uncertain: true, manual: true,
    });
    const recover = vi.fn().mockResolvedValue({ status: 'unique', uid: 88, uidValidity: '202' });
    const spec = {
      intent: moveIntent,
      acquireProvider: callback => callback({}),
      validate: vi.fn(), validateRecovery: vi.fn(), prepare: vi.fn(),
      command: vi.fn().mockRejectedValue(mismatch), recover, complete: vi.fn(),
    };

    await expect(executor.execute(spec)).rejects.toMatchObject({
      code: 'PROVIDER_RECEIPT_MISMATCH', retryable: false,
    });
    expect(repository.row.state).toBe('manual_intervention');

    await expect(executor.execute(spec)).rejects.toMatchObject({
      code: 'PROVIDER_RECEIPT_MISMATCH', retryable: false,
    });
    expect(spec.command).toHaveBeenCalledOnce();
    expect(recover).not.toHaveBeenCalled();
  });
});

describe('Postgres provider operation repository', () => {
  const dbRow = {
    operation_key: moveIntent.id,
    kind: 'move', account_id: 'account-1', marker: moveIntent.marker,
    source_observation: moveIntent.source,
    destination_observation: moveIntent.destination,
    state: 'provider_started', attempt_generation: 3, attempt_owner: 'owner-3',
    receipt: null, uncertainty: null,
  };

  function fakePool({ transitionRowCount = 1 } = {}) {
    const ownership = {
      release: vi.fn(),
      query: vi.fn(async sql => {
        if (/SELECT \* FROM provider_operations/.test(sql)) return { rows: [dbRow] };
        if (/^\s*UPDATE provider_operations/.test(sql)) return { rowCount: transitionRowCount };
        return { rows: [], rowCount: 1 };
      }),
    };
    const fence = {
      release: vi.fn(),
      query: vi.fn(async sql => (
        /^\s*UPDATE provider_operations/.test(sql)
          ? { rows: [dbRow], rowCount: transitionRowCount }
          : { rows: [], rowCount: 1 }
      )),
    };
    const pool = {
      connect: vi.fn()
        .mockResolvedValueOnce(ownership)
        .mockResolvedValueOnce(fence),
    };
    return { pool, ownership, fence };
  }

  it('acquires the observation session before BEGIN and closes it after the fenced callback', async () => {
    const { pool, fence } = fakePool();
    const repository = createPostgresProviderOperationRepository(pool);
    let inside = false;

    await repository.withOwnership(moveIntent.id, async session => {
      await session.withMutationFence(async tx => {
        inside = true;
        expect(pool.connect).toHaveBeenCalledTimes(2);
        expect(tx).toBe(fence);
        expect(fence.query).toHaveBeenCalledWith('BEGIN');
        expect(fence.release).not.toHaveBeenCalled();
      });
      expect(inside).toBe(true);
      expect(fence.query).toHaveBeenCalledWith('COMMIT');
      expect(fence.release).toHaveBeenCalledOnce();
    });
  });

  it('guards every takeover, result, uncertainty, terminal, and completion update by attempt', async () => {
    const { pool, ownership, fence } = fakePool();
    const repository = createPostgresProviderOperationRepository(pool);
    const attempt = { generation: 3, owner: 'owner-3' };

    await repository.withOwnership(moveIntent.id, async session => {
      await session.markProviderStarted(moveIntent.id, 'owner-1');
      await session.claimAttempt({
        id: moveIntent.id, state: 'provider_started', attemptGeneration: 3,
        attemptOwner: 'owner-3',
      }, 'provider_started', 'owner-4');
      await session.markProviderApplied(moveIntent.id, attempt, { uid: 88 });
      await session.recordUncertainty(moveIntent.id, attempt, { code: 'UNCERTAIN' });
      await session.markManualIntervention(moveIntent.id, attempt, { code: 'MISMATCH' });
      await session.withMutationFence(tx => (
        session.markCompleted(moveIntent.id, attempt, { uid: 88 }, tx)
      ));
    });

    const updates = [...ownership.query.mock.calls, ...fence.query.mock.calls]
      .filter(([sql]) => /^\s*UPDATE provider_operations/.test(sql))
      .map(([sql]) => sql);
    expect(updates).toHaveLength(6);
    for (const sql of updates) {
      const where = sql.split(/\bWHERE\b/i)[1];
      expect(where).toMatch(/attempt_generation\s*=/i);
      expect(where).toMatch(/attempt_owner/i);
    }
  });

  it('surfaces lock loss when a checked Postgres transition updates no row', async () => {
    const { pool } = fakePool({ transitionRowCount: 0 });
    const repository = createPostgresProviderOperationRepository(pool);

    await expect(repository.withOwnership(moveIntent.id, session => (
      session.markProviderApplied(
        moveIntent.id, { generation: 3, owner: 'stale-owner' }, { uid: 88 },
      )
    ))).rejects.toMatchObject({ code: 'PROVIDER_OPERATION_OWNERSHIP_LOST' });
  });
});
