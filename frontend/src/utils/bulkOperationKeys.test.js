import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createBulkOperationKeyRegistry } from './bulkOperationKeys.js';

function memoryStorage() {
  const values = new Map();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

describe('bulk operation key registry', () => {
  it('reuses failed row keys across changed subsets and frontend recreation', () => {
    const storage = memoryStorage();
    let sequence = 0;
    const options = { storage, createKey: () => `key-${++sequence}`, now: () => sequence };
    const firstProcess = createBulkOperationKeyRegistry(options);
    const first = firstProcess.prepare('archive', ['old-row', 'done-row']);
    firstProcess.complete('archive', ['done-row']);

    const reloadedProcess = createBulkOperationKeyRegistry(options);
    const retry = reloadedProcess.prepare('archive', ['old-row', 'new-row']);
    const laterLifecycle = reloadedProcess.prepare('archive', ['done-row']);

    assert.equal(retry['old-row'], first['old-row']);
    assert.notEqual(retry['new-row'], first['old-row']);
    assert.notEqual(laterLifecycle['done-row'], first['done-row']);
  });

  it('keeps unconfirmed keys and fails closed at the unresolved-row bound', () => {
    const storage = memoryStorage();
    let sequence = 0;
    const registry = createBulkOperationKeyRegistry({
      storage, maxEntries: 2, createKey: () => `key-${++sequence}`, now: () => sequence,
    });
    const first = registry.prepare('delete', ['row-1']);
    registry.prepare('delete', ['row-2']);

    assert.throws(() => registry.prepare('delete', ['row-3']), /too many unresolved bulk operations/i);
    assert.equal(registry.prepare('delete', ['row-1'])['row-1'], 'key-1');
    assert.equal(first['row-1'], 'key-1');
  });

  it('fails closed when durable storage cannot persist a new row key', () => {
    const registry = createBulkOperationKeyRegistry({
      storage: {
        getItem: () => null,
        setItem: () => { throw new Error('quota'); },
      },
      createKey: () => 'key-1',
    });

    assert.throws(() => registry.prepare('archive', ['row-1']), /persist bulk operation keys/i);
  });

  it('fails closed instead of overwriting unreadable unresolved keys', () => {
    const registry = createBulkOperationKeyRegistry({
      storage: {
        getItem: () => '{not-json',
        setItem: () => {},
      },
      createKey: () => 'key-1',
    });

    assert.throws(() => registry.prepare('move', ['row-1'], 'Archive'), /read bulk operation keys/i);
  });

  it('canonicalizes UUID row ids across store, reload, and success clearing', () => {
    const storage = memoryStorage();
    let sequence = 0;
    const options = { storage, createKey: () => `key-${++sequence}`, now: () => sequence };
    const upper = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
    const lower = upper.toLowerCase();
    const first = createBulkOperationKeyRegistry(options).prepare('archive', [upper]);

    assert.deepEqual(Object.keys(first), [lower]);
    assert.equal(createBulkOperationKeyRegistry(options).prepare('archive', [lower])[lower], first[lower]);

    createBulkOperationKeyRegistry(options).complete('archive', [lower]);
    const next = createBulkOperationKeyRegistry(options).prepare('archive', [upper]);
    assert.notEqual(next[lower], first[lower]);
  });

  it('rejects case-variant duplicate UUID row ids', () => {
    const registry = createBulkOperationKeyRegistry({ storage: memoryStorage() });
    const upper = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';

    assert.throws(
      () => registry.prepare('move', [upper, upper.toLowerCase()], 'Archive'),
      /duplicate row ids/i,
    );
  });

  it('migrates a persisted uppercase registry entry before lookup and clearing', () => {
    const storage = memoryStorage();
    const upper = 'DDDDDDDD-DDDD-4DDD-8DDD-DDDDDDDDDDDD';
    const lower = upper.toLowerCase();
    storage.setItem('mailflow_bulk_operation_keys_v1', JSON.stringify({
      [JSON.stringify(['delete', '', upper])]: { key: 'persisted-uppercase-key', updatedAt: 1 },
    }));
    const registry = createBulkOperationKeyRegistry({
      storage, createKey: () => 'must-not-create', now: () => 2,
    });

    assert.equal(registry.prepare('delete', [lower])[lower], 'persisted-uppercase-key');
    registry.complete('delete', [upper]);
    assert.deepEqual(JSON.parse(storage.getItem('mailflow_bulk_operation_keys_v1')), {});
  });
});
