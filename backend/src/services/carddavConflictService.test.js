import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  decrypt: vi.fn(value => value),
  deleteCardResource: vi.fn(),
  fetchCardResource: vi.fn(),
  getConnectionPolicy: vi.fn(async () => ({ allowPrivateHosts: false })),
  putCardResource: vi.fn(),
  query: vi.fn(),
  withTransaction: vi.fn(),
}));

vi.mock('./db.js', () => ({
  query: mocks.query,
  withTransaction: mocks.withTransaction,
}));
vi.mock('./encryption.js', () => ({ decrypt: mocks.decrypt }));
vi.mock('./connectionPolicy.js', () => ({ getConnectionPolicy: mocks.getConnectionPolicy }));
vi.mock('./carddavClient.js', () => ({
  deleteCardResource: mocks.deleteCardResource,
  fetchCardResource: mocks.fetchCardResource,
  putCardResource: mocks.putCardResource,
}));

import * as conflictService from './carddavConflictService.js';
import { refreshUnresolvedConflict } from './carddavMappingState.js';

const recordCarddavConflict = async (client, change) => {
  const result = await refreshUnresolvedConflict(client, change);
  return result.ok ? result.conflict : result;
};

const BOOK_ID = '00000000-0000-4000-8000-000000000002';
const CONFLICT_ID = '00000000-0000-4000-8000-000000000009';
const USER_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_USER_ID = '00000000-0000-4000-8000-000000000008';
const HREF = 'https://dav.example.test/books/default/contact.vcf';
const LOCAL_BOOK_ID = '00000000-0000-4000-8000-000000000003';

const photoVCard = [
  'BEGIN:VCARD',
  'VERSION:3.0',
  'UID:contact-1',
  'FN:Ada Lovelace',
  'N:Lovelace;Ada;;;',
  'EMAIL;TYPE=WORK:ada@example.test',
  'PHOTO;ENCODING=b;TYPE=PNG:AQID',
  'END:VCARD',
  '',
].join('\r\n');

const remoteVCard = photoVCard
  .replace('FN:Ada Lovelace', 'FN:Ada Byron')
  .replace('N:Lovelace;Ada', 'N:Byron;Ada')
  .replace('PHOTO;ENCODING=b;TYPE=PNG:AQID\r\n', '');

const uriPhotoVCard = remoteVCard.replace(
  'END:VCARD\r\n',
  'PHOTO;VALUE=URI:https://images.example.test/private.jpg\r\nEND:VCARD\r\n',
);

function conflictRow(overrides = {}) {
  return {
    id: CONFLICT_ID,
    href: HREF,
    status: 'unresolved',
    resolution: null,
    local_vcard: photoVCard,
    remote_vcard: remoteVCard,
    local_tombstone: false,
    remote_tombstone: false,
    created_at: new Date('2026-07-01T00:00:00.000Z'),
    updated_at: new Date('2026-07-02T00:00:00.000Z'),
    resolved_at: null,
    config: {
      serverUrl: 'https://dav.example.test/',
      username: 'private-user',
      password: 'encrypted-secret',
    },
    ...overrides,
  };
}

function resolutionRow(overrides = {}) {
  return conflictRow({
    address_book_id: BOOK_ID,
    mapping_revision: '7',
    mapping_status: 'conflict',
    contact_id: '00000000-0000-4000-8000-000000000004',
    contact_uid: 'contact-1',
    contact_etag: 'local-etag-before',
    local_address_book_id: LOCAL_BOOK_ID,
    remote_book_url: 'https://dav.example.test/books/default/',
    remote_book_is_write_target: true,
    connection_generation: 'generation-current',
    config: {
      serverUrl: 'https://dav.example.test/',
      username: 'carddav-user',
      password: 'encrypted-password',
      connectionGeneration: 'generation-current',
    },
    ...overrides,
  });
}

function resolutionClient(state = resolutionRow()) {
  return {
    query: vi.fn(async (sql, params) => {
      if (/FROM carddav_conflicts[\s\S]+FOR UPDATE/.test(sql)) {
        return { rows: [state], rowCount: 1 };
      }
      if (/SELECT local_vcard, local_tombstone/.test(sql)) {
        return {
          rows: [{
            local_vcard: state.local_vcard,
            local_tombstone: state.local_tombstone,
          }],
          rowCount: 1,
        };
      }
      if (/UPDATE carddav_conflicts/.test(sql)) {
        return {
          rows: [{ ...state, status: 'resolved', resolution: params[1] }],
          rowCount: 1,
        };
      }
      if (/UPDATE carddav_remote_objects/.test(sql)) {
        return { rows: [{ mapping_revision: '8' }], rowCount: 1 };
      }
      if (/DELETE FROM carddav_remote_objects/.test(sql)) {
        return { rows: [{ mapping_revision: '7' }], rowCount: 1 };
      }
      if (/INSERT INTO carddav_conflicts/.test(sql)) {
        return { rows: [{ id: CONFLICT_ID, status: 'unresolved' }], rowCount: 1 };
      }
      if (/UPDATE contacts SET/.test(sql)) {
        return { rows: [{ id: state.contact_id }], rowCount: 1 };
      }
      if (/INSERT INTO contacts/.test(sql)) {
        return {
          rows: [{ id: '00000000-0000-4000-8000-000000000005' }],
          rowCount: 1,
        };
      }
      if (/DELETE FROM contacts/.test(sql)) return { rows: [], rowCount: 1 };
      if (/UPDATE address_books/.test(sql)) return { rows: [], rowCount: 1 };
      if (/DELETE FROM carddav_conflicts/.test(sql)) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    }),
  };
}

function conflictClient() {
  return {
    query: vi.fn(async sql => ({
      rows: sql.includes('INSERT INTO carddav_conflicts')
        ? [{ id: CONFLICT_ID, status: 'unresolved' }]
        : [],
      rowCount: 1,
    })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('conflict reads', () => {
  it('lists only conflicts owned through the CardDAV integration and mapping', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [conflictRow()] });

    expect(conflictService.listConflicts).toBeTypeOf('function');
    const conflicts = await conflictService.listConflicts(USER_ID);

    expect(mocks.query).toHaveBeenCalledOnce();
    expect(mocks.query.mock.calls[0][0]).toMatch(
      /FROM carddav_conflicts[\s\S]+JOIN carddav_remote_objects[\s\S]+JOIN user_integrations/,
    );
    expect(mocks.query.mock.calls[0][1]).toEqual([USER_ID]);
    expect(conflicts).toEqual([{
      id: CONFLICT_ID,
      href: HREF,
      status: 'unresolved',
      resolution: null,
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-02T00:00:00.000Z',
      resolvedAt: null,
      local: {
        tombstone: false,
        hasPhoto: true,
        contact: expect.objectContaining({
          uid: 'contact-1',
          displayName: 'Ada Lovelace',
        }),
      },
      remote: {
        tombstone: false,
        hasPhoto: false,
        contact: expect.objectContaining({
          uid: 'contact-1',
          displayName: 'Ada Byron',
        }),
      },
    }]);
    expect(JSON.stringify(conflicts)).not.toMatch(
      /private-user|encrypted-secret|serverUrl|password|photoData|BEGIN:VCARD/,
    );
  });

  it('returns no detail when the integration-plus-mapping ownership chain does not match', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });

    expect(conflictService.getConflict).toBeTypeOf('function');
    await expect(conflictService.getConflict(OTHER_USER_ID, CONFLICT_ID)).resolves.toBeNull();

    expect(mocks.query.mock.calls[0][0]).toMatch(
      /FROM carddav_conflicts[\s\S]+JOIN carddav_remote_objects[\s\S]+JOIN user_integrations/,
    );
    expect(mocks.query.mock.calls[0][1]).toEqual([OTHER_USER_ID, CONFLICT_ID]);
  });

  it('represents tombstones without parsing or exposing a raw snapshot', async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [conflictRow({
        local_vcard: null,
        local_tombstone: true,
      })],
    });

    const conflict = await conflictService.getConflict(USER_ID, CONFLICT_ID);

    expect(conflict.local).toEqual({
      tombstone: true,
      hasPhoto: false,
      contact: null,
    });
  });

  it('reports URI-backed PHOTO presence without exposing or fetching its value', async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [conflictRow({ remote_vcard: uriPhotoVCard })],
    });

    const conflict = await conflictService.getConflict(USER_ID, CONFLICT_ID);

    expect(conflict.remote).toMatchObject({
      tombstone: false,
      hasPhoto: true,
      contact: expect.not.objectContaining({ photoData: expect.anything() }),
    });
    expect(JSON.stringify(conflict.remote)).not.toMatch(
      /images\.example\.test|private\.jpg|BEGIN:VCARD/,
    );
  });
});

describe('conflict resolution validation', () => {
  it.each([
    undefined,
    null,
    '',
    'keep-mailflow ',
    'KEEP-CARDDAV',
    'merge',
  ])('rejects non-enum resolution %j before database or remote I/O', async resolution => {
    expect(conflictService.resolveConflict).toBeTypeOf('function');

    await expect(conflictService.resolveConflict(USER_ID, CONFLICT_ID, resolution))
      .rejects.toMatchObject({ code: 'ERR_CARDDAV_CONFLICT_RESOLUTION' });

    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.withTransaction).not.toHaveBeenCalled();
    expect(mocks.fetchCardResource).not.toHaveBeenCalled();
  });

  it('rejects an already-resolved transition as stale before remote I/O', async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [resolutionRow({
        status: 'resolved',
        resolution: 'keep-carddav',
        resolved_at: new Date('2026-07-03T00:00:00.000Z'),
      })],
    });

    await expect(conflictService.resolveConflict(
      USER_ID,
      CONFLICT_ID,
      'keep-mailflow',
    )).rejects.toMatchObject({ code: 'ERR_CARDDAV_CONFLICT_STALE' });

    expect(mocks.fetchCardResource).not.toHaveBeenCalled();
    expect(mocks.putCardResource).not.toHaveBeenCalled();
    expect(mocks.withTransaction).not.toHaveBeenCalled();
  });
});

describe('conflict resolution lifecycle', () => {
  it('keep-mailflow uses the latest ETag, canonical GET, then one atomic resolve', async () => {
    const preflight = resolutionRow();
    const client = resolutionClient(preflight);
    let insideTransaction = false;
    mocks.query.mockResolvedValueOnce({ rows: [preflight] });
    mocks.fetchCardResource
      .mockImplementationOnce(async () => {
        expect(insideTransaction).toBe(false);
        return { href: HREF, etag: '"latest-before"', vcard: remoteVCard };
      })
      .mockImplementationOnce(async () => {
        expect(insideTransaction).toBe(false);
        return { href: HREF, etag: '"canonical-after"', vcard: photoVCard };
      });
    mocks.putCardResource.mockImplementationOnce(async () => {
      expect(insideTransaction).toBe(false);
      return { href: HREF, etag: '"provisional"' };
    });
    mocks.withTransaction.mockImplementationOnce(async callback => {
      insideTransaction = true;
      try {
        return await callback(client);
      } finally {
        insideTransaction = false;
      }
    });

    await expect(conflictService.resolveConflict(
      USER_ID,
      CONFLICT_ID,
      'keep-mailflow',
    )).resolves.toMatchObject({
      id: CONFLICT_ID,
      status: 'resolved',
      resolution: 'keep-mailflow',
    });

    expect(mocks.fetchCardResource).toHaveBeenCalledTimes(2);
    expect(mocks.putCardResource).toHaveBeenCalledOnce();
    expect(mocks.putCardResource).toHaveBeenCalledWith({
      url: preflight.remote_book_url,
      href: HREF,
      etag: '"latest-before"',
      vcard: photoVCard,
      username: 'carddav-user',
      password: 'encrypted-password',
      allowPrivate: false,
    });
    expect(mocks.putCardResource.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.fetchCardResource.mock.invocationCallOrder[1]);
    expect(mocks.fetchCardResource.mock.invocationCallOrder[1])
      .toBeLessThan(mocks.withTransaction.mock.invocationCallOrder[0]);

    const sql = client.query.mock.calls.map(([statement]) => statement);
    expect(sql.some(statement => /UPDATE contacts SET/.test(statement))).toBe(true);
    expect(sql.some(statement => /UPDATE carddav_remote_objects/.test(statement))).toBe(true);
    expect(sql.some(statement => /UPDATE carddav_conflicts/.test(statement))).toBe(true);
  });

  // multi-book-design.md's load-bearing invariant: a subscribed (or lookup)
  // secondary is read-only from MailFlow regardless of server write
  // capability, so 'keep-mailflow' — the one MailFlow-originated write this
  // service performs — must refuse before any network call when this
  // conflict's book isn't the write-target.
  it('refuses keep-mailflow before any network call when the book is not the write-target', async () => {
    const preflight = resolutionRow({ remote_book_is_write_target: false });
    mocks.query.mockResolvedValueOnce({ rows: [preflight] });

    await expect(conflictService.resolveConflict(
      USER_ID,
      CONFLICT_ID,
      'keep-mailflow',
    )).rejects.toMatchObject({ code: 'ERR_CARDDAV_READ_ONLY' });

    expect(mocks.fetchCardResource).not.toHaveBeenCalled();
    expect(mocks.putCardResource).not.toHaveBeenCalled();
    expect(mocks.deleteCardResource).not.toHaveBeenCalled();
    expect(mocks.withTransaction).not.toHaveBeenCalled();
  });

  it('allows keep-carddav regardless of write-target status (no MailFlow-originated write)', async () => {
    const preflight = resolutionRow({ remote_book_is_write_target: false });
    const client = resolutionClient(preflight);
    mocks.query.mockResolvedValueOnce({ rows: [preflight] });
    mocks.fetchCardResource.mockResolvedValueOnce({ href: HREF, etag: '"remote-1"', vcard: remoteVCard });
    mocks.withTransaction.mockImplementationOnce(async callback => callback(client));

    await expect(conflictService.resolveConflict(
      USER_ID,
      CONFLICT_ID,
      'keep-carddav',
    )).resolves.toMatchObject({ status: 'resolved', resolution: 'keep-carddav' });

    expect(mocks.putCardResource).not.toHaveBeenCalled();
    expect(mocks.deleteCardResource).not.toHaveBeenCalled();
  });

  it('keep-mailflow conditionally deletes a local tombstone before canonical confirmation', async () => {
    const preflight = resolutionRow({
      local_vcard: null,
      local_tombstone: true,
    });
    const client = resolutionClient(preflight);
    mocks.query.mockResolvedValueOnce({ rows: [preflight] });
    mocks.fetchCardResource
      .mockResolvedValueOnce({ href: HREF, etag: '"latest-before"', vcard: remoteVCard })
      .mockRejectedValueOnce(Object.assign(new Error('Not found'), { status: 404 }));
    mocks.withTransaction.mockImplementationOnce(callback => callback(client));

    await conflictService.resolveConflict(USER_ID, CONFLICT_ID, 'keep-mailflow');

    expect(mocks.deleteCardResource).toHaveBeenCalledWith({
      url: preflight.remote_book_url,
      href: HREF,
      etag: '"latest-before"',
      username: 'carddav-user',
      password: 'encrypted-password',
      allowPrivate: false,
    });
    expect(mocks.fetchCardResource).toHaveBeenCalledTimes(2);
    expect(mocks.withTransaction).toHaveBeenCalledOnce();
    expect(client.query.mock.calls.some(([sql]) => /DELETE FROM contacts/.test(sql))).toBe(true);
  });

  it('keep-carddav fetches a fresh snapshot before applying and resolving locally', async () => {
    const preflight = resolutionRow();
    const client = resolutionClient(preflight);
    const losslessRemoteVCard = remoteVCard
      .replace('UID:contact-1', 'UID:remote-contact')
      .replace('END:VCARD\r\n', 'X-CUSTOM-KEEP;VALUE=TEXT:x\r\nEND:VCARD\r\n');
    let insideTransaction = false;
    mocks.query.mockResolvedValueOnce({ rows: [preflight] });
    mocks.fetchCardResource.mockImplementationOnce(async () => {
      expect(insideTransaction).toBe(false);
      return { href: HREF, etag: '"fresh-remote"', vcard: losslessRemoteVCard };
    });
    mocks.withTransaction.mockImplementationOnce(async callback => {
      insideTransaction = true;
      try {
        return await callback(client);
      } finally {
        insideTransaction = false;
      }
    });

    await expect(conflictService.resolveConflict(
      USER_ID,
      CONFLICT_ID,
      'keep-carddav',
    )).resolves.toMatchObject({
      id: CONFLICT_ID,
      status: 'resolved',
      resolution: 'keep-carddav',
    });

    expect(mocks.fetchCardResource).toHaveBeenCalledOnce();
    expect(mocks.putCardResource).not.toHaveBeenCalled();
    expect(mocks.deleteCardResource).not.toHaveBeenCalled();
    expect(mocks.fetchCardResource.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.withTransaction.mock.invocationCallOrder[0]);
    const contactUpdate = client.query.mock.calls.find(([sql]) => /UPDATE contacts SET/.test(sql));
    expect(contactUpdate[1][1]).toContain('UID:contact-1');
    expect(contactUpdate[1][1]).toContain('X-CUSTOM-KEEP;VALUE=TEXT:x');
    expect(contactUpdate[1]).toEqual(expect.arrayContaining([
      'Ada Byron', preflight.contact_id, USER_ID,
    ]));
  });

  it('keep-carddav recreates a missing local tombstone from the fresh snapshot', async () => {
    const preflight = resolutionRow({
      contact_id: null,
      contact_uid: null,
      contact_etag: null,
      local_address_book_id: null,
      local_vcard: null,
      local_tombstone: true,
    });
    const client = resolutionClient(preflight);
    mocks.query.mockResolvedValueOnce({ rows: [preflight] });
    mocks.fetchCardResource.mockResolvedValueOnce({
      href: HREF,
      etag: '"fresh-remote"',
      vcard: remoteVCard,
    });
    mocks.withTransaction.mockImplementationOnce(callback => callback(client));

    await conflictService.resolveConflict(USER_ID, CONFLICT_ID, 'keep-carddav');

    const insert = client.query.mock.calls.find(([sql]) => /INSERT INTO contacts/.test(sql));
    expect(insert).toBeDefined();
    expect(insert[1].slice(0, 2)).toEqual([BOOK_ID, USER_ID]);
    const mapping = client.query.mock.calls.find(([sql]) => (
      /UPDATE carddav_remote_objects/.test(sql)
    ));
    expect(mapping[1]).toContain('00000000-0000-4000-8000-000000000005');
    expect(client.query).toHaveBeenCalledWith(
      expect.stringMatching(/UPDATE address_books/),
      [BOOK_ID, USER_ID],
    );
  });

  it('refreshes the same unresolved conflict after a concurrent 412', async () => {
    const preflight = resolutionRow();
    const client = resolutionClient(preflight);
    const concurrentVCard = remoteVCard.replace('FN:Ada Byron', 'FN:Concurrent Remote');
    mocks.query.mockResolvedValueOnce({ rows: [preflight] });
    mocks.fetchCardResource
      .mockResolvedValueOnce({ href: HREF, etag: '"latest-before"', vcard: remoteVCard })
      .mockResolvedValueOnce({ href: HREF, etag: '"concurrent"', vcard: concurrentVCard });
    mocks.putCardResource.mockRejectedValueOnce(
      Object.assign(new Error('Precondition failed'), { status: 412 }),
    );
    mocks.withTransaction.mockImplementationOnce(callback => callback(client));

    await expect(conflictService.resolveConflict(
      USER_ID,
      CONFLICT_ID,
      'keep-mailflow',
    )).rejects.toMatchObject({
      code: 'ERR_CARDDAV_CONFLICT_STALE',
      conflictId: CONFLICT_ID,
    });

    expect(mocks.fetchCardResource).toHaveBeenCalledTimes(2);
    expect(mocks.putCardResource).toHaveBeenCalledOnce();
    expect(mocks.withTransaction).toHaveBeenCalledOnce();
    const refresh = client.query.mock.calls.find(([sql]) => (
      /INSERT INTO carddav_conflicts/.test(sql)
    ));
    expect(refresh[1]).toEqual(expect.arrayContaining([
      BOOK_ID,
      HREF,
      USER_ID,
      '"concurrent"',
      concurrentVCard,
    ]));
    expect(client.query.mock.calls.some(([sql]) => (
      /UPDATE carddav_conflicts[\s\S]+status = 'resolved'/.test(sql)
    ))).toBe(false);
  });
});

describe('resolved conflict cleanup', () => {
  it('deletes only resolved rows strictly older than the supplied cutoff', async () => {
    const cutoff = new Date('2026-06-12T12:00:00.000Z');
    const client = {
      query: vi.fn(async () => ({ rows: [], rowCount: 3 })),
    };

    expect(conflictService.deleteResolvedConflictsBefore).toBeTypeOf('function');
    await expect(conflictService.deleteResolvedConflictsBefore(client, cutoff)).resolves.toBe(3);

    expect(client.query).toHaveBeenCalledWith(
      expect.stringMatching(
        /DELETE FROM carddav_conflicts[\s\S]+status = 'resolved'[\s\S]+resolved_at < \$1/,
      ),
      [cutoff],
    );
    expect(client.query.mock.calls[0][0]).not.toMatch(/status = 'unresolved'/);
  });
});

describe('conflict snapshot limits', () => {
  it('allows exactly 2 MiB of non-tombstone UTF-8 snapshots', async () => {
    await expect(recordCarddavConflict(conflictClient(), {
      addressBookId: BOOK_ID,
      href: 'https://dav.example.test/books/default/contact.vcf',
      expectedMappingRevision: '7',
      userId: USER_ID,
      localVCard: '🙂'.repeat(256 * 1024),
      remoteVCard: '🙂'.repeat(256 * 1024),
    })).resolves.toMatchObject({ id: CONFLICT_ID });
  });

  it('rejects 2 MiB + 1 before any conflict query', async () => {
    const client = conflictClient();

    await expect(recordCarddavConflict(client, {
      addressBookId: BOOK_ID,
      href: 'https://dav.example.test/books/default/contact.vcf',
      expectedMappingRevision: '7',
      userId: USER_ID,
      localVCard: '🙂'.repeat(256 * 1024),
      remoteVCard: '🙂'.repeat(256 * 1024) + 'x',
    })).rejects.toMatchObject({ code: 'ERR_CARDDAV_CONFLICT_TOO_LARGE' });

    expect(client.query).not.toHaveBeenCalled();
  });

  it.each([
    ['local', {
      localVCard: 'a'.repeat(2 * 1024 * 1024 + 1),
      remoteVCard: 'remote',
      localTombstone: true,
    }],
    ['remote', {
      localVCard: 'local',
      remoteVCard: 'b'.repeat(2 * 1024 * 1024 + 1),
      remoteTombstone: true,
    }],
  ])('excludes a %s tombstone snapshot from the byte total', async (_side, snapshots) => {
    await expect(recordCarddavConflict(conflictClient(), {
      addressBookId: BOOK_ID,
      href: 'https://dav.example.test/books/default/contact.vcf',
      expectedMappingRevision: '7',
      userId: USER_ID,
      ...snapshots,
    })).resolves.toMatchObject({ id: CONFLICT_ID });
  });
});

describe('recordCarddavConflict', () => {
  it('requires the caller to supply the locked mapping revision', async () => {
    const client = conflictClient();

    await expect(recordCarddavConflict(client, {
      addressBookId: BOOK_ID,
      href: 'https://dav.example.test/books/default/contact.vcf',
      userId: USER_ID,
      localVCard: 'BEGIN:VCARD\r\nFN:Local\r\nEND:VCARD\r\n',
      remoteVCard: 'BEGIN:VCARD\r\nFN:Remote\r\nEND:VCARD\r\n',
    })).rejects.toMatchObject({ code: 'ERR_CARDDAV_MAPPING_REVISION_REQUIRED' });

    expect(client.query).not.toHaveBeenCalled();
  });

  it('upserts the one unresolved conflict and marks its mapping conflicted', async () => {
    const conflict = {
      addressBookId: BOOK_ID,
      href: 'https://dav.example.test/books/default/contact.vcf',
      expectedMappingRevision: '7',
      userId: USER_ID,
      baseLocalHash: 'base-hash',
      remoteEtag: '"remote-2"',
      localVCard: 'BEGIN:VCARD\r\nFN:Rejected\r\nEND:VCARD\r\n',
      remoteVCard: 'BEGIN:VCARD\r\nFN:Remote\r\nEND:VCARD\r\n',
      localTombstone: false,
      remoteTombstone: false,
    };
    const client = {
      query: vi.fn(async sql => {
        if (sql.includes('INSERT INTO carddav_conflicts')) {
          return { rows: [{ id: CONFLICT_ID, status: 'unresolved' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }),
    };

    await expect(recordCarddavConflict(client, conflict)).resolves.toEqual({
      id: CONFLICT_ID,
      status: 'unresolved',
    });

    const insert = client.query.mock.calls.find(([sql]) => (
      sql.includes('INSERT INTO carddav_conflicts')
    ));
    expect(insert[0]).toContain("ON CONFLICT (address_book_id, href) WHERE status = 'unresolved'");
    expect(insert[1]).toEqual([
      BOOK_ID,
      conflict.href,
      USER_ID,
      'base-hash',
      '"remote-2"',
      conflict.localVCard,
      conflict.remoteVCard,
      false,
      false,
    ]);
    expect(client.query).toHaveBeenCalledWith(
      expect.stringMatching(
        /UPDATE carddav_remote_objects[\s\S]+mapping_status = 'conflict'[\s\S]+mapping_revision = mapping_revision \+ 1/,
      ),
      [BOOK_ID, conflict.href, '7'],
    );
  });

  it('records deletion snapshots with explicit tombstones', async () => {
    const client = {
      query: vi.fn(async sql => ({
        rows: sql.includes('INSERT INTO carddav_conflicts')
          ? [{ id: CONFLICT_ID, status: 'unresolved' }]
          : [],
        rowCount: 1,
      })),
    };

    await recordCarddavConflict(client, {
      addressBookId: BOOK_ID,
      href: 'https://dav.example.test/books/default/contact.vcf',
      expectedMappingRevision: '7',
      userId: USER_ID,
      baseLocalHash: 'base-hash',
      remoteEtag: null,
      localVCard: 'BEGIN:VCARD\r\nFN:Local\r\nEND:VCARD\r\n',
      remoteVCard: null,
      localTombstone: false,
      remoteTombstone: true,
    });

    const insert = client.query.mock.calls.find(([sql]) => (
      sql.includes('INSERT INTO carddav_conflicts')
    ));
    expect(insert[1].slice(-2)).toEqual([false, true]);
  });

  it('refreshes the caller-supplied local snapshot on repeated wrapper calls', async () => {
    const href = 'https://dav.example.test/books/default/repeated.vcf';
    const inserts = [];
    let storedLocal = null;
    const client = {
      query: vi.fn(async (sql, params) => {
        if (sql.includes('SELECT local_vcard, local_tombstone')) {
          return { rows: storedLocal ? [storedLocal] : [], rowCount: Number(Boolean(storedLocal)) };
        }
        if (sql.includes('UPDATE carddav_remote_objects')) {
          return { rows: [{ mapping_revision: inserts.length === 0 ? '8' : '9' }], rowCount: 1 };
        }
        if (sql.includes('INSERT INTO carddav_conflicts')) {
          inserts.push([sql, params]);
          storedLocal ??= { local_vcard: params[5], local_tombstone: params[7] };
          return { rows: [{ id: CONFLICT_ID, status: 'unresolved' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }),
    };
    const shared = {
      addressBookId: BOOK_ID,
      href,
      userId: USER_ID,
      baseLocalHash: 'base-hash',
      remoteEtag: '"remote"',
      remoteVCard: 'BEGIN:VCARD\r\nFN:Remote\r\nEND:VCARD\r\n',
      remoteTombstone: false,
    };

    await recordCarddavConflict(client, {
      ...shared,
      expectedMappingRevision: '7',
      localVCard: 'BEGIN:VCARD\r\nFN:First Local\r\nEND:VCARD\r\n',
      localTombstone: false,
    });
    await recordCarddavConflict(client, {
      ...shared,
      expectedMappingRevision: '8',
      localVCard: null,
      localTombstone: true,
    });

    expect(inserts).toHaveLength(2);
    expect(inserts[1][0]).toMatch(/local_vcard = EXCLUDED\.local_vcard/);
    expect(inserts[1][0]).toMatch(/local_tombstone = EXCLUDED\.local_tombstone/);
    expect(inserts[1][1].slice(5, 9)).toEqual([
      null,
      shared.remoteVCard,
      true,
      false,
    ]);
  });
});
