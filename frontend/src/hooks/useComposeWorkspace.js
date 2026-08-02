import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useStore } from '../store/index.js';
import { api as mailflowApi } from '../utils/api.js';
import {
  capacityForDockWidth,
  composeChipSessions,
  nextComposeFocus,
  visibleComposeSessions,
} from '../compose/workspaceState.js';
import {
  deleteRecoveryPatch,
  getRecoveryPatch,
  openRecoveryStore,
  putRecoveryPatch,
} from '../compose/recoveryStore.js';

const SAVE_DELAY_MS = 2000;
const EDITABLE_FIELDS = Object.freeze([
  'accountId', 'aliasId', 'mode', 'to', 'cc', 'bcc', 'subject', 'body',
  'bodyIsHtml', 'quotedBody', 'quotedBodyHtml', 'editedSignature',
  'forwardedAttachments', 'priority', 'inReplyTo', 'references', 'fromChanged',
]);
const EDITABLE_FIELD_SET = new Set(EDITABLE_FIELDS);

function clone(value) {
  if (value === undefined) return undefined;
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function equal(left, right) {
  if (Object.is(left, right)) return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function editableChanges(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  return Object.fromEntries(
    Object.entries(input)
      .filter(([field]) => EDITABLE_FIELD_SET.has(field))
      .map(([field, value]) => [field, clone(value)]),
  );
}

function legacyRecipient(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return value;
  const address = value.email || value.address || '';
  if (!address) return '';
  return value.name ? `${value.name} <${address}>` : address;
}

function normalizedCreateChanges(input = {}) {
  const normalized = { ...input };
  if (!normalized.mode) {
    if (normalized.isReplyAll) normalized.mode = 'reply_all';
    else if (normalized.isReply) normalized.mode = 'reply';
    else if (normalized.isForward) normalized.mode = 'forward';
  }
  for (const field of ['to', 'cc', 'bcc']) {
    if (Array.isArray(normalized[field])) {
      normalized[field] = normalized[field].map(legacyRecipient).filter(Boolean);
    }
  }
  if (typeof normalized.references === 'string') {
    normalized.references = normalized.references.trim().split(/\s+/).filter(Boolean);
  }
  return editableChanges(normalized);
}

function hasChanges(record) {
  return Object.keys(record.localChanges || {}).length > 0;
}

function serverConflictResolution(record, strategy, selectedFields) {
  const conflict = record.conflict || {};
  const fields = Array.isArray(selectedFields)
    ? selectedFields
    : (conflict.conflictingFields || []);
  const localChanges = { ...clone(record.localChanges) };
  const snapshot = { ...clone(record.snapshot) };
  if (strategy === 'remote') {
    for (const field of fields) {
      if (Object.hasOwn(conflict.remoteValues || {}, field)) {
        snapshot[field] = clone(conflict.remoteValues[field]);
      }
      delete localChanges[field];
    }
  }
  return {
    snapshot,
    localChanges,
    baseRevision: Number(conflict.currentRevision ?? record.baseRevision),
  };
}

function recordView(record) {
  return {
    ...(clone(record.summary) || {}),
    ...(clone(record.snapshot) || {}),
    ...(clone(record.localChanges) || {}),
    summary: clone(record.summary),
    snapshot: clone(record.snapshot),
    localChanges: clone(record.localChanges) || {},
    baseRevision: record.baseRevision,
    status: record.status,
    conflict: clone(record.conflict),
    recoveryConflict: clone(record.recoveryConflict),
    error: record.error || null,
    needsSnapshot: Boolean(record.needsSnapshot),
    remoteMissing: Boolean(record.remoteMissing),
    remoteRevision: record.remoteRevision ?? null,
    acknowledgedEcho: clone(record.acknowledgedEcho),
    terminalPending: record.terminalPending || null,
    lastFocusedAt: record.localFocusedAt
      || record.snapshot?.lastFocusedAt
      || record.summary?.lastFocusedAt,
  };
}

function summaryVisibilityView(record) {
  return {
    ...recordView(record),
    ...(clone(record.summary) || {}),
    lastFocusedAt: record.localFocusedAt
      || record.summary?.lastFocusedAt
      || record.snapshot?.lastFocusedAt,
  };
}

export function initialComposeWorkspaceState() {
  return {
    records: [],
    focusedSessionId: null,
    capacity: 1,
  };
}

function updateRecord(state, sessionId, updater) {
  let changed = false;
  const records = state.records.map(record => {
    if (record.id !== sessionId) return record;
    changed = true;
    return updater(record);
  });
  return changed ? { ...state, records } : state;
}

function cleanRecord(record) {
  return !hasChanges(record)
    && !['dirty', 'saving', 'offline', 'conflict', 'error', 'restoring'].includes(record.status);
}

export function composeWorkspaceReducer(state, action) {
  switch (action.type) {
    case 'LOAD_SUMMARIES': {
      const summaries = Array.isArray(action.summaries) ? action.summaries : [];
      const incoming = new Map(summaries.map(item => [item.id, clone(item)]));
      const existing = new Map(state.records.map(record => [record.id, record]));
      const records = [];
      for (const item of summaries) {
        const summary = clone(item);
        const record = existing.get(item.id);
        if (!record) {
          records.push({
            id: item.id,
            summary,
            snapshot: null,
            localChanges: {},
            baseRevision: Number(item.revision),
            status: 'clean',
            conflict: null,
            recoveryConflict: null,
            error: null,
            needsSnapshot: true,
            remoteMissing: false,
            remoteRevision: null,
            acknowledgedEcho: null,
            saveRequestId: null,
            saveGeneration: 0,
          });
          continue;
        }
        const revisionChanged = Number(summary.revision) !== Number(record.summary?.revision);
        records.push({
          ...record,
          summary,
          needsSnapshot: cleanRecord(record)
            ? Boolean(record.needsSnapshot || !record.snapshot || revisionChanged)
            : Boolean(record.needsSnapshot),
          remoteMissing: false,
          remoteRevision: revisionChanged ? Number(summary.revision) : record.remoteRevision,
        });
      }
      for (const record of state.records) {
        if (incoming.has(record.id) || cleanRecord(record)) continue;
        records.push({ ...record, remoteMissing: true });
      }
      const focusedSessionId = records.some(record => record.id === state.focusedSessionId)
        ? state.focusedSessionId
        : null;
      return { ...state, records, focusedSessionId };
    }

    case 'LOAD_SNAPSHOT':
      return updateRecord(state, action.sessionId, record => {
        const snapshot = clone(action.snapshot);
        const dirty = hasChanges(record);
        return {
          ...record,
          summary: { ...record.summary, ...snapshot },
          snapshot,
          baseRevision: dirty ? record.baseRevision : Number(snapshot.revision),
          status: dirty ? record.status : 'clean',
          conflict: dirty ? record.conflict : null,
          error: dirty ? record.error : null,
          needsSnapshot: false,
          remoteMissing: false,
          remoteRevision: null,
        };
      });

    case 'LOCAL_CHANGE':
      return updateRecord(state, action.sessionId, record => {
        const changes = editableChanges(action.changes);
        if (!Object.keys(changes).length) return record;
        return {
          ...record,
          localChanges: { ...clone(record.localChanges), ...changes },
          status: 'dirty',
          conflict: null,
          error: null,
        };
      });

    case 'HYDRATE_RECOVERY':
      return updateRecord(state, action.sessionId, record => ({
        ...record,
        localChanges: editableChanges(action.changes),
        baseRevision: Number(action.baseRevision),
        status: 'dirty',
        conflict: null,
        recoveryConflict: null,
        error: null,
      }));

    case 'MERGE_RECOVERY':
      return updateRecord(state, action.sessionId, record => ({
        ...record,
        localChanges: {
          ...editableChanges(action.changes),
          ...clone(record.localChanges),
        },
        baseRevision: Number(action.baseRevision),
        status: 'dirty',
        conflict: null,
        recoveryConflict: null,
        error: null,
      }));

    case 'RECOVERY_CONFLICT':
      return updateRecord(state, action.sessionId, record => ({
        ...record,
        status: 'conflict',
        recoveryConflict: clone(action.recoveryConflict),
        error: null,
      }));

    case 'RESOLVE_RECOVERY_CONFLICT':
      return updateRecord(state, action.sessionId, record => {
        const recoveryConflict = record.recoveryConflict;
        if (!recoveryConflict) return record;
        const useRecovered = action.strategy === 'recovered';
        const useRemote = action.strategy === 'remote';
        const localChanges = useRecovered
          ? editableChanges(recoveryConflict.recoveredChanges)
          : useRemote ? {} : clone(record.localChanges);
        const baseRevision = useRecovered
          ? recoveryConflict.recoveryBaseRevision
          : recoveryConflict.currentBaseRevision;
        return {
          ...record,
          localChanges,
          baseRevision: Number(baseRevision ?? record.baseRevision),
          status: Object.keys(localChanges).length ? 'dirty' : 'clean',
          conflict: null,
          recoveryConflict: null,
          error: null,
        };
      });

    case 'SAVE_START':
      return updateRecord(state, action.sessionId, record => ({
        ...record,
        status: 'saving',
        error: null,
        saveRequestId: action.requestId,
        saveGeneration: action.requestId,
      }));

    case 'SAVE_SUCCESS':
      return updateRecord(state, action.sessionId, record => {
        if (record.saveRequestId !== action.requestId) return record;
        const remaining = { ...clone(record.localChanges) };
        for (const [field, sentValue] of Object.entries(action.sentChanges || {})) {
          if (Object.hasOwn(remaining, field) && equal(remaining[field], sentValue)) {
            delete remaining[field];
          }
        }
        const savedSnapshot = clone(action.snapshot);
        const dirty = Object.keys(remaining).length > 0;
        const recoveryConflict = clone(record.recoveryConflict);
        return {
          ...record,
          summary: { ...record.summary, ...savedSnapshot },
          snapshot: savedSnapshot,
          localChanges: remaining,
          baseRevision: Number(savedSnapshot.revision),
          status: recoveryConflict ? 'conflict' : dirty ? 'dirty' : 'clean',
          conflict: null,
          recoveryConflict,
          error: null,
          needsSnapshot: false,
          remoteMissing: false,
          remoteRevision: null,
          acknowledgedEcho: {
            clientId: action.clientId,
            revision: Number(savedSnapshot.revision),
          },
          saveRequestId: null,
        };
      });

    case 'SAVE_OFFLINE':
      return updateRecord(state, action.sessionId, record => ({
        ...record,
        status: action.status || 'offline',
        error: action.error || null,
        saveRequestId: null,
      }));

    case 'SAVE_CONFLICT':
      return updateRecord(state, action.sessionId, record => ({
        ...record,
        status: 'conflict',
        conflict: clone(action.conflict),
        error: action.error || null,
        saveRequestId: null,
      }));

    case 'RESTORE_ACK':
      return updateRecord(state, action.sessionId, record => ({
        ...record,
        summary: {
          ...record.summary,
          revision: Number(action.snapshot.revision),
          lastFocusedAt: action.snapshot.lastFocusedAt ?? record.summary?.lastFocusedAt,
          updatedAt: action.snapshot.updatedAt ?? record.summary?.updatedAt,
        },
        baseRevision: Number(action.snapshot.revision),
        status: 'restoring',
        error: null,
        needsSnapshot: true,
        remoteRevision: Number(action.snapshot.revision),
      }));

    case 'REMOTE_INVALIDATION':
      return updateRecord(state, action.sessionId, record => ({
        ...record,
        needsSnapshot: cleanRecord(record)
          || record.status === 'restoring'
          || (record.status === 'error' && !hasChanges(record)),
        remoteRevision: Number(action.revision),
      }));

    case 'FOCUS':
      return state.records.some(record => record.id === action.sessionId)
        ? {
            ...state,
            records: action.focusedAt
              ? state.records.map(record => record.id === action.sessionId
                  ? { ...record, localFocusedAt: action.focusedAt }
                  : record)
              : state.records,
            focusedSessionId: action.sessionId,
          }
        : state;

    case 'REMOVE': {
      const records = state.records.filter(record => record.id !== action.sessionId);
      if (records.length === state.records.length) return state;
      const views = records.map(recordView);
      return {
        ...state,
        records,
        focusedSessionId: state.focusedSessionId === action.sessionId
          ? nextComposeFocus(views)
          : state.focusedSessionId,
      };
    }

    case 'SET_CAPACITY':
      return action.capacity === state.capacity ? state : { ...state, capacity: action.capacity };

    case 'TERMINAL_START':
      return updateRecord(state, action.sessionId, record => ({
        ...record,
        terminalPending: action.operation,
      }));

    case 'TERMINAL_END':
      return updateRecord(state, action.sessionId, record => ({
        ...record,
        terminalPending: null,
      }));

    case 'APPLY_SERVER_SNAPSHOT':
      return updateRecord(state, action.sessionId, record => {
        const nextSnapshot = clone(action.snapshot);
        return {
          ...record,
          summary: { ...record.summary, ...nextSnapshot },
          snapshot: nextSnapshot,
          baseRevision: Number(nextSnapshot.revision),
          status: hasChanges(record) ? 'dirty' : 'clean',
          conflict: null,
          error: null,
          needsSnapshot: false,
          acknowledgedEcho: action.clientId ? {
            clientId: action.clientId,
            revision: Number(nextSnapshot.revision),
          } : record.acknowledgedEcho,
        };
      });

    case 'RESOLVE_CONFLICT':
      return updateRecord(state, action.sessionId, record => {
        const resolution = serverConflictResolution(record, action.strategy, action.fields);
        const stillDirty = Object.keys(resolution.localChanges).length > 0;
        return {
          ...record,
          snapshot: resolution.snapshot,
          localChanges: resolution.localChanges,
          baseRevision: resolution.baseRevision,
          status: stillDirty ? 'dirty' : 'clean',
          conflict: null,
          error: null,
        };
      });

    default:
      return state;
  }
}

export function selectComposeSessions(state) {
  return state.records.map(recordView);
}

function structuredConflict(error) {
  if (error?.status !== 409) return null;
  const details = error.details || error.body;
  if (!details || !Array.isArray(details.conflictingFields)
      || !details.remoteValues || typeof details.remoteValues !== 'object'
      || !Number.isSafeInteger(details.currentRevision)) return null;
  return {
    conflictingFields: [...details.conflictingFields],
    remoteValues: clone(details.remoteValues),
    currentRevision: details.currentRevision,
  };
}

function recoveryConflictError() {
  return Object.assign(
    new Error('Resolve recovered compose changes before continuing'),
    {
      name: 'ComposeRecoveryConflictError',
      code: 'compose_recovery_conflict',
    },
  );
}

function networkFailure(error) {
  return error instanceof TypeError && error?.code == null;
}

function defaultClientId() {
  const opaque = globalThis.crypto?.randomUUID?.()
    || `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  return `browser_${opaque}`.slice(0, 64).replace(/[^A-Za-z0-9_-]/g, '_');
}

function publicSnapshot(state) {
  const sessions = selectComposeSessions(state);
  const visibleSessions = visibleComposeSessions(sessions, state.capacity);
  return {
    sessions,
    visibleSessions,
    chipSessions: composeChipSessions(sessions, state.capacity),
    focusedSessionId: state.focusedSessionId,
    capacity: state.capacity,
  };
}

export function createComposeWorkspaceController(options = {}) {
  let dependencies = {
    api: options.api || mailflowApi.composeSessions,
    userId: options.userId,
    clientId: options.clientId || defaultClientId(),
    recoveryStore: options.recoveryStore,
    getRecoveryStore: options.getRecoveryStore,
    setTimeout: options.setTimeout || globalThis.setTimeout.bind(globalThis),
    clearTimeout: options.clearTimeout || globalThis.clearTimeout.bind(globalThis),
    ResizeObserver: options.ResizeObserver || globalThis.ResizeObserver,
  };
  let state = initialComposeWorkspaceState();
  let snapshotCache = publicSnapshot(state);
  let destroyed = false;
  let localFocusClock = Date.now();
  let requestId = 0;
  let snapshotEpoch = 0;
  let summaryEpoch = 0;
  let minimumSummaryEpoch = 0;
  let refreshEntry = null;
  let recoveryPromise = null;
  let resizeObserver = null;
  let eventTarget = null;
  const listeners = new Set();
  const saveTimers = new Map();
  const saves = new Map();
  const snapshotLoads = new Map();
  const latestAppliedSnapshotEpochs = new Map();
  const minimumSnapshotEpochs = new Map();
  const recoveryHydrationSuppressed = new Set();
  const terminalHydrationFrozen = new Set();
  const restores = new Map();
  const queuedRestores = new Map();
  const sessionMutationTails = new Map();
  const background = new Set();

  const track = promise => {
    if (destroyed) return promise;
    background.add(promise);
    promise.finally(() => background.delete(promise)).catch(() => {});
    return promise;
  };

  const enqueueSessionMutation = (sessionId, operation) => {
    if (destroyed) return Promise.resolve(null);
    const prior = sessionMutationTails.get(sessionId);
    const execute = () => destroyed ? null : operation();
    const mutation = prior
      ? prior.then(execute, execute)
      : Promise.resolve(execute());
    const tail = mutation.then(() => undefined, () => undefined);
    sessionMutationTails.set(sessionId, tail);
    tail.finally(() => {
      if (sessionMutationTails.get(sessionId) === tail) {
        sessionMutationTails.delete(sessionId);
      }
    }).catch(() => {});
    track(mutation);
    return mutation;
  };

  const recordFor = sessionId => state.records.find(record => record.id === sessionId);
  const viewFor = sessionId => {
    const record = recordFor(sessionId);
    return record ? recordView(record) : null;
  };

  const requireResolvedRecovery = record => {
    if (record?.recoveryConflict) throw recoveryConflictError();
  };

  const snapshotEpochRetired = (sessionId, epoch) => (
    epoch < (minimumSnapshotEpochs.get(sessionId) || 0)
    || epoch < (latestAppliedSnapshotEpochs.get(sessionId) || 0)
  );

  const emit = action => {
    if (destroyed) return;
    const next = composeWorkspaceReducer(state, action);
    if (next === state) return;
    state = next;
    snapshotCache = publicSnapshot(state);
    for (const listener of listeners) listener();
    ensureVisibleSnapshots();
  };

  const emitFocus = sessionId => {
    localFocusClock = Math.max(Date.now(), localFocusClock + 1);
    emit({
      type: 'FOCUS',
      sessionId,
      focusedAt: new Date(localFocusClock).toISOString(),
    });
  };

  const recovery = async () => {
    if (destroyed) return null;
    if (dependencies.recoveryStore) return dependencies.recoveryStore;
    if (!recoveryPromise) {
      recoveryPromise = dependencies.getRecoveryStore
        ? Promise.resolve().then(() => dependencies.getRecoveryStore())
        : openRecoveryStore();
    }
    return recoveryPromise;
  };

  const clearTimer = sessionId => {
    const timer = saveTimers.get(sessionId);
    if (timer !== undefined) dependencies.clearTimeout(timer);
    saveTimers.delete(sessionId);
  };

  const writeRecovery = async (sessionId, baseRevision, changes) => {
    if (destroyed || !Object.keys(changes).length) return;
    const store = await recovery();
    if (destroyed || !store) return;
    await putRecoveryPatch(store, {
      userId: dependencies.userId,
      sessionId,
      baseRevision,
      changes,
    });
  };

  const clearRecovery = async sessionId => {
    if (destroyed) return;
    const store = await recovery();
    if (destroyed || !store) return;
    await deleteRecoveryPatch(store, dependencies.userId, sessionId);
  };

  const reconcileRecovery = async (sessionId, baseRevision, changes) => {
    if (destroyed) return;
    await clearRecovery(sessionId);
    if (destroyed) return;
    if (Object.keys(changes).length) await writeRecovery(sessionId, baseRevision, changes);
  };

  const rebaseDirtyRecovery = async sessionId => {
    if (destroyed) return;
    const record = recordFor(sessionId);
    if (!record || record.recoveryConflict || !hasChanges(record)) return;
    try {
      await reconcileRecovery(sessionId, record.baseRevision, record.localChanges);
    } catch (error) {
      applyFailure(sessionId, error);
    }
  };

  const finishAcceptedTerminal = async sessionId => {
    if (destroyed) return;
    emit({ type: 'REMOVE', sessionId });
    try {
      await clearRecovery(sessionId);
    } catch (error) {
      // The server already accepted the terminal action. Never leave a retryable
      // ghost session merely because local crash-recovery cleanup failed.
      console.error('Compose recovery cleanup failed', {
        code: typeof error?.code === 'string' ? error.code : 'unknown',
      });
    }
  };

  async function loadSnapshot(
    sessionId,
    { force = false, afterEpoch = 0, authoritative = false } = {},
  ) {
    if (destroyed) return null;
    const record = recordFor(sessionId);
    if (!record || (!force && record.snapshot && !record.needsSnapshot)) return viewFor(sessionId);
    const existing = snapshotLoads.get(sessionId);
    // Terminal intent owns the session from click time onward. Reuse hydration
    // already in flight, but never start a new read that could outlive removal.
    if (terminalHydrationFrozen.has(sessionId)) return existing?.promise || viewFor(sessionId);
    if (authoritative
        && record.snapshot
        && !record.needsSnapshot
        && (latestAppliedSnapshotEpochs.get(sessionId) || 0) > afterEpoch) {
      return viewFor(sessionId);
    }
    if (existing
        && existing.epoch > afterEpoch
        && !snapshotEpochRetired(sessionId, existing.epoch)) {
      if (authoritative) {
        minimumSnapshotEpochs.set(
          sessionId,
          Math.max(minimumSnapshotEpochs.get(sessionId) || 0, existing.epoch),
        );
      }
      return existing.promise;
    }
    const epoch = ++snapshotEpoch;
    if (authoritative) {
      minimumSnapshotEpochs.set(
        sessionId,
        Math.max(minimumSnapshotEpochs.get(sessionId) || 0, epoch),
      );
    }
    const entry = { epoch, promise: null, recoveryError: null };
    entry.promise = dependencies.api.get(sessionId)
      .then(async snapshot => {
        if (destroyed) return viewFor(sessionId);
        if (snapshotEpochRetired(sessionId, epoch)) return viewFor(sessionId);
        emit({ type: 'LOAD_SNAPSHOT', sessionId, snapshot });
        latestAppliedSnapshotEpochs.set(sessionId, epoch);
        const hydrationStart = recordFor(sessionId);
        if (hydrationStart && !recoveryHydrationSuppressed.has(sessionId)) {
          try {
            const store = await recovery();
            if (destroyed || !store) return viewFor(sessionId);
            const recovered = await getRecoveryPatch(
              store,
              dependencies.userId,
              sessionId,
            );
            if (destroyed) return viewFor(sessionId);
            if (snapshotEpochRetired(sessionId, epoch)) return viewFor(sessionId);
            if (recovered && Object.keys(recovered.changes || {}).length) {
              const live = recordFor(sessionId);
              if (!live) return null;
              const changedWhileReading = hasChanges(live);
              const requestChanged = live.saveRequestId !== hydrationStart.saveRequestId
                || live.saveGeneration !== hydrationStart.saveGeneration;
              if (!changedWhileReading && !requestChanged) {
                emit({
                  type: 'HYDRATE_RECOVERY',
                  sessionId,
                  baseRevision: recovered.baseRevision,
                  changes: recovered.changes,
                });
                scheduleSave(sessionId);
              } else if (!requestChanged
                  && Number(recovered.baseRevision) === Number(live.baseRevision)) {
                emit({
                  type: 'MERGE_RECOVERY',
                  sessionId,
                  baseRevision: recovered.baseRevision,
                  changes: recovered.changes,
                });
                scheduleSave(sessionId);
              } else {
                clearTimer(sessionId);
                emit({
                  type: 'RECOVERY_CONFLICT',
                  sessionId,
                  recoveryConflict: {
                    recoveryBaseRevision: Number(recovered.baseRevision),
                    currentBaseRevision: Number(live.baseRevision),
                    recoveredChanges: editableChanges(recovered.changes),
                  },
                });
              }
            }
          } catch (error) {
            if (destroyed) return viewFor(sessionId);
            entry.recoveryError = error;
            // Server state remains authoritative when the optional local crash aid
            // is unavailable. Avoid making a clean snapshot sticky/non-convergent.
            console.error('Compose recovery read failed', {
              code: typeof error?.code === 'string' ? error.code : 'unknown',
            });
          }
        }
        return viewFor(sessionId);
      })
      .finally(() => {
        if (snapshotLoads.get(sessionId) === entry) snapshotLoads.delete(sessionId);
      });
    snapshotLoads.set(sessionId, entry);
    track(entry.promise);
    return entry.promise;
  }

  function ensureVisibleSnapshots() {
    if (destroyed) return;
    for (const session of snapshotCache.visibleSessions) {
      const record = recordFor(session.id);
      if (record && (!record.snapshot || record.needsSnapshot)) {
        loadSnapshot(session.id).catch(() => {});
      }
    }
  }

  async function refreshSummaries({ afterEpoch = 0, authoritative = false } = {}) {
    if (destroyed) return snapshotCache.sessions;
    const existing = refreshEntry;
    if (existing && existing.epoch > afterEpoch) return existing.promise;
    if (authoritative) {
      minimumSummaryEpoch = Math.max(minimumSummaryEpoch, afterEpoch + 1);
    }
    if (existing) {
      try {
        await existing.promise;
      } catch (error) {
        if (!authoritative) throw error;
      }
      if (destroyed) return snapshotCache.sessions;
      if (refreshEntry && refreshEntry.epoch > afterEpoch) return refreshEntry.promise;
    }
    const epoch = ++summaryEpoch;
    if (authoritative) minimumSummaryEpoch = Math.max(minimumSummaryEpoch, epoch);
    const entry = { epoch, promise: null };
    entry.promise = dependencies.api.list()
      .then(summaries => {
        if (destroyed) return snapshotCache.sessions;
        if (epoch < minimumSummaryEpoch) return snapshotCache.sessions;
        emit({ type: 'LOAD_SUMMARIES', summaries });
        return snapshotCache.sessions;
      })
      .finally(() => {
        if (refreshEntry === entry) refreshEntry = null;
      });
    refreshEntry = entry;
    track(entry.promise);
    return entry.promise;
  }

  function scheduleSave(sessionId) {
    if (destroyed) return;
    clearTimer(sessionId);
    const timer = dependencies.setTimeout(() => {
      saveTimers.delete(sessionId);
      if (destroyed) return undefined;
      return flushSession(sessionId).catch(() => {});
    }, SAVE_DELAY_MS);
    saveTimers.set(sessionId, timer);
  }

  function changeSession(sessionId, changes) {
    if (destroyed) return null;
    if (recordFor(sessionId)?.terminalPending) return viewFor(sessionId);
    const filtered = editableChanges(changes);
    if (!recordFor(sessionId) || !Object.keys(filtered).length) return viewFor(sessionId);
    emit({ type: 'LOCAL_CHANGE', sessionId, changes: filtered });
    scheduleSave(sessionId);
    return viewFor(sessionId);
  }

  function applyFailure(sessionId, error) {
    if (error?.code === 'compose_recovery_conflict') return;
    const conflict = structuredConflict(error);
    if (conflict) {
      emit({ type: 'SAVE_CONFLICT', sessionId, conflict, error });
    } else {
      emit({
        type: 'SAVE_OFFLINE',
        sessionId,
        error,
        status: networkFailure(error) ? 'offline' : 'error',
      });
    }
  }

  async function flushSessionRaw(sessionId) {
    if (destroyed) return null;
    requireResolvedRecovery(recordFor(sessionId));
    if (saves.has(sessionId)) return saves.get(sessionId);
    const record = recordFor(sessionId);
    requireResolvedRecovery(record);
    if (!record || !hasChanges(record)) return viewFor(sessionId);
    clearTimer(sessionId);
    const baseRevision = record.baseRevision;
    const changes = clone(record.localChanges);
    const currentRequestId = ++requestId;
    const promise = (async () => {
      try {
        await writeRecovery(sessionId, baseRevision, changes);
        if (destroyed) return null;
        emit({ type: 'SAVE_START', sessionId, requestId: currentRequestId });
        const saved = await dependencies.api.patch(
          sessionId,
          baseRevision,
          changes,
          dependencies.clientId,
        );
        if (destroyed) return null;
        emit({
          type: 'SAVE_SUCCESS',
          sessionId,
          requestId: currentRequestId,
          baseRevision,
          sentChanges: changes,
          snapshot: saved,
          clientId: dependencies.clientId,
        });
        const after = recordFor(sessionId);
        if (after) {
          if (after.recoveryConflict) return viewFor(sessionId);
          await reconcileRecovery(sessionId, after.baseRevision, after.localChanges);
          if (destroyed) return null;
          if (hasChanges(after)) scheduleSave(sessionId);
        }
        return viewFor(sessionId);
      } catch (error) {
        if (destroyed) return null;
        applyFailure(sessionId, error);
        throw error;
      }
    })().finally(() => saves.delete(sessionId));
    saves.set(sessionId, promise);
    track(promise);
    return promise;
  }

  function flushSession(sessionId) {
    return enqueueSessionMutation(sessionId, () => flushSessionRaw(sessionId));
  }

  function saveSession(sessionId, changes) {
    changeSession(sessionId, changes);
    return flushSession(sessionId);
  }

  async function createSession(input = {}) {
    if (destroyed) return null;
    const {
      requestedSlot,
      replyAllRecipients: explicitReplyAllRecipients,
      allRecipients: legacyReplyAllRecipients,
      ...rawChanges
    } = input || {};
    const replyAllRecipients = (explicitReplyAllRecipients ?? legacyReplyAllRecipients ?? [])
      .map(legacyRecipient)
      .filter(Boolean);
    const created = await dependencies.api.create({
      ...(requestedSlot == null ? {} : { requestedSlot }),
      ...(replyAllRecipients.length ? { replyAllRecipients } : {}),
      changes: normalizedCreateChanges(rawChanges),
      clientId: dependencies.clientId,
    });
    if (destroyed) return null;
    emit({
      type: 'LOAD_SUMMARIES',
      summaries: [
        ...state.records.filter(record => record.id !== created.id).map(record => record.summary),
        created,
      ],
    });
    emit({ type: 'LOAD_SNAPSHOT', sessionId: created.id, snapshot: created });
    emitFocus(created.id);
    return viewFor(created.id);
  }

  async function claimDraft(input) {
    if (destroyed) return null;
    const claimed = await dependencies.api.claimDraft(input);
    if (destroyed) return null;
    emit({
      type: 'LOAD_SUMMARIES',
      summaries: [
        ...state.records.filter(record => record.id !== claimed.id).map(record => record.summary),
        claimed,
      ],
    });
    emit({ type: 'LOAD_SNAPSHOT', sessionId: claimed.id, snapshot: claimed });
    emitFocus(claimed.id);
    return viewFor(claimed.id);
  }

  function focusSession(sessionId, { persist = true } = {}) {
    if (destroyed) return null;
    const session = viewFor(sessionId);
    if (!session) return null;
    emitFocus(sessionId);
    if (persist && session.presentationState === 'minimized') {
      return restoreSession(sessionId);
    }
    return viewFor(sessionId);
  }

  async function flushDirtyGenerations(sessionId) {
    clearTimer(sessionId);
    while (!destroyed) {
      const record = recordFor(sessionId);
      requireResolvedRecovery(record);
      if (!record || !hasChanges(record)) return viewFor(sessionId);
      await flushSessionRaw(sessionId);
      if (destroyed) return null;
      clearTimer(sessionId);
    }
    return null;
  }

  async function minimizeSessionRaw(sessionId) {
    if (destroyed) return null;
    try {
      await flushDirtyGenerations(sessionId);
      if (destroyed) return null;
      const session = viewFor(sessionId);
      if (!session) return null;
      const updated = await dependencies.api.presentation(
        sessionId,
        session.baseRevision,
        'minimized',
        dependencies.clientId,
      );
      if (destroyed) return null;
      emit({
        type: 'APPLY_SERVER_SNAPSHOT',
        sessionId,
        snapshot: { ...(session.snapshot || session.summary), ...updated },
        clientId: dependencies.clientId,
      });
      await rebaseDirtyRecovery(sessionId);
      if (destroyed) return null;
      clearTimer(sessionId);
      if (state.focusedSessionId === sessionId) {
        const remaining = selectComposeSessions(state)
          .map(item => item.id === sessionId ? { ...item, presentationState: 'minimized' } : item);
        const next = nextComposeFocus(remaining);
        state = { ...state, focusedSessionId: next };
        snapshotCache = publicSnapshot(state);
        for (const listener of listeners) listener();
      }
      return viewFor(sessionId);
    } catch (error) {
      if (destroyed) return null;
      applyFailure(sessionId, error);
      throw error;
    }
  }

  function minimizeSession(sessionId) {
    return enqueueSessionMutation(sessionId, () => minimizeSessionRaw(sessionId));
  }

  async function restoreSessionRaw(sessionId) {
    if (destroyed) return Promise.resolve(null);
    try {
      await flushDirtyGenerations(sessionId);
      if (destroyed) return null;
      const session = viewFor(sessionId);
      if (!session) return null;
      const updated = await dependencies.api.presentation(
        sessionId,
        session.baseRevision,
        'expanded',
        dependencies.clientId,
      );
      if (destroyed) return null;
      const snapshotBoundary = snapshotEpoch;
      emit({ type: 'RESTORE_ACK', sessionId, snapshot: updated });
      await loadSnapshot(sessionId, {
        force: true,
        afterEpoch: snapshotBoundary,
        authoritative: true,
      });
      if (destroyed) return null;
      emitFocus(sessionId);
      return viewFor(sessionId);
    } catch (error) {
      if (destroyed) return null;
      applyFailure(sessionId, error);
      throw error;
    }
  }

  function restoreSession(sessionId) {
    if (destroyed) return Promise.resolve(null);
    if (restores.has(sessionId)) return restores.get(sessionId);
    const restoring = enqueueSessionMutation(
      sessionId,
      () => restoreSessionRaw(sessionId),
    );
    const tracked = restoring.finally(() => {
      if (restores.get(sessionId) === tracked) restores.delete(sessionId);
    });
    restores.set(sessionId, tracked);
    track(tracked);
    return tracked;
  }

  async function awaitTerminalHydration(sessionId, hydrationEntry) {
    if (!hydrationEntry) return;
    await hydrationEntry.promise;
    if (destroyed) return;
    if (hydrationEntry.recoveryError) throw hydrationEntry.recoveryError;
    requireResolvedRecovery(recordFor(sessionId));
  }

  async function closeSessionRaw(sessionId, hydrationEntry) {
    if (destroyed) return null;
    try {
      await awaitTerminalHydration(sessionId, hydrationEntry);
      if (destroyed) return null;
      const existingSave = saves.get(sessionId);
      if (existingSave) await existingSave;
      if (destroyed) return null;
      const record = recordFor(sessionId);
      if (!record) return null;
      requireResolvedRecovery(record);
      clearTimer(sessionId);
      const changes = editableChanges(record.localChanges);
      const baseRevision = record.baseRevision;
      const terminalRequestId = ++requestId;
      if (Object.keys(changes).length) await writeRecovery(sessionId, baseRevision, changes);
      if (destroyed) return null;
      emit({ type: 'SAVE_START', sessionId, requestId: terminalRequestId });
      const result = await dependencies.api.close(sessionId, baseRevision, changes);
      if (destroyed) return result;
      await finishAcceptedTerminal(sessionId);
      return result;
    } catch (error) {
      if (destroyed) return null;
      applyFailure(sessionId, error);
      throw error;
    }
  }

  function terminalMutation(sessionId, operation, mutation) {
    if (destroyed) return Promise.resolve(null);
    const record = recordFor(sessionId);
    if (!record) return Promise.resolve(null);
    if (record.terminalPending) {
      return Promise.reject(Object.assign(new Error('Compose terminal operation is pending'), {
        code: 'compose_terminal_pending',
      }));
    }
    emit({ type: 'TERMINAL_START', sessionId, operation });
    const hydrationEntry = snapshotLoads.get(sessionId) || null;
    terminalHydrationFrozen.add(sessionId);
    return enqueueSessionMutation(sessionId, () => mutation(hydrationEntry)).then(
      result => {
        terminalHydrationFrozen.delete(sessionId);
        if (!destroyed && recordFor(sessionId)) {
          emit({ type: 'TERMINAL_END', sessionId });
        }
        return result;
      },
      error => {
        terminalHydrationFrozen.delete(sessionId);
        if (!destroyed && recordFor(sessionId)) {
          emit({ type: 'TERMINAL_END', sessionId });
        }
        throw error;
      },
    );
  }

  function closeSession(sessionId) {
    return terminalMutation(
      sessionId,
      'close',
      hydrationEntry => closeSessionRaw(sessionId, hydrationEntry),
    );
  }

  async function flushedTerminal(sessionId, hydrationEntry, operation) {
    if (destroyed) return null;
    await awaitTerminalHydration(sessionId, hydrationEntry);
    if (destroyed) return null;
    await flushDirtyGenerations(sessionId);
    if (destroyed) return null;
    requireResolvedRecovery(recordFor(sessionId));
    const session = viewFor(sessionId);
    if (!session) return null;
    const result = await operation(session);
    if (destroyed) return result;
    await finishAcceptedTerminal(sessionId);
    return result;
  }

  function discardSession(sessionId) {
    return terminalMutation(
      sessionId,
      'discard',
      hydrationEntry => flushedTerminal(sessionId, hydrationEntry, session => (
        dependencies.api.discard(sessionId, session.baseRevision)
      )),
    ).catch(error => {
      if (destroyed) return null;
      applyFailure(sessionId, error);
      throw error;
    });
  }

  function sendSession(sessionId, options = {}) {
    return terminalMutation(
      sessionId,
      'send',
      hydrationEntry => flushedTerminal(sessionId, hydrationEntry, session => {
        const { idempotencyKey, ...data } = options || {};
        const headers = idempotencyKey ? { 'X-Idempotency-Key': idempotencyKey } : {};
        return dependencies.api.send(sessionId, session.baseRevision, data, headers);
      }),
    ).catch(error => {
      if (destroyed) return null;
      applyFailure(sessionId, error);
      throw error;
    });
  }

  async function undoQueuedSendRaw(outboxId) {
    if (destroyed) return null;
    const result = await dependencies.api.restoreQueuedSend(outboxId);
    if (destroyed) return result;
    if (!result?.restored || !result.session?.id) return result;
    const summaryBoundary = summaryEpoch;
    const snapshotBoundary = snapshotEpoch;
    // Retire pre-restore summaries immediately, before optional local cleanup
    // yields and lets an older response publish obsolete session identities.
    minimumSummaryEpoch = Math.max(minimumSummaryEpoch, summaryBoundary + 1);
    // The restored row deliberately reuses the original session UUID. A rare
    // failed cleanup from the accepted terminal action must never overlay that
    // new authoritative generation, now or through a concurrent summary GET.
    recoveryHydrationSuppressed.add(result.session.id);
    try {
      await clearRecovery(result.session.id);
    } catch (error) {
      console.error('Compose restored recovery cleanup failed', {
        code: typeof error?.code === 'string' ? error.code : 'unknown',
      });
    }
    if (destroyed) return result;
    await refreshSummaries({
      afterEpoch: summaryBoundary,
      authoritative: true,
    });
    if (destroyed) return result;
    await loadSnapshot(result.session.id, {
      force: true,
      afterEpoch: snapshotBoundary,
      authoritative: true,
    });
    if (destroyed) return result;
    emitFocus(result.session.id);
    return { ...result, session: viewFor(result.session.id) };
  }

  function undoQueuedSend(outboxId) {
    if (destroyed) return Promise.resolve(null);
    if (queuedRestores.has(outboxId)) return queuedRestores.get(outboxId);
    const restoring = undoQueuedSendRaw(outboxId);
    const tracked = restoring.finally(() => {
      if (queuedRestores.get(outboxId) === tracked) queuedRestores.delete(outboxId);
    });
    queuedRestores.set(outboxId, tracked);
    track(tracked);
    return tracked;
  }

  async function addAttachmentRaw(sessionId, file) {
    if (destroyed) return null;
    const session = viewFor(sessionId);
    if (!session) return null;
    try {
      const result = await dependencies.api.uploadAttachment(
        sessionId,
        session.baseRevision,
        file,
        dependencies.clientId,
      );
      if (destroyed) return result;
      const current = viewFor(sessionId);
      const attachments = [...(current.attachments || []), clone(result.attachment)];
      emit({
        type: 'APPLY_SERVER_SNAPSHOT',
        sessionId,
        snapshot: { ...(current.snapshot || current.summary), attachments, revision: result.revision },
        clientId: dependencies.clientId,
      });
      await rebaseDirtyRecovery(sessionId);
      if (destroyed) return result;
      return result;
    } catch (error) {
      if (destroyed) return null;
      applyFailure(sessionId, error);
      throw error;
    }
  }

  function addAttachment(sessionId, file) {
    return enqueueSessionMutation(sessionId, () => addAttachmentRaw(sessionId, file));
  }

  async function removeAttachmentRaw(sessionId, attachmentId) {
    if (destroyed) return null;
    const session = viewFor(sessionId);
    if (!session) return null;
    try {
      const result = await dependencies.api.removeAttachment(
        sessionId,
        attachmentId,
        session.baseRevision,
      );
      if (destroyed) return result;
      const current = viewFor(sessionId);
      const attachments = (current.attachments || [])
        .filter(attachment => attachment.id !== result.removedAttachmentId);
      emit({
        type: 'APPLY_SERVER_SNAPSHOT',
        sessionId,
        snapshot: { ...(current.snapshot || current.summary), attachments, revision: result.revision },
      });
      await rebaseDirtyRecovery(sessionId);
      if (destroyed) return result;
      return result;
    } catch (error) {
      if (destroyed) return null;
      applyFailure(sessionId, error);
      throw error;
    }
  }

  function removeAttachment(sessionId, attachmentId) {
    return enqueueSessionMutation(
      sessionId,
      () => removeAttachmentRaw(sessionId, attachmentId),
    );
  }

  async function resolveRecoveryConflict(sessionId, strategy) {
    const record = recordFor(sessionId);
    if (!record?.recoveryConflict) return viewFor(sessionId);
    if (!['mine', 'recovered', 'remote'].includes(strategy)) {
      throw new TypeError(`Unsupported recovery conflict strategy: ${strategy}`);
    }
    const recoveryConflict = clone(record.recoveryConflict);
    const changes = strategy === 'recovered'
      ? editableChanges(recoveryConflict.recoveredChanges)
      : strategy === 'remote' ? {} : clone(record.localChanges);
    const baseRevision = strategy === 'recovered'
      ? recoveryConflict.recoveryBaseRevision
      : recoveryConflict.currentBaseRevision;
    await reconcileRecovery(sessionId, baseRevision, changes);
    if (destroyed) return null;
    emit({ type: 'RESOLVE_RECOVERY_CONFLICT', sessionId, strategy });
    const session = viewFor(sessionId);
    if (session?.status === 'dirty') scheduleSave(sessionId);
    return session;
  }

  async function resolveServerConflict(sessionId, strategy, fields) {
    const record = recordFor(sessionId);
    if (!record?.conflict) return viewFor(sessionId);
    if (!['mine', 'remote'].includes(strategy)) {
      throw new TypeError(`Unsupported server conflict strategy: ${strategy}`);
    }
    const resolution = serverConflictResolution(record, strategy, fields);
    await reconcileRecovery(
      sessionId,
      resolution.baseRevision,
      resolution.localChanges,
    );
    if (destroyed) return null;
    emit({ type: 'RESOLVE_CONFLICT', sessionId, strategy, fields });
    const session = viewFor(sessionId);
    if (session?.status === 'dirty') scheduleSave(sessionId);
    return session;
  }

  function resolveConflict(sessionId, { strategy = 'mine', fields } = {}) {
    if (destroyed) return null;
    if (recordFor(sessionId)?.recoveryConflict) {
      return resolveRecoveryConflict(sessionId, strategy);
    }
    return resolveServerConflict(sessionId, strategy, fields);
  }

  async function handleInvalidation(event) {
    if (destroyed) return;
    const detail = event?.detail;
    if (!detail || typeof detail.sessionId !== 'string') return;
    const record = recordFor(detail.sessionId);
    if (record?.acknowledgedEcho
        && detail.clientId === record.acknowledgedEcho.clientId
        && Number(detail.revision) === record.acknowledgedEcho.revision) return;
    const wasClean = record ? cleanRecord(record) : false;
    const wasVisible = snapshotCache.visibleSessions.some(item => item.id === detail.sessionId);
    const summaryBoundary = summaryEpoch;
    const snapshotBoundary = snapshotEpoch;
    const ownsSnapshotConvergence = wasClean
      && !terminalHydrationFrozen.has(detail.sessionId);
    // RESTORE_ACK already started an authoritative post-presentation GET. Its
    // exact own echo describes that same boundary rather than superseding it.
    const preservesRestoreRead = record?.status === 'restoring'
      && detail.clientId === dependencies.clientId
      && Number(detail.revision) === Number(record.remoteRevision);
    // An invalidation is a read barrier: requests begun before it cannot prove
    // convergence, even if they happen to resolve after the event arrives.
    minimumSummaryEpoch = Math.max(minimumSummaryEpoch, summaryBoundary + 1);
    if (!preservesRestoreRead) {
      minimumSnapshotEpochs.set(
        detail.sessionId,
        Math.max(minimumSnapshotEpochs.get(detail.sessionId) || 0, snapshotBoundary + 1),
      );
    }
    emit({
      type: 'REMOTE_INVALIDATION',
      sessionId: detail.sessionId,
      revision: detail.revision,
    });
    const summaryConvergence = refreshSummaries({
      afterEpoch: summaryBoundary,
      authoritative: true,
    }).then(() => true, () => false);
    const convergence = summaryConvergence.then(async refreshed => {
      if (!refreshed || destroyed || !ownsSnapshotConvergence) return;
      const refreshedRecord = recordFor(detail.sessionId);
      if (!refreshedRecord
          || !cleanRecord(refreshedRecord)
          || terminalHydrationFrozen.has(detail.sessionId)) return;
      const isVisibleFromSummary = visibleComposeSessions(
        state.records.map(summaryVisibilityView),
        state.capacity,
      ).some(item => item.id === detail.sessionId);
      if (wasVisible || isVisibleFromSummary) {
        await loadSnapshot(detail.sessionId, {
          force: true,
          afterEpoch: snapshotBoundary,
          authoritative: true,
        }).catch(() => null);
      }
    });
    track(convergence);
    await convergence;
  }

  function setCapacity(widthOrCapacity) {
    if (destroyed) return Promise.resolve(snapshotCache);
    const capacity = Number.isInteger(widthOrCapacity) && widthOrCapacity >= 1 && widthOrCapacity <= 3
      ? widthOrCapacity
      : capacityForDockWidth(widthOrCapacity);
    if (capacity === state.capacity) return Promise.resolve(snapshotCache);
    const sessions = selectComposeSessions(state);
    const nextVisibleIds = new Set(
      visibleComposeSessions(sessions, capacity).map(session => session.id),
    );
    const leavingDirty = snapshotCache.visibleSessions
      .map(session => recordFor(session.id))
      .filter(record => record && hasChanges(record) && !nextVisibleIds.has(record.id));
    if (!leavingDirty.length) {
      emit({ type: 'SET_CAPACITY', capacity });
      return Promise.resolve(snapshotCache);
    }
    const persistence = Promise.all(leavingDirty.map(record => (
      writeRecovery(record.id, record.baseRevision, record.localChanges)
    ))).then(() => {
      if (destroyed) return snapshotCache;
      emit({ type: 'SET_CAPACITY', capacity });
      return snapshotCache;
    }).catch(error => {
      if (destroyed) return snapshotCache;
      for (const record of leavingDirty) applyFailure(record.id, error);
      throw error;
    });
    track(persistence);
    return persistence;
  }

  function observeWorkspace(element) {
    if (destroyed) return;
    resizeObserver?.disconnect();
    resizeObserver = null;
    if (!element) return;
    setCapacity(element.getBoundingClientRect?.().width ?? 0).catch(() => {});
    if (typeof dependencies.ResizeObserver === 'function') {
      resizeObserver = new dependencies.ResizeObserver(entries => {
        const width = entries?.[0]?.contentRect?.width
          ?? element.getBoundingClientRect?.().width
          ?? 0;
        setCapacity(width).catch(() => {});
      });
      resizeObserver.observe(element);
    }
  }

  async function start({ eventTarget: target = globalThis.window, workspaceElement } = {}) {
    if (destroyed) throw new Error('Compose workspace controller is destroyed');
    if (target && target !== eventTarget) {
      eventTarget?.removeEventListener(
        'mailflow:compose-session-updated',
        handleInvalidation,
      );
      eventTarget = target;
      eventTarget.addEventListener('mailflow:compose-session-updated', handleInvalidation);
    }
    observeWorkspace(workspaceElement);
    return refreshSummaries();
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    for (const sessionId of saveTimers.keys()) clearTimer(sessionId);
    eventTarget?.removeEventListener('mailflow:compose-session-updated', handleInvalidation);
    eventTarget = null;
    resizeObserver?.disconnect();
    resizeObserver = null;
    listeners.clear();
  }

  async function whenIdle() {
    while (background.size) await Promise.allSettled([...background]);
  }

  const controller = {
    getSnapshot: () => snapshotCache,
    subscribe(listener) {
      if (destroyed) return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start,
    destroy,
    whenIdle,
    refreshSummaries,
    loadSnapshot,
    setCapacity,
    observeWorkspace,
    createSession,
    claimDraft,
    changeSession,
    flushSession,
    saveSession,
    focusSession,
    minimizeSession,
    restoreSession,
    closeSession,
    discardSession,
    sendSession,
    undoQueuedSend,
    addAttachment,
    removeAttachment,
    resolveConflict,
    replaceDependencies(next) {
      if (destroyed) return;
      dependencies = { ...dependencies, ...next };
    },
  };
  Object.defineProperties(controller, {
    dependencies: { get: () => dependencies },
    sessions: { get: () => snapshotCache.sessions },
    focusedSessionId: { get: () => snapshotCache.focusedSessionId },
  });
  return controller;
}

export function useComposeWorkspace(options = {}) {
  const authenticatedUserId = useStore(state => state.user?.id ?? null);
  const userId = options.userId ?? authenticatedUserId;
  const controller = useMemo(() => createComposeWorkspaceController({
    api: options.api || mailflowApi.composeSessions,
    userId,
    clientId: options.clientId,
    recoveryStore: options.recoveryStore,
    getRecoveryStore: options.getRecoveryStore,
    setTimeout: options.setTimeout,
    clearTimeout: options.clearTimeout,
    ResizeObserver: options.ResizeObserver,
  }), [
    options.api,
    options.clearTimeout,
    options.clientId,
    options.getRecoveryStore,
    options.recoveryStore,
    options.ResizeObserver,
    options.setTimeout,
    userId,
  ]);
  const workspace = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );

  useEffect(() => {
    if (!userId || options.enabled === false) return undefined;
    const store = useStore.getState();
    store.setComposeWorkspaceController(controller);
    const workspaceElement = options.workspaceElement
      || globalThis.document?.querySelector?.('[data-mail-workspace]');
    controller.start({ eventTarget: options.eventTarget || globalThis.window, workspaceElement })
      .catch(() => {});
    return () => {
      controller.destroy();
      useStore.getState().clearComposeWorkspaceController(controller);
    };
  }, [controller, options.enabled, options.eventTarget, options.workspaceElement, userId]);

  useEffect(() => {
    useStore.getState().setFocusedComposeSessionId(workspace.focusedSessionId);
  }, [workspace.focusedSessionId]);

  return useMemo(() => ({
    ...workspace,
    createSession: controller.createSession,
    claimDraft: controller.claimDraft,
    changeSession: controller.changeSession,
    flushSession: controller.flushSession,
    saveSession: controller.saveSession,
    focusSession: controller.focusSession,
    minimizeSession: controller.minimizeSession,
    restoreSession: controller.restoreSession,
    closeSession: controller.closeSession,
    discardSession: controller.discardSession,
    sendSession: controller.sendSession,
    undoQueuedSend: controller.undoQueuedSend,
    addAttachment: controller.addAttachment,
    removeAttachment: controller.removeAttachment,
    resolveConflict: controller.resolveConflict,
  }), [controller, workspace]);
}
