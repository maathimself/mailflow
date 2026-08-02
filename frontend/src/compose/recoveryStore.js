const DATABASE_NAME = 'mailflow-compose-recovery';
const DATABASE_VERSION = 1;
const OBJECT_STORE_NAME = 'patches';
const MAX_SERIALIZED_BYTES = 25 * 1024 * 1024;
const RECOVERY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const ATTACHMENT_FIELDS = new Set([
  'attachmentid',
  'bytecount',
  'cid',
  'contenttype',
  'filename',
  'id',
  'mediatype',
  'size',
]);
const FORWARDED_ATTACHMENT_FIELDS = new Set([
  'bytecount',
  'cid',
  'contenttype',
  'filename',
  'mediatype',
  'messageid',
  'part',
  'size',
]);
const ATTACHMENT_KEYS = new Map([
  ['attachment', { fields: ATTACHMENT_FIELDS, multiple: false }],
  ['attachments', { fields: ATTACHMENT_FIELDS, multiple: true }],
  ['forwardedattachments', { fields: FORWARDED_ATTACHMENT_FIELDS, multiple: true }],
]);
const ATTACHMENT_NUMBER_FIELDS = new Set(['bytecount', 'size']);

export class RecoveryStoreError extends Error {
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'RecoveryStoreError';
    this.code = code;
  }
}

function recoveryError(code, message, cause) {
  return new RecoveryStoreError(code, message, cause);
}

function assertStore(store) {
  if (!store
    || typeof store.get !== 'function'
    || typeof store.put !== 'function'
    || typeof store.delete !== 'function') {
    throw recoveryError(
      'recovery_invalid',
      'Recovery store must provide get, put, and delete methods',
    );
  }
}

function assertIdentifier(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw recoveryError('recovery_invalid', `${name} must be a non-empty string`);
  }
}

function assertBaseRevision(baseRevision) {
  if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) {
    throw recoveryError(
      'recovery_invalid',
      'Recovery patch base revision must be a non-negative safe integer',
    );
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isBinaryValue(value) {
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return true;
  if (typeof SharedArrayBuffer === 'function' && value instanceof SharedArrayBuffer) return true;
  if (typeof Blob === 'function' && value instanceof Blob) return true;
  return false;
}

function normalizedFieldName(name) {
  return String(name).replace(/[^a-z0-9]/giu, '').toLowerCase();
}

function binaryForbidden(message = 'Recovery changes must not contain attachment or binary content') {
  throw recoveryError('recovery_binary_forbidden', message);
}

function validateAttachmentDescriptor(value, fields) {
  if (!isPlainObject(value)) {
    binaryForbidden('Recovery attachment values must be metadata objects');
  }
  for (const [name, child] of Object.entries(value)) {
    const normalized = normalizedFieldName(name);
    if (!fields.has(normalized)) {
      binaryForbidden(`Recovery attachment metadata field ${name} is not allowed`);
    }
    if (ATTACHMENT_NUMBER_FIELDS.has(normalized)) {
      if (!Number.isSafeInteger(child) || child < 0) {
        binaryForbidden(`Recovery attachment metadata field ${name} must be a non-negative integer`);
      }
    } else if (typeof child !== 'string') {
      binaryForbidden(`Recovery attachment metadata field ${name} must be a string`);
    }
  }
}

function validateAttachmentValue(value, definition) {
  if (isBinaryValue(value)) binaryForbidden();
  if (definition.multiple) {
    if (!Array.isArray(value)) {
      binaryForbidden('Recovery attachment collections must be arrays of metadata objects');
    }
    for (const descriptor of value) validateAttachmentDescriptor(descriptor, definition.fields);
    return;
  }
  validateAttachmentDescriptor(value, definition.fields);
}

function validateJsonValue(value, seen) {
  if (isBinaryValue(value)) {
    binaryForbidden();
  }

  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw recoveryError('recovery_invalid', 'Recovery changes must contain JSON values');
    }
    return;
  }
  if (typeof value !== 'object') {
    throw recoveryError('recovery_invalid', 'Recovery changes must contain JSON values');
  }
  if (!Array.isArray(value) && !isPlainObject(value)) {
    throw recoveryError('recovery_invalid', 'Recovery changes must contain JSON values');
  }
  if (seen.has(value)) {
    throw recoveryError('recovery_invalid', 'Recovery changes must not contain cycles');
  }

  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) validateJsonValue(item, seen);
  } else {
    for (const [name, child] of Object.entries(value)) {
      const normalized = normalizedFieldName(name);
      const attachmentDefinition = ATTACHMENT_KEYS.get(normalized);
      if (attachmentDefinition) {
        validateAttachmentValue(child, attachmentDefinition);
      } else if (normalized.includes('attachment')) {
        binaryForbidden(`Recovery attachment field ${name} is not allowed`);
      } else {
        validateJsonValue(child, seen);
      }
    }
  }
  seen.delete(value);
}

function assertChanges(changes) {
  if (!isPlainObject(changes)) {
    throw recoveryError('recovery_invalid', 'Recovery patch changes must be an object');
  }
  validateJsonValue(changes, new WeakSet());
}

function cloneChanges(changes) {
  return JSON.parse(JSON.stringify(changes));
}

function serializedByteLength(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function assertWithinSizeLimit(value) {
  if (serializedByteLength(value) > MAX_SERIALIZED_BYTES) {
    throw recoveryError(
      'recovery_size_exceeded',
      'Recovery patch exceeds the 25 MiB serialized size limit',
    );
  }
}

function readClock(now) {
  const value = typeof now === 'function' ? now() : now;
  if (!Number.isFinite(value)) {
    throw recoveryError('recovery_invalid', 'Recovery clock must return a finite timestamp');
  }
  return value;
}

function recoveryKey(userId, sessionId) {
  assertIdentifier(userId, 'userId');
  assertIdentifier(sessionId, 'sessionId');
  return `${userId}:${sessionId}`;
}

function isExpired(record, currentTime) {
  return currentTime - record.updatedAt >= RECOVERY_TTL_MS;
}

function validateStoredRecord(record, { key, userId, sessionId }) {
  try {
    if (!isPlainObject(record)
      || record.key !== key
      || record.userId !== userId
      || record.sessionId !== sessionId
      || !Number.isFinite(record.updatedAt)) {
      throw new Error('Stored recovery record metadata is invalid');
    }
    assertBaseRevision(record.baseRevision);
    assertChanges(record.changes);
    assertWithinSizeLimit(record);
  } catch (cause) {
    throw recoveryError(
      'recovery_corrupt_record',
      'Stored recovery record is invalid',
      cause,
    );
  }
}

function nativeCause(request, transaction, fallback) {
  return request?.error || transaction?.error || new Error(fallback);
}

function runTransaction(db, mode, operation) {
  return new Promise((resolve, reject) => {
    let transaction;
    let request;
    let result;
    let settled = false;
    const fail = error => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    try {
      transaction = db.transaction(OBJECT_STORE_NAME, mode);
      try {
        request = operation(transaction.objectStore(OBJECT_STORE_NAME));
      } catch (cause) {
        fail(recoveryError('recovery_request_failed', 'IndexedDB request failed', cause));
        return;
      }
      request.onsuccess = () => { result = request.result; };
      request.onerror = () => fail(recoveryError(
        'recovery_request_failed',
        'IndexedDB request failed',
        nativeCause(request, transaction, 'IndexedDB request failed'),
      ));
      transaction.oncomplete = () => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      transaction.onerror = () => fail(recoveryError(
        'recovery_transaction_failed',
        'IndexedDB transaction failed',
        nativeCause(null, transaction, 'IndexedDB transaction failed'),
      ));
      transaction.onabort = () => fail(recoveryError(
        'recovery_transaction_aborted',
        'IndexedDB transaction aborted',
        nativeCause(null, transaction, 'IndexedDB transaction aborted'),
      ));
    } catch (cause) {
      fail(recoveryError(
        'recovery_transaction_failed',
        'IndexedDB transaction failed',
        cause,
      ));
    }
  });
}

function indexedDbAdapter(db) {
  return {
    get(key) {
      return runTransaction(db, 'readonly', objectStore => objectStore.get(key));
    },
    put(record) {
      return runTransaction(db, 'readwrite', objectStore => objectStore.put(record));
    },
    delete(key) {
      return runTransaction(db, 'readwrite', objectStore => objectStore.delete(key));
    },
  };
}

export function mergeRecoveryPatch(current, incoming) {
  assertBaseRevision(current?.baseRevision);
  assertBaseRevision(incoming?.baseRevision);
  assertChanges(current?.changes);
  assertChanges(incoming?.changes);
  if (current.baseRevision !== incoming.baseRevision) {
    throw recoveryError(
      'recovery_revision_mismatch',
      'Recovery patches must have the same base revision',
    );
  }

  const merged = {
    baseRevision: current.baseRevision,
    changes: {
      ...cloneChanges(current.changes),
      ...cloneChanges(incoming.changes),
    },
  };
  assertWithinSizeLimit(merged.changes);
  return merged;
}

export async function openRecoveryStore({ adapter, indexedDB = globalThis.indexedDB } = {}) {
  if (adapter !== undefined) {
    assertStore(adapter);
    return adapter;
  }
  if (!indexedDB || typeof indexedDB.open !== 'function') {
    throw recoveryError('recovery_unavailable', 'IndexedDB is unavailable');
  }

  return new Promise((resolve, reject) => {
    let request;
    let settled = false;
    const fail = error => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    try {
      request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        try {
          const db = request.result;
          if (!db.objectStoreNames.contains(OBJECT_STORE_NAME)) {
            db.createObjectStore(OBJECT_STORE_NAME, { keyPath: 'key' });
          }
        } catch (cause) {
          try {
            request.transaction?.abort();
          } catch {
            // The upgrade failure remains the primary error.
          }
          fail(recoveryError(
            'recovery_upgrade_failed',
            'Unable to upgrade recovery IndexedDB',
            cause,
          ));
        }
      };
      request.onerror = () => {
        const cause = request.error || new Error('Unable to open recovery IndexedDB');
        fail(recoveryError(
          'recovery_open_failed',
          'Unable to open recovery IndexedDB',
          cause,
        ));
      };
      request.onblocked = () => fail(recoveryError(
        'recovery_blocked',
        'Opening recovery IndexedDB was blocked',
      ));
      request.onsuccess = () => {
        if (settled) {
          request.result?.close();
          return;
        }
        settled = true;
        resolve(indexedDbAdapter(request.result));
      };
    } catch (cause) {
      fail(recoveryError(
        'recovery_open_failed',
        'Unable to open recovery IndexedDB',
        cause,
      ));
    }
  });
}

export async function putRecoveryPatch(
  store,
  { userId, sessionId, baseRevision, changes },
  { now = Date.now } = {},
) {
  assertStore(store);
  const key = recoveryKey(userId, sessionId);
  assertBaseRevision(baseRevision);
  assertChanges(changes);
  assertWithinSizeLimit(changes);
  const updatedAt = readClock(now);

  let existing = await store.get(key);
  if (existing != null) {
    validateStoredRecord(existing, { key, userId, sessionId });
  }
  if (existing != null && isExpired(existing, updatedAt)) {
    await store.delete(key);
    existing = undefined;
  }

  const patch = { baseRevision, changes };
  const merged = existing
    ? mergeRecoveryPatch(existing, patch)
    : { baseRevision, changes: cloneChanges(changes) };
  const record = {
    key,
    userId,
    sessionId,
    baseRevision: merged.baseRevision,
    changes: merged.changes,
    updatedAt,
  };
  assertWithinSizeLimit(record);
  await store.put(record);
  return cloneChanges(record);
}

export async function getRecoveryPatch(
  store,
  userId,
  sessionId,
  { now = Date.now } = {},
) {
  assertStore(store);
  const key = recoveryKey(userId, sessionId);
  const currentTime = readClock(now);
  const record = await store.get(key);
  if (record == null) return null;
  validateStoredRecord(record, { key, userId, sessionId });
  if (isExpired(record, currentTime)) {
    await store.delete(key);
    return null;
  }
  return cloneChanges(record);
}

export async function deleteRecoveryPatch(store, userId, sessionId) {
  assertStore(store);
  await store.delete(recoveryKey(userId, sessionId));
}
