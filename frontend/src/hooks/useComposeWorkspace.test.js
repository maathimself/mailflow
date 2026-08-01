import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.json')) {
      return {
        format: 'module',
        source: `export default ${readFileSync(new URL(url), 'utf8')}`,
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});

globalThis.localStorage = (() => {
  let values = { mailflow_theme: 'dark' };
  return {
    getItem: key => values[key] ?? null,
    setItem: (key, value) => { values[key] = String(value); },
    removeItem: key => { delete values[key]; },
    clear: () => { values = {}; },
  };
})();

const {
  composeWorkspaceReducer,
  createComposeWorkspaceController,
  initialComposeWorkspaceState,
  selectComposeSessions,
} = await import('./useComposeWorkspace.js');
const { useStore } = await import('../store/index.js');
const { createCommandController } = await import('../commands/controller.js');
const { createCommandRegistry } = await import('../commands/registry.js');
const {
  composeSessionCommandDefinitions,
  createComposeSessionCommandExecutors,
} = await import('../commands/composeSessionCommands.js');

const SESSION_A = '11111111-1111-4111-8111-111111111111';
const SESSION_B = '22222222-2222-4222-8222-222222222222';
const USER_ID = 'synthetic-user';

const summary = (overrides = {}) => ({
  id: SESSION_A,
  slot: 1,
  subject: 'Synthetic subject',
  presentationState: 'expanded',
  operationState: 'idle',
  revision: 3,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastFocusedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

const snapshot = (overrides = {}) => ({
  ...summary(),
  to: [], cc: [], bcc: [], body: 'Synthetic body', attachments: [],
  ...overrides,
});

function reduce(actions) {
  return actions.reduce(composeWorkspaceReducer, initialComposeWorkspaceState());
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function composeConflict({
  fields = ['subject'],
  remoteValues = { subject: 'Remote subject' },
  currentRevision = 4,
} = {}) {
  return Object.assign(new Error('compose conflict'), {
    status: 409,
    details: {
      code: 'compose_conflict',
      conflictingFields: fields,
      remoteValues,
      currentRevision,
    },
  });
}

async function until(predicate) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  assert.ok(predicate(), 'condition did not become true');
}

function recoveryAdapter() {
  const records = new Map();
  const calls = [];
  return {
    records,
    calls,
    async get(key) { return structuredClone(records.get(key)); },
    async put(record) {
      calls.push(['put', record.sessionId, record.baseRevision, structuredClone(record.changes)]);
      records.set(record.key, structuredClone(record));
    },
    async delete(key) {
      calls.push(['delete', key]);
      records.delete(key);
    },
  };
}

function fakeTimers() {
  let nextId = 1;
  const pending = new Map();
  return {
    pending,
    setTimeout(fn, delay) {
      const id = nextId++;
      pending.set(id, { fn, delay });
      return id;
    },
    clearTimeout(id) { pending.delete(id); },
    async run(id) {
      const timer = pending.get(id);
      assert.ok(timer, `missing timer ${id}`);
      pending.delete(id);
      await timer.fn();
    },
  };
}

function fakeEventTarget() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
    dispatch(type, detail) { listeners.get(type)?.({ detail }); },
  };
}

function controllerHarness(overrides = {}) {
  const adapter = recoveryAdapter();
  const timers = fakeTimers();
  const calls = [];
  const snapshots = new Map([[SESSION_A, snapshot()]]);
  const api = {
    list: async () => [summary()],
    get: async id => structuredClone(snapshots.get(id)),
    create: async data => ({ ...snapshot(), ...data.changes, revision: 1 }),
    claimDraft: async () => snapshot({ revision: 1 }),
    patch: async (id, revision, changes, clientId) => {
      calls.push(['patch', id, revision, structuredClone(changes), clientId]);
      return snapshot({ ...changes, revision: revision + 1 });
    },
    presentation: async (id, revision, state, clientId) => {
      calls.push(['presentation', id, revision, state, clientId]);
      return snapshot({ presentationState: state, revision: revision + 1 });
    },
    close: async (id, revision, changes) => {
      calls.push(['close', id, revision, structuredClone(changes)]);
      return { closed: true, slot: 1 };
    },
    discard: async (id, revision) => {
      calls.push(['discard', id, revision]);
      return { discarded: true, slot: 1 };
    },
    send: async (id, revision, data, headers) => {
      calls.push(['send', id, revision, data, headers]);
      return { ok: true };
    },
    uploadAttachment: async (id, revision, file, clientId) => ({
      sessionId: id,
      revision: revision + 1,
      attachment: { id: 'attachment-a', filename: file.name, byteCount: file.size },
      clientId,
    }),
    removeAttachment: async (id, attachmentId, revision) => ({
      sessionId: id, revision: revision + 1, removedAttachmentId: attachmentId,
    }),
    ...overrides.api,
  };
  const controller = createComposeWorkspaceController({
    api,
    userId: USER_ID,
    clientId: 'browser-synthetic',
    recoveryStore: adapter,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    ...overrides.dependencies,
  });
  return { controller, adapter, timers, calls, api, snapshots };
}

async function recoveryConflictHarness() {
  const recoveryRead = deferred();
  const recoveryStarted = deferred();
  const memory = recoveryAdapter();
  let firstRead = true;
  const adapter = {
    ...memory,
    async get(key) {
      if (firstRead) {
        firstRead = false;
        recoveryStarted.resolve();
        return recoveryRead.promise;
      }
      return memory.get(key);
    },
  };
  const harness = controllerHarness({ dependencies: { recoveryStore: adapter } });
  await harness.controller.refreshSummaries();
  const loading = harness.controller.loadSnapshot(SESSION_A);
  await recoveryStarted.promise;
  harness.controller.changeSession(SESSION_A, { subject: 'Newer local subject' });
  const stale = {
    key: `${USER_ID}:${SESSION_A}`,
    userId: USER_ID,
    sessionId: SESSION_A,
    baseRevision: 2,
    changes: { subject: 'Recovered subject', body: 'Recovered body' },
    updatedAt: Date.now(),
  };
  memory.records.set(stale.key, structuredClone(stale));
  recoveryRead.resolve(stale);
  await loading;
  await harness.controller.whenIdle();
  assert.equal(harness.controller.getSnapshot().sessions[0].status, 'conflict');
  return { ...harness, adapter, memory };
}

describe('compose workspace reducer', () => {
  it('loads summaries and snapshots without mutating action values', () => {
    const inputSummary = summary();
    const inputSnapshot = snapshot();
    const state = reduce([
      { type: 'LOAD_SUMMARIES', summaries: [inputSummary] },
      { type: 'LOAD_SNAPSHOT', sessionId: SESSION_A, snapshot: inputSnapshot },
      { type: 'FOCUS', sessionId: SESSION_A },
    ]);

    const [session] = selectComposeSessions(state);
    assert.equal(session.subject, 'Synthetic subject');
    assert.equal(session.body, 'Synthetic body');
    assert.equal(session.baseRevision, 3);
    assert.equal(state.focusedSessionId, SESSION_A);
    session.localChanges.subject = 'Changed output';
    assert.deepEqual(inputSummary, summary());
    assert.deepEqual(inputSnapshot, snapshot());
  });

  it('keeps dirty local and recovery state across summary reloads and missing rows', () => {
    const dirty = reduce([
      { type: 'LOAD_SUMMARIES', summaries: [summary()] },
      { type: 'LOAD_SNAPSHOT', sessionId: SESSION_A, snapshot: snapshot() },
      { type: 'LOCAL_CHANGE', sessionId: SESSION_A, changes: { subject: 'Local subject' } },
      { type: 'SAVE_OFFLINE', sessionId: SESSION_A, error: new Error('offline') },
    ]);
    const reloaded = composeWorkspaceReducer(dirty, {
      type: 'LOAD_SUMMARIES',
      summaries: [summary({ id: SESSION_B, slot: 2, revision: 1 })],
    });

    const retained = selectComposeSessions(reloaded).find(item => item.id === SESSION_A);
    assert.equal(retained.subject, 'Local subject');
    assert.deepEqual(retained.localChanges, { subject: 'Local subject' });
    assert.equal(retained.baseRevision, 3);
    assert.equal(retained.status, 'offline');
    assert.equal(retained.remoteMissing, true);
  });

  it('preserves edits made during a save and clears only matching acknowledged fields', () => {
    const saving = reduce([
      { type: 'LOAD_SUMMARIES', summaries: [summary()] },
      { type: 'LOAD_SNAPSHOT', sessionId: SESSION_A, snapshot: snapshot() },
      { type: 'LOCAL_CHANGE', sessionId: SESSION_A, changes: { subject: 'First', body: 'Body A' } },
      { type: 'SAVE_START', sessionId: SESSION_A, requestId: 1 },
      { type: 'LOCAL_CHANGE', sessionId: SESSION_A, changes: { subject: 'Second' } },
    ]);
    const saved = composeWorkspaceReducer(saving, {
      type: 'SAVE_SUCCESS',
      sessionId: SESSION_A,
      requestId: 1,
      baseRevision: 3,
      sentChanges: { subject: 'First', body: 'Body A' },
      snapshot: snapshot({ subject: 'First', body: 'Body A', revision: 4 }),
      clientId: 'browser-synthetic',
    });

    const [session] = selectComposeSessions(saved);
    assert.equal(session.subject, 'Second');
    assert.deepEqual(session.localChanges, { subject: 'Second' });
    assert.equal(session.baseRevision, 4);
    assert.equal(session.status, 'dirty');
    assert.deepEqual(session.acknowledgedEcho, {
      clientId: 'browser-synthetic', revision: 4,
    });
  });

  it('stores exact structured same-field conflicts and retains local changes', () => {
    const dirty = reduce([
      { type: 'LOAD_SUMMARIES', summaries: [summary()] },
      { type: 'LOAD_SNAPSHOT', sessionId: SESSION_A, snapshot: snapshot() },
      { type: 'LOCAL_CHANGE', sessionId: SESSION_A, changes: { subject: 'Local subject' } },
    ]);
    const details = {
      conflictingFields: ['subject'],
      remoteValues: { subject: 'Remote subject' },
      currentRevision: 4,
    };
    const conflicted = composeWorkspaceReducer(dirty, {
      type: 'SAVE_CONFLICT', sessionId: SESSION_A, conflict: details,
    });
    const [session] = selectComposeSessions(conflicted);

    assert.equal(session.status, 'conflict');
    assert.deepEqual(session.conflict, details);
    assert.deepEqual(session.localChanges, { subject: 'Local subject' });
  });

  it('marks only clean invalidations for refetch and removes immutably', () => {
    const loaded = reduce([
      { type: 'LOAD_SUMMARIES', summaries: [summary(), summary({ id: SESSION_B, slot: 2 })] },
      { type: 'LOAD_SNAPSHOT', sessionId: SESSION_A, snapshot: snapshot() },
      { type: 'LOAD_SNAPSHOT', sessionId: SESSION_B, snapshot: snapshot({ id: SESSION_B, slot: 2 }) },
      { type: 'LOCAL_CHANGE', sessionId: SESSION_B, changes: { body: 'Local body' } },
    ]);
    const invalidatedClean = composeWorkspaceReducer(loaded, {
      type: 'REMOTE_INVALIDATION', sessionId: SESSION_A, revision: 4,
    });
    const invalidatedDirty = composeWorkspaceReducer(invalidatedClean, {
      type: 'REMOTE_INVALIDATION', sessionId: SESSION_B, revision: 4,
    });
    const beforeRemove = selectComposeSessions(invalidatedDirty);
    assert.equal(beforeRemove.find(item => item.id === SESSION_A).needsSnapshot, true);
    assert.equal(beforeRemove.find(item => item.id === SESSION_B).needsSnapshot, false);
    assert.equal(beforeRemove.find(item => item.id === SESSION_B).body, 'Local body');

    const removed = composeWorkspaceReducer(invalidatedDirty, { type: 'REMOVE', sessionId: SESSION_A });
    assert.deepEqual(selectComposeSessions(removed).map(item => item.id), [SESSION_B]);
    assert.equal(selectComposeSessions(invalidatedDirty).length, 2);
  });
});

describe('compose workspace controller', () => {
  it('promotes an expanded overflow chip into the local visible set without changing global presentation', async () => {
    const { controller, calls } = controllerHarness({
      api: {
        list: async () => [
          summary({ lastFocusedAt: '2026-01-01T00:00:00.000Z' }),
          summary({
            id: SESSION_B,
            slot: 2,
            lastFocusedAt: '2026-01-02T00:00:00.000Z',
          }),
        ],
        get: async id => snapshot({
          id,
          slot: id === SESSION_A ? 1 : 2,
          lastFocusedAt: id === SESSION_A
            ? '2026-01-01T00:00:00.000Z'
            : '2026-01-02T00:00:00.000Z',
        }),
      },
    });
    await controller.setCapacity(1);
    await controller.refreshSummaries();
    await controller.whenIdle();
    assert.deepEqual(controller.getSnapshot().visibleSessions.map(item => item.id), [SESSION_B]);
    assert.deepEqual(controller.getSnapshot().chipSessions.map(item => item.id), [SESSION_A]);

    controller.focusSession(SESSION_A, { persist: false });
    await controller.whenIdle();

    assert.deepEqual(controller.getSnapshot().visibleSessions.map(item => item.id), [SESSION_A]);
    assert.deepEqual(controller.getSnapshot().chipSessions.map(item => item.id), [SESSION_B]);
    assert.equal(controller.getSnapshot().focusedSessionId, SESSION_A);
    assert.equal(calls.filter(call => call[0] === 'presentation').length, 0);
    controller.destroy();
  });

  it('deduplicates visible snapshot loads and never loads chip snapshots', async () => {
    const first = deferred();
    let getCalls = 0;
    const { controller } = controllerHarness({
      api: {
        list: async () => [
          summary(),
          summary({ id: SESSION_B, slot: 2, presentationState: 'minimized', revision: 1 }),
        ],
        get: async id => {
          getCalls += 1;
          if (id === SESSION_A) return first.promise;
          throw new Error('chip snapshot must not load');
        },
      },
    });
    controller.setCapacity(1);
    await controller.refreshSummaries();
    const duplicate = controller.loadSnapshot(SESSION_A);
    assert.equal(getCalls, 1);
    first.resolve(snapshot());
    await duplicate;
    assert.equal(getCalls, 1);
    assert.equal(controller.getSnapshot().chipSessions[0].id, SESSION_B);
    controller.destroy();
  });

  it('debounces each session for exactly 2000ms and writes recovery before patch', async () => {
    const { controller, timers, adapter, calls } = controllerHarness();
    await controller.refreshSummaries();
    await controller.loadSnapshot(SESSION_A);
    controller.changeSession(SESSION_A, { subject: 'First' });
    const firstTimer = [...timers.pending.keys()][0];
    controller.changeSession(SESSION_A, { subject: 'Second' });
    const [[timerId, timer]] = [...timers.pending.entries()];
    assert.notEqual(timerId, firstTimer);
    assert.equal(timer.delay, 2000);
    await timers.run(timerId);

    assert.deepEqual(adapter.calls.map(call => call[0]), ['put', 'delete']);
    assert.deepEqual(calls[0], [
      'patch', SESSION_A, 3, { subject: 'Second' }, 'browser-synthetic',
    ]);
    assert.equal(controller.getSnapshot().sessions[0].status, 'clean');
    controller.destroy();
  });

  it('flushes every dirty generation before minimizing at the acknowledged revision', async () => {
    const firstPatch = deferred();
    const order = [];
    let patchCount = 0;
    let adapter;
    const harness = controllerHarness({
      api: {
        patch: async (id, revision, changes) => {
          assert.equal(adapter.calls.at(-1)[0], 'put', 'recovery precedes every patch');
          patchCount += 1;
          order.push(['patch', patchCount, revision, structuredClone(changes)]);
          if (patchCount === 1) return firstPatch.promise;
          return snapshot({ subject: 'First generation', body: 'Second generation', revision: 5 });
        },
        presentation: async (id, revision, state) => {
          order.push(['presentation', revision, state]);
          return snapshot({
            subject: 'First generation', body: 'Second generation',
            revision: revision + 1, presentationState: state,
          });
        },
      },
    });
    ({ adapter } = harness);
    const { controller, timers } = harness;
    await controller.refreshSummaries();
    await controller.loadSnapshot(SESSION_A);
    controller.changeSession(SESSION_A, { subject: 'First generation' });
    const minimizing = controller.minimizeSession(SESSION_A);
    await until(() => patchCount === 1);
    controller.changeSession(SESSION_A, { body: 'Second generation' });
    firstPatch.resolve(snapshot({ subject: 'First generation', revision: 4 }));
    await minimizing;

    assert.deepEqual(order, [
      ['patch', 1, 3, { subject: 'First generation' }],
      ['patch', 2, 4, { body: 'Second generation' }],
      ['presentation', 5, 'minimized'],
    ]);
    const session = controller.getSnapshot().sessions[0];
    assert.equal(session.presentationState, 'minimized');
    assert.equal(session.status, 'clean');
    assert.equal(session.baseRevision, 6);
    assert.equal(timers.pending.size, 0);
    controller.destroy();
  });

  it('reconciles a reload recovery patch before exposing the visible snapshot', async () => {
    const { controller, adapter, timers } = controllerHarness();
    adapter.records.set(`${USER_ID}:${SESSION_A}`, {
      key: `${USER_ID}:${SESSION_A}`,
      userId: USER_ID,
      sessionId: SESSION_A,
      baseRevision: 2,
      changes: { subject: 'Recovered subject' },
      updatedAt: Date.now(),
    });
    await controller.refreshSummaries();
    await controller.loadSnapshot(SESSION_A);

    const session = controller.getSnapshot().sessions[0];
    assert.equal(session.subject, 'Recovered subject');
    assert.deepEqual(session.localChanges, { subject: 'Recovered subject' });
    assert.equal(session.baseRevision, 2);
    assert.equal(session.status, 'dirty');
    assert.equal([...timers.pending.values()][0].delay, 2000);
    controller.destroy();
  });

  it('merges delayed compatible recovery without overwriting newer local edits', async () => {
    const recoveryRead = deferred();
    const recoveryStarted = deferred();
    const adapter = {
      async get() { recoveryStarted.resolve(); return recoveryRead.promise; },
      async put() {},
      async delete() {},
    };
    const { controller, timers } = controllerHarness({
      dependencies: { recoveryStore: adapter },
    });
    await controller.refreshSummaries();
    const loading = controller.loadSnapshot(SESSION_A);
    await recoveryStarted.promise;
    controller.changeSession(SESSION_A, {
      subject: 'Newer local subject',
      priority: 'high',
    });
    recoveryRead.resolve({
      key: `${USER_ID}:${SESSION_A}`,
      userId: USER_ID,
      sessionId: SESSION_A,
      baseRevision: 3,
      changes: { subject: 'Older recovered subject', body: 'Recovered body' },
      updatedAt: Date.now(),
    });
    await loading;
    await controller.whenIdle();

    const session = controller.getSnapshot().sessions[0];
    assert.deepEqual(session.localChanges, {
      subject: 'Newer local subject',
      body: 'Recovered body',
      priority: 'high',
    });
    assert.equal(session.baseRevision, 3);
    assert.equal(session.status, 'dirty');
    assert.equal(timers.pending.size, 1);
    controller.destroy();
  });

  it('preserves newer local edits and surfaces incompatible delayed recovery', async () => {
    const recoveryRead = deferred();
    const recoveryStarted = deferred();
    const adapter = {
      async get() { recoveryStarted.resolve(); return recoveryRead.promise; },
      async put() {},
      async delete() {},
    };
    const { controller, timers } = controllerHarness({
      dependencies: { recoveryStore: adapter },
    });
    await controller.refreshSummaries();
    const loading = controller.loadSnapshot(SESSION_A);
    await recoveryStarted.promise;
    controller.changeSession(SESSION_A, { subject: 'Newer local subject' });
    recoveryRead.resolve({
      key: `${USER_ID}:${SESSION_A}`,
      userId: USER_ID,
      sessionId: SESSION_A,
      baseRevision: 2,
      changes: { subject: 'Older recovered subject', body: 'Recovered body' },
      updatedAt: Date.now(),
    });
    await loading;
    await controller.whenIdle();

    const session = controller.getSnapshot().sessions[0];
    assert.deepEqual(session.localChanges, { subject: 'Newer local subject' });
    assert.equal(session.baseRevision, 3);
    assert.equal(session.status, 'conflict');
    assert.deepEqual(session.recoveryConflict, {
      recoveryBaseRevision: 2,
      currentBaseRevision: 3,
      recoveredChanges: { subject: 'Older recovered subject', body: 'Recovered body' },
    });
    assert.equal(timers.pending.size, 0);
    controller.destroy();
  });

  it('blocks lifecycle calls until keep-mine clears stale recovery and can save', async () => {
    const { controller, timers, calls, memory } = await recoveryConflictHarness();

    for (const [method, args] of [
      ['minimizeSession', [SESSION_A]],
      ['closeSession', [SESSION_A]],
      ['discardSession', [SESSION_A]],
      ['sendSession', [SESSION_A]],
    ]) {
      await assert.rejects(
        Promise.resolve(controller[method](...args)),
        error => error?.code === 'compose_recovery_conflict',
      );
    }
    assert.equal(calls.some(call => ['patch', 'presentation', 'close', 'discard', 'send'].includes(call[0])), false);
    assert.equal(timers.pending.size, 0);

    const resolved = await controller.resolveConflict(SESSION_A, { strategy: 'mine' });
    assert.equal(resolved.recoveryConflict, null);
    assert.equal(resolved.status, 'dirty');
    assert.deepEqual(resolved.localChanges, { subject: 'Newer local subject' });
    const currentRecovery = [...memory.records.values()][0];
    assert.equal(currentRecovery.baseRevision, 3);
    assert.deepEqual(currentRecovery.changes, { subject: 'Newer local subject' });

    await controller.flushSession(SESSION_A);
    const saved = controller.getSnapshot().sessions[0];
    assert.equal(saved.status, 'clean');
    assert.equal(saved.recoveryConflict, null);
    assert.deepEqual(saved.localChanges, {});
    assert.ok(calls.some(call => call[0] === 'patch'));
    controller.destroy();
  });

  it('can deliberately select recovered values with their coherent recovery base', async () => {
    const { controller, timers, memory } = await recoveryConflictHarness();
    const resolved = await controller.resolveConflict(SESSION_A, { strategy: 'recovered' });

    assert.equal(resolved.recoveryConflict, null);
    assert.equal(resolved.status, 'dirty');
    assert.equal(resolved.baseRevision, 2);
    assert.deepEqual(resolved.localChanges, {
      subject: 'Recovered subject', body: 'Recovered body',
    });
    const selectedRecovery = [...memory.records.values()][0];
    assert.equal(selectedRecovery.baseRevision, 2);
    assert.deepEqual(selectedRecovery.changes, {
      subject: 'Recovered subject', body: 'Recovered body',
    });
    assert.equal(timers.pending.size, 1);
    controller.destroy();
  });

  it('retains later edits and rewrites recovery against the acknowledged revision', async () => {
    const patch = deferred();
    const { controller, adapter } = controllerHarness({
      api: { patch: () => patch.promise },
    });
    await controller.refreshSummaries();
    await controller.loadSnapshot(SESSION_A);
    controller.changeSession(SESSION_A, { subject: 'First' });
    const saving = controller.flushSession(SESSION_A);
    await Promise.resolve();
    controller.changeSession(SESSION_A, { subject: 'Second' });
    patch.resolve(snapshot({ subject: 'First', revision: 4 }));
    await saving;

    const session = controller.getSnapshot().sessions[0];
    assert.equal(session.subject, 'Second');
    assert.equal(session.status, 'dirty');
    assert.equal(session.baseRevision, 4);
    assert.deepEqual(adapter.calls.map(call => call[0]), ['put', 'delete', 'put']);
    assert.equal([...adapter.records.values()][0].baseRevision, 4);
    controller.destroy();
  });

  it('keeps structured 409 and offline failures dirty with recovery intact', async () => {
    const conflictError = Object.assign(new Error('conflict'), {
      status: 409,
      details: {
        code: 'compose_conflict',
        conflictingFields: ['subject'],
        remoteValues: { subject: 'Remote subject' },
        currentRevision: 4,
      },
    });
    const { controller, adapter } = controllerHarness({
      api: { patch: async () => { throw conflictError; } },
    });
    await controller.refreshSummaries();
    await controller.loadSnapshot(SESSION_A);
    controller.changeSession(SESSION_A, { subject: 'Local subject' });
    await assert.rejects(controller.flushSession(SESSION_A), conflictError);
    let session = controller.getSnapshot().sessions[0];
    assert.equal(session.status, 'conflict');
    assert.deepEqual(session.conflict, {
      conflictingFields: ['subject'],
      remoteValues: { subject: 'Remote subject' },
      currentRevision: 4,
    });
    assert.equal(adapter.records.size, 1);

    controller.replaceDependencies({ api: {
      ...controller.dependencies.api,
      patch: async () => { throw new TypeError('network unavailable'); },
    } });
    controller.changeSession(SESSION_A, { body: 'Offline body' });
    await assert.rejects(controller.flushSession(SESSION_A), /network unavailable/);
    session = controller.getSnapshot().sessions[0];
    assert.equal(session.status, 'offline');
    assert.equal(session.subject, 'Local subject');
    assert.equal(session.body, 'Offline body');
    assert.ok(adapter.records.size > 0);
    controller.destroy();
  });

  it('rebases recovered keep-mine state before retrying a structured 409', async () => {
    const conflictError = composeConflict();
    let patchCalls = 0;
    const { controller, memory } = await recoveryConflictHarness();
    await controller.resolveConflict(SESSION_A, { strategy: 'recovered' });
    controller.replaceDependencies({ api: {
      ...controller.dependencies.api,
      patch: async (id, revision, changes) => {
        patchCalls += 1;
        if (patchCalls === 1) throw conflictError;
        return snapshot({ id, ...changes, revision: revision + 1 });
      },
    } });

    await assert.rejects(controller.flushSession(SESSION_A), conflictError);
    let session = controller.getSnapshot().sessions[0];
    assert.equal(session.recoveryConflict, null);
    assert.deepEqual(session.conflict, {
      conflictingFields: ['subject'],
      remoteValues: { subject: 'Remote subject' },
      currentRevision: 4,
    });

    session = await controller.resolveConflict(SESSION_A, { strategy: 'mine' });
    assert.equal(session.status, 'dirty');
    assert.equal(session.baseRevision, 4);
    const recoveryRecord = [...memory.records.values()][0];
    assert.equal(recoveryRecord.baseRevision, 4);
    assert.deepEqual(recoveryRecord.changes, {
      subject: 'Recovered subject', body: 'Recovered body',
    });
    await controller.flushSession(SESSION_A);
    session = controller.getSnapshot().sessions[0];
    assert.equal(patchCalls, 2);
    assert.equal(session.status, 'clean');
    assert.equal(session.baseRevision, 5);
    assert.equal(memory.records.size, 0);
    controller.destroy();
  });

  it('rebases or deletes recovered state before accepting remote 409 values', async t => {
    for (const scenario of [
      {
        name: 'dirty fields remain',
        fields: ['subject'],
        remoteValues: { subject: 'Remote subject' },
        remaining: { body: 'Recovered body' },
      },
      {
        name: 'no dirty fields remain',
        fields: ['subject', 'body'],
        remoteValues: { subject: 'Remote subject', body: 'Remote body' },
        remaining: {},
      },
    ]) {
      await t.test(scenario.name, async () => {
        const conflictError = composeConflict({
          fields: scenario.fields,
          remoteValues: scenario.remoteValues,
        });
        const { controller, memory, timers } = await recoveryConflictHarness();
        await controller.resolveConflict(SESSION_A, { strategy: 'recovered' });
        controller.replaceDependencies({ api: {
          ...controller.dependencies.api,
          patch: async () => { throw conflictError; },
        } });
        await assert.rejects(controller.flushSession(SESSION_A), conflictError);

        let session = await controller.resolveConflict(SESSION_A, { strategy: 'remote' });
        assert.equal(session.baseRevision, 4);
        assert.deepEqual(session.localChanges, scenario.remaining);
        if (Object.keys(scenario.remaining).length) {
          const recoveryRecord = [...memory.records.values()][0];
          assert.equal(recoveryRecord.baseRevision, 4);
          assert.deepEqual(recoveryRecord.changes, scenario.remaining);
          assert.equal(timers.pending.size, 1);
        } else {
          assert.equal(memory.records.size, 0);
          assert.equal(timers.pending.size, 0);
          await controller.loadSnapshot(SESSION_A, { force: true });
          session = controller.getSnapshot().sessions[0];
          assert.deepEqual(session.localChanges, {});
          assert.notEqual(session.subject, 'Recovered subject');
          assert.notEqual(session.body, 'Recovered body');
        }
        controller.destroy();
      });
    }
  });

  it('durably reconciles ordinary server conflicts for mine and remote choices', async t => {
    for (const strategy of ['mine', 'remote']) {
      await t.test(strategy, async () => {
        const conflictError = composeConflict();
        const { controller, adapter, timers } = controllerHarness({
          api: { patch: async () => { throw conflictError; } },
        });
        await controller.refreshSummaries();
        await controller.loadSnapshot(SESSION_A);
        controller.changeSession(SESSION_A, {
          subject: 'Local subject', body: 'Local body',
        });
        await assert.rejects(controller.flushSession(SESSION_A), conflictError);

        const resolved = await controller.resolveConflict(SESSION_A, { strategy });
        const expectedChanges = strategy === 'mine'
          ? { subject: 'Local subject', body: 'Local body' }
          : { body: 'Local body' };
        assert.equal(resolved.status, 'dirty');
        assert.equal(resolved.baseRevision, 4);
        assert.equal(resolved.conflict, null);
        assert.deepEqual(resolved.localChanges, expectedChanges);
        const recoveryRecord = [...adapter.records.values()][0];
        assert.equal(recoveryRecord.baseRevision, 4);
        assert.deepEqual(recoveryRecord.changes, expectedChanges);
        assert.equal(timers.pending.size, 1);
        controller.destroy();
      });
    }
  });

  it('does not claim server-conflict resolution when recovery reconciliation fails', async t => {
    for (const failurePoint of ['delete', 'put']) {
      await t.test(`${failurePoint} failure`, async () => {
        const conflictError = composeConflict();
        const failure = Object.assign(new Error(`synthetic recovery ${failurePoint} failure`), {
          code: `synthetic_recovery_${failurePoint}`,
        });
        const memory = recoveryAdapter();
        let activeFailure = null;
        const adapter = {
          ...memory,
          async put(record) {
            if (activeFailure === 'put') throw failure;
            return memory.put(record);
          },
          async delete(key) {
            if (activeFailure === 'delete') throw failure;
            return memory.delete(key);
          },
        };
        const { controller, timers } = controllerHarness({
          dependencies: { recoveryStore: adapter },
          api: { patch: async () => { throw conflictError; } },
        });
        await controller.refreshSummaries();
        await controller.loadSnapshot(SESSION_A);
        controller.changeSession(SESSION_A, { subject: 'Local subject' });
        await assert.rejects(controller.flushSession(SESSION_A), conflictError);
        activeFailure = failurePoint;

        await assert.rejects(
          Promise.resolve(controller.resolveConflict(SESSION_A, { strategy: 'mine' })),
          failure,
        );
        let session = controller.getSnapshot().sessions[0];
        assert.equal(session.status, 'conflict');
        assert.equal(session.baseRevision, 3);
        assert.ok(session.conflict);
        assert.equal(session.recoveryConflict, null);
        assert.equal(timers.pending.size, 0);

        activeFailure = null;
        session = await controller.resolveConflict(SESSION_A, { strategy: 'mine' });
        assert.equal(session.status, 'dirty');
        assert.equal(session.baseRevision, 4);
        const recoveryRecord = [...memory.records.values()][0];
        assert.equal(recoveryRecord.baseRevision, 4);
        assert.deepEqual(recoveryRecord.changes, { subject: 'Local subject' });
        controller.destroy();
      });
    }
  });

  it('safe-closes with one atomic final patch and never preflushes or removes on failure', async () => {
    const close = deferred();
    let patchCalls = 0;
    const { controller, adapter, calls } = controllerHarness({
      api: {
        patch: async () => { patchCalls += 1; },
        close: (id, revision, changes) => {
          calls.push(['close', id, revision, structuredClone(changes)]);
          return close.promise;
        },
      },
    });
    await controller.refreshSummaries();
    await controller.loadSnapshot(SESSION_A);
    controller.focusSession(SESSION_A, { persist: false });
    controller.changeSession(SESSION_A, { subject: 'Atomic subject', body: 'Atomic body' });
    const closing = controller.closeSession(SESSION_A);
    await until(() => calls.length === 1);
    assert.equal(patchCalls, 0);
    assert.deepEqual(calls[0], [
      'close', SESSION_A, 3, { subject: 'Atomic subject', body: 'Atomic body' },
    ]);
    assert.equal(adapter.records.size, 1);

    const failure = Object.assign(new Error('close conflict'), {
      status: 409,
      details: { conflictingFields: ['body'], remoteValues: { body: 'Remote' }, currentRevision: 4 },
    });
    close.reject(failure);
    await assert.rejects(closing, failure);
    const session = controller.getSnapshot().sessions[0];
    assert.equal(controller.getSnapshot().focusedSessionId, SESSION_A);
    assert.equal(session.status, 'conflict');
    assert.deepEqual(session.localChanges, { subject: 'Atomic subject', body: 'Atomic body' });
    assert.equal(adapter.records.size, 1);
    controller.destroy();
  });

  it('drains edits from an existing in-flight patch before send and freezes later edits', async () => {
    const firstPatch = deferred();
    const events = [];
    let patchCalls = 0;
    const { controller } = controllerHarness({
      api: {
        patch: async (_id, revision, changes) => {
          patchCalls += 1;
          events.push(['patch', revision, structuredClone(changes)]);
          if (patchCalls === 1) return firstPatch.promise;
          return snapshot({ ...changes, revision: revision + 1 });
        },
        send: async (_id, revision) => {
          events.push(['send', revision]);
          return { ok: true };
        },
      },
    });
    await controller.refreshSummaries();
    await controller.loadSnapshot(SESSION_A);
    controller.changeSession(SESSION_A, { body: 'First generation' });
    const saving = controller.flushSession(SESSION_A);
    await until(() => patchCalls === 1);
    controller.changeSession(SESSION_A, { body: 'Second generation' });
    const sending = controller.sendSession(SESSION_A);
    const rejected = controller.changeSession(SESSION_A, { body: 'Too late generation' });
    assert.equal(rejected.body, 'Second generation');
    assert.equal(rejected.terminalPending, 'send');

    firstPatch.resolve(snapshot({ body: 'First generation', revision: 4 }));
    await saving;
    await sending;
    assert.deepEqual(events, [
      ['patch', 3, { body: 'First generation' }],
      ['patch', 4, { body: 'Second generation' }],
      ['send', 5],
    ]);
    assert.equal(controller.getSnapshot().sessions.length, 0);
    controller.destroy();
  });

  it('freezes close synchronously and unfreezes with dirty state on failure', async () => {
    const closingApi = deferred();
    const closeCalls = [];
    const { controller } = controllerHarness({
      api: {
        close: async (_id, revision, changes) => {
          closeCalls.push([revision, structuredClone(changes)]);
          return closingApi.promise;
        },
      },
    });
    await controller.refreshSummaries();
    await controller.loadSnapshot(SESSION_A);
    controller.focusSession(SESSION_A);
    assert.equal(controller.getSnapshot().focusedSessionId, SESSION_A);
    controller.changeSession(SESSION_A, { subject: 'Before close' });

    const closing = controller.closeSession(SESSION_A);
    const rejected = controller.changeSession(SESSION_A, { subject: 'After close invocation' });
    assert.equal(rejected.subject, 'Before close');
    assert.equal(rejected.terminalPending, 'close');
    closingApi.reject(new TypeError('synthetic close failure'));
    await assert.rejects(closing, /synthetic close failure/);

    let session = controller.getSnapshot().sessions[0];
    assert.equal(session.terminalPending, null);
    assert.equal(controller.getSnapshot().focusedSessionId, SESSION_A);
    assert.equal(session.subject, 'Before close');
    assert.deepEqual(session.localChanges, { subject: 'Before close' });
    controller.changeSession(SESSION_A, { subject: 'Accepted after failure' });
    session = controller.getSnapshot().sessions[0];
    assert.equal(session.subject, 'Accepted after failure');
    assert.deepEqual(closeCalls, [[3, { subject: 'Before close' }]]);
    controller.destroy();
  });

  it('waits for compatible recovery hydration before capturing an atomic close patch', async () => {
    const recoveryRead = deferred();
    const recoveryStarted = deferred();
    const memory = recoveryAdapter();
    const adapter = {
      ...memory,
      async get() {
        recoveryStarted.resolve();
        return recoveryRead.promise;
      },
    };
    const { controller, calls } = controllerHarness({
      dependencies: { recoveryStore: adapter },
    });
    await controller.refreshSummaries();
    const loading = controller.loadSnapshot(SESSION_A);
    await recoveryStarted.promise;

    const closing = controller.closeSession(SESSION_A);
    assert.equal(controller.getSnapshot().sessions[0].terminalPending, 'close');
    await Promise.resolve();
    assert.deepEqual(calls, []);

    recoveryRead.resolve({
      key: `${USER_ID}:${SESSION_A}`,
      userId: USER_ID,
      sessionId: SESSION_A,
      baseRevision: 3,
      changes: { subject: 'Hydrated before close' },
      updatedAt: Date.now(),
    });
    await loading;
    await closing;
    assert.deepEqual(calls, [[
      'close', SESSION_A, 3, { subject: 'Hydrated before close' },
    ]]);
    assert.equal(controller.getSnapshot().sessions.length, 0);
    controller.destroy();
  });

  it('waits for compatible recovery hydration before draining send generations', async () => {
    const recoveryRead = deferred();
    const recoveryStarted = deferred();
    const memory = recoveryAdapter();
    const adapter = {
      ...memory,
      async get() {
        recoveryStarted.resolve();
        return recoveryRead.promise;
      },
    };
    const { controller, calls } = controllerHarness({
      dependencies: { recoveryStore: adapter },
    });
    await controller.refreshSummaries();
    const loading = controller.loadSnapshot(SESSION_A);
    await recoveryStarted.promise;

    const sending = controller.sendSession(SESSION_A);
    assert.equal(controller.getSnapshot().sessions[0].terminalPending, 'send');
    await Promise.resolve();
    assert.deepEqual(calls, []);

    recoveryRead.resolve({
      key: `${USER_ID}:${SESSION_A}`,
      userId: USER_ID,
      sessionId: SESSION_A,
      baseRevision: 3,
      changes: { body: 'Hydrated before send' },
      updatedAt: Date.now(),
    });
    await loading;
    await sending;
    assert.deepEqual(calls, [
      ['patch', SESSION_A, 3, { body: 'Hydrated before send' }, 'browser-synthetic'],
      ['send', SESSION_A, 4, {}, {}],
    ]);
    assert.equal(controller.getSnapshot().sessions.length, 0);
    controller.destroy();
  });

  it('blocks and unfreezes a terminal action when pending hydration finds a conflict', async () => {
    const recoveryRead = deferred();
    const recoveryStarted = deferred();
    const memory = recoveryAdapter();
    const adapter = {
      ...memory,
      async get() {
        recoveryStarted.resolve();
        return recoveryRead.promise;
      },
    };
    const { controller, calls } = controllerHarness({
      dependencies: { recoveryStore: adapter },
    });
    await controller.refreshSummaries();
    const loading = controller.loadSnapshot(SESSION_A);
    await recoveryStarted.promise;
    controller.changeSession(SESSION_A, { subject: 'Newer editor value' });

    const closing = controller.closeSession(SESSION_A);
    const recovered = {
      key: `${USER_ID}:${SESSION_A}`,
      userId: USER_ID,
      sessionId: SESSION_A,
      baseRevision: 2,
      changes: { subject: 'Recovered older value' },
      updatedAt: Date.now(),
    };
    memory.records.set(recovered.key, structuredClone(recovered));
    recoveryRead.resolve(recovered);
    await loading;
    await assert.rejects(closing, error => error?.code === 'compose_recovery_conflict');

    const session = controller.getSnapshot().sessions[0];
    assert.equal(session.terminalPending, null);
    assert.equal(session.subject, 'Newer editor value');
    assert.deepEqual(session.localChanges, { subject: 'Newer editor value' });
    assert.equal(session.status, 'conflict');
    assert.ok(session.recoveryConflict);
    assert.equal(memory.records.size, 1);
    assert.deepEqual(calls, []);
    controller.destroy();
  });

  it('blocks and unfreezes a terminal action when pending recovery hydration fails', async () => {
    const recoveryRead = deferred();
    const recoveryStarted = deferred();
    const memory = recoveryAdapter();
    const adapter = {
      ...memory,
      async get() {
        recoveryStarted.resolve();
        return recoveryRead.promise;
      },
    };
    const { controller, calls } = controllerHarness({
      dependencies: { recoveryStore: adapter },
    });
    await controller.refreshSummaries();
    const loading = controller.loadSnapshot(SESSION_A);
    await recoveryStarted.promise;

    const failure = Object.assign(new Error('synthetic recovery read failure'), {
      code: 'synthetic_recovery_read',
    });
    controller.changeSession(SESSION_A, { body: 'Editor survives hydration error' });
    const sending = controller.sendSession(SESSION_A);
    recoveryRead.reject(failure);
    await loading;
    await assert.rejects(sending, failure);

    const session = controller.getSnapshot().sessions[0];
    assert.equal(session.terminalPending, null);
    assert.equal(session.status, 'error');
    assert.equal(session.error, failure);
    assert.equal(session.body, 'Editor survives hydration error');
    assert.deepEqual(session.localChanges, { body: 'Editor survives hydration error' });
    assert.deepEqual(calls, []);
    controller.destroy();
  });

  it('does not start stale snapshot hydration after terminal intent is accepted', async () => {
    const close = deferred();
    let snapshotReads = 0;
    const { controller } = controllerHarness({
      api: {
        get: async () => {
          snapshotReads += 1;
          return snapshot();
        },
        close: async () => close.promise,
      },
    });
    await controller.refreshSummaries();
    await controller.loadSnapshot(SESSION_A);
    assert.equal(snapshotReads, 1);

    const closing = controller.closeSession(SESSION_A);
    await controller.loadSnapshot(SESSION_A, { force: true });
    assert.equal(snapshotReads, 1);
    close.resolve({ closed: true, slot: 1 });
    await closing;
    assert.equal(controller.getSnapshot().sessions.length, 0);
    controller.destroy();
  });

  it('clears recovery and removes only after close, discard, or send succeeds', async () => {
    for (const terminal of ['closeSession', 'discardSession', 'sendSession']) {
      const { controller, adapter, calls } = controllerHarness();
      await controller.refreshSummaries();
      await controller.loadSnapshot(SESSION_A);
      controller.changeSession(SESSION_A, { body: `Synthetic ${terminal}` });
      await controller[terminal](SESSION_A);
      assert.equal(controller.getSnapshot().sessions.length, 0);
      assert.equal(adapter.records.size, 0);
      assert.ok(calls.some(call => call[0] === terminal.replace('Session', '').replace('close', 'close')));
      controller.destroy();
    }
  });

  it('keeps attachments immediate and server-authoritative without recovery bytes', async () => {
    const { controller, adapter } = controllerHarness();
    await controller.refreshSummaries();
    await controller.loadSnapshot(SESSION_A);
    const file = { name: 'fixture.txt', size: 12, type: 'text/plain' };
    await controller.addAttachment(SESSION_A, file);
    let session = controller.getSnapshot().sessions[0];
    assert.deepEqual(session.attachments, [
      { id: 'attachment-a', filename: 'fixture.txt', byteCount: 12 },
    ]);
    assert.equal(session.revision, 4);
    assert.equal(adapter.records.size, 0);
    await controller.removeAttachment(SESSION_A, 'attachment-a');
    session = controller.getSnapshot().sessions[0];
    assert.deepEqual(session.attachments, []);
    assert.equal(session.revision, 5);
    controller.destroy();
  });

  it('manual save flushes the complete current patch without losing authoritative attachments', async () => {
    const attachment = { id: 'attachment-a', filename: 'fixture.txt', byteCount: 12 };
    const calls = [];
    const { controller } = controllerHarness({
      api: {
        get: async () => snapshot({ attachments: [attachment] }),
        patch: async (id, revision, changes, clientId) => {
          calls.push(['patch', id, revision, structuredClone(changes), clientId]);
          return snapshot({ ...changes, revision: revision + 1, attachments: [attachment] });
        },
      },
    });
    await controller.refreshSummaries();
    await controller.loadSnapshot(SESSION_A);

    const changes = {
      accountId: 'synthetic-account', aliasId: null, mode: 'new',
      to: ['recipient@example.com'], cc: [], bcc: [], subject: 'Manual save',
      body: '<p>Complete body</p>', bodyIsHtml: true, quotedBody: '',
      quotedBodyHtml: null, editedSignature: '', forwardedAttachments: [],
      priority: 'normal', inReplyTo: null, references: [], fromChanged: false,
    };
    const saved = await controller.saveSession(SESSION_A, changes);

    assert.deepEqual(calls, [[
      'patch', SESSION_A, 3, changes, 'browser-synthetic',
    ]]);
    assert.equal(saved.status, 'clean');
    assert.deepEqual(saved.attachments, [attachment]);
    controller.destroy();
  });

  it('keeps edits made after manual-save capture dirty while the captured patch flushes', async () => {
    const patch = deferred();
    const calls = [];
    const { controller } = controllerHarness({
      api: {
        patch: async (id, revision, changes) => {
          calls.push([id, revision, structuredClone(changes)]);
          return patch.promise;
        },
      },
    });
    await controller.refreshSummaries();
    await controller.loadSnapshot(SESSION_A);

    const saving = controller.saveSession(SESSION_A, { subject: 'Captured subject' });
    await until(() => calls.length === 1);
    controller.changeSession(SESSION_A, { subject: 'Later local subject' });
    patch.resolve(snapshot({ subject: 'Captured subject', revision: 4 }));
    await saving;

    const session = controller.getSnapshot().sessions[0];
    assert.equal(session.subject, 'Later local subject');
    assert.deepEqual(session.localChanges, { subject: 'Later local subject' });
    assert.equal(session.status, 'dirty');
    controller.destroy();
  });

  it('rebases an existing dirty recovery patch after an authoritative attachment revision', async () => {
    const { controller, adapter } = controllerHarness({
      api: { patch: async () => { throw new TypeError('synthetic offline'); } },
    });
    await controller.refreshSummaries();
    await controller.loadSnapshot(SESSION_A);
    controller.changeSession(SESSION_A, { body: 'Recovered local body' });
    await assert.rejects(controller.flushSession(SESSION_A), /synthetic offline/);
    assert.equal([...adapter.records.values()][0].baseRevision, 3);

    await controller.addAttachment(SESSION_A, {
      name: 'fixture.txt', size: 12, type: 'text/plain',
    });
    const recovery = [...adapter.records.values()][0];
    assert.equal(recovery.baseRevision, 4);
    assert.deepEqual(recovery.changes, { body: 'Recovered local body' });
    assert.equal(controller.getSnapshot().sessions[0].status, 'dirty');
    controller.destroy();
  });

  it('serializes an in-flight upload before close and uses the attachment revision', async () => {
    const upload = deferred();
    const events = [];
    const { controller } = controllerHarness({
      api: {
        uploadAttachment: async (_id, revision) => {
          events.push(['upload', revision]);
          return upload.promise;
        },
        close: async (_id, revision) => {
          events.push(['close', revision, controller.getSnapshot().sessions[0].attachments.length]);
          return { closed: true, slot: 1 };
        },
      },
    });
    await controller.refreshSummaries();
    await controller.loadSnapshot(SESSION_A);

    const uploading = controller.addAttachment(SESSION_A, {
      name: 'fixture.txt', size: 12, type: 'text/plain',
    });
    await until(() => events.length === 1);
    const closing = controller.closeSession(SESSION_A);
    await Promise.resolve();
    assert.deepEqual(events, [['upload', 3]]);

    upload.resolve({
      sessionId: SESSION_A,
      revision: 4,
      attachment: { id: 'attachment-a', filename: 'fixture.txt', byteCount: 12 },
    });
    await uploading;
    await closing;
    assert.deepEqual(events, [['upload', 3], ['close', 4, 1]]);
    assert.equal(controller.getSnapshot().sessions.length, 0);
    controller.destroy();
  });

  it('orders multiple uploads from separate callers by acknowledged revision', async () => {
    const firstUpload = deferred();
    const calls = [];
    const { controller } = controllerHarness({
      api: {
        uploadAttachment: async (_id, revision, file) => {
          calls.push([revision, file.name]);
          if (calls.length === 1) return firstUpload.promise;
          return {
            sessionId: SESSION_A,
            revision: revision + 1,
            attachment: { id: 'attachment-b', filename: file.name, byteCount: file.size },
          };
        },
      },
    });
    await controller.refreshSummaries();
    await controller.loadSnapshot(SESSION_A);

    const first = controller.addAttachment(SESSION_A, { name: 'one.txt', size: 1 });
    const second = controller.addAttachment(SESSION_A, { name: 'two.txt', size: 2 });
    await until(() => calls.length === 1);
    assert.deepEqual(calls, [[3, 'one.txt']]);
    firstUpload.resolve({
      sessionId: SESSION_A,
      revision: 4,
      attachment: { id: 'attachment-a', filename: 'one.txt', byteCount: 1 },
    });
    await Promise.all([first, second]);

    assert.deepEqual(calls, [[3, 'one.txt'], [4, 'two.txt']]);
    assert.equal(controller.getSnapshot().sessions[0].revision, 5);
    controller.destroy();
  });

  it('does not issue a ghost upload after an accepted terminal mutation', async () => {
    const terminal = deferred();
    let uploadCalls = 0;
    const { controller } = controllerHarness({
      api: {
        close: async () => terminal.promise,
        uploadAttachment: async () => {
          uploadCalls += 1;
          throw new Error('ghost upload');
        },
      },
    });
    await controller.refreshSummaries();
    await controller.loadSnapshot(SESSION_A);

    const closing = controller.closeSession(SESSION_A);
    const uploading = controller.addAttachment(SESSION_A, { name: 'late.txt', size: 1 });
    await Promise.resolve();
    assert.equal(uploadCalls, 0);
    terminal.resolve({ closed: true, slot: 1 });
    await closing;
    assert.equal(await uploading, null);
    assert.equal(uploadCalls, 0);
    controller.destroy();
  });

  it('releases the mutation queue after failure and preserves error state', async () => {
    const firstUpload = deferred();
    const secondUpload = deferred();
    const calls = [];
    const { controller } = controllerHarness({
      api: {
        uploadAttachment: async (_id, revision, file) => {
          calls.push([revision, file.name]);
          if (calls.length === 1) return firstUpload.promise;
          return secondUpload.promise;
        },
      },
    });
    await controller.refreshSummaries();
    await controller.loadSnapshot(SESSION_A);

    const failed = controller.addAttachment(SESSION_A, { name: 'bad.txt', size: 1 });
    const recovered = controller.addAttachment(SESSION_A, { name: 'good.txt', size: 2 });
    firstUpload.reject(new TypeError('synthetic upload failure'));
    await assert.rejects(failed, /synthetic upload failure/);
    await until(() => calls.length === 2);
    assert.equal(controller.getSnapshot().sessions[0].error?.message, 'synthetic upload failure');
    secondUpload.resolve({
      sessionId: SESSION_A,
      revision: 4,
      attachment: { id: 'attachment-b', filename: 'good.txt', byteCount: 2 },
    });
    await recovered;

    assert.deepEqual(calls, [[3, 'bad.txt'], [3, 'good.txt']]);
    const session = controller.getSnapshot().sessions[0];
    assert.equal(session.revision, 4);
    assert.equal(session.attachments[0].filename, 'good.txt');
    assert.equal(session.error, null);
    controller.destroy();
  });

  it('converges WebSocket events, ignoring only an exact own acknowledged echo', async () => {
    let lists = 0;
    let gets = 0;
    const events = fakeEventTarget();
    const { controller } = controllerHarness({
      api: {
        list: async () => { lists += 1; return [summary({ revision: lists > 1 ? 4 : 3 })]; },
        get: async () => { gets += 1; return snapshot({ revision: gets > 1 ? 4 : 3 }); },
      },
    });
    await controller.start({ eventTarget: events });
    await controller.loadSnapshot(SESSION_A);
    controller.changeSession(SESSION_A, { subject: 'Saved' });
    await controller.flushSession(SESSION_A);
    const baselineLists = lists;
    events.dispatch('mailflow:compose-session-updated', {
      sessionId: SESSION_A, clientId: 'browser-synthetic', revision: 4,
    });
    await Promise.resolve();
    assert.equal(lists, baselineLists, 'exact own echo is ignored');

    events.dispatch('mailflow:compose-session-updated', {
      sessionId: SESSION_A, clientId: 'browser-synthetic', revision: 5,
    });
    await controller.whenIdle();
    assert.ok(lists > baselineLists, 'different own revision converges');
    assert.ok(gets >= 2, 'clean visible snapshot refetches');

    controller.changeSession(SESSION_A, { body: 'Unsaved local body' });
    const dirtyGets = gets;
    events.dispatch('mailflow:compose-session-updated', {
      sessionId: SESSION_A, clientId: 'other-browser', revision: 6,
    });
    await controller.whenIdle();
    const session = controller.getSnapshot().sessions[0];
    assert.equal(session.body, 'Unsaved local body');
    assert.equal(gets, dirtyGets, 'dirty snapshot is not replaced');
    controller.destroy();
  });

  it('retires a clean-started snapshot when an invalidation arrives after a local edit', async () => {
    const staleGet = deferred();
    const events = fakeEventTarget();
    let listCalls = 0;
    let getCalls = 0;
    const { controller } = controllerHarness({
      api: {
        list: async () => {
          listCalls += 1;
          return [summary({ revision: listCalls === 1 ? 3 : 4 })];
        },
        get: async () => {
          getCalls += 1;
          if (getCalls === 2) return staleGet.promise;
          return snapshot();
        },
      },
    });
    await controller.start({ eventTarget: events });
    await controller.whenIdle();

    const staleRead = controller.loadSnapshot(SESSION_A, { force: true });
    await until(() => getCalls === 2);
    controller.changeSession(SESSION_A, { subject: 'Unsaved local subject' });
    events.dispatch('mailflow:compose-session-updated', {
      sessionId: SESSION_A, clientId: 'other-browser', revision: 4,
    });
    await until(() => listCalls === 2);
    staleGet.resolve(snapshot({
      body: 'Stale untouched body',
      presentationState: 'minimized',
      revision: 3,
    }));
    await staleRead;
    await controller.whenIdle();

    const session = controller.getSnapshot().sessions[0];
    assert.equal(getCalls, 2, 'dirty invalidation does not launch replacement hydration');
    assert.equal(session.subject, 'Unsaved local subject');
    assert.equal(session.body, 'Synthetic body');
    assert.equal(session.presentationState, 'expanded');
    assert.equal(session.status, 'dirty');
    assert.equal(session.remoteRevision, 4);
    controller.destroy();
  });

  it('retires terminal-owned hydration and replaces it only after terminal failure', async () => {
    const staleGet = deferred();
    const events = fakeEventTarget();
    const closeFailure = Object.assign(new Error('synthetic close failure'), { status: 503 });
    let listCalls = 0;
    let getCalls = 0;
    let closeCalls = 0;
    const { controller } = controllerHarness({
      api: {
        list: async () => {
          listCalls += 1;
          return [summary({ revision: listCalls === 1 ? 3 : 4 })];
        },
        get: async () => {
          getCalls += 1;
          if (getCalls === 2) return staleGet.promise;
          if (getCalls === 3) {
            return snapshot({ body: 'Current remote body', revision: 4 });
          }
          return snapshot();
        },
        close: async () => {
          closeCalls += 1;
          throw closeFailure;
        },
      },
    });
    await controller.start({ eventTarget: events });
    await controller.whenIdle();

    const staleRead = controller.loadSnapshot(SESSION_A, { force: true });
    await until(() => getCalls === 2);
    const closing = controller.closeSession(SESSION_A);
    events.dispatch('mailflow:compose-session-updated', {
      sessionId: SESSION_A, clientId: 'other-browser', revision: 4,
    });
    await until(() => listCalls === 2);
    assert.equal(getCalls, 2, 'terminal ownership prevents replacement hydration before failure');
    staleGet.resolve(snapshot({
      body: 'Stale terminal body',
      presentationState: 'minimized',
      revision: 3,
    }));
    await staleRead;
    await assert.rejects(closing, closeFailure);
    await controller.whenIdle();

    const session = controller.getSnapshot().sessions[0];
    assert.equal(getCalls, 3, 'replacement hydration starts only after terminal ownership releases');
    assert.equal(closeCalls, 1);
    assert.equal(session.body, 'Current remote body');
    assert.equal(session.presentationState, 'expanded');
    assert.equal(session.revision, 4);
    assert.equal(session.status, 'clean');
    assert.equal(session.terminalPending, null);
    assert.equal(session.needsSnapshot, false);
    assert.equal(session.remoteRevision, null);
    controller.destroy();
  });

  it('absorbs a failed invalidation summary refresh and converges on the next event', async () => {
    const events = fakeEventTarget();
    const summaryFailure = new Error('synthetic summary refresh failure');
    const unhandled = [];
    const onUnhandled = reason => unhandled.push(reason);
    let listCalls = 0;
    let getCalls = 0;
    const { controller } = controllerHarness({
      api: {
        list: async () => {
          listCalls += 1;
          if (listCalls === 2) throw summaryFailure;
          return [summary({
            presentationState: listCalls === 1 ? 'minimized' : 'expanded',
            revision: listCalls === 1 ? 3 : 5,
          })];
        },
        get: async () => {
          getCalls += 1;
          return snapshot({
            presentationState: getCalls === 1 ? 'minimized' : 'expanded',
            revision: getCalls === 1 ? 3 : 5,
          });
        },
      },
    });
    globalThis.process.on('unhandledRejection', onUnhandled);
    try {
      await controller.start({ eventTarget: events });
      await controller.loadSnapshot(SESSION_A);
      events.dispatch('mailflow:compose-session-updated', {
        sessionId: SESSION_A, clientId: 'other-browser', revision: 4,
      });
      await controller.whenIdle();
      await new Promise(resolve => globalThis.setTimeout(resolve, 0));

      const failed = controller.getSnapshot().sessions[0];
      assert.deepEqual(unhandled, []);
      assert.equal(failed.needsSnapshot, true);
      assert.equal(failed.remoteRevision, 4);

      events.dispatch('mailflow:compose-session-updated', {
        sessionId: SESSION_A, clientId: 'other-browser', revision: 5,
      });
      await controller.whenIdle();
      const recovered = controller.getSnapshot().sessions[0];
      assert.equal(listCalls, 3);
      assert.equal(getCalls, 2);
      assert.equal(recovered.presentationState, 'expanded');
      assert.equal(recovered.revision, 5);
      assert.equal(recovered.needsSnapshot, false);
      assert.equal(recovered.remoteRevision, null);
    } finally {
      controller.destroy();
      await Promise.resolve();
      await Promise.resolve();
      globalThis.process.off('unhandledRejection', onUnhandled);
    }
  });

  it('loads an externally restored minimized session after its refreshed summary becomes visible', async () => {
    const events = fakeEventTarget();
    let serverSnapshot = snapshot({ presentationState: 'expanded', revision: 3 });
    let listCalls = 0;
    let getCalls = 0;
    const { controller } = controllerHarness({
      api: {
        list: async () => {
          listCalls += 1;
          return [summary({
            presentationState: serverSnapshot.presentationState,
            revision: serverSnapshot.revision,
          })];
        },
        get: async () => {
          getCalls += 1;
          return structuredClone(serverSnapshot);
        },
      },
    });
    await controller.start({ eventTarget: events });
    await controller.whenIdle();
    assert.deepEqual(
      controller.getSnapshot().visibleSessions.map(item => item.id),
      [SESSION_A],
    );

    serverSnapshot = snapshot({ presentationState: 'minimized', revision: 4 });
    events.dispatch('mailflow:compose-session-updated', {
      sessionId: SESSION_A, clientId: 'other-browser', revision: 4,
    });
    await controller.whenIdle();
    assert.deepEqual(controller.getSnapshot().visibleSessions, []);
    assert.deepEqual(
      controller.getSnapshot().chipSessions.map(item => item.id),
      [SESSION_A],
    );
    const getsAfterMinimize = getCalls;

    serverSnapshot = snapshot({ presentationState: 'expanded', revision: 5 });
    events.dispatch('mailflow:compose-session-updated', {
      sessionId: SESSION_A, clientId: 'other-browser', revision: 5,
    });
    await controller.whenIdle();

    assert.equal(listCalls, 3, 'each invalidation refreshes authoritative summaries');
    assert.equal(getCalls, getsAfterMinimize + 1, 'external restore loads its snapshot');
    assert.deepEqual(
      controller.getSnapshot().visibleSessions.map(item => item.id),
      [SESSION_A],
    );
    assert.deepEqual(controller.getSnapshot().chipSessions, []);
    assert.equal(controller.getSnapshot().sessions[0].presentationState, 'expanded');
    controller.destroy();
  });

  it('retires a pre-restore minimize snapshot before applying an external restore', async () => {
    const minimizedGet = deferred();
    const events = fakeEventTarget();
    let serverSnapshot = snapshot({ presentationState: 'expanded', revision: 3 });
    let listCalls = 0;
    let getCalls = 0;
    const { controller } = controllerHarness({
      api: {
        list: async () => {
          listCalls += 1;
          return [summary({
            presentationState: serverSnapshot.presentationState,
            revision: serverSnapshot.revision,
          })];
        },
        get: async () => {
          getCalls += 1;
          if (getCalls === 2) return minimizedGet.promise;
          return structuredClone(serverSnapshot);
        },
      },
    });
    await controller.start({ eventTarget: events });
    await controller.whenIdle();

    serverSnapshot = snapshot({ presentationState: 'minimized', revision: 4 });
    events.dispatch('mailflow:compose-session-updated', {
      sessionId: SESSION_A, clientId: 'other-browser', revision: 4,
    });
    await until(() => getCalls === 2);

    serverSnapshot = snapshot({ presentationState: 'expanded', revision: 5 });
    events.dispatch('mailflow:compose-session-updated', {
      sessionId: SESSION_A, clientId: 'other-browser', revision: 5,
    });
    await Promise.resolve();
    minimizedGet.resolve(snapshot({ presentationState: 'minimized', revision: 4 }));
    await controller.whenIdle();

    assert.equal(listCalls, 3, 'restore requires a summary started after its invalidation');
    assert.equal(getCalls, 3, 'restore requires a snapshot started after its invalidation');
    assert.deepEqual(
      controller.getSnapshot().visibleSessions.map(item => item.id),
      [SESSION_A],
    );
    assert.equal(controller.getSnapshot().sessions[0].revision, 5);
    controller.destroy();
  });

  it('retires a pre-restore summary request before evaluating external visibility', async () => {
    const staleList = deferred();
    const events = fakeEventTarget();
    let serverSnapshot = snapshot({ presentationState: 'minimized', revision: 3 });
    let listCalls = 0;
    let getCalls = 0;
    const { controller } = controllerHarness({
      api: {
        list: async () => {
          listCalls += 1;
          if (listCalls === 2) return staleList.promise;
          return [summary({
            presentationState: serverSnapshot.presentationState,
            revision: serverSnapshot.revision,
          })];
        },
        get: async () => {
          getCalls += 1;
          return structuredClone(serverSnapshot);
        },
      },
    });
    await controller.start({ eventTarget: events });
    await controller.loadSnapshot(SESSION_A);

    serverSnapshot = snapshot({ presentationState: 'minimized', revision: 4 });
    const olderRefresh = controller.refreshSummaries();
    await until(() => listCalls === 2);
    serverSnapshot = snapshot({ presentationState: 'expanded', revision: 5 });
    events.dispatch('mailflow:compose-session-updated', {
      sessionId: SESSION_A, clientId: 'other-browser', revision: 5,
    });
    staleList.resolve([summary({ presentationState: 'minimized', revision: 4 })]);
    await olderRefresh;
    await controller.whenIdle();

    assert.equal(listCalls, 3, 'restore requires a summary started after its invalidation');
    assert.equal(getCalls, 2, 'fresh expanded summary makes the restore snapshot eligible');
    assert.deepEqual(
      controller.getSnapshot().visibleSessions.map(item => item.id),
      [SESSION_A],
    );
    assert.equal(controller.getSnapshot().sessions[0].revision, 5);
    controller.destroy();
  });

  it('restores only after presentation and an authoritative snapshot refresh', async () => {
    const authoritative = deferred();
    const events = fakeEventTarget();
    const order = [];
    let getCalls = 0;
    let listCalls = 0;
    const { controller } = controllerHarness({
      api: {
        list: async () => {
          listCalls += 1;
          return [summary({ presentationState: 'minimized', revision: listCalls === 1 ? 3 : 4 })];
        },
        get: async () => {
          getCalls += 1;
          order.push(['get', getCalls]);
          if (getCalls === 1) {
            return snapshot({
              presentationState: 'minimized', revision: 3,
              attachments: [{ id: 'attachment-old', filename: 'old.txt' }],
            });
          }
          return authoritative.promise;
        },
        presentation: async (id, revision, state) => {
          order.push(['presentation', revision, state]);
          return {
            ...snapshot({ presentationState: state, revision: 5 }),
            attachments: undefined,
          };
        },
      },
    });
    await controller.start({ eventTarget: events });
    await controller.loadSnapshot(SESSION_A);
    events.dispatch('mailflow:compose-session-updated', {
      sessionId: SESSION_A, clientId: 'other-browser', revision: 4,
    });
    await controller.whenIdle();

    const restoring = controller.restoreSession(SESSION_A);
    await until(() => order.some(call => call[0] === 'presentation'));
    assert.equal(controller.getSnapshot().sessions[0].presentationState, 'minimized');
    assert.deepEqual(order.slice(-2), [['presentation', 3, 'expanded'], ['get', 2]]);
    const beforeOwnEcho = listCalls;
    events.dispatch('mailflow:compose-session-updated', {
      sessionId: SESSION_A, clientId: 'browser-synthetic', revision: 5,
    });
    await until(() => listCalls > beforeOwnEcho);
    authoritative.resolve(snapshot({
      presentationState: 'expanded', revision: 5,
      attachments: [{ id: 'attachment-new', filename: 'new.txt' }],
    }));
    await restoring;

    const restored = controller.getSnapshot().sessions[0];
    assert.equal(getCalls, 2, 'exact own restore echo preserves the authoritative GET');
    assert.equal(restored.presentationState, 'expanded');
    assert.deepEqual(restored.attachments, [
      { id: 'attachment-new', filename: 'new.txt' },
    ]);
    assert.equal(controller.getSnapshot().focusedSessionId, SESSION_A);
    controller.destroy();
  });

  it('does not pretend restore succeeded when authoritative refresh fails', async () => {
    let getCalls = 0;
    const { controller } = controllerHarness({
      api: {
        list: async () => [summary({ presentationState: 'minimized' })],
        get: async () => {
          getCalls += 1;
          if (getCalls === 1) return snapshot({ presentationState: 'minimized' });
          throw Object.assign(new Error('refresh failed'), { status: 503 });
        },
        presentation: async () => snapshot({ presentationState: 'expanded', revision: 4 }),
      },
    });
    await controller.refreshSummaries();
    await controller.loadSnapshot(SESSION_A);
    await assert.rejects(controller.restoreSession(SESSION_A), /refresh failed/);
    const session = controller.getSnapshot().sessions[0];
    assert.equal(session.presentationState, 'minimized');
    assert.equal(session.baseRevision, 4);
    assert.equal(session.status, 'error');
    assert.equal(session.needsSnapshot, true);
    controller.destroy();
  });

  it('retires a pre-presentation GET and applies only the later restore snapshot', async () => {
    const staleGet = deferred();
    const authoritativeGet = deferred();
    const presentation = deferred();
    let getCalls = 0;
    let presentationCalls = 0;
    const { controller } = controllerHarness({
      api: {
        list: async () => [summary({ presentationState: 'minimized' })],
        get: async () => {
          getCalls += 1;
          if (getCalls === 1) return snapshot({ presentationState: 'minimized' });
          if (getCalls === 2) return staleGet.promise;
          return authoritativeGet.promise;
        },
        presentation: async () => {
          presentationCalls += 1;
          return presentation.promise;
        },
      },
    });
    await controller.refreshSummaries();
    await controller.loadSnapshot(SESSION_A);
    const staleRequest = controller.loadSnapshot(SESSION_A, { force: true });
    await until(() => getCalls === 2);

    const restoring = controller.restoreSession(SESSION_A);
    const overlapping = controller.restoreSession(SESSION_A);
    await until(() => presentationCalls === 1);
    presentation.resolve(snapshot({ presentationState: 'expanded', revision: 5 }));
    await until(() => getCalls === 3);
    authoritativeGet.resolve(snapshot({
      presentationState: 'expanded', revision: 6,
      attachments: [{ id: 'attachment-current', filename: 'current.txt' }],
    }));
    await Promise.all([restoring, overlapping]);

    staleGet.resolve(snapshot({
      presentationState: 'minimized', revision: 4,
      attachments: [{ id: 'attachment-stale', filename: 'stale.txt' }],
    }));
    await staleRequest;
    const session = controller.getSnapshot().sessions[0];
    assert.equal(presentationCalls, 1);
    assert.equal(getCalls, 3);
    assert.equal(session.presentationState, 'expanded');
    assert.equal(session.revision, 6);
    assert.deepEqual(session.attachments, [
      { id: 'attachment-current', filename: 'current.txt' },
    ]);
    controller.destroy();
  });

  it('retires delayed recovery hydration owned by a pre-presentation GET', async () => {
    const staleRecovery = deferred();
    const staleHydrationStarted = deferred();
    const memory = recoveryAdapter();
    let recoveryReads = 0;
    let getCalls = 0;
    const adapter = {
      ...memory,
      async get(key) {
        recoveryReads += 1;
        if (recoveryReads === 2) {
          staleHydrationStarted.resolve();
          return staleRecovery.promise;
        }
        return memory.get(key);
      },
    };
    const { controller } = controllerHarness({
      dependencies: { recoveryStore: adapter },
      api: {
        list: async () => [summary({ presentationState: 'minimized' })],
        get: async () => {
          getCalls += 1;
          if (getCalls === 1) return snapshot({ presentationState: 'minimized' });
          if (getCalls === 2) return snapshot({ presentationState: 'minimized', revision: 4 });
          return snapshot({ presentationState: 'expanded', revision: 6 });
        },
        presentation: async () => snapshot({ presentationState: 'expanded', revision: 5 }),
      },
    });
    await controller.refreshSummaries();
    await controller.loadSnapshot(SESSION_A);
    const staleRequest = controller.loadSnapshot(SESSION_A, { force: true });
    await staleHydrationStarted.promise;

    await controller.restoreSession(SESSION_A);
    staleRecovery.resolve({
      key: `${USER_ID}:${SESSION_A}`,
      userId: USER_ID,
      sessionId: SESSION_A,
      baseRevision: 2,
      changes: { subject: 'Recovered stale subject' },
      updatedAt: Date.now(),
    });
    await staleRequest;

    const session = controller.getSnapshot().sessions[0];
    assert.equal(session.presentationState, 'expanded');
    assert.equal(session.baseRevision, 6);
    assert.equal(session.status, 'clean');
    assert.deepEqual(session.localChanges, {});
    assert.equal(session.recoveryConflict, null);
    controller.destroy();
  });

  it('creates no post-destroy work when a patch resolves late', async () => {
    const patch = deferred();
    let patchCalls = 0;
    const { controller, timers, adapter } = controllerHarness({
      api: {
        patch: async () => {
          patchCalls += 1;
          return patch.promise;
        },
      },
    });
    await controller.refreshSummaries();
    await controller.loadSnapshot(SESSION_A);
    controller.changeSession(SESSION_A, { subject: 'Pending save' });
    let notifications = 0;
    controller.subscribe(() => { notifications += 1; });
    const saving = controller.flushSession(SESSION_A);
    await until(() => patchCalls === 1);
    const beforeDestroyNotifications = notifications;
    const beforeDestroyRecoveryCalls = adapter.calls.length;
    controller.destroy();
    patch.resolve(snapshot({ subject: 'Pending save', revision: 4 }));
    await saving;

    assert.equal(patchCalls, 1);
    assert.equal(timers.pending.size, 0);
    assert.equal(notifications, beforeDestroyNotifications);
    assert.equal(adapter.calls.length, beforeDestroyRecoveryCalls);
  });

  it('creates no post-destroy timer or mutation when recovery hydration resolves late', async () => {
    const recoveryRead = deferred();
    const recoveryStarted = deferred();
    let patchCalls = 0;
    const adapter = {
      async get() { recoveryStarted.resolve(); return recoveryRead.promise; },
      async put() {},
      async delete() {},
    };
    const { controller, timers } = controllerHarness({
      api: { patch: async () => { patchCalls += 1; return snapshot({ revision: 4 }); } },
      dependencies: { recoveryStore: adapter },
    });
    await controller.refreshSummaries();
    const loading = controller.loadSnapshot(SESSION_A);
    await recoveryStarted.promise;
    let notifications = 0;
    controller.subscribe(() => { notifications += 1; });
    controller.destroy();
    recoveryRead.resolve({
      key: `${USER_ID}:${SESSION_A}`,
      userId: USER_ID,
      sessionId: SESSION_A,
      baseRevision: 3,
      changes: { subject: 'Late recovery' },
      updatedAt: Date.now(),
    });
    await loading;
    await controller.whenIdle();

    assert.equal(patchCalls, 0);
    assert.equal(timers.pending.size, 0);
    assert.equal(notifications, 0);
    assert.deepEqual(controller.getSnapshot().sessions[0].localChanges, {});
  });

  it('cleans up timers, invalidation listeners, and ResizeObserver', async () => {
    const events = fakeEventTarget();
    const observerCalls = [];
    class FakeResizeObserver {
      constructor(callback) { this.callback = callback; }
      observe(element) { observerCalls.push(['observe', element]); }
      disconnect() { observerCalls.push(['disconnect']); }
    }
    const workspaceElement = { getBoundingClientRect: () => ({ width: 940 }) };
    const { controller, timers } = controllerHarness({
      dependencies: { ResizeObserver: FakeResizeObserver },
    });
    await controller.start({ eventTarget: events, workspaceElement });
    controller.changeSession(SESSION_A, { body: 'Pending' });
    assert.equal(events.listeners.size, 1);
    assert.equal(timers.pending.size, 1);
    controller.destroy();
    assert.equal(events.listeners.size, 0);
    assert.equal(timers.pending.size, 0);
    assert.deepEqual(observerCalls, [['observe', workspaceElement], ['disconnect']]);
  });

  it('persists a dirty editor before responsive overflow makes it a chip', async () => {
    const { controller, adapter } = controllerHarness({
      api: {
        list: async () => [
          summary(),
          summary({ id: SESSION_B, slot: 2 }),
        ],
        get: async id => snapshot({ id, slot: id === SESSION_A ? 1 : 2 }),
      },
    });
    await controller.setCapacity(2);
    await controller.refreshSummaries();
    await Promise.all([
      controller.loadSnapshot(SESSION_A),
      controller.loadSnapshot(SESSION_B),
    ]);
    controller.changeSession(SESSION_B, { body: 'Local overflow body' });
    await controller.setCapacity(1);

    assert.equal(controller.getSnapshot().capacity, 1);
    assert.equal(controller.getSnapshot().chipSessions[0].id, SESSION_B);
    assert.deepEqual([...adapter.records.values()][0].changes, {
      body: 'Local overflow body',
    });
    controller.destroy();
  });

  it('normalizes legacy reply payloads at the compatibility boundary', async () => {
    let payload;
    const { controller } = controllerHarness({
      api: {
        create: async data => {
          payload = data;
          return snapshot({ revision: 1, ...data.changes });
        },
      },
    });
    await controller.createSession({
      isReply: true,
      to: [{ name: 'Synthetic Sender', email: 'sender@example.com' }],
      references: '<synthetic-a> <synthetic-b>',
      subject: 'Synthetic reply',
      allRecipients: [{ name: 'Synthetic Copied', email: 'copied@example.com' }],
    });
    assert.deepEqual(payload, {
      replyAllRecipients: ['Synthetic Copied <copied@example.com>'],
      changes: {
        mode: 'reply',
        to: ['Synthetic Sender <sender@example.com>'],
        references: ['<synthetic-a>', '<synthetic-b>'],
        subject: 'Synthetic reply',
      },
      clientId: 'browser-synthetic',
    });
    controller.destroy();
  });

  it('restores queued send authoritatively, refreshes summaries, and focuses it', async () => {
    const calls = [];
    const restored = snapshot({ id: SESSION_B, slot: 2, revision: 1 });
    const { controller } = controllerHarness({
      api: {
        restoreQueuedSend: async (outboxId) => {
          calls.push(['restore', outboxId]);
          return { restored: true, replayed: false, session: restored };
        },
        list: async () => {
          calls.push(['list']);
          return [summary(), summary({ id: SESSION_B, slot: 2, revision: 1 })];
        },
        get: async (id) => {
          calls.push(['get', id]);
          return id === SESSION_B ? restored : snapshot();
        },
      },
    });

    const result = await controller.undoQueuedSend('outbox-synthetic');

    assert.equal(result.session.id, SESSION_B);
    assert.equal(controller.getSnapshot().focusedSessionId, SESSION_B);
    assert.equal(controller.getSnapshot().sessions.find(item => item.id === SESSION_B).revision, 1);
    assert.deepEqual(calls.slice(0, 2), [
      ['restore', 'outbox-synthetic'],
      ['list'],
    ]);
    assert.deepEqual(calls.at(-1), ['get', SESSION_B]);
    controller.destroy();
  });

  it('never rehydrates stale terminal recovery over an authoritative queued restore', async () => {
    const memory = recoveryAdapter();
    memory.records.set(`${USER_ID}:${SESSION_B}`, {
      key: `${USER_ID}:${SESSION_B}`,
      userId: USER_ID,
      sessionId: SESSION_B,
      baseRevision: 3,
      changes: { subject: 'Stale pre-send subject' },
      updatedAt: Date.now(),
    });
    const adapter = {
      ...memory,
      async delete() { throw Object.assign(new Error('storage unavailable'), { code: 'delete_failed' }); },
    };
    const restored = snapshot({ id: SESSION_B, slot: 2, revision: 1, subject: 'Restored subject' });
    const { controller, timers } = controllerHarness({
      dependencies: { recoveryStore: adapter },
      api: {
        restoreQueuedSend: async () => ({ restored: true, replayed: false, session: restored }),
        list: async () => [summary({ id: SESSION_B, slot: 2, revision: 1 })],
        get: async () => restored,
      },
    });

    await controller.undoQueuedSend('outbox-synthetic');
    await controller.whenIdle();

    const session = controller.getSnapshot().sessions[0];
    assert.equal(session.subject, 'Restored subject');
    assert.deepEqual(session.localChanges, {});
    assert.equal(session.recoveryConflict, null);
    assert.equal(timers.pending.size, 0);
    controller.destroy();
  });

  it('retires a pre-restore summary response before requiring a fresh list and snapshot', async () => {
    const staleList = deferred();
    let listCalls = 0;
    const events = [];
    const restored = snapshot({ id: SESSION_B, slot: 2, revision: 1, subject: 'Restored subject' });
    const { controller } = controllerHarness({
      api: {
        list: async () => {
          listCalls += 1;
          events.push(['list', listCalls]);
          if (listCalls === 1) return staleList.promise;
          return [summary({ id: SESSION_B, slot: 2, revision: 1 })];
        },
        restoreQueuedSend: async () => {
          events.push(['restore']);
          return { restored: true, replayed: false, session: restored };
        },
        get: async (id) => {
          events.push(['get', id]);
          return restored;
        },
      },
    });

    const staleRefresh = controller.refreshSummaries();
    await until(() => listCalls === 1);
    const undoing = controller.undoQueuedSend('outbox-synthetic');
    await until(() => events.some(([event]) => event === 'restore'));
    assert.equal(listCalls, 1);

    staleList.resolve([summary({ id: SESSION_A, subject: 'Stale summary' })]);
    await staleRefresh;
    const result = await undoing;

    assert.equal(listCalls, 2);
    assert.equal(result.session.id, SESSION_B);
    assert.equal(result.session.subject, 'Restored subject');
    assert.equal(controller.getSnapshot().focusedSessionId, SESSION_B);
    assert.deepEqual(controller.getSnapshot().sessions.map(session => session.id), [SESSION_B]);
    assert.deepEqual(events, [
      ['list', 1],
      ['restore'],
      ['list', 2],
      ['get', SESSION_B],
    ]);
    controller.destroy();
  });

  it('deduplicates overlapping undo replay calls by outbox id', async () => {
    const restore = deferred();
    let restoreCalls = 0;
    const restored = snapshot({ id: SESSION_B, slot: 2, revision: 1 });
    const { controller } = controllerHarness({
      api: {
        restoreQueuedSend: async () => {
          restoreCalls += 1;
          return restore.promise;
        },
        list: async () => [summary({ id: SESSION_B, slot: 2, revision: 1 })],
        get: async () => restored,
      },
    });

    const first = controller.undoQueuedSend('outbox-synthetic');
    const second = controller.undoQueuedSend('outbox-synthetic');
    assert.equal(restoreCalls, 1);
    restore.resolve({ restored: true, replayed: false, session: restored });

    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(firstResult.session.id, SESSION_B);
    assert.equal(secondResult.session.id, SESSION_B);
    assert.equal(restoreCalls, 1);
    assert.equal(controller.getSnapshot().focusedSessionId, SESSION_B);
    controller.destroy();
  });
});

describe('compose store compatibility actions', () => {
  const original = {};

  beforeEach(() => {
    const state = useStore.getState();
    for (const key of [
      'composeWorkspaceController', 'focusedComposeSessionId',
    ]) original[key] = state[key];
    useStore.setState({ composeWorkspaceController: null, focusedComposeSessionId: null });
  });

  afterEach(() => useStore.setState(original));

  it('delegates legacy create, draft claim, and explicit close asynchronously', async () => {
    const calls = [];
    const controller = {
      createSession: async data => { calls.push(['create', data]); return 'created'; },
      claimDraft: async data => { calls.push(['claim', data]); return 'claimed'; },
      closeSession: async id => { calls.push(['close', id]); return 'closed'; },
    };
    useStore.getState().setComposeWorkspaceController(controller);

    assert.equal(await useStore.getState().openCompose({ subject: 'Synthetic' }), 'created');
    assert.equal(await useStore.getState().openCompose({
      accountId: 'account-a', draftFolder: 'Drafts', draftUid: 7,
    }), 'claimed');
    assert.equal(await useStore.getState().closeCompose(SESSION_A), 'closed');
    assert.deepEqual(calls, [
      ['create', { subject: 'Synthetic' }],
      ['claim', { accountId: 'account-a', folder: 'Drafts', uid: 7 }],
      ['close', SESSION_A],
    ]);
    assert.equal(Object.hasOwn(useStore.getState(), 'composing'), false);
    assert.equal(Object.hasOwn(useStore.getState(), 'composeData'), false);
  });

  it('queues cold-start compose requests in order and replays each exactly once', async () => {
    const create = deferred();
    const claim = deferred();
    const calls = [];
    const controller = {
      createSession: data => { calls.push(['create', data]); return create.promise; },
      claimDraft: data => { calls.push(['claim', data]); return claim.promise; },
    };

    const first = useStore.getState().openCompose({ subject: 'First' });
    const second = useStore.getState().openCompose({
      accountId: 'account-a', draftFolder: 'Drafts', draftUid: 7,
    });
    await Promise.resolve();
    assert.deepEqual(calls, []);

    useStore.getState().setComposeWorkspaceController(controller);
    await until(() => calls.length === 1);
    assert.deepEqual(calls, [['create', { subject: 'First' }]]);

    useStore.getState().clearComposeWorkspaceController(controller);
    create.resolve('created');
    assert.equal(await first, 'created');
    await Promise.resolve();
    assert.equal(calls.length, 1, 'detached controller must not receive the next request');

    useStore.getState().setComposeWorkspaceController(controller);
    await until(() => calls.length === 2);
    assert.deepEqual(calls[1], ['claim', { accountId: 'account-a', folder: 'Drafts', uid: 7 }]);
    claim.resolve('claimed');
    assert.equal(await second, 'claimed');
    assert.equal(calls.length, 2, 'queued requests must not be duplicated');
  });

  it('rejects a queued compose request with the controller failure', async () => {
    const failure = new Error('synthetic create failure');
    const request = useStore.getState().openCompose({ subject: 'Rejected' });
    useStore.getState().setComposeWorkspaceController({
      createSession: async () => { throw failure; },
    });
    await assert.rejects(request, error => error === failure);
  });

  it('bounds cold-start compose requests without disturbing the accepted FIFO queue', async () => {
    const accepted = Array.from({ length: 32 }, (_, index) => (
      useStore.getState().openCompose({ subject: `Queued ${index + 1}` })
    ));
    await assert.rejects(
      useStore.getState().openCompose({ subject: 'Overflow' }),
      error => error?.code === 'compose_request_queue_full',
    );

    const calls = [];
    useStore.getState().setComposeWorkspaceController({
      createSession: async data => { calls.push(data.subject); return data.subject; },
    });
    assert.deepEqual(await Promise.all(accepted),
      Array.from({ length: 32 }, (_, index) => `Queued ${index + 1}`));
    assert.deepEqual(calls, Array.from({ length: 32 }, (_, index) => `Queued ${index + 1}`));
  });

  it('cancels queued compose requests when the authenticated user changes', async () => {
    useStore.setState({ user: { id: 'synthetic-user-a' } });
    const request = useStore.getState().openCompose({ subject: 'Private draft' });
    let observed = null;
    request.catch(error => { observed = error; });
    useStore.getState().setUser({ id: 'synthetic-user-b' });
    await Promise.resolve();

    // Drain the request under the current implementation so a RED assertion cannot
    // contaminate the following store tests with module-scoped queue state.
    useStore.getState().setComposeWorkspaceController({
      createSession: async () => 'drained',
    });
    await request.catch(() => null);
    useStore.setState({ user: null });

    assert.equal(observed?.code, 'compose_request_cancelled');
  });

  it('cancels dispatched old-user work and lets only a replacement serve the new user', async () => {
    const oldCreate = deferred();
    const oldCalls = [];
    let oldDestroyCalls = 0;
    useStore.setState({ user: { id: 'synthetic-user-a' } });
    useStore.getState().setComposeWorkspaceController({
      createSession: data => {
        oldCalls.push(data.subject);
        return oldCreate.promise;
      },
      destroy: () => { oldDestroyCalls += 1; },
    });

    const dispatched = useStore.getState().openCompose({ subject: 'Old dispatched' });
    const queued = useStore.getState().openCompose({ subject: 'Old queued' });
    await until(() => oldCalls.length === 1);
    let dispatchedError = null;
    let queuedError = null;
    dispatched.catch(error => { dispatchedError = error; });
    queued.catch(error => { queuedError = error; });

    useStore.getState().setUser({ id: 'synthetic-user-b' });
    await Promise.resolve();
    await Promise.resolve();
    try {
      assert.equal(dispatchedError?.code, 'compose_request_cancelled');
      assert.equal(queuedError?.code, 'compose_request_cancelled');
      assert.equal(oldDestroyCalls, 1);
      assert.equal(useStore.getState().composeWorkspaceController, null);

      const replacementCalls = [];
      const replacement = {
        createSession: async data => {
          replacementCalls.push(data.subject);
          return `new:${data.subject}`;
        },
      };
      useStore.getState().setComposeWorkspaceController(replacement);
      assert.equal(
        await useStore.getState().openCompose({ subject: 'New request' }),
        'new:New request',
      );

      oldCreate.resolve('must-stay-quarantined');
      await Promise.resolve();
      await Promise.resolve();
      assert.deepEqual(oldCalls, ['Old dispatched']);
      assert.deepEqual(replacementCalls, ['New request']);
      assert.equal(useStore.getState().composeWorkspaceController, replacement);
    } finally {
      oldCreate.resolve('red-cleanup');
      await Promise.allSettled([dispatched, queued]);
      await Promise.resolve();
      await Promise.resolve();
      useStore.setState({ user: null });
    }
  });

  it('quarantines a late old-controller rejection without an unhandled rejection', async () => {
    const oldCreate = deferred();
    const unhandled = [];
    const onUnhandled = reason => unhandled.push(reason);
    let createCalls = 0;
    globalThis.process.on('unhandledRejection', onUnhandled);
    useStore.setState({ user: { id: 'synthetic-user-a' } });
    useStore.getState().setComposeWorkspaceController({
      createSession: () => {
        createCalls += 1;
        return oldCreate.promise;
      },
      destroy: () => {},
    });
    const request = useStore.getState().openCompose({ subject: 'Old rejection' });
    let cancellationError = null;
    request.catch(error => { cancellationError = error; });
    await until(() => createCalls === 1);

    try {
      useStore.getState().setUser({ id: 'synthetic-user-b' });
      await Promise.resolve();
      await Promise.resolve();
      assert.equal(cancellationError?.code, 'compose_request_cancelled');
      oldCreate.reject(new Error('synthetic private server rejection'));
      await new Promise(resolve => globalThis.setTimeout(resolve, 0));
      assert.deepEqual(unhandled, []);
    } finally {
      oldCreate.reject(new Error('red cleanup rejection'));
      await Promise.allSettled([request, oldCreate.promise]);
      await Promise.resolve();
      await Promise.resolve();
      globalThis.process.off('unhandledRejection', onUnhandled);
      useStore.setState({ user: null });
    }
  });

  it('reports a cancelled old-user compose command as failed, never successful', async () => {
    const oldCreate = deferred();
    let createCalls = 0;
    useStore.setState({ user: { id: 'synthetic-user-a' } });
    useStore.getState().setComposeWorkspaceController({
      createSession: () => {
        createCalls += 1;
        return oldCreate.promise;
      },
      destroy: () => {},
    });
    const commandContext = {
      surface: 'list', draft: null, composeSlots: [], accountId: null,
      activeConversationId: null, selectedConversationIds: [], conversationsById: {},
      platform: 'linux', shortcutOverrides: {}, translate: key => key,
    };
    const commandController = createCommandController({
      registry: createCommandRegistry(composeSessionCommandDefinitions),
      getContext: () => commandContext,
      executors: createComposeSessionCommandExecutors({
        getController: () => useStore.getState().composeWorkspaceController,
        openCompose: data => useStore.getState().openCompose(data),
      }),
    });
    let observedOutcome = null;
    const execution = commandController.execute('compose.new', {
      source: 'test', input: { subject: 'Old command' },
    });
    execution.then(outcome => { observedOutcome = outcome; });
    await until(() => createCalls === 1);

    useStore.getState().setUser({ id: 'synthetic-user-b' });
    try {
      await until(() => observedOutcome !== null);
      assert.equal(observedOutcome?.status, 'failed');
      assert.equal(observedOutcome?.error?.code, 'compose_request_cancelled');
    } finally {
      oldCreate.resolve('must-not-be-command-success');
      await execution;
      useStore.setState({ user: null });
    }
  });

  it('does not let stale cleanup clear a replacement controller', () => {
    const first = {};
    const second = {};
    useStore.getState().setComposeWorkspaceController(first);
    useStore.getState().setComposeWorkspaceController(second);
    useStore.getState().clearComposeWorkspaceController(first);
    assert.equal(useStore.getState().composeWorkspaceController, second);
  });
});
