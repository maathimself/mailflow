import { describe, expect, it, vi } from 'vitest';

import {
  advanceDiscoveredBookState,
  applyConfirmedRemoteContact,
  applyRemoteTombstone,
  lockCarddavMapping,
  persistDiscoveredBook,
  persistPendingMutationIntent,
  persistDeniedBookCapability,
  refreshUnresolvedConflict,
} from './carddavMappingState.js';
import * as mappingState from './carddavMappingState.js';

const USER_ID = '00000000-0000-4000-8000-000000000001';
const BOOK_ID = '00000000-0000-4000-8000-000000000002';
const CONTACT_ID = '00000000-0000-4000-8000-000000000003';
const CONFLICT_ID = '00000000-0000-4000-8000-000000000004';
const HREF = 'https://dav.example.test/addressbooks/default/contact.vcf';

function change(overrides = {}) {
  return {
    addressBookId: BOOK_ID,
    href: HREF,
    expectedMappingRevision: '7',
    remoteEtag: '"remote-2"',
    vcard: 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:contact\r\nFN:Remote\r\nEND:VCARD\r\n',
    primaryEmail: 'remote@example.test',
    localContactId: CONTACT_ID,
    vcardVersion: '3.0',
    remoteSemanticHash: 'remote-hash-2',
    localContactHash: 'local-hash-2',
    ...overrides,
  };
}

describe('lockCarddavMapping', () => {
  it('locks the mapping and linked contact for the owned identity', async () => {
    const mapping = { href: HREF, mapping_revision: '7', contact_id: CONTACT_ID };
    const client = { query: vi.fn(async () => ({ rows: [mapping] })) };
    await expect(lockCarddavMapping(client, {
      userId: USER_ID, addressBookId: BOOK_ID, href: HREF,
    })).resolves.toEqual(mapping);
    expect(client.query).toHaveBeenCalledWith(
      expect.stringMatching(/FOR UPDATE OF mapping, contact/),
      [BOOK_ID, HREF, USER_ID],
    );
  });
});

describe('mapping revision compare-and-commit', () => {
  it('persists one bounded update intent while advancing the locked mapping revision', async () => {
    const pendingStartedAt = '2026-07-12 12:00:00.123456+00';
    const client = { query: vi.fn(async sql => {
      if (sql.includes('FOR UPDATE OF mapping, contact')) {
        return { rows: [{
          ...change(),
          mapping_revision: '7',
          pending_operation: null,
        }] };
      }
      return { rows: [{ mapping_revision: '8', pending_started_at: pendingStartedAt }], rowCount: 1 };
    }) };

    await expect(persistPendingMutationIntent(client, {
      userId: USER_ID,
      addressBookId: BOOK_ID,
      href: HREF,
      expectedMappingRevision: '7',
      operation: 'update',
      pendingVCard: change().vcard,
      pendingLocalHash: 'local-hash-before',
      pendingRemoteSemanticHash: 'remote-hash-2',
    })).resolves.toEqual({ ok: true, mappingRevision: '8', pendingStartedAt });

    const update = client.query.mock.calls.find(([sql]) => (
      sql.includes('UPDATE carddav_remote_objects')
    ));
    expect(update[0]).toMatch(/pending_operation = \$4[\s\S]+pending_started_at = NOW\(\)/);
    expect(update[0]).toContain("mapping_status = 'pending_push'");
    expect(update[0]).toContain('mapping_revision = mapping_revision + 1');
    expect(update[1]).toEqual([
      BOOK_ID,
      HREF,
      '7',
      'update',
      change().vcard,
      'local-hash-before',
      'remote-hash-2',
    ]);
  });

  it('rejects a pending update vCard one byte over 1 MiB before locking the mapping', async () => {
    const client = { query: vi.fn() };
    const oversized = `BEGIN:VCARD\r\n${'X'.repeat(1024 * 1024)}\r\nEND:VCARD\r\n`;
    expect(Buffer.byteLength(oversized, 'utf8')).toBeGreaterThan(1024 * 1024);

    await expect(persistPendingMutationIntent(client, {
      userId: USER_ID,
      addressBookId: BOOK_ID,
      href: HREF,
      expectedMappingRevision: '7',
      operation: 'update',
      pendingVCard: oversized,
      pendingLocalHash: 'local-hash-before',
      pendingRemoteSemanticHash: 'remote-hash-2',
    })).rejects.toMatchObject({ code: 'ERR_CARDDAV_PENDING_INTENT_TOO_LARGE' });
    // Rejected by the size gate before any lock query touches the database.
    expect(client.query).not.toHaveBeenCalled();
  });

  it('admits a pending update vCard at exactly 1 MiB past the size gate to the mapping lock', async () => {
    const client = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
    const frame = Buffer.byteLength('BEGIN:VCARD\r\n\r\nEND:VCARD\r\n', 'utf8');
    const exact = `BEGIN:VCARD\r\n${'X'.repeat(1024 * 1024 - frame)}\r\nEND:VCARD\r\n`;
    expect(Buffer.byteLength(exact, 'utf8')).toBe(1024 * 1024);

    // Exactly at the limit passes the size gate and reaches the mapping lock, which
    // reports the mapping stale here (rows: []) rather than raising the size error.
    await expect(persistPendingMutationIntent(client, {
      userId: USER_ID,
      addressBookId: BOOK_ID,
      href: HREF,
      expectedMappingRevision: '7',
      operation: 'update',
      pendingVCard: exact,
      pendingLocalHash: 'local-hash-before',
      pendingRemoteSemanticHash: 'remote-hash-2',
    })).resolves.toMatchObject({ ok: false });
    expect(client.query).toHaveBeenCalled();
  });

  it('rejects a second intent while the locked mapping already has one', async () => {
    const client = { query: vi.fn(async () => ({ rows: [{
      mapping_revision: '7',
      pending_operation: 'delete',
      pending_started_at: new Date('2026-07-01T00:00:00.000Z'),
    }] })) };

    await expect(persistPendingMutationIntent(client, {
      userId: USER_ID,
      addressBookId: BOOK_ID,
      href: HREF,
      expectedMappingRevision: '7',
      operation: 'update',
      pendingVCard: change().vcard,
      pendingLocalHash: 'local-hash-before',
      pendingRemoteSemanticHash: 'remote-hash-2',
    })).rejects.toMatchObject({ code: 'ERR_CARDDAV_PENDING_INTENT' });

    expect(client.query).toHaveBeenCalledOnce();
  });

  it('restores only the matching pending intent to its exact confirmed mapping state', async () => {
    const previousUpdatedAt = new Date('2026-07-12T11:59:00.000Z');
    const pendingStartedAt = '2026-07-12 12:00:00.123456+00';
    const client = { query: vi.fn(async () => ({
      rows: [{ mapping_revision: '7' }],
      rowCount: 1,
    })) };

    await expect(mappingState.restorePendingMutationIntent(client, {
      addressBookId: BOOK_ID,
      href: HREF,
      expectedMappingRevision: '8',
      operation: 'update',
      pendingVCard: change().vcard,
      pendingLocalHash: 'local-hash-before',
      pendingRemoteSemanticHash: 'remote-hash-2',
      pendingStartedAt,
      previousMappingStatus: 'synced',
      previousMappingRevision: '7',
      previousUpdatedAt,
    })).resolves.toEqual({ ok: true, mappingRevision: '7' });

    expect(client.query).toHaveBeenCalledWith(
      expect.stringMatching(
        /UPDATE carddav_remote_objects[\s\S]+mapping_status = \$8[\s\S]+mapping_revision = \$9::bigint[\s\S]+updated_at = \$10[\s\S]+mapping_revision = \$3::bigint[\s\S]+pending_operation = \$4[\s\S]+pending_vcard IS NOT DISTINCT FROM \$5[\s\S]+pending_local_hash IS NOT DISTINCT FROM \$6[\s\S]+pending_remote_semantic_hash IS NOT DISTINCT FROM \$7[\s\S]+pending_started_at = \$11::timestamptz/,
      ),
      [
        BOOK_ID,
        HREF,
        '8',
        'update',
        change().vcard,
        'local-hash-before',
        'remote-hash-2',
        'synced',
        '7',
        previousUpdatedAt,
        pendingStartedAt,
      ],
    );
  });

  it('reports a stale rollback fence without clobbering an intervening mapping change', async () => {
    const pendingStartedAt = '2026-07-12 12:00:00.123456+00';
    const client = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };

    await expect(mappingState.restorePendingMutationIntent(client, {
      addressBookId: BOOK_ID,
      href: HREF,
      expectedMappingRevision: '8',
      operation: 'delete',
      pendingVCard: null,
      pendingLocalHash: 'local-hash-before',
      pendingRemoteSemanticHash: null,
      pendingStartedAt,
      previousMappingStatus: 'pending_push',
      previousMappingRevision: '7',
      previousUpdatedAt: new Date('2026-07-12T11:59:00.000Z'),
    })).resolves.toEqual({
      ok: false,
      stale: true,
      code: 'ERR_CARDDAV_MAPPING_STALE',
      addressBookId: BOOK_ID,
      href: HREF,
      expectedMappingRevision: '8',
    });

    expect(client.query).toHaveBeenCalledOnce();
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('pending_started_at = $11::timestamptz'),
      expect.arrayContaining([pendingStartedAt]),
    );
  });

  it('persists a confirmed remote snapshot and returns its incremented revision', async () => {
    const client = { query: vi.fn(async sql => (
      sql.includes('DELETE FROM carddav_conflicts')
        ? { rows: [], rowCount: 0 }
        : { rows: [{ mapping_revision: '8' }], rowCount: 1 }
    )) };
    await expect(applyConfirmedRemoteContact(client, change())).resolves.toEqual({
      ok: true, mappingRevision: '8',
    });
    expect(client.query).toHaveBeenCalledWith(
      expect.stringMatching(
        /UPDATE carddav_remote_objects[\s\S]+mapping_status = 'synced'[\s\S]+mapping_revision = mapping_revision \+ 1[\s\S]+mapping_revision = \$10::bigint[\s\S]+RETURNING mapping_revision::text/,
      ),
      [HREF, '"remote-2"', change().vcard, 'remote@example.test', CONTACT_ID,
        '3.0', 'remote-hash-2', 'local-hash-2', BOOK_ID, '7'],
    );
  });

  it('retains a local-only change as pending push while confirming harmless remote drift', async () => {
    const client = { query: vi.fn(async sql => (
      sql.includes('DELETE FROM carddav_conflicts')
        ? { rows: [], rowCount: 0 }
        : { rows: [{ mapping_revision: '8' }], rowCount: 1 }
    )) };

    await applyConfirmedRemoteContact(client, change({
      mappingStatus: 'pending_push',
      localContactHash: 'confirmed-local-hash',
      supportsPendingIntent: true,
      preservePendingIntent: true,
    }));

    const update = client.query.mock.calls.find(([sql]) => (
      sql.includes('UPDATE carddav_remote_objects')
    ));
    expect(update[0]).toContain("mapping_status = 'pending_push'");
    expect(update[1]).toContain('confirmed-local-hash');
    expect(update[0]).not.toContain('pending_operation = NULL');
  });

  it('clears an unresolved conflict after a public remote-tombstone transition', async () => {
    const client = { query: vi.fn(async sql => (
      sql.includes('DELETE FROM carddav_remote_objects')
        ? { rows: [{ mapping_revision: '7' }], rowCount: 1 }
        : { rows: [], rowCount: 1 }
    )) };

    await expect(applyRemoteTombstone(client, {
      addressBookId: BOOK_ID,
      href: HREF,
      expectedMappingRevision: '7',
    })).resolves.toMatchObject({ ok: true });

    expect(client.query).toHaveBeenCalledWith(
      expect.stringMatching(
        /DELETE FROM carddav_conflicts[\s\S]+status = 'unresolved'/,
      ),
      [BOOK_ID, HREF],
    );
  });

  it.each([
    ['confirmed contact', applyConfirmedRemoteContact, change()],
    ['remote tombstone', applyRemoteTombstone, {
      addressBookId: BOOK_ID, href: HREF, expectedMappingRevision: '7',
    }],
  ])('returns typed stale state for a missed %s revision', async (_case, apply, input) => {
    const client = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
    await expect(apply(client, input)).resolves.toEqual({
      ok: false,
      stale: true,
      code: 'ERR_CARDDAV_MAPPING_STALE',
      addressBookId: BOOK_ID,
      href: HREF,
      expectedMappingRevision: '7',
    });
  });

  it.each([
    ['confirmed contact', applyConfirmedRemoteContact, change({ expectedMappingRevision: undefined })],
    ['remote tombstone', applyRemoteTombstone, { addressBookId: BOOK_ID, href: HREF }],
    ['conflict refresh', refreshUnresolvedConflict, change({ expectedMappingRevision: undefined })],
  ])('requires an expected revision for every %s write', async (_case, apply, input) => {
    const client = { query: vi.fn() };
    await expect(apply(client, input)).rejects.toMatchObject({
      code: 'ERR_CARDDAV_MAPPING_REVISION_REQUIRED',
    });
    expect(client.query).not.toHaveBeenCalled();
  });

  it.each([
    ['confirmed contact', false],
    ['remote tombstone', true],
  ])('owns the conflict transition together with the %s mapping CAS', async (
    _case,
    remoteTombstone,
  ) => {
    const resolved = {
      id: CONFLICT_ID,
      status: 'resolved',
      resolution: 'keep-carddav',
    };
    const client = { query: vi.fn(async sql => {
      if (sql.includes('UPDATE carddav_conflicts')) {
        return { rows: [resolved], rowCount: 1 };
      }
      if (sql.includes('UPDATE carddav_remote_objects')) {
        return { rows: [{ mapping_revision: '8' }], rowCount: 1 };
      }
      if (sql.includes('DELETE FROM carddav_remote_objects')) {
        return { rows: [{ mapping_revision: '7' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }) };

    expect(mappingState.resolveCarddavConflict).toBeTypeOf('function');
    await expect(mappingState.resolveCarddavConflict(client, change({
      conflictId: CONFLICT_ID,
      userId: USER_ID,
      resolution: 'keep-carddav',
      remoteTombstone,
    }))).resolves.toMatchObject({
      ok: true,
      conflict: resolved,
      mappingRevision: remoteTombstone ? '7' : '8',
    });

    const statements = client.query.mock.calls.map(([sql]) => sql);
    const conflictIndex = statements.findIndex(sql => sql.includes('UPDATE carddav_conflicts'));
    const mappingIndex = statements.findIndex(sql => (
      sql.includes(`${remoteTombstone ? 'DELETE FROM' : 'UPDATE'} carddav_remote_objects`)
    ));
    expect(mappingIndex).toBeGreaterThanOrEqual(0);
    expect(conflictIndex).toBeGreaterThan(mappingIndex);
    expect(client.query).toHaveBeenCalledWith(
      expect.stringMatching(/UPDATE carddav_conflicts[\s\S]+status = 'resolved'[\s\S]+status = 'unresolved'/),
      [CONFLICT_ID, 'keep-carddav', USER_ID, BOOK_ID, HREF],
    );
  });
});

describe('refreshUnresolvedConflict', () => {
  it('omits pending-intent columns while refreshing a transitional-schema conflict', async () => {
    const client = { query: vi.fn(async sql => {
      if (sql.includes('UPDATE carddav_remote_objects')) {
        return { rows: [{ mapping_revision: '8' }], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO carddav_conflicts')) {
        return { rows: [{ id: CONFLICT_ID, status: 'unresolved' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }) };

    await refreshUnresolvedConflict(client, change({
      userId: USER_ID,
      localVCard: 'BEGIN:VCARD\r\nFN:Local\r\nEND:VCARD\r\n',
      remoteVCard: change().vcard,
      supportsPendingIntent: false,
    }));

    const update = client.query.mock.calls.find(([sql]) => (
      sql.includes('UPDATE carddav_remote_objects')
    ));
    expect(update[0]).not.toContain('pending_operation');
  });

  it('refreshes the same conflict while advancing the mapping once', async () => {
    const client = { query: vi.fn(async sql => {
      if (sql.includes('UPDATE carddav_remote_objects')) {
        return { rows: [{ mapping_revision: '8' }], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO carddav_conflicts')) {
        return { rows: [{ id: CONFLICT_ID, status: 'unresolved' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }) };
    await expect(refreshUnresolvedConflict(client, change({
      userId: USER_ID,
      baseLocalHash: 'confirmed-local-hash',
      localVCard: 'BEGIN:VCARD\r\nFN:Local\r\nEND:VCARD\r\n',
      remoteVCard: change().vcard,
      localTombstone: false,
      remoteTombstone: false,
    }))).resolves.toEqual({
      ok: true,
      mappingRevision: '8',
      conflict: { id: CONFLICT_ID, status: 'unresolved' },
    });
    const conflictInsert = client.query.mock.calls.find(([sql]) => (
      sql.includes('INSERT INTO carddav_conflicts')
    ));
    expect(conflictInsert[0]).toContain(
      "ON CONFLICT (address_book_id, href) WHERE status = 'unresolved'",
    );
  });

  it('preserves the durable local snapshot while refreshing the remote side', async () => {
    const durableLocalVCard = 'BEGIN:VCARD\r\nFN:Durable Local\r\nEND:VCARD\r\n';
    const client = { query: vi.fn(async sql => {
      if (sql.includes('SELECT local_vcard, local_tombstone')) {
        return { rows: [{
          local_vcard: durableLocalVCard,
          local_tombstone: true,
        }], rowCount: 1 };
      }
      if (sql.includes('UPDATE carddav_remote_objects')) {
        return { rows: [{ mapping_revision: '8' }], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO carddav_conflicts')) {
        return { rows: [{ id: CONFLICT_ID, status: 'unresolved' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }) };

    await refreshUnresolvedConflict(client, change({
      userId: USER_ID,
      baseLocalHash: 'confirmed-local-hash',
      preserveLocalSnapshot: true,
      localVCard: undefined,
      remoteVCard: change().vcard,
      localTombstone: undefined,
      remoteTombstone: false,
    }));

    const conflictInsert = client.query.mock.calls.find(([sql]) => (
      sql.includes('INSERT INTO carddav_conflicts')
    ));
    expect(conflictInsert[0]).not.toMatch(/local_vcard = EXCLUDED\.local_vcard/);
    expect(conflictInsert[0]).not.toMatch(/local_tombstone = EXCLUDED\.local_tombstone/);
    expect(conflictInsert[1].slice(5, 9)).toEqual([
      durableLocalVCard,
      change().vcard,
      true,
      false,
    ]);
    const mappingUpdate = client.query.mock.calls.find(([sql]) => (
      sql.includes('UPDATE carddav_remote_objects')
    ));
    expect(mappingUpdate[0]).toMatch(/pending_operation = NULL[\s\S]+pending_started_at = NULL/);
  });
});

describe('persistDiscoveredBook', () => {
  it('persists capabilities without overwriting sync state', async () => {
    const stored = { id: BOOK_ID, external_url: 'https://dav.example.test/addressbooks/default/' };
    const client = { query: vi.fn(async () => ({ rows: [stored], rowCount: 1 })) };
    await expect(persistDiscoveredBook(client, {
      userId: USER_ID,
      url: stored.external_url,
      displayName: 'Remote',
      capabilities: { create: 'allowed', update: 'denied', delete: 'unknown' },
    })).resolves.toEqual(stored);
    expect(client.query).toHaveBeenCalledWith(
      expect.stringMatching(
        /INSERT INTO address_books[\s\S]+remote_create_capability[\s\S]+ON CONFLICT[\s\S]+remote_create_capability = EXCLUDED.remote_create_capability/,
      ),
      [USER_ID, 'Remote', stored.external_url, 'allowed', 'denied', 'unknown'],
    );
  });

  it('owns a single denied capability update without changing its siblings', async () => {
    const client = { query: vi.fn(async () => ({ rows: [{ id: BOOK_ID }], rowCount: 1 })) };

    await persistDeniedBookCapability(client, {
      userId: USER_ID,
      addressBookId: BOOK_ID,
      capability: 'update',
    });

    expect(client.query).toHaveBeenCalledWith(
      expect.stringMatching(
        /UPDATE address_books[\s\S]+remote_update_capability = 'denied'[\s\S]+WHERE id = \$1 AND user_id = \$2/,
      ),
      [BOOK_ID, USER_ID],
    );
    expect(client.query.mock.calls[0][0]).not.toMatch(/remote_(?:create|delete)_capability =/);
  });

  it('owns guarded remote token and observed-capability advancement', async () => {
    const client = { query: vi.fn(async () => ({ rows: [], rowCount: 1 })) };

    await advanceDiscoveredBookState(client, {
      addressBookId: BOOK_ID,
      expectedRemoteRevision: '4',
      canonicalUrl: 'https://dav.example.test/addressbooks/default/',
      remoteSyncToken: 'opaque-token-2',
      remoteSyncCapability: 'supported',
      remoteProjectionFingerprint: 'projection-fingerprint',
      capabilities: { create: 'allowed', update: 'unknown', delete: 'denied' },
    });

    expect(client.query).toHaveBeenCalledWith(
      expect.stringMatching(
        /UPDATE address_books[\s\S]+remote_sync_token = \$2[\s\S]+remote_create_capability = \$7[\s\S]+remote_sync_revision = \$5::bigint/,
      ),
      [
        BOOK_ID,
        'opaque-token-2',
        'supported',
        'projection-fingerprint',
        '4',
        'https://dav.example.test/addressbooks/default/',
        'allowed',
        'unknown',
        'denied',
      ],
    );
  });
});

describe('assertConflictSnapshotsWithinLimit', () => {
  const HALF = 'x'.repeat(1024 * 1024);

  it('accepts combined local and remote snapshots at exactly 2 MiB', () => {
    expect(() => mappingState.assertConflictSnapshotsWithinLimit({
      localVCard: HALF,
      remoteVCard: HALF,
    })).not.toThrow();
  });

  it('rejects combined snapshots one byte over 2 MiB', () => {
    expect(() => mappingState.assertConflictSnapshotsWithinLimit({
      localVCard: `${HALF}x`,
      remoteVCard: HALF,
    })).toThrow(/2 MiB/);
  });

  it('excludes a tombstoned side from the combined size', () => {
    expect(() => mappingState.assertConflictSnapshotsWithinLimit({
      localVCard: null,
      remoteVCard: 'x'.repeat(2 * 1024 * 1024),
      localTombstone: true,
    })).not.toThrow();
  });
});
