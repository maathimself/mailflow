import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  CARDDAV_RESOLUTIONS,
  CONFLICT_FIELD_LABELS,
  CONFLICT_FIELD_ORDER,
  beginConflictLoad,
  beginConflictResolution,
  completeConflictLoad,
  completeConflictResolution,
  conflictComparison,
  failConflictLoad,
  failConflictResolution,
  initialConflictQueueState,
} from './carddavConflictState.js';
import { api } from './utils/api.js';

describe('CardDAV conflict state', () => {
  const conflicts = [{
    id: 'conflict-1',
    status: 'unresolved',
    local: {
      tombstone: true,
      hasPhoto: false,
      contact: null,
    },
    remote: {
      tombstone: false,
      hasPhoto: true,
      contact: {
        displayName: 'Ada Lovelace',
        firstName: 'Ada',
        lastName: 'Lovelace',
        emails: [
          { value: 'z@example.test', type: 'other', primary: false },
          { value: 'ada@example.test', type: 'work', primary: true },
        ],
        phones: [{ value: '+1 555 0100', type: 'mobile' }],
        organization: 'Analytical Engines',
        notes: 'Remote note',
        additionalFields: [{ id: 'site', kind: 'url', label: 'Website', value: 'https://example.test' }],
      },
    },
  }];

  it('orders normalized comparison fields and represents tombstones and photos without payloads', () => {
    assert.deepEqual(CONFLICT_FIELD_ORDER, [
      'displayName', 'firstName', 'lastName', 'emails', 'phones',
      'organization', 'notes', 'additionalFields', 'photo',
    ]);

    const rows = conflictComparison(conflicts[0]);
    assert.deepEqual(rows.map(row => row.key), CONFLICT_FIELD_ORDER);
    assert.ok(rows.every(row => row.local.kind === 'tombstone'));
    assert.deepEqual(rows.find(row => row.key === 'emails').remote, {
      kind: 'value',
      value: [
        { value: 'ada@example.test', type: 'work', primary: true },
        { value: 'z@example.test', type: 'other', primary: false },
      ],
    });
    assert.deepEqual(rows.at(-1).remote, { kind: 'photo', present: true });
    assert.equal(JSON.stringify(rows).includes('photoData'), false);
    assert.deepEqual(CONFLICT_FIELD_LABELS, {
      displayName: 'contacts.fields.displayName',
      firstName: 'contacts.fields.firstName',
      lastName: 'contacts.fields.lastName',
      emails: 'contacts.fields.email',
      phones: 'contacts.fields.phone',
      organization: 'contacts.fields.organization',
      notes: 'contacts.fields.notes',
      additionalFields: 'contacts.additional.title',
      photo: 'contacts.photo.title',
    });
  });

  it('exposes exactly the two server-supported resolution actions', () => {
    assert.deepEqual(CARDDAV_RESOLUTIONS, ['keep-mailflow', 'keep-carddav']);
  });

  it('keeps the selected comparison open with safe copy when resolution fails', () => {
    const initial = initialConflictQueueState(conflicts, 'conflict-1');
    const pending = beginConflictResolution(initial, 'keep-carddav');
    assert.equal(pending.pendingResolution, 'keep-carddav');

    const failed = failConflictResolution(pending);
    assert.equal(failed.selectedId, 'conflict-1');
    assert.deepEqual(failed.conflicts, conflicts);
    assert.equal(failed.pendingResolution, null);
    assert.equal(failed.errorKey, 'contacts.conflicts.resolveFailed');
    assert.equal(JSON.stringify(failed).includes('private remote response'), false);
  });

  it('does not publish an empty conflict count before the first successful load', () => {
    assert.equal(initialConflictQueueState(null, 'conflict-1').countKnown, false);
    assert.equal(initialConflictQueueState([], 'conflict-1').countKnown, true);
  });

  it('keeps a successful resolution pending until the refreshed queue arrives', () => {
    const queue = initialConflictQueueState([
      ...conflicts,
      { ...conflicts[0], id: 'conflict-2' },
    ], 'conflict-1');
    const pending = beginConflictResolution(queue, 'keep-carddav');
    const applied = completeConflictResolution(pending);

    assert.equal(applied.pendingResolution, 'keep-carddav');
    assert.equal(applied.resolutionApplied, true);
    assert.equal(applied.selectedId, 'conflict-1');
    assert.deepEqual(applied.conflicts, queue.conflicts);

    const loading = beginConflictLoad(applied);
    const refreshed = completeConflictLoad(loading, loading.loadGeneration, [
      { ...conflicts[0], id: 'conflict-2' },
    ], 'conflict-1');

    assert.equal(refreshed.pendingResolution, null);
    assert.equal(refreshed.resolutionApplied, false);
    assert.equal(refreshed.loading, false);
    assert.equal(refreshed.selectedId, 'conflict-2');
  });

  it('ignores an older conflict load after a newer load has completed', () => {
    const initial = initialConflictQueueState(conflicts, 'conflict-1');
    const older = beginConflictLoad(initial);
    const newer = beginConflictLoad(older);
    const newestConflict = { ...conflicts[0], id: 'conflict-newest' };
    const current = completeConflictLoad(
      newer,
      newer.loadGeneration,
      [newestConflict],
      'conflict-newest',
    );

    assert.equal(completeConflictLoad(
      current,
      older.loadGeneration,
      conflicts,
      'conflict-1',
    ), current);
    assert.deepEqual(current.conflicts, [newestConflict]);
  });

  it('keeps safe comparison state when the post-resolution refresh fails', () => {
    const pending = beginConflictResolution(
      initialConflictQueueState(conflicts, 'conflict-1'),
      'keep-mailflow',
    );
    const applied = completeConflictResolution(pending);
    const loading = beginConflictLoad(applied);
    const failed = failConflictLoad(loading, loading.loadGeneration);

    assert.deepEqual(failed.conflicts, conflicts);
    assert.equal(failed.selectedId, 'conflict-1');
    assert.equal(failed.pendingResolution, null);
    assert.equal(failed.resolutionApplied, false);
    assert.equal(failed.loading, false);
    assert.equal(failed.loadError, true);
    assert.equal(failed.errorKey, 'contacts.conflicts.resolveFailed');
  });

  it('uses the exact conflict list and resolution API contracts', async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, options) => {
      calls.push({ url, options });
      return { ok: true, json: async () => ({}) };
    };

    try {
      await api.carddav.getConflicts();
      await api.carddav.resolveConflict('conflict-1', 'keep-mailflow');
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.deepEqual(calls.map(({ url, options }) => [url, options.method]), [
      ['/api/carddav/conflicts', 'GET'],
      ['/api/carddav/conflicts/conflict-1/resolve', 'POST'],
    ]);
    assert.equal(calls[1].options.body, JSON.stringify({ resolution: 'keep-mailflow' }));
  });
});
