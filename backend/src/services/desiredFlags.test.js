import { describe, expect, it, vi } from 'vitest';

import {
  DESIRED_FLAG_LEASE_MS,
  DesiredFlagError,
  createDesiredFlagExecutor,
  createImapDesiredFlagSession,
  createPostgresDesiredFlagRepository,
  flagColumn,
  normalizeDesiredFlag,
} from './desiredFlags.js';

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

function memoryRepository({
  read = false,
  star = false,
  clock = { now: 0 },
  leaseMs = 300_000,
  onLease = null,
  beforeRenew = null,
} = {}) {
  const message = {
    id: 'row-1', accountId: 'acct-1', uid: 7, folder: 'INBOX',
    uidValidity: '101', folderGeneration: '4', read, star,
    readRevision: 0, starRevision: 0,
  };
  const deliveries = new Map();
  let tail = Promise.resolve();
  const leaseTails = new Map();
  const keyFor = (messageId, flag) => `${messageId}:${flag}`;
  const clone = value => value == null ? value : structuredClone(value);
  const assertAttempt = (row, attempt) => {
    if (row.revision !== attempt.revision ||
        row.attemptGeneration !== attempt.attemptGeneration ||
        row.attemptOwner !== attempt.attemptOwner) {
      throw new DesiredFlagError('Desired flag ownership was lost', {
        code: 'DESIRED_FLAG_OWNERSHIP_LOST', retryable: true, uncertain: true,
      });
    }
  };
  const withTurn = async callback => {
    const previous = tail;
    const turn = deferred();
    tail = turn.promise;
    await previous;
    try { return await callback(); } finally { turn.resolve(); }
  };

  return {
    message,
    deliveries,
    clock,
    async withDeliveryLease(messageId, flag, callback) {
      const key = keyFor(messageId, flag);
      const previous = leaseTails.get(key) || Promise.resolve();
      const lease = deferred();
      leaseTails.set(key, lease.promise);
      await previous;
      let active = true;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        lease.resolve();
      };
      const token = {
        key,
        async assertActive() {
          if (!active) throw new DesiredFlagError('Delivery advisory session was lost', {
            code: 'DESIRED_FLAG_LEASE_SESSION_LOST', retryable: true, uncertain: true,
          });
        },
        drop() { active = false; release(); },
      };
      onLease?.(token);
      try { return await callback(token); } finally {
        active = false;
        release();
        if (leaseTails.get(key) === lease.promise) leaseTails.delete(key);
      }
    },
    async acceptIntent({ messageId, flag, value }) {
      return withTurn(async () => {
        if (messageId !== message.id) throw new Error('missing row');
        const revisionKey = `${flag}Revision`;
        const valueKey = flag;
        const previousValue = message[valueKey];
        message[revisionKey] += 1;
        message[valueKey] = value;
        const key = keyFor(messageId, flag);
        const previous = deliveries.get(key);
        const tombstones = [...(previous?.uncertaintyTombstones || [])];
        if (previous && (previous.state === 'uncertain' ||
            (previous.state === 'delivering' && previous.providerStartedAt != null))) {
          tombstones.push({
            revision: previous.revision,
            value: previous.desiredValue,
            baseline: previous.capturedModseq,
          });
        }
        const row = {
          messageId, flag, desiredValue: value, revision: message[revisionKey],
          accountId: message.accountId, uid: message.uid, folder: message.folder,
          uidValidity: message.uidValidity, folderGeneration: message.folderGeneration,
          state: 'pending', attemptGeneration: previous?.attemptGeneration || 0,
          attemptOwner: null, capturedModseq: null,
          uncertaintyTombstones: tombstones,
        };
        deliveries.set(key, row);
        return { delivery: clone(row), changed: previousValue !== value };
      });
    },
    async claim(messageId, flag, owner, lease) {
      return withTurn(async () => {
        if (lease?.key !== keyFor(messageId, flag)) throw new Error('delivery lease required');
        const row = deliveries.get(keyFor(messageId, flag));
        if (!row || row.state === 'confirmed') return clone(row);
        if (row.state === 'delivering' && row.leaseExpiresAt > clock.now) {
          throw new DesiredFlagError('Desired flag delivery lease is still active', {
            code: 'DESIRED_FLAG_LEASE_ACTIVE', retryable: true, uncertain: true,
          });
        }
        if (row.state === 'delivering' && row.providerStartedAt != null &&
            !row.uncertaintyTombstones.some(item =>
              Number(item.revision) === row.revision &&
              Number(item.attemptGeneration) === row.attemptGeneration)) {
          row.uncertaintyTombstones.push({
            revision: row.revision,
            value: row.desiredValue,
            baseline: row.capturedModseq,
            attemptGeneration: row.attemptGeneration,
            reason: 'ownership-takeover',
          });
        }
        row.state = 'delivering';
        row.attemptGeneration += 1;
        row.attemptOwner = owner;
        row.leaseExpiresAt = clock.now + leaseMs;
        row.capturedModseq = null;
        row.condstore = null;
        row.providerStartedAt = null;
        return clone(row);
      });
    },
    async renewLease(attempt) {
      if (beforeRenew) await beforeRenew();
      return withTurn(async () => {
        const row = deliveries.get(keyFor(attempt.messageId, attempt.flag));
        assertAttempt(row, attempt);
        if (row.leaseExpiresAt <= clock.now) throw new DesiredFlagError('Delivery lease expired', {
          code: 'DESIRED_FLAG_OWNERSHIP_LOST', retryable: true, uncertain: true,
        });
        row.leaseExpiresAt = clock.now + leaseMs;
        return clone(row);
      });
    },
    async recordBaseline(attempt, baseline, condstore) {
      return withTurn(async () => {
        const row = deliveries.get(keyFor(attempt.messageId, attempt.flag));
        assertAttempt(row, attempt);
        if (row.leaseExpiresAt <= clock.now) throw new DesiredFlagError('Delivery lease expired', {
          code: 'DESIRED_FLAG_OWNERSHIP_LOST', retryable: true, uncertain: true,
        });
        row.capturedModseq = baseline;
        row.condstore = condstore;
        return clone(row);
      });
    },
    async markProviderStarted(attempt) {
      return withTurn(async () => {
        const row = deliveries.get(keyFor(attempt.messageId, attempt.flag));
        assertAttempt(row, attempt);
        if (row.leaseExpiresAt <= clock.now || row.condstore == null) {
          throw new DesiredFlagError('Delivery lease or baseline was lost', {
            code: 'DESIRED_FLAG_OWNERSHIP_LOST', retryable: true, uncertain: true,
          });
        }
        row.providerStartedAt = new Date(clock.now).toISOString();
        return clone(row);
      });
    },
    async complete(attempt, result) {
      return withTurn(async () => {
        const row = deliveries.get(keyFor(attempt.messageId, attempt.flag));
        assertAttempt(row, attempt);
        const strictProof = result.condstore && result.modseq != null &&
          row.uncertaintyTombstones.every(item =>
            item.baseline != null && BigInt(result.modseq) > BigInt(item.baseline));
        const hasUncertainty = row.uncertaintyTombstones.length > 0;
        if (result.value === row.desiredValue && (!hasUncertainty || strictProof)) {
          row.state = 'confirmed';
          row.uncertaintyTombstones = [];
        } else {
          row.state = 'uncertain';
          if (!hasUncertainty) row.uncertaintyTombstones.push({
            revision: row.revision,
            value: row.desiredValue,
            baseline: row.capturedModseq,
            attemptGeneration: row.attemptGeneration,
            reason: 'post-store-mismatch',
          });
        }
        row.leaseExpiresAt = null;
        row.providerStartedAt = null;
        return clone(row);
      });
    },
    async releasePending(attempt) {
      return withTurn(async () => {
        const row = deliveries.get(keyFor(attempt.messageId, attempt.flag));
        assertAttempt(row, attempt);
        row.state = row.uncertaintyTombstones.length > 0 ? 'uncertain' : 'pending';
        row.attemptOwner = null;
        row.leaseExpiresAt = null;
        row.providerStartedAt = null;
        return clone(row);
      });
    },
    async markUncertain(attempt, uncertainty) {
      return withTurn(async () => {
        const row = deliveries.get(keyFor(attempt.messageId, attempt.flag));
        assertAttempt(row, attempt);
        row.state = 'uncertain';
        row.leaseExpiresAt = null;
        row.providerStartedAt = null;
        row.uncertaintyTombstones.push({
          revision: row.revision,
          value: row.desiredValue,
          baseline: row.capturedModseq,
          uncertainty,
        });
        return clone(row);
      });
    },
    async load(messageId, flag) {
      return clone(deliveries.get(keyFor(messageId, flag)));
    },
  };
}

function provider({ value = false, modseq = '10', condstore = true } = {}) {
  const state = { value, modseq: BigInt(modseq), stores: [] };
  return {
    state,
    async withSession(_delivery, callback) {
      return callback({
        condstore,
        async observe() {
          return { value: state.value, modseq: condstore ? String(state.modseq) : null };
        },
        async store(next, { unchangedSince } = {}) {
          state.stores.push({ value: next, unchangedSince: unchangedSince ?? null });
          if (condstore && unchangedSince != null && BigInt(unchangedSince) < state.modseq) return false;
          if (state.value !== next) {
            state.value = next;
            state.modseq += 1n;
          }
          return true;
        },
      });
    },
  };
}

describe('desired flag model', () => {
  it('normalizes only the two durable logical flags', () => {
    expect(normalizeDesiredFlag('\\Seen')).toBe('read');
    expect(normalizeDesiredFlag('\\Flagged')).toBe('star');
    expect(flagColumn('read')).toEqual({ value: 'is_read', revision: 'read_revision' });
    expect(() => normalizeDesiredFlag('\\Deleted')).toThrow(/unsupported/i);
  });

  it('increments read and star revisions independently and records exact row facts', async () => {
    const repository = memoryRepository();
    const executor = createDesiredFlagExecutor({ repository, ownerFactory: () => 'worker-1' });

    const read = await executor.accept({ messageId: 'row-1', flag: '\\Seen', value: true });
    const star = await executor.accept({ messageId: 'row-1', flag: '\\Flagged', value: true });
    const unread = await executor.accept({ messageId: 'row-1', flag: '\\Seen', value: false });

    expect([read.delivery.revision, star.delivery.revision, unread.delivery.revision]).toEqual([1, 1, 2]);
    expect(unread.delivery).toMatchObject({
      messageId: 'row-1', accountId: 'acct-1', uid: 7, folder: 'INBOX',
      uidValidity: '101', folderGeneration: '4', desiredValue: false,
    });
    expect(repository.message).toMatchObject({ read: false, star: true, readRevision: 2, starRevision: 1 });
  });

  it('reports one unread-count transition only when the local read CAS changes value', async () => {
    const repository = memoryRepository({ read: false });
    const executor = createDesiredFlagExecutor({ repository });

    await expect(executor.accept({ messageId: 'row-1', flag: '\\Seen', value: true }))
      .resolves.toMatchObject({ changed: true, unreadDelta: -1 });
    await expect(executor.accept({ messageId: 'row-1', flag: '\\Seen', value: true }))
      .resolves.toMatchObject({ changed: false, unreadDelta: 0 });
    await expect(executor.accept({ messageId: 'row-1', flag: '\\Seen', value: false }))
      .resolves.toMatchObject({ changed: true, unreadDelta: 1 });
    await expect(executor.accept({ messageId: 'row-1', flag: '\\Flagged', value: true }))
      .resolves.toMatchObject({ changed: true, unreadDelta: 0 });
  });

  it('uses UNCHANGEDSINCE and confirms a clean CONDSTORE delivery', async () => {
    const repository = memoryRepository();
    const remote = provider({ value: false, modseq: '10', condstore: true });
    const executor = createDesiredFlagExecutor({ repository, ownerFactory: () => 'worker-1' });
    await executor.accept({ messageId: 'row-1', flag: '\\Seen', value: true });

    await expect(executor.deliver('row-1', '\\Seen', remote)).resolves.toMatchObject({ state: 'confirmed' });
    expect(remote.state.stores).toEqual([{ value: true, unchangedSince: '10' }]);
    expect(remote.state.modseq).toBe(11n);
  });

  it('retains a same-MODSEQ predecessor tombstone and reasserts instead of accepting a no-op', async () => {
    const repository = memoryRepository();
    const remote = provider({ value: false, modseq: '10', condstore: true });
    const executor = createDesiredFlagExecutor({ repository, ownerFactory: () => 'worker-2' });
    await executor.accept({ messageId: 'row-1', flag: '\\Seen', value: true });
    const first = repository.deliveries.get('row-1:read');
    first.state = 'uncertain';
    first.capturedModseq = '10';
    first.uncertaintyTombstones = [{ revision: 1, value: true, baseline: '10' }];
    await executor.accept({ messageId: 'row-1', flag: '\\Seen', value: false });

    await expect(executor.deliver('row-1', '\\Seen', remote)).resolves.toMatchObject({ state: 'uncertain' });
    expect(remote.state.stores).toEqual([{ value: false, unchangedSince: '10' }]);
  });

  it('clears a predecessor tombstone only after the desired value is proven at a strictly greater MODSEQ', async () => {
    const repository = memoryRepository();
    const remote = provider({ value: true, modseq: '11', condstore: true });
    const executor = createDesiredFlagExecutor({ repository, ownerFactory: () => 'worker-2' });
    await executor.accept({ messageId: 'row-1', flag: '\\Seen', value: true });
    const first = repository.deliveries.get('row-1:read');
    first.state = 'uncertain';
    first.capturedModseq = '10';
    first.uncertaintyTombstones = [{ revision: 1, value: true, baseline: '10' }];
    await executor.accept({ messageId: 'row-1', flag: '\\Seen', value: false });

    await expect(executor.deliver('row-1', '\\Seen', remote)).resolves.toMatchObject({ state: 'confirmed' });
    expect(remote.state.stores).toEqual([{ value: false, unchangedSince: '11' }]);
    expect(remote.state.modseq).toBe(12n);
  });

  it('keeps non-CONDSTORE uncertainty and reasserts the latest value on every reconciliation', async () => {
    const repository = memoryRepository();
    const remote = provider({ value: false, condstore: false });
    const executor = createDesiredFlagExecutor({ repository, ownerFactory: () => 'worker-2' });
    await executor.accept({ messageId: 'row-1', flag: '\\Seen', value: true });
    const first = repository.deliveries.get('row-1:read');
    first.state = 'uncertain';
    first.uncertaintyTombstones = [{ revision: 1, value: true, baseline: null }];
    await executor.accept({ messageId: 'row-1', flag: '\\Seen', value: false });

    await expect(executor.deliver('row-1', '\\Seen', remote)).resolves.toMatchObject({ state: 'uncertain' });
    await expect(executor.deliver('row-1', '\\Seen', remote)).resolves.toMatchObject({ state: 'uncertain' });
    expect(remote.state.stores).toEqual([
      { value: false, unchangedSince: null },
      { value: false, unchangedSince: null },
    ]);
  });

  it('keeps an uncertainty tombstone when the provider disconnects after baseline capture', async () => {
    const repository = memoryRepository();
    const executor = createDesiredFlagExecutor({ repository, ownerFactory: () => 'worker-1' });
    await executor.accept({ messageId: 'row-1', flag: '\\Flagged', value: true });
    const remote = provider({ value: false, modseq: '20' });
    remote.withSession = async (_delivery, callback) => callback({
      condstore: true,
      observe: async () => ({ value: false, modseq: '20' }),
      store: async () => { throw new Error('socket disconnected'); },
    });

    await expect(executor.deliver('row-1', '\\Flagged', remote)).rejects.toMatchObject({
      code: 'DESIRED_FLAG_DELIVERY_UNCERTAIN', retryable: true, uncertain: true,
    });
    expect(repository.deliveries.get('row-1:star')).toMatchObject({ state: 'uncertain' });
    expect(repository.deliveries.get('row-1:star').uncertaintyTombstones).toHaveLength(1);
  });

  it('keeps STORE timeout uncertainty under a lease longer than provider command timeout', async () => {
    expect(DESIRED_FLAG_LEASE_MS).toBeGreaterThan(60_000);
    const repository = memoryRepository();
    const executor = createDesiredFlagExecutor({ repository, ownerFactory: () => 'worker-1' });
    await executor.accept({ messageId: 'row-1', flag: '\\Seen', value: true });
    const store = vi.fn().mockRejectedValue(Object.assign(new Error('STORE timed out'), {
      code: 'ETIMEDOUT',
    }));
    const remote = {
      withSession: async (_delivery, callback) => callback({
        condstore: true,
        observe: async () => ({ value: false, modseq: '25' }),
        store,
      }),
    };

    await expect(executor.deliver('row-1', '\\Seen', remote)).rejects.toMatchObject({
      code: 'DESIRED_FLAG_DELIVERY_UNCERTAIN', retryable: true, uncertain: true,
    });
    expect(store).toHaveBeenCalledOnce();
    expect(repository.deliveries.get('row-1:read')).toMatchObject({
      state: 'uncertain', leaseExpiresAt: null,
      uncertaintyTombstones: [expect.objectContaining({ baseline: '25' })],
    });
  });

  it('does not append a permanent tombstone when observation fails before a baseline or STORE', async () => {
    const repository = memoryRepository();
    const executor = createDesiredFlagExecutor({ repository, ownerFactory: () => 'worker-1' });
    await executor.accept({ messageId: 'row-1', flag: '\\Seen', value: true });
    const remote = {
      withSession: async (_delivery, callback) => callback({
        condstore: true,
        observe: async () => { throw new Error('fetch failed before STORE'); },
        store: vi.fn(),
      }),
    };

    await expect(executor.deliver('row-1', '\\Seen', remote)).rejects.toMatchObject({
      code: 'DESIRED_FLAG_DELIVERY_UNCERTAIN',
    });
    expect(repository.deliveries.get('row-1:read')).toMatchObject({
      state: 'pending', uncertaintyTombstones: [],
    });
  });

  it.each([
    ['provider session acquisition', ({ remote }) => {
      remote.withSession = async () => { throw new Error('provider connect failed'); };
    }],
    ['advisory lock acquisition', ({ repository }) => {
      repository.withDeliveryLease = async () => { throw new Error('advisory lock timeout'); };
    }],
    ['claim transaction', ({ repository }) => {
      repository.claim = async () => { throw new Error('claim database failure'); };
    }],
  ])('types %s failure and preserves the accepted pending intent without a tombstone', async (_name, arrange) => {
    const repository = memoryRepository();
    const remote = provider();
    const executor = createDesiredFlagExecutor({ repository });
    await executor.accept({ messageId: 'row-1', flag: '\\Seen', value: true });
    arrange({ repository, remote });

    await expect(executor.deliver('row-1', '\\Seen', remote)).rejects.toMatchObject({
      code: 'DESIRED_FLAG_DELIVERY_UNCERTAIN', retryable: true, uncertain: true,
    });
    expect(repository.deliveries.get('row-1:read')).toMatchObject({
      state: 'pending', uncertaintyTombstones: [],
    });
  });

  it('prevents STORE and takeover when the advisory session drops inside the durable lease', async () => {
    const renewEntered = deferred();
    const releaseRenew = deferred();
    let firstLease;
    const repository = memoryRepository({
      onLease: lease => { if (!firstLease) firstLease = lease; },
      beforeRenew: async () => { renewEntered.resolve(); await releaseRenew.promise; },
    });
    const remote = provider({ value: false, modseq: '20' });
    const store = vi.fn().mockResolvedValue(true);
    remote.withSession = async (_delivery, callback) => callback({
      condstore: true,
      observe: async () => ({ value: false, modseq: '20' }),
      store,
    });
    await createDesiredFlagExecutor({ repository }).accept({
      messageId: 'row-1', flag: '\\Seen', value: true,
    });
    const worker1 = createDesiredFlagExecutor({ repository, ownerFactory: () => 'worker-1' });
    const worker2 = createDesiredFlagExecutor({ repository, ownerFactory: () => 'worker-2' });

    const first = worker1.deliver('row-1', '\\Seen', remote);
    await renewEntered.promise;
    firstLease.drop();
    const second = worker2.deliver('row-1', '\\Seen', remote);
    await expect(second).rejects.toMatchObject({
      code: 'DESIRED_FLAG_LEASE_ACTIVE', retryable: true, uncertain: true,
    });
    releaseRenew.resolve();

    await expect(first).rejects.toMatchObject({
      code: 'DESIRED_FLAG_LEASE_SESSION_LOST', retryable: true, uncertain: true,
    });
    expect(store).not.toHaveBeenCalled();
    expect(repository.deliveries.get('row-1:read')).toMatchObject({
      state: 'pending', uncertaintyTombstones: [],
    });
  });

  it('allows abandoned delivering work to be reclaimed only after durable lease expiry', async () => {
    const clock = { now: 0 };
    const repository = memoryRepository({ clock, leaseMs: 100 });
    await createDesiredFlagExecutor({ repository }).accept({
      messageId: 'row-1', flag: '\\Seen', value: true,
    });
    const abandoned = repository.deliveries.get('row-1:read');
    abandoned.state = 'delivering';
    abandoned.attemptGeneration = 1;
    abandoned.attemptOwner = 'dead-worker';
    abandoned.capturedModseq = '20';
    abandoned.leaseExpiresAt = 100;
    const remote = provider({ value: false, modseq: '21' });
    const executor = createDesiredFlagExecutor({ repository, ownerFactory: () => 'worker-2' });

    await expect(executor.deliver('row-1', '\\Seen', remote)).rejects.toMatchObject({
      code: 'DESIRED_FLAG_LEASE_ACTIVE',
    });
    clock.now = 101;
    await expect(executor.deliver('row-1', '\\Seen', remote)).resolves.toMatchObject({
      state: 'confirmed', attemptOwner: 'worker-2',
    });
    expect(remote.state.stores).toHaveLength(1);
  });

  it('reclaims a post-claim/pre-observe crash without creating a null-baseline tombstone', async () => {
    const clock = { now: 101 };
    const repository = memoryRepository({ clock, leaseMs: 100 });
    await createDesiredFlagExecutor({ repository }).accept({
      messageId: 'row-1', flag: '\\Seen', value: true,
    });
    Object.assign(repository.deliveries.get('row-1:read'), {
      state: 'delivering', attemptGeneration: 1, attemptOwner: 'dead-worker',
      leaseExpiresAt: 100, capturedModseq: null, providerStartedAt: null,
    });
    const originalClaim = repository.claim.bind(repository);
    let claimed;
    repository.claim = async (...args) => {
      claimed = await originalClaim(...args);
      return claimed;
    };
    const remote = provider({ value: false, modseq: '20' });

    await expect(createDesiredFlagExecutor({
      repository, ownerFactory: () => 'worker-2',
    }).deliver('row-1', '\\Seen', remote)).resolves.toMatchObject({ state: 'confirmed' });
    expect(claimed.uncertaintyTombstones).toEqual([]);
    expect(remote.state.stores).toHaveLength(1);
  });

  it('reclaims a post-baseline/pre-STORE crash without manufacturing uncertainty', async () => {
    const clock = { now: 101 };
    const repository = memoryRepository({ clock, leaseMs: 100 });
    await createDesiredFlagExecutor({ repository }).accept({
      messageId: 'row-1', flag: '\\Seen', value: true,
    });
    Object.assign(repository.deliveries.get('row-1:read'), {
      state: 'delivering', attemptGeneration: 1, attemptOwner: 'dead-worker',
      leaseExpiresAt: 100, capturedModseq: '20', condstore: true,
      providerStartedAt: null,
    });
    const originalClaim = repository.claim.bind(repository);
    let claimed;
    repository.claim = async (...args) => {
      claimed = await originalClaim(...args);
      return claimed;
    };
    const remote = provider({ value: false, modseq: '20' });

    await expect(createDesiredFlagExecutor({
      repository, ownerFactory: () => 'worker-2',
    }).deliver('row-1', '\\Seen', remote)).resolves.toMatchObject({ state: 'confirmed' });
    expect(claimed.uncertaintyTombstones).toEqual([]);
    expect(remote.state.stores).toHaveLength(1);
  });

  it('preserves a post-STORE ambiguous takeover tombstone and rejects same-MODSEQ equality', async () => {
    const clock = { now: 101 };
    const repository = memoryRepository({ clock, leaseMs: 100 });
    await createDesiredFlagExecutor({ repository }).accept({
      messageId: 'row-1', flag: '\\Seen', value: true,
    });
    Object.assign(repository.deliveries.get('row-1:read'), {
      state: 'delivering', attemptGeneration: 1, attemptOwner: 'dead-worker',
      leaseExpiresAt: 100, capturedModseq: '20', condstore: true,
      providerStartedAt: '2026-08-26T08:00:00.000Z',
    });
    const originalClaim = repository.claim.bind(repository);
    let claimed;
    repository.claim = async (...args) => {
      claimed = await originalClaim(...args);
      return claimed;
    };
    const remote = provider({ value: true, modseq: '20' });

    await expect(createDesiredFlagExecutor({
      repository, ownerFactory: () => 'worker-2',
    }).deliver('row-1', '\\Seen', remote)).resolves.toMatchObject({ state: 'uncertain' });
    expect(claimed.uncertaintyTombstones).toEqual([
      expect.objectContaining({ baseline: '20', attemptGeneration: 1 }),
    ]);
    expect(remote.state.stores).toHaveLength(1);
  });

  it('serializes simultaneous cross-worker claims through one provider STORE boundary', async () => {
    const repository = memoryRepository();
    const firstStore = deferred();
    let enteredStores = 0;
    const remote = provider({ value: false, modseq: '20', condstore: true });
    remote.withSession = async (_delivery, callback) => callback({
      condstore: true,
      observe: async () => ({ value: remote.state.value, modseq: String(remote.state.modseq) }),
      store: async value => {
        enteredStores += 1;
        await firstStore.promise;
        remote.state.value = value;
        remote.state.modseq += 1n;
        return true;
      },
    });
    await createDesiredFlagExecutor({ repository }).accept({
      messageId: 'row-1', flag: '\\Seen', value: true,
    });
    const worker1 = createDesiredFlagExecutor({ repository, ownerFactory: () => 'worker-1' });
    const worker2 = createDesiredFlagExecutor({ repository, ownerFactory: () => 'worker-2' });

    const delivering1 = worker1.deliver('row-1', '\\Seen', remote);
    await vi.waitFor(() => expect(enteredStores).toBe(1));
    const delivering2 = worker2.deliver('row-1', '\\Seen', remote);
    await Promise.resolve();
    expect(enteredStores).toBe(1);
    expect(repository.deliveries.get('row-1:read')).toMatchObject({ attemptOwner: 'worker-1' });

    firstStore.resolve();
    await expect(Promise.all([delivering1, delivering2])).resolves.toEqual([
      expect.objectContaining({ state: 'confirmed' }),
      expect.objectContaining({ state: 'confirmed' }),
    ]);
    expect(enteredStores).toBe(1);
  });

  it('tombstones a captured baseline when STORE succeeds but the post-value is wrong', async () => {
    const repository = memoryRepository();
    const executor = createDesiredFlagExecutor({ repository, ownerFactory: () => 'worker-1' });
    await executor.accept({ messageId: 'row-1', flag: '\\Seen', value: true });
    const observe = vi.fn()
      .mockResolvedValueOnce({ value: false, modseq: '40' })
      .mockResolvedValueOnce({ value: false, modseq: '40' });
    const store = vi.fn().mockResolvedValue(true);
    const remote = { withSession: async (_delivery, callback) => callback({
      condstore: true, observe, store,
    }) };

    await expect(executor.deliver('row-1', '\\Seen', remote)).resolves.toMatchObject({
      state: 'uncertain',
      uncertaintyTombstones: [expect.objectContaining({ baseline: '40' })],
    });

    observe.mockReset()
      .mockResolvedValueOnce({ value: true, modseq: '40' })
      .mockResolvedValueOnce({ value: true, modseq: '40' });
    await expect(executor.deliver('row-1', '\\Seen', remote)).resolves.toMatchObject({
      state: 'uncertain',
    });
    expect(store).toHaveBeenCalledTimes(2);
  });

  it('rejects stale owner completion without clearing the newer desired revision', async () => {
    const repository = memoryRepository();
    const remote = provider({ value: false, modseq: '30' });
    const executor = createDesiredFlagExecutor({ repository, ownerFactory: () => 'worker-1' });
    await executor.accept({ messageId: 'row-1', flag: '\\Seen', value: true });
    const gate = deferred();
    remote.withSession = async (delivery, callback) => callback({
      condstore: true,
      observe: vi.fn()
        .mockResolvedValueOnce({ value: false, modseq: '30' })
        .mockImplementationOnce(() => gate.promise),
      store: async () => true,
    });

    const stale = executor.deliver('row-1', '\\Seen', remote);
    await vi.waitFor(() => expect(repository.deliveries.get('row-1:read').capturedModseq).toBe('30'));
    await executor.accept({ messageId: 'row-1', flag: '\\Seen', value: false });
    gate.resolve({ value: true, modseq: '31' });

    await expect(stale).rejects.toMatchObject({ code: 'DESIRED_FLAG_OWNERSHIP_LOST' });
    expect(repository.deliveries.get('row-1:read')).toMatchObject({ revision: 2, desiredValue: false, state: 'pending' });
  });

  it('adapts one exact UID to CONDSTORE observations and UNCHANGEDSINCE STORE', async () => {
    const client = {
      enabled: new Set(['CONDSTORE']),
      mailbox: { noModseq: false },
      fetchOne: vi.fn()
        .mockResolvedValueOnce({ uid: 7, flags: new Set(), modseq: 40n })
        .mockResolvedValueOnce({ uid: 7, flags: new Set(['\\Seen']), modseq: 41n }),
      messageFlagsAdd: vi.fn().mockResolvedValue(true),
      messageFlagsRemove: vi.fn(),
    };
    const session = createImapDesiredFlagSession(client, {
      uid: 7, flag: 'read', desiredValue: true,
    });

    expect(session.condstore).toBe(true);
    await expect(session.observe()).resolves.toEqual({ value: false, modseq: '40' });
    await expect(session.store(true, { unchangedSince: '40' })).resolves.toBe(true);
    await expect(session.observe()).resolves.toEqual({ value: true, modseq: '41' });
    expect(client.messageFlagsAdd).toHaveBeenCalledWith('7', ['\\Seen'], {
      uid: true, unchangedSince: 40n,
    });
  });

  it('treats a missing exact UID observation as typed uncertainty', async () => {
    const client = {
      enabled: new Set(), mailbox: {}, fetchOne: vi.fn().mockResolvedValue(false),
      messageFlagsAdd: vi.fn(), messageFlagsRemove: vi.fn(),
    };
    const session = createImapDesiredFlagSession(client, { uid: 7, flag: 'star' });
    await expect(session.observe()).rejects.toMatchObject({
      code: 'DESIRED_FLAG_UID_NOT_FOUND', retryable: true, uncertain: true,
    });
  });
});

describe('Postgres desired flag repository', () => {
  it('lists durable pending, uncertain, and abandoned delivering work for cross-process reconciliation', async () => {
    const runQuery = vi.fn().mockResolvedValue({ rows: [{
      message_id: 'row-1', flag: 'read', account_id: 'acct-1', uid: '7', folder: 'INBOX',
      uid_validity: '101', folder_generation: '9', revision: '5', desired_value: true,
      state: 'uncertain', attempt_generation: '3', attempt_owner: 'dead-worker',
      captured_modseq: '40', condstore: true, uncertainty_tombstones: [],
    }] });
    const repository = createPostgresDesiredFlagRepository({ runQuery });

    await expect(repository.listPending(25)).resolves.toEqual([
      expect.objectContaining({ messageId: 'row-1', state: 'uncertain', revision: 5 }),
    ]);
    expect(runQuery.mock.calls[0][0]).toMatch(/state IN \('pending', 'delivering', 'uncertain'\)/);
    expect(runQuery.mock.calls[0][0]).toMatch(/pg_locks/);
    expect(runQuery.mock.calls[0][0]).toMatch(/locktype = 'advisory'/);
    expect(runQuery.mock.calls[0][0]).toMatch(/lease_expires_at IS NULL[\s\S]*lease_expires_at <= NOW\(\)/);
    expect(runQuery.mock.calls[0][0]).toMatch(/m\.is_deleted = false/);
    expect(runQuery.mock.calls[0][0]).toMatch(/f\.is_present = true/);
    expect(runQuery).toHaveBeenCalledWith(expect.any(String), [25]);
  });

  it('uses a session advisory lease keyed by message and flag', async () => {
    const client = { query: vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ held: true }] })
      .mockResolvedValueOnce({ rows: [] }) };
    const runSession = vi.fn(callback => callback(client));
    const repository = createPostgresDesiredFlagRepository({ runSession });
    const callback = vi.fn(async lease => {
      await lease.assertActive();
      return 'done';
    });

    await expect(repository.withDeliveryLease('row-1', 'read', callback)).resolves.toBe('done');
    expect(client.query.mock.calls[0]).toEqual([
      'SELECT pg_advisory_lock(hashtextextended($1, 0))', ['row-1:read'],
    ]);
    expect(client.query.mock.calls.at(-1)).toEqual([
      'SELECT pg_advisory_unlock(hashtextextended($1, 0))', ['row-1:read'],
    ]);
    expect(client.query.mock.calls[1][0]).toMatch(/FROM pg_locks[\s\S]*pg_backend_pid/);
    expect(callback).toHaveBeenCalledOnce();
  });

  it('does not reclaim a delivering row while its durable lease is unexpired', async () => {
    const deliveryRow = {
      message_id: 'row-1', flag: 'read', account_id: 'acct-1', uid: '7', folder: 'INBOX',
      uid_validity: '101', folder_generation: '9', revision: '5', desired_value: true,
      state: 'delivering', attempt_generation: '3', attempt_owner: 'worker-1',
      lease_expires_at: '2026-08-26T08:00:00.000Z',
      captured_modseq: '40', condstore: true, uncertainty_tombstones: [],
    };
    const tx = { query: vi.fn()
      .mockResolvedValueOnce({ rows: [deliveryRow] })
      .mockResolvedValueOnce({ rows: [] }) };
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const repository = createPostgresDesiredFlagRepository({
      runSession: callback => callback(client),
      runTransaction: callback => callback(tx),
    });

    await expect(repository.withDeliveryLease('row-1', 'read', lease =>
      repository.claim('row-1', 'read', 'worker-2', lease)
    )).rejects.toMatchObject({ code: 'DESIRED_FLAG_LEASE_ACTIVE', retryable: true });
    expect(tx.query.mock.calls[1][0]).toMatch(/lease_expires_at IS NULL[\s\S]*lease_expires_at <= NOW\(\)/);
  });

  it.each([
    ['post-claim/pre-observe', null, null, 0],
    ['post-baseline/pre-STORE', '40', null, 0],
    ['post-STORE ambiguous', '40', '2026-08-26T08:00:00.000Z', 1],
  ])('uses durable provider-start evidence for %s expired takeover', async (
    _window, capturedModseq, providerStartedAt, expectedTombstones,
  ) => {
    const deliveryRow = {
      message_id: 'row-1', flag: 'read', account_id: 'acct-1', uid: '7', folder: 'INBOX',
      uid_validity: '101', folder_generation: '9', revision: '5', desired_value: true,
      state: 'delivering', attempt_generation: '3', attempt_owner: 'worker-1',
      lease_expires_at: '2026-08-26T07:59:00.000Z',
      captured_modseq: capturedModseq, condstore: true,
      provider_started_at: providerStartedAt, uncertainty_tombstones: [],
    };
    let updateParams;
    const tx = { query: vi.fn(async (sql, params) => {
      if (sql.includes('FOR UPDATE')) return { rows: [deliveryRow] };
      if (sql.includes('UPDATE message_flag_deliveries')) {
        updateParams = params;
        return { rows: [{
          ...deliveryRow,
          state: 'delivering',
          attempt_generation: '4',
          attempt_owner: 'worker-2',
          captured_modseq: null,
          condstore: null,
          provider_started_at: null,
          uncertainty_tombstones: JSON.parse(params[3]),
        }] };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    }) };
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const repository = createPostgresDesiredFlagRepository({
      runSession: callback => callback(client),
      runTransaction: callback => callback(tx),
    });

    const claimed = await repository.withDeliveryLease('row-1', 'read', lease =>
      repository.claim('row-1', 'read', 'worker-2', lease)
    );

    expect(JSON.parse(updateParams[3])).toHaveLength(expectedTombstones);
    expect(claimed.uncertaintyTombstones).toHaveLength(expectedTombstones);
    expect(tx.query.mock.calls[1][0]).toMatch(/provider_started_at = NULL/);
  });

  it('refuses to claim delivering ownership outside the advisory lease callback', async () => {
    const runTransaction = vi.fn();
    const repository = createPostgresDesiredFlagRepository({ runTransaction });

    await expect(repository.claim('row-1', 'read', 'worker-1')).rejects.toMatchObject({
      code: 'DESIRED_FLAG_LEASE_REQUIRED', retryable: true,
    });
    expect(runTransaction).not.toHaveBeenCalled();
  });

  it('accepts one exact live row intent and adjusts unread count in the same transaction', async () => {
    const calls = [];
    const tx = { query: vi.fn(async (sql, params) => {
      calls.push([sql, params]);
      if (sql.includes('FOR UPDATE OF f, m')) return { rows: [{
        id: 'row-1', account_id: 'acct-1', uid: '7', folder: 'INBOX',
        is_read: false, is_starred: false, read_revision: '4', star_revision: '2',
        uid_validity: '101', observation_generation: '9',
      }] };
      if (sql.includes('FROM message_flag_deliveries')) return { rows: [] };
      if (sql.includes('UPDATE messages') && sql.includes('read_revision = read_revision + 1')) {
        return { rowCount: 1, rows: [{ revision: '5', visible_value: true }] };
      }
      if (sql.includes('UPDATE folders') && sql.includes('unread_count')) return { rowCount: 1, rows: [] };
      if (sql.includes('INSERT INTO message_flag_deliveries')) return { rowCount: 1, rows: [{
        message_id: 'row-1', flag: 'read', account_id: 'acct-1', uid: '7', folder: 'INBOX',
        uid_validity: '101', folder_generation: '9', revision: '5', desired_value: true,
        state: 'pending', attempt_generation: '0', attempt_owner: null,
        captured_modseq: null, uncertainty_tombstones: [],
      }] };
      throw new Error(`unexpected SQL: ${sql}`);
    }) };
    const repository = createPostgresDesiredFlagRepository({
      runQuery: vi.fn(),
      runTransaction: callback => callback(tx),
    });

    await expect(repository.acceptIntent({
      messageId: 'row-1', flag: 'read', value: true,
      accountId: 'acct-1', uid: 7, folder: 'INBOX', uidValidity: '101', folderGeneration: '9',
    })).resolves.toMatchObject({ changed: true, delivery: { revision: 5, desiredValue: true } });

    expect(calls[0][0]).toMatch(/JOIN folders f[\s\S]*is_present = true[\s\S]*uid_validity IS NOT NULL[\s\S]*metadata_complete = true[\s\S]*FOR UPDATE OF f, m/);
    expect(calls.some(([sql]) => /read_revision = read_revision \+ 1/.test(sql))).toBe(true);
    expect(calls.find(([sql]) => sql.includes('UPDATE folders'))[1]).toEqual([-1, 'acct-1', 'INBOX']);
  });

  it('rejects incomplete, deleted, absent, epochless, relocated, and reused-UID rows before mutation', async () => {
    const tx = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const repository = createPostgresDesiredFlagRepository({
      runQuery: vi.fn(), runTransaction: callback => callback(tx),
    });

    await expect(repository.acceptIntent({
      messageId: 'row-1', flag: 'star', value: true,
      accountId: 'acct-1', uid: 7, folder: 'INBOX', uidValidity: '101', folderGeneration: '9',
    })).rejects.toMatchObject({ code: 'DESIRED_FLAG_ROW_SUPERSEDED', retryable: true });
    expect(tx.query).toHaveBeenCalledTimes(1);
  });

  it('checks revision, attempt owner, and generation on every delivery transition', async () => {
    const tx = { query: vi.fn(async (sql) => {
      if (sql.includes('UPDATE message_flag_deliveries') && sql.includes('captured_modseq')) {
        return { rows: [] };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    }) };
    const repository = createPostgresDesiredFlagRepository({
      runQuery: vi.fn(), runTransaction: callback => callback(tx),
    });

    await expect(repository.recordBaseline({
      messageId: 'row-1', flag: 'read', revision: 3,
      attemptGeneration: 7, attemptOwner: '00000000-0000-4000-8000-000000000001',
    }, '44', true)).rejects.toMatchObject({ code: 'DESIRED_FLAG_OWNERSHIP_LOST' });
    expect(tx.query.mock.calls[0][0]).toMatch(/revision = \$[0-9]+[\s\S]*attempt_generation = \$[0-9]+[\s\S]*attempt_owner = \$[0-9]+/);
  });

  it('applies a bulk pull only to exact rows whose captured per-flag revisions still match', async () => {
    const calls = [];
    const tx = { query: vi.fn(async (sql, params) => {
      calls.push([sql, params]);
      if (sql.includes('FOR SHARE')) return { rows: [{ uid_validity: '101', observation_generation: '9', is_present: true }] };
      if (sql.includes('WITH pulled AS')) return { rows: [{ folder: 'INBOX', old_is_read: false, is_read: true }] };
      if (sql.includes('UPDATE folders')) return { rowCount: 1, rows: [] };
      throw new Error(`unexpected SQL: ${sql}`);
    }) };
    const repository = createPostgresDesiredFlagRepository({
      runQuery: vi.fn(), runTransaction: callback => callback(tx),
    });

    const changed = await repository.applyPull({
      accountId: 'acct-1', folder: 'INBOX', uidValidity: '101', folderGeneration: '9',
      rows: [{
        id: 'row-1', uid: 7, readRevision: 3, starRevision: 5,
        isRead: true, isStarred: false, modseq: '51',
      }],
    });

    expect(changed).toBe(1);
    const update = calls.find(([sql]) => sql.includes('WITH pulled AS'));
    expect(update[0]).toMatch(/m\.id = pulled\.id/);
    expect(update[0]).toMatch(/m\.uid = pulled\.uid/);
    expect(update[0]).toMatch(/m\.read_revision = pulled\.read_revision[\s\S]*AS apply_read/);
    expect(update[0]).toMatch(/m\.star_revision = pulled\.star_revision[\s\S]*AS apply_star/);
    expect(update[0]).not.toMatch(/WHERE[\s\S]*m\.read_revision = pulled\.read_revision[\s\S]*m\.star_revision = pulled\.star_revision/);
    expect(update[0]).toMatch(/message_flag_deliveries[\s\S]*state IN \('pending', 'delivering', 'uncertain'\)/);
    expect(calls.find(([sql]) => sql.includes('UPDATE folders'))[1]).toEqual([-1, 'acct-1', 'INBOX']);
  });
});
