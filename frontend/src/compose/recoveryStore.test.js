import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  deleteRecoveryPatch,
  getRecoveryPatch,
  mergeRecoveryPatch,
  openRecoveryStore,
  putRecoveryPatch,
} from './recoveryStore.js';

const MIB_25 = 25 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
const USER_A = 'user-a';
const USER_B = 'user-b';
const SESSION_A = '11111111-1111-4111-8111-111111111111';
const SESSION_B = '22222222-2222-4222-8222-222222222222';

function recoveryError(code, cause) {
  return error => {
    assert.equal(error.name, 'RecoveryStoreError');
    assert.equal(error.code, code);
    if (cause !== undefined) assert.equal(error.cause, cause);
    return true;
  };
}

function memoryAdapter() {
  const records = new Map();
  const state = { records, deleteCount: 0 };
  return {
    state,
    async get(key) {
      return records.has(key) ? structuredClone(records.get(key)) : undefined;
    },
    async put(record) {
      records.set(record.key, structuredClone(record));
    },
    async delete(key) {
      state.deleteCount += 1;
      records.delete(key);
    },
  };
}

async function memoryStore() {
  return openRecoveryStore({ adapter: memoryAdapter() });
}

function fakeIndexedDB({
  openError = null,
  blocked = false,
  upgradeError = null,
  operationFailure = null,
  delayedCompletion = false,
} = {}) {
  const records = new Map();
  const opened = [];
  const createdStores = [];
  const objectStoreNames = new Set();
  const pendingCompletions = [];

  function request(transaction, operation) {
    const req = { error: null, result: undefined };
    queueMicrotask(() => {
      if (operationFailure?.kind === 'request') {
        req.error = operationFailure.error;
        req.onerror?.({ target: req });
        return;
      }
      try {
        req.result = operation();
        req.onsuccess?.({ target: req });
        if (operationFailure?.kind === 'transaction') {
          transaction.error = operationFailure.error;
          transaction.onerror?.({ target: transaction });
        } else if (operationFailure?.kind === 'abort') {
          transaction.error = operationFailure.error;
          transaction.onabort?.({ target: transaction });
        } else if (delayedCompletion) {
          pendingCompletions.push(() => transaction.oncomplete?.({ target: transaction }));
        } else {
          transaction.oncomplete?.({ target: transaction });
        }
      } catch (error) {
        req.error = error;
        transaction.error = error;
        req.onerror?.({ target: req });
        transaction.onabort?.({ target: transaction });
      }
    });
    return req;
  }

  const db = {
    closed: false,
    objectStoreNames: {
      contains: name => objectStoreNames.has(name),
    },
    createObjectStore(name, options) {
      if (upgradeError) throw upgradeError;
      objectStoreNames.add(name);
      createdStores.push({ name, options });
      return {};
    },
    transaction(name, mode) {
      assert.equal(name, 'patches');
      const transaction = { error: null, mode };
      transaction.objectStore = storeName => {
        assert.equal(storeName, 'patches');
        return {
          get: key => request(transaction, () => structuredClone(records.get(key))),
          put: record => request(transaction, () => {
            records.set(record.key, structuredClone(record));
            return record.key;
          }),
          delete: key => request(transaction, () => records.delete(key)),
        };
      };
      return transaction;
    },
    close() {
      this.closed = true;
    },
  };

  const factory = {
    opened,
    createdStores,
    completeNextTransaction() {
      const complete = pendingCompletions.shift();
      assert.ok(complete, 'expected a pending IndexedDB transaction');
      complete();
    },
    open(name, version) {
      opened.push({ name, version });
      const req = {
        error: null,
        result: db,
        transaction: { abort() {} },
      };
      queueMicrotask(() => {
        if (openError) {
          req.error = openError;
          req.onerror?.({ target: req });
          return;
        }
        if (blocked) {
          req.onblocked?.({ target: req });
          return;
        }
        req.onupgradeneeded?.({ target: req });
        req.onsuccess?.({ target: req });
      });
      return req;
    },
  };
  return factory;
}

describe('compose recovery patch merge', () => {
  it('merges field changes only at an equal base revision', () => {
    const current = { baseRevision: 2, changes: { subject: 'A' } };
    const incoming = { baseRevision: 2, changes: { body: 'B' } };

    assert.deepEqual(mergeRecoveryPatch(current, incoming), {
      baseRevision: 2,
      changes: { subject: 'A', body: 'B' },
    });
    assert.deepEqual(current, { baseRevision: 2, changes: { subject: 'A' } });
    assert.deepEqual(incoming, { baseRevision: 2, changes: { body: 'B' } });
  });

  it('deeply detaches nested merge inputs and output in both directions', () => {
    const current = {
      baseRevision: 2,
      changes: { recipients: { to: [{ address: 'sender@example.com' }] } },
    };
    const incoming = {
      baseRevision: 2,
      changes: { formatting: { font: { family: 'sans-serif' } } },
    };
    const currentBefore = structuredClone(current);
    const incomingBefore = structuredClone(incoming);
    const merged = mergeRecoveryPatch(current, incoming);

    merged.changes.recipients.to[0].address = 'changed@example.com';
    merged.changes.formatting.font.family = 'serif';
    assert.deepEqual(current, currentBefore);
    assert.deepEqual(incoming, incomingBefore);

    current.changes.recipients.to[0].address = 'later@example.com';
    incoming.changes.formatting.font.family = 'monospace';
    assert.equal(merged.changes.recipients.to[0].address, 'changed@example.com');
    assert.equal(merged.changes.formatting.font.family, 'serif');
  });

  it('rejects mismatched and invalid revisions instead of combining them', () => {
    assert.throws(
      () => mergeRecoveryPatch(
        { baseRevision: 2, changes: { subject: 'A' } },
        { baseRevision: 3, changes: { body: 'B' } },
      ),
      recoveryError('recovery_revision_mismatch'),
    );

    for (const baseRevision of [-1, 1.5, NaN, Infinity, '2', null, 2n, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(
        () => mergeRecoveryPatch(
          { baseRevision: 2, changes: {} },
          { baseRevision, changes: {} },
        ),
        recoveryError('recovery_invalid'),
      );
    }
  });

  it('rejects non-object changes instead of silently dropping them', () => {
    for (const changes of [null, undefined, [], 'body', 42, true]) {
      assert.throws(
        () => mergeRecoveryPatch(
          { baseRevision: 2, changes: {} },
          { baseRevision: 2, changes },
        ),
        recoveryError('recovery_invalid'),
      );
    }
  });

  it('rejects binary values and nested attachment content while allowing metadata', () => {
    const binaryValues = [
      new Uint8Array([1, 2]),
      new Uint8Array([1, 2]).buffer,
      new DataView(new ArrayBuffer(2)),
      new Blob(['safe-fixture']),
    ];
    if (typeof File === 'function') binaryValues.push(new File(['safe-fixture'], 'fixture.txt'));

    for (const value of binaryValues) {
      assert.throws(
        () => mergeRecoveryPatch(
          { baseRevision: 2, changes: {} },
          { baseRevision: 2, changes: { nested: { value } } },
        ),
        recoveryError('recovery_binary_forbidden'),
      );
    }

    for (const changes of [
      { attachment: 'encoded-content' },
      { attachments: ['encoded-content'] },
      { attachments: [{ id: 'attachment-a', content: 'encoded-content' }] },
      { attachment: { data: 'encoded-content' } },
      { forwardedAttachments: [{ messageId: 'message-a', part: '2', payload: 'encoded-content' }] },
      { attachments: [{ id: 'attachment-a', rawPayload: 'encoded-content' }] },
      { attachments: [{ id: 'attachment-a', nested: { filename: 'fixture.txt' } }] },
      { wrapper: { attachmentBytes: 'encoded-content' } },
      { attachmentContent: { base64: 'encoded-content' } },
    ]) {
      assert.throws(
        () => mergeRecoveryPatch(
          { baseRevision: 2, changes: {} },
          { baseRevision: 2, changes },
        ),
        recoveryError('recovery_binary_forbidden'),
      );
    }

    assert.deepEqual(
      mergeRecoveryPatch(
        { baseRevision: 2, changes: {} },
        {
          baseRevision: 2,
          changes: {
            attachments: [{
              id: 'attachment-a',
              filename: 'fixture.txt',
              contentType: 'text/plain',
              mediaType: 'text/plain',
              byteCount: 12,
              size: 12,
              cid: 'fixture-cid',
            }],
            attachment: {
              attachmentId: 'attachment-b',
              filename: 'fixture-b.txt',
              contentType: 'text/plain',
              size: 8,
            },
            forwardedAttachments: [{
              messageId: 'message-a',
              part: '2',
              filename: 'forwarded.txt',
              mediaType: 'text/plain',
              byteCount: 6,
              cid: 'forwarded-cid',
            }],
          },
        },
      ),
      {
        baseRevision: 2,
        changes: {
          attachments: [{
            id: 'attachment-a',
            filename: 'fixture.txt',
            contentType: 'text/plain',
            mediaType: 'text/plain',
            byteCount: 12,
            size: 12,
            cid: 'fixture-cid',
          }],
          attachment: {
            attachmentId: 'attachment-b',
            filename: 'fixture-b.txt',
            contentType: 'text/plain',
            size: 8,
          },
          forwardedAttachments: [{
            messageId: 'message-a',
            part: '2',
            filename: 'forwarded.txt',
            mediaType: 'text/plain',
            byteCount: 6,
            cid: 'forwarded-cid',
          }],
        },
      },
    );
  });

  it('uses stable validation, binary, size, and revision error codes', () => {
    assert.throws(
      () => mergeRecoveryPatch(
        { baseRevision: 2, changes: {} },
        { baseRevision: 2, changes: null },
      ),
      recoveryError('recovery_invalid'),
    );
    assert.throws(
      () => mergeRecoveryPatch(
        { baseRevision: 2, changes: {} },
        { baseRevision: 2, changes: { attachment: new Uint8Array([1]) } },
      ),
      recoveryError('recovery_binary_forbidden'),
    );
    assert.throws(
      () => mergeRecoveryPatch(
        { baseRevision: 2, changes: {} },
        { baseRevision: 3, changes: {} },
      ),
      recoveryError('recovery_revision_mismatch'),
    );
  });
});

describe('compose recovery store', () => {
  it('isolates exact records by user and session key', async () => {
    const store = await memoryStore();
    const now = () => 1_000;

    await putRecoveryPatch(store, {
      userId: USER_A,
      sessionId: SESSION_A,
      baseRevision: 2,
      changes: { subject: 'A' },
    }, { now });
    await putRecoveryPatch(store, {
      userId: USER_A,
      sessionId: SESSION_B,
      baseRevision: 2,
      changes: { subject: 'B' },
    }, { now });
    await putRecoveryPatch(store, {
      userId: USER_B,
      sessionId: SESSION_A,
      baseRevision: 2,
      changes: { subject: 'C' },
    }, { now });

    assert.deepEqual(await getRecoveryPatch(store, USER_A, SESSION_A, { now }), {
      key: `${USER_A}:${SESSION_A}`,
      userId: USER_A,
      sessionId: SESSION_A,
      baseRevision: 2,
      changes: { subject: 'A' },
      updatedAt: 1_000,
    });
    assert.equal((await getRecoveryPatch(store, USER_A, SESSION_B, { now })).changes.subject, 'B');
    assert.equal((await getRecoveryPatch(store, USER_B, SESSION_A, { now })).changes.subject, 'C');
  });

  it('upserts and merges equal-revision patches without retaining caller references', async () => {
    const store = await memoryStore();
    const firstChanges = { subject: 'A' };

    await putRecoveryPatch(store, {
      userId: USER_A,
      sessionId: SESSION_A,
      baseRevision: 2,
      changes: firstChanges,
    }, { now: () => 1_000 });
    firstChanges.subject = 'mutated-after-put';

    await putRecoveryPatch(store, {
      userId: USER_A,
      sessionId: SESSION_A,
      baseRevision: 2,
      changes: { body: 'B' },
    }, { now: () => 2_000 });

    assert.deepEqual(
      await getRecoveryPatch(store, USER_A, SESSION_A, { now: () => 2_000 }),
      {
        key: `${USER_A}:${SESSION_A}`,
        userId: USER_A,
        sessionId: SESSION_A,
        baseRevision: 2,
        changes: { subject: 'A', body: 'B' },
        updatedAt: 2_000,
      },
    );
  });

  it('rejects a mismatched upsert without changing the stored recovery record', async () => {
    const store = await memoryStore();
    await putRecoveryPatch(store, {
      userId: USER_A,
      sessionId: SESSION_A,
      baseRevision: 2,
      changes: { subject: 'A' },
    }, { now: () => 1_000 });

    await assert.rejects(
      putRecoveryPatch(store, {
        userId: USER_A,
        sessionId: SESSION_A,
        baseRevision: 3,
        changes: { body: 'B' },
      }, { now: () => 2_000 }),
      recoveryError('recovery_revision_mismatch'),
    );
    assert.deepEqual(
      await getRecoveryPatch(store, USER_A, SESSION_A, { now: () => 2_000 }),
      {
        key: `${USER_A}:${SESSION_A}`,
        userId: USER_A,
        sessionId: SESSION_A,
        baseRevision: 2,
        changes: { subject: 'A' },
        updatedAt: 1_000,
      },
    );
  });

  it('deletes a stored patch and leaves other keys intact', async () => {
    const store = await memoryStore();
    for (const sessionId of [SESSION_A, SESSION_B]) {
      await putRecoveryPatch(store, {
        userId: USER_A,
        sessionId,
        baseRevision: 2,
        changes: { subject: sessionId },
      }, { now: () => 1_000 });
    }

    await deleteRecoveryPatch(store, USER_A, SESSION_A);

    assert.equal(await getRecoveryPatch(store, USER_A, SESSION_A, { now: () => 1_000 }), null);
    assert.ok(await getRecoveryPatch(store, USER_A, SESSION_B, { now: () => 1_000 }));
  });

  it('expires and deletes a record at seven days but not one millisecond before', async () => {
    const store = await memoryStore();
    await putRecoveryPatch(store, {
      userId: USER_A,
      sessionId: SESSION_A,
      baseRevision: 2,
      changes: { subject: 'A' },
    }, { now: () => 5_000 });

    assert.ok(await getRecoveryPatch(store, USER_A, SESSION_A, {
      now: () => 5_000 + (7 * DAY_MS) - 1,
    }));
    assert.equal(store.state.deleteCount, 0);
    assert.equal(store.state.records.has(`${USER_A}:${SESSION_A}`), true);
    assert.equal(await getRecoveryPatch(store, USER_A, SESSION_A, {
      now: () => 5_000 + (7 * DAY_MS),
    }), null);
    assert.equal(store.state.deleteCount, 1);
    assert.equal(store.state.records.has(`${USER_A}:${SESSION_A}`), false);
    assert.equal(await getRecoveryPatch(store, USER_A, SESSION_A, {
      now: () => 5_000 + (7 * DAY_MS),
    }), null);
    assert.equal(store.state.deleteCount, 1);
  });

  it('reports malformed persisted records with a stable corruption code', async () => {
    const store = await memoryStore();
    store.state.records.set(`${USER_A}:${SESSION_A}`, {
      key: `${USER_A}:${SESSION_A}`,
      userId: USER_A,
      sessionId: SESSION_A,
      baseRevision: 2,
      changes: { subject: 'A' },
      updatedAt: 'not-a-timestamp',
    });

    await assert.rejects(
      getRecoveryPatch(store, USER_A, SESSION_A, { now: () => 1_000 }),
      recoveryError('recovery_corrupt_record'),
    );
  });

  it('accepts an exactly 25 MiB UTF-8 record and rejects one byte more', async () => {
    const exactStore = await memoryStore();
    const key = `${USER_A}:${SESSION_A}`;
    const fixedRecord = {
      key,
      userId: USER_A,
      sessionId: SESSION_A,
      baseRevision: 2,
      changes: { body: '' },
      updatedAt: 1_000,
    };
    const fixedBytes = new TextEncoder().encode(JSON.stringify(fixedRecord)).byteLength;
    const exactBody = 'x'.repeat(MIB_25 - fixedBytes);

    await putRecoveryPatch(exactStore, {
      userId: USER_A,
      sessionId: SESSION_A,
      baseRevision: 2,
      changes: { body: exactBody },
    }, { now: () => 1_000 });
    assert.equal(
      new TextEncoder().encode(JSON.stringify(
        await getRecoveryPatch(exactStore, USER_A, SESSION_A, { now: () => 1_000 }),
      )).byteLength,
      MIB_25,
    );

    const oversizedStore = await memoryStore();
    await assert.rejects(
      putRecoveryPatch(oversizedStore, {
        userId: USER_A,
        sessionId: SESSION_A,
        baseRevision: 2,
        changes: { body: `${exactBody}x` },
      }, { now: () => 1_000 }),
      recoveryError('recovery_size_exceeded'),
    );
  });

  it('measures the serialized record in UTF-8 bytes rather than string code units', async () => {
    const store = await memoryStore();
    const key = `${USER_A}:${SESSION_A}`;
    const fixedRecord = {
      key,
      userId: USER_A,
      sessionId: SESSION_A,
      baseRevision: 2,
      changes: { body: '' },
      updatedAt: 1_000,
    };
    const fixedBytes = new TextEncoder().encode(JSON.stringify(fixedRecord)).byteLength;
    const body = '€'.repeat(Math.floor((MIB_25 - fixedBytes) / 3) + 1);
    assert.ok(JSON.stringify({ ...fixedRecord, changes: { body } }).length < MIB_25);

    await assert.rejects(
      putRecoveryPatch(store, {
        userId: USER_A,
        sessionId: SESSION_A,
        baseRevision: 2,
        changes: { body },
      }, { now: () => 1_000 }),
      recoveryError('recovery_size_exceeded'),
    );
  });
});

describe('native IndexedDB recovery adapter', () => {
  it('opens and upgrades the named database, then completes read-write transactions', async () => {
    const indexedDB = fakeIndexedDB();
    const store = await openRecoveryStore({ indexedDB });
    assert.deepEqual(indexedDB.opened, [{ name: 'mailflow-compose-recovery', version: 1 }]);
    assert.deepEqual(indexedDB.createdStores, [{ name: 'patches', options: { keyPath: 'key' } }]);

    await putRecoveryPatch(store, {
      userId: USER_A,
      sessionId: SESSION_A,
      baseRevision: 2,
      changes: { subject: 'A' },
    }, { now: () => 1_000 });
    assert.equal(
      (await getRecoveryPatch(store, USER_A, SESSION_A, { now: () => 1_000 })).changes.subject,
      'A',
    );
    await deleteRecoveryPatch(store, USER_A, SESSION_A);
    assert.equal(await getRecoveryPatch(store, USER_A, SESSION_A, { now: () => 1_000 }), null);
  });

  it('does not resolve an operation until its transaction completes', async () => {
    const indexedDB = fakeIndexedDB({ delayedCompletion: true });
    const store = await openRecoveryStore({ indexedDB });
    let resolved = false;
    const pending = store.put({ key: 'delayed', value: 'written' }).then(() => {
      resolved = true;
    });

    await new Promise(resolve => queueMicrotask(resolve));
    assert.equal(resolved, false);
    indexedDB.completeNextTransaction();
    await pending;
    assert.equal(resolved, true);
  });

  it('uses distinct unavailable, blocked, open, and upgrade error codes with causes', async () => {
    await assert.rejects(
      openRecoveryStore({ indexedDB: null }),
      recoveryError('recovery_unavailable'),
    );
    await assert.rejects(
      openRecoveryStore({ indexedDB: fakeIndexedDB({ blocked: true }) }),
      recoveryError('recovery_blocked'),
    );

    const openCause = new DOMException('open failed', 'UnknownError');
    await assert.rejects(
      openRecoveryStore({ indexedDB: fakeIndexedDB({ openError: openCause }) }),
      recoveryError('recovery_open_failed', openCause),
    );

    const upgradeCause = new DOMException('upgrade failed', 'InvalidStateError');
    await assert.rejects(
      openRecoveryStore({ indexedDB: fakeIndexedDB({ upgradeError: upgradeCause }) }),
      recoveryError('recovery_upgrade_failed', upgradeCause),
    );
  });

  it('uses distinct request, transaction, and abort error codes with causes', async () => {
    const failures = [
      ['request', 'recovery_request_failed'],
      ['transaction', 'recovery_transaction_failed'],
      ['abort', 'recovery_transaction_aborted'],
    ];

    for (const [kind, code] of failures) {
      const cause = new DOMException(`${kind} failed`, 'UnknownError');
      const store = await openRecoveryStore({
        indexedDB: fakeIndexedDB({ operationFailure: { kind, error: cause } }),
      });

      await assert.rejects(
        store.put({ key: `${kind}-failure` }),
        recoveryError(code, cause),
      );
    }
  });
});
