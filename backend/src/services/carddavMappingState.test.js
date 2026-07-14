import { describe, expect, it, vi } from 'vitest';

import {
  advanceDiscoveredBookState,
  applyConfirmedRemoteContact,
  applyRemoteTombstone,
  claimBestWriteTargetCandidate,
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
  it('persists capabilities on an already-discovered book without touching its role flags or sync state', async () => {
    // Matched by URL (findDiscoveredBookByUrl) — never a fresh INSERT, and
    // never touches is_write_target/is_subscribed/external_url: those are
    // only ever decided once, at first creation.
    const stored = { id: BOOK_ID, external_url: 'https://dav.example.test/addressbooks/default/' };
    const client = {
      query: vi.fn(async sql => {
        if (/SELECT 1 FROM address_books/.test(sql)) return { rows: [] };
        if (/SELECT id FROM address_books/.test(sql)) return { rows: [{ id: BOOK_ID }] };
        return { rows: [stored], rowCount: 1 };
      }),
    };

    await expect(persistDiscoveredBook(client, {
      userId: USER_ID,
      url: stored.external_url,
      displayName: 'Remote',
      capabilities: { create: 'allowed', update: 'denied', delete: 'unknown' },
    })).resolves.toEqual(stored);

    expect(client.query).not.toHaveBeenCalledWith(
      expect.stringMatching(/INSERT INTO address_books/),
      expect.anything(),
    );
    const updateCall = client.query.mock.calls.find(([sql]) => /^UPDATE address_books SET/.test(sql));
    expect(updateCall[0]).toMatch(
      /remote_create_capability = \$2[\s\S]+remote_update_capability = \$3[\s\S]+remote_delete_capability = \$4[\s\S]+WHERE id = \$1/,
    );
    expect(updateCall[0]).not.toMatch(/is_write_target|is_subscribed|external_url\s*=/);
    expect(updateCall[1]).toEqual([BOOK_ID, 'allowed', 'denied', 'unknown']);
  });

  it('resolves an existing book by its discovery alias and updates it instead of inserting a duplicate', async () => {
    // Some CardDAV servers keep advertising a stable "alias" href for a
    // collection whose canonical external_url advanceDiscoveredBookState
    // already rewrote (see carddavContactService.js's selectedCreateBook).
    // Matching only on external_url here would insert a second, non-write-
    // target row for the same remote collection.
    const stored = { id: BOOK_ID, external_url: 'https://dav.example.test/addressbooks/canonical/' };
    const aliasUrl = 'https://dav.example.test/addressbooks/alias/';
    const client = {
      query: vi.fn(async sql => {
        if (/SELECT 1 FROM address_books/.test(sql)) return { rows: [] };
        if (/SELECT id FROM address_books/.test(sql)) return { rows: [{ id: BOOK_ID }] };
        return { rows: [stored], rowCount: 1 };
      }),
    };

    await expect(persistDiscoveredBook(client, {
      userId: USER_ID,
      url: aliasUrl,
      displayName: 'Remote',
      capabilities: { create: 'allowed', update: 'allowed', delete: 'allowed' },
    })).resolves.toEqual(stored);

    expect(client.query).toHaveBeenCalledWith(
      expect.stringMatching(/SELECT id FROM address_books[\s\S]+external_url = \$2 OR discovery_alias_url = \$2/),
      [USER_ID, aliasUrl],
    );
    expect(client.query).not.toHaveBeenCalledWith(
      expect.stringMatching(/INSERT INTO address_books/),
      expect.anything(),
    );
    const updateCall = client.query.mock.calls.find(([sql]) => /^UPDATE address_books SET/.test(sql));
    expect(updateCall[1]).toEqual([BOOK_ID, 'allowed', 'allowed', 'allowed']);
  });

  it('claims the write-target for the first create-capable book a user discovers', async () => {
    const stored = { id: BOOK_ID, external_url: 'https://dav.example.test/addressbooks/default/' };
    const client = {
      query: vi.fn(async sql => {
        if (/SELECT 1 FROM address_books/.test(sql)) return { rows: [] };
        if (/SELECT id FROM address_books/.test(sql)) return { rows: [] };
        if (/INSERT INTO address_books/.test(sql)) return { rows: [stored], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      }),
    };

    await persistDiscoveredBook(client, {
      userId: USER_ID,
      url: stored.external_url,
      displayName: 'Remote',
      capabilities: { create: 'allowed', update: 'allowed', delete: 'allowed' },
    });

    // Every brand-new book is inserted lookup-only (never claims directly,
    // in per-book discovery order) ...
    expect(client.query).toHaveBeenCalledWith(
      expect.stringMatching(
        /INSERT INTO address_books[\s\S]+is_write_target, is_subscribed[\s\S]+VALUES \(\$1,\$2,'carddav',\$3,\$4,\$5,\$6,false,false\)/,
      ),
      [USER_ID, 'Remote', stored.external_url, 'allowed', 'allowed', 'allowed'],
    );
    // ... and claimBestWriteTargetCandidate promotes it afterward, since it's
    // the only (and therefore best) candidate.
    expect(client.query).toHaveBeenCalledWith(
      expect.stringMatching(/is_write_target = true, is_subscribed = true[\s\S]+NOT EXISTS/),
      [USER_ID],
    );
  });

  it('never lets a book claim its own write-target directly, in discovery order', async () => {
    const stored = { id: BOOK_ID, external_url: 'https://dav.example.test/addressbooks/default/' };
    const client = {
      query: vi.fn(async sql => {
        if (/SELECT 1 FROM address_books/.test(sql)) return { rows: [] };
        if (/SELECT id FROM address_books/.test(sql)) return { rows: [] };
        if (/INSERT INTO address_books/.test(sql)) return { rows: [stored], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      }),
    };

    await persistDiscoveredBook(client, {
      userId: USER_ID,
      url: stored.external_url,
      displayName: 'Remote',
      capabilities: { create: 'denied', update: 'denied', delete: 'denied' },
    });

    expect(client.query).toHaveBeenCalledWith(
      expect.stringMatching(
        /INSERT INTO address_books[\s\S]+VALUES \(\$1,\$2,'carddav',\$3,\$4,\$5,\$6,false,false\)/,
      ),
      [USER_ID, 'Remote', stored.external_url, 'denied', 'denied', 'denied'],
    );
    // The claim attempt still runs (it ranks across this user's *whole*
    // snapshot of carddav books, not just this one), but its own ranking
    // excludes denied books, so a lone denied book is never promoted.
    expect(client.query).toHaveBeenCalledWith(
      expect.stringMatching(/remote_create_capability <> 'denied'/),
      [USER_ID],
    );
  });

  it('defers the write-target claim when the caller is batching a discovery snapshot', async () => {
    const stored = { id: BOOK_ID, external_url: 'https://dav.example.test/addressbooks/default/' };
    const client = {
      query: vi.fn(async sql => {
        if (/SELECT 1 FROM address_books/.test(sql)) return { rows: [] };
        if (/SELECT id FROM address_books/.test(sql)) return { rows: [] };
        if (/INSERT INTO address_books/.test(sql)) return { rows: [stored], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      }),
    };

    await persistDiscoveredBook(client, {
      userId: USER_ID,
      url: stored.external_url,
      displayName: 'Remote',
      capabilities: { create: 'allowed', update: 'allowed', delete: 'allowed' },
      deferWriteTargetClaim: true,
    });

    expect(client.query).not.toHaveBeenCalledWith(
      expect.stringMatching(/is_write_target = true, is_subscribed = true/),
      expect.anything(),
    );
  });

  it('retries an unrelated 23505 with the identical name instead of spuriously renaming the book', async () => {
    const stored = { id: BOOK_ID, external_url: 'https://dav.example.test/addressbooks/default/' };
    let insertAttempts = 0;
    const client = {
      query: vi.fn(async sql => {
        if (/SELECT 1 FROM address_books/.test(sql)) return { rows: [] };
        if (/SELECT id FROM address_books/.test(sql)) return { rows: [] };
        if (/INSERT INTO address_books/.test(sql)) {
          insertAttempts += 1;
          if (insertAttempts === 1) {
            // Not a (user_id, name) collision — e.g. a concurrent insert for
            // this same external_url racing this one.
            throw Object.assign(new Error('duplicate key'), {
              code: '23505',
              constraint: 'some_unrelated_constraint',
            });
          }
          return { rows: [stored], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }),
    };

    await expect(persistDiscoveredBook(client, {
      userId: USER_ID,
      url: stored.external_url,
      displayName: 'Remote',
      capabilities: { create: 'allowed', update: 'allowed', delete: 'allowed' },
    })).resolves.toEqual(stored);

    const insertCalls = client.query.mock.calls.filter(([sql]) => /INSERT INTO address_books/.test(sql));
    expect(insertCalls).toHaveLength(2);
    expect(insertCalls[0][1][1]).toBe('Remote');
    expect(insertCalls[1][1][1]).toBe('Remote');
  });

  it('renames only on a genuine display-name collision, retrying with a numbered suffix', async () => {
    const stored = { id: BOOK_ID, external_url: 'https://dav.example.test/addressbooks/default/' };
    let insertAttempts = 0;
    const client = {
      query: vi.fn(async sql => {
        if (/SELECT 1 FROM address_books/.test(sql)) return { rows: [] };
        if (/SELECT id FROM address_books/.test(sql)) return { rows: [] };
        if (/INSERT INTO address_books/.test(sql)) {
          insertAttempts += 1;
          if (insertAttempts === 1) {
            throw Object.assign(new Error('duplicate key'), {
              code: '23505',
              constraint: 'address_books_user_id_name_key',
            });
          }
          return { rows: [stored], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }),
    };

    await expect(persistDiscoveredBook(client, {
      userId: USER_ID,
      url: stored.external_url,
      displayName: 'Remote',
      capabilities: { create: 'allowed', update: 'allowed', delete: 'allowed' },
    })).resolves.toEqual(stored);

    const insertCalls = client.query.mock.calls.filter(([sql]) => /INSERT INTO address_books/.test(sql));
    expect(insertCalls).toHaveLength(2);
    expect(insertCalls[0][1][1]).toBe('Remote');
    expect(insertCalls[1][1][1]).toBe('Remote (2)');
  });

  it('inserts without multi-book role columns on a not-yet-migrated (transitional) schema', async () => {
    const stored = { id: BOOK_ID, external_url: 'https://dav.example.test/addressbooks/default/' };
    const client = {
      query: vi.fn(async sql => {
        if (/SELECT 1 FROM address_books/.test(sql)) {
          throw Object.assign(new Error('column "is_write_target" does not exist'), { code: '42703' });
        }
        return { rows: [stored], rowCount: 1 };
      }),
    };

    await expect(persistDiscoveredBook(client, {
      userId: USER_ID,
      url: stored.external_url,
      displayName: 'Remote',
      capabilities: { create: 'allowed', update: 'allowed', delete: 'allowed' },
    })).resolves.toEqual(stored);

    const insertCall = client.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO address_books'));
    expect(insertCall[0]).not.toMatch(/is_write_target/);
    expect(insertCall[1]).toEqual([USER_ID, 'Remote', stored.external_url, 'allowed', 'allowed', 'allowed']);
    expect(client.query.mock.calls.some(([sql]) => sql === 'ROLLBACK TO SAVEPOINT carddav_multi_book_probe')).toBe(true);
    // No alias lookup on a not-yet-migrated schema (no discovery_alias_url column).
    expect(client.query).not.toHaveBeenCalledWith(
      expect.stringMatching(/SELECT id FROM address_books/),
      expect.anything(),
    );
  });

  it('ranks candidates by capability priority before created_at/id and no-ops once a write-target exists', async () => {
    const client = { query: vi.fn(async () => ({ rows: [], rowCount: 1 })) };

    await claimBestWriteTargetCandidate(client, USER_ID);

    expect(client.query).toHaveBeenCalledWith(
      expect.stringMatching(
        /UPDATE address_books SET[\s\S]+is_write_target = true, is_subscribed = true[\s\S]+remote_create_capability <> 'denied'[\s\S]+ORDER BY \(remote_create_capability = 'allowed'\) DESC, created_at, id[\s\S]+NOT EXISTS[\s\S]+is_write_target = true/,
      ),
      [USER_ID],
    );
  });

  it('swallows a lost write-target race instead of throwing', async () => {
    const client = {
      query: vi.fn(async sql => {
        if (/^UPDATE address_books SET/.test(sql)) {
          throw Object.assign(new Error('duplicate key'), {
            code: '23505',
            constraint: 'carddav_one_write_target_idx',
          });
        }
        return { rows: [], rowCount: 1 };
      }),
    };

    await expect(claimBestWriteTargetCandidate(client, USER_ID)).resolves.toBeUndefined();

    expect(client.query).toHaveBeenCalledWith('ROLLBACK TO SAVEPOINT carddav_write_target_claim');
  });

  it('no-ops on a not-yet-migrated (transitional) schema', async () => {
    const client = {
      query: vi.fn(async sql => {
        if (/^UPDATE address_books SET/.test(sql)) {
          throw Object.assign(new Error('column "is_write_target" does not exist'), { code: '42703' });
        }
        return { rows: [], rowCount: 1 };
      }),
    };

    await expect(claimBestWriteTargetCandidate(client, USER_ID)).resolves.toBeUndefined();

    expect(client.query).toHaveBeenCalledWith('ROLLBACK TO SAVEPOINT carddav_write_target_claim');
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

  it('records the discovery alias a canonical URL rewrite replaces', async () => {
    const client = { query: vi.fn(async () => ({ rows: [], rowCount: 1 })) };

    await advanceDiscoveredBookState(client, {
      addressBookId: BOOK_ID,
      expectedRemoteRevision: '4',
      canonicalUrl: 'https://dav.example.test/addressbooks/canonical/',
      remoteSyncToken: 'opaque-token-2',
      remoteSyncCapability: 'supported',
      remoteProjectionFingerprint: 'projection-fingerprint',
      capabilities: { create: 'allowed', update: 'unknown', delete: 'denied' },
    });

    expect(client.query).toHaveBeenCalledWith(
      expect.stringMatching(/discovery_alias_url = CASE[\s\S]+WHEN \$6 IS NOT NULL AND \$6 <> external_url THEN external_url/),
      [
        BOOK_ID,
        'opaque-token-2',
        'supported',
        'projection-fingerprint',
        '4',
        'https://dav.example.test/addressbooks/canonical/',
        'allowed',
        'unknown',
        'denied',
      ],
    );
  });

  it('advances book state without the alias column on a not-yet-migrated (transitional) schema', async () => {
    let attempt = 0;
    const client = {
      query: vi.fn(async sql => {
        if (sql.includes('UPDATE address_books') && sql.includes('discovery_alias_url')) {
          attempt++;
          throw Object.assign(new Error('column "discovery_alias_url" does not exist'), { code: '42703' });
        }
        return { rows: [], rowCount: 1 };
      }),
    };

    await advanceDiscoveredBookState(client, {
      addressBookId: BOOK_ID,
      expectedRemoteRevision: '4',
      canonicalUrl: 'https://dav.example.test/addressbooks/default/',
      remoteSyncToken: 'opaque-token-2',
      remoteSyncCapability: 'supported',
      remoteProjectionFingerprint: 'projection-fingerprint',
      capabilities: { create: 'allowed', update: 'unknown', delete: 'denied' },
    });

    expect(attempt).toBe(1);
    const fallbackCall = client.query.mock.calls.find(([sql]) => (
      sql.includes('UPDATE address_books') && !sql.includes('discovery_alias_url')
    ));
    expect(fallbackCall).toBeDefined();
    expect(client.query.mock.calls.some(([sql]) => sql === 'ROLLBACK TO SAVEPOINT carddav_book_alias_column')).toBe(true);
  });
});

describe('upsertLookupObjects chunking', () => {
  // Must mirror the constants in carddavMappingState.js: 8 binds per row, and a
  // chunk small enough that even the largest permitted lookup delta stays under
  // PostgreSQL's 65,535-bind ceiling.
  const COLUMNS_PER_ROW = 8;
  const CHUNK_ROWS = 4000;
  const PG_BIND_LIMIT = 65535;

  function lookupChange(index) {
    return {
      addressBookId: BOOK_ID,
      href: `https://dav.example.test/addressbooks/lookup/${index}.vcf`,
      remoteEtag: `"etag-${index}"`,
      vcard: `BEGIN:VCARD\r\nVERSION:3.0\r\nUID:lookup-${index}\r\nEND:VCARD\r\n`,
      primaryEmail: `lookup-${index}@example.test`,
      vcardVersion: '3.0',
      remoteSemanticHash: `hash-${index}`,
      lookupDisplayName: `Lookup ${index}`,
    };
  }

  function recordingClient() {
    const inserts = [];
    const control = [];
    const client = {
      query: vi.fn(async (sql, params) => {
        if (/INSERT INTO carddav_remote_objects/.test(sql)) {
          inserts.push({ sql, params });
          return { rowCount: params.length / COLUMNS_PER_ROW };
        }
        control.push(sql);
        return { rows: [], rowCount: 0 };
      }),
    };
    return { client, inserts, control };
  }

  // Each VALUES tuple ends with ",NOW())"; the ON CONFLICT clause never does, so
  // this counts exactly the rows a single statement carries — independent of the
  // parameter array.
  function rowsInStatement(insert) {
    return (insert.sql.match(/,NOW\(\)\)/g) || []).length;
  }

  it('writes nothing and issues no statement for an empty delta', async () => {
    const { client, inserts } = recordingClient();
    expect(await mappingState.upsertLookupObjects(client, [])).toBe(0);
    expect(inserts).toHaveLength(0);
  });

  it('writes a single-row delta in one statement inside the caller transaction', async () => {
    const { client, inserts, control } = recordingClient();
    const written = await mappingState.upsertLookupObjects(client, [lookupChange(0)]);
    expect(written).toBe(1);
    expect(inserts).toHaveLength(1);
    expect(rowsInStatement(inserts[0])).toBe(1);
    expect(inserts[0].params).toHaveLength(COLUMNS_PER_ROW);
    // No BEGIN/COMMIT/SAVEPOINT — the chunks share the caller's transaction.
    expect(control).toEqual([]);
  });

  it('writes an exactly-full chunk in one statement', async () => {
    const changes = Array.from({ length: CHUNK_ROWS }, (_, index) => lookupChange(index));
    const { client, inserts } = recordingClient();
    const written = await mappingState.upsertLookupObjects(client, changes);
    expect(written).toBe(CHUNK_ROWS);
    expect(inserts).toHaveLength(1);
    expect(rowsInStatement(inserts[0])).toBe(CHUNK_ROWS);
    expect(inserts[0].params).toHaveLength(CHUNK_ROWS * COLUMNS_PER_ROW);
    expect(inserts[0].params.length).toBeLessThanOrEqual(PG_BIND_LIMIT);
  });

  it('splits one row past a full chunk into two statements, each within the bind budget', async () => {
    const changes = Array.from({ length: CHUNK_ROWS + 1 }, (_, index) => lookupChange(index));
    const { client, inserts } = recordingClient();
    const written = await mappingState.upsertLookupObjects(client, changes);
    expect(written).toBe(CHUNK_ROWS + 1);
    expect(inserts.map(rowsInStatement)).toEqual([CHUNK_ROWS, 1]);
    expect(inserts.every(insert => insert.params.length <= PG_BIND_LIMIT)).toBe(true);
    // Every chunk rebuilds fresh $1-based placeholders.
    expect(inserts[1].sql).toMatch(/VALUES \(\$1,/);
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
