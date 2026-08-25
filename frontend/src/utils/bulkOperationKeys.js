const STORAGE_KEY = 'mailflow_bulk_operation_keys_v1';
const DEFAULT_MAX_ENTRIES = 2000;

function inMemoryStorage() {
  const values = new Map();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

const fallbackStorage = inMemoryStorage();

function defaultStorage() {
  try {
    if (typeof window === 'undefined') return fallbackStorage;
    if (window.localStorage) return window.localStorage;
    throw new Error('localStorage unavailable');
  } catch (cause) {
    return {
      getItem: () => { throw cause; },
      setItem: () => { throw cause; },
    };
  }
}

function entryId(kind, destination, rowId) {
  return JSON.stringify([kind, destination || '', String(rowId).toLowerCase()]);
}

function canonicalRowIds(rowIds) {
  const canonical = rowIds.map(rowId => String(rowId).toLowerCase());
  if (new Set(canonical).size !== rowIds.length) {
    throw new Error('Duplicate row ids are not allowed');
  }
  return canonical;
}

export function createBulkOperationKeyRegistry({
  storage = defaultStorage(),
  maxEntries = DEFAULT_MAX_ENTRIES,
  createKey = () => globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`,
  now = () => Date.now(),
} = {}) {
  const read = () => {
    try {
      const raw = storage.getItem(STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Invalid bulk operation registry');
      }
      const canonicalEntries = {};
      for (const [storedId, entry] of Object.entries(parsed)) {
        const parts = JSON.parse(storedId);
        if (!Array.isArray(parts) || parts.length !== 3) {
          throw new Error('Invalid bulk operation registry entry');
        }
        const canonicalId = entryId(parts[0], parts[1], parts[2]);
        if (Object.prototype.hasOwnProperty.call(canonicalEntries, canonicalId)) {
          throw new Error('Duplicate canonical bulk operation registry entry');
        }
        canonicalEntries[canonicalId] = entry;
      }
      return canonicalEntries;
    } catch (cause) {
      throw new Error('Unable to read bulk operation keys', { cause });
    }
  };
  const write = (entries) => {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(entries));
    } catch (cause) {
      throw new Error('Unable to persist bulk operation keys', { cause });
    }
  };

  return {
    prepare(kind, rowIds, destination = '') {
      const entries = read();
      const canonicalIds = canonicalRowIds(rowIds);
      const newEntryCount = canonicalIds.filter(rowId => (
        !entries[entryId(kind, destination, rowId)]
      )).length;
      if (Object.keys(entries).length + newEntryCount > maxEntries) {
        throw new Error('Too many unresolved bulk operations; retry or resolve pending rows first');
      }
      const operationKeys = {};
      for (const rowId of canonicalIds) {
        const id = entryId(kind, destination, rowId);
        const existing = entries[id];
        const key = existing?.key || createKey();
        entries[id] = { key, updatedAt: now() };
        operationKeys[rowId] = key;
      }
      write(entries);
      return operationKeys;
    },

    complete(kind, rowIds, destination = '') {
      const entries = read();
      for (const rowId of canonicalRowIds(rowIds)) {
        delete entries[entryId(kind, destination, rowId)];
      }
      write(entries);
    },
  };
}

const bulkOperationKeys = createBulkOperationKeyRegistry();

export const prepareBulkOperationKeys = (...args) => bulkOperationKeys.prepare(...args);
export const completeBulkOperationKeys = (...args) => bulkOperationKeys.complete(...args);
