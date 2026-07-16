import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  localContactHash,
  parseVCardDocument,
  semanticVCardHash,
} from '../utils/vcardProperties.js';

const runtime = vi.hoisted(() => ({ inTransaction: false, events: [] }));
const mocks = vi.hoisted(() => ({
  decrypt: vi.fn(value => value),
  deleteCardResource: vi.fn(),
  discoverAddressBooks: vi.fn(),
  fetchCardResource: vi.fn(),
  getConnectionPolicy: vi.fn(async () => ({ allowPrivateHosts: false })),
  putCardResource: vi.fn(),
  query: vi.fn(),
  randomUUID: vi.fn(),
  withTransaction: vi.fn(),
}));

vi.mock('node:crypto', async importOriginal => ({
  ...await importOriginal(),
  randomUUID: mocks.randomUUID,
}));
vi.mock('./db.js', () => ({ query: mocks.query, withTransaction: mocks.withTransaction }));
vi.mock('./encryption.js', () => ({ decrypt: mocks.decrypt }));
vi.mock('./connectionPolicy.js', () => ({ getConnectionPolicy: mocks.getConnectionPolicy }));
vi.mock('./carddavClient.js', async importOriginal => ({
  ...await importOriginal(),
  deleteCardResource: mocks.deleteCardResource,
  discoverAddressBooks: mocks.discoverAddressBooks,
  fetchCardResource: mocks.fetchCardResource,
  putCardResource: mocks.putCardResource,
}));
const {
  CARDDAV_CONTACT_ERROR_STATUS,
  CardDavAmbiguousWriteError,
  CardDavConflictError,
  createContact,
  createContactFromVCard,
  deleteContact,
  deleteContactFromVCard,
  exportExistingContact,
  fetchCreated,
  recoverPendingCarddavMutations,
  replaceContactFromVCard,
  updateContact,
} = await import('./carddavContactService.js');
const { CardDavError } = await vi.importActual('./carddavTransport.js');

const USER_ID = '00000000-0000-4000-8000-000000000001';
const BOOK_ID = '00000000-0000-4000-8000-000000000002';
const LOCAL_BOOK_ID = '00000000-0000-4000-8000-000000000003';
const CONTACT_ID = '00000000-0000-4000-8000-000000000004';
const UID = '00000000-0000-4000-8000-000000000005';
const CONFLICT_ID = '00000000-0000-4000-8000-000000000006';
const BOOK_URL = 'https://dav.example.test/books/default/';
const HREF = `${BOOK_URL}${UID}.vcf`;
const BASE_VCARD = `BEGIN:VCARD\r\nVERSION:3.0\r\nUID:${UID}\r\nFN:Before\r\nEND:VCARD\r\n`;
const CANONICAL_VCARD = `BEGIN:VCARD\r\nVERSION:3.0\r\nUID:${UID}\r\nFN:After\r\nEND:VCARD\r\n`;

it('exports the shared CardDAV contact error status mappings', () => {
  expect(CARDDAV_CONTACT_ERROR_STATUS).toEqual({
    ERR_CONTACT_VALIDATION: 400,
    ERR_CONTACT_UID_MISMATCH: 400,
    ERR_CONTACT_NOT_FOUND: 404,
    ERR_ADDRESS_BOOK_NOT_FOUND: 404,
    ERR_CONTACT_EXISTS: 409,
    ERR_CARDDAV_CONFLICT: 409,
    ERR_CARDDAV_READ_ONLY: 403,
    ERR_CARDDAV_FINAL_FENCE: 503,
    ERR_CARDDAV_STALE_GENERATION: 503,
    ERR_CARDDAV_AMBIGUOUS_WRITE: 409,
    ERR_CARDDAV_PENDING_INTENT: 409,
    '23505': 409,
  });
});

const draft = (overrides = {}) => ({
  displayName: 'After',
  firstName: null,
  lastName: null,
  emails: [{ value: 'after@example.test', type: 'work', primary: true }],
  phones: [],
  organization: null,
  notes: null,
  additionalFields: [],
  ...overrides,
});

const confirmedRow = (overrides = {}) => ({
  id: CONTACT_ID,
  uid: UID,
  display_name: 'After',
  first_name: null,
  last_name: null,
  primary_email: 'after@example.test',
  emails: draft().emails,
  phones: [],
  organization: null,
  notes: null,
  photo_data: null,
  additional_fields: [],
  is_auto: false,
  send_count: 0,
  last_sent: null,
  etag: 'local-etag-after',
  created_at: new Date('2026-07-12T00:00:00Z'),
  updated_at: new Date('2026-07-12T00:00:00Z'),
  ...overrides,
});

const integration = {
  id: '00000000-0000-4000-8000-000000000007',
  config: {
    serverUrl: 'https://dav.example.test/',
    username: 'user',
    password: 'secret',
    connectionGeneration: 'generation-1',
  },
};

const mapped = (overrides = {}) => ({
  id: CONTACT_ID,
  uid: UID,
  address_book_id: BOOK_ID,
  user_id: USER_ID,
  vcard: BASE_VCARD,
  etag: 'local-etag-before',
  display_name: 'Before',
  first_name: null,
  last_name: null,
  primary_email: 'before@example.test',
  emails: [{ value: 'before@example.test', type: 'work', primary: true }],
  phones: [],
  organization: null,
  notes: null,
  photo_data: null,
  additional_fields: [],
  source: 'carddav',
  external_url: BOOK_URL,
  remote_create_capability: 'allowed',
  remote_update_capability: 'allowed',
  remote_delete_capability: 'allowed',
  href: HREF,
  remote_etag: '"remote-1"',
  mapping_status: 'synced',
  vcard_version: '3.0',
  remote_semantic_hash: 'remote-hash-before',
  local_contact_hash: 'local-hash-before',
  mapping_revision: '3',
  ...overrides,
});

const book = (overrides = {}) => ({
  url: BOOK_URL,
  displayName: 'Default',
  capabilities: { create: 'allowed', update: 'allowed', delete: 'allowed' },
  addressData: [{ contentType: 'text/vcard', version: '3.0' }],
  ...overrides,
});

const mappedLocalHash = (contact = mapped()) => localContactHash({
  uid: contact.uid,
  displayName: contact.display_name,
  firstName: contact.first_name,
  lastName: contact.last_name,
  emails: contact.emails,
  phones: contact.phones,
  organization: contact.organization,
  notes: contact.notes,
  photoData: contact.photo_data,
  additionalFields: contact.additional_fields,
});

const pendingUpdate = (vcard, overrides = {}) => mapped({
  mapping_status: 'pending_push',
  mapping_revision: '4',
  pending_operation: 'update',
  pending_vcard: vcard,
  pending_local_hash: mappedLocalHash(),
  pending_remote_semantic_hash: semanticVCardHash(parseVCardDocument(vcard)),
  pending_started_at: new Date('2026-07-12T12:00:00.000Z'),
  ...overrides,
});

const pendingDelete = (overrides = {}) => mapped({
  mapping_status: 'pending_push',
  mapping_revision: '4',
  pending_operation: 'delete',
  pending_vcard: null,
  pending_local_hash: mappedLocalHash(),
  pending_remote_semantic_hash: null,
  pending_started_at: new Date('2026-07-12T12:00:00.000Z'),
  ...overrides,
});

function protocolMock(mock, result) {
  mock.mockImplementation(async () => {
    expect(runtime.inTransaction).toBe(false);
    runtime.events.push(mock === mocks.putCardResource ? 'remote:put'
      : mock === mocks.fetchCardResource ? 'remote:get' : 'remote:delete');
    if (result instanceof Error) throw result;
    return typeof result === 'function' ? result() : result;
  });
}

function transactions(...handlers) {
  let index = 0;
  mocks.withTransaction.mockImplementation(async callback => {
    runtime.inTransaction = true;
    runtime.events.push(`tx:${index + 1}:begin`);
    const client = { query: vi.fn(handlers[index++] || (async () => ({ rows: [], rowCount: 0 }))) };
    try {
      const result = await callback(client);
      runtime.events.push(`tx:${index}:commit`);
      return result;
    } finally {
      runtime.inTransaction = false;
    }
  });
}

function preflightHandler({ contact = mapped(), connected = true } = {}) {
  return async sql => {
    const activeContact = typeof contact === 'function' ? contact() : contact;
    if (sql.includes('FROM user_integrations')) return { rows: connected ? [integration] : [] };
    if (sql.includes('FROM contacts c')) return { rows: activeContact ? [activeContact] : [] };
    if (sql.includes('FROM carddav_remote_objects mapping') && sql.includes('FOR UPDATE')) {
      return { rows: activeContact ? [activeContact] : [] };
    }
    if (sql.includes('UPDATE carddav_remote_objects')) {
      return { rows: [{ mapping_revision: '4' }], rowCount: 1 };
    }
    if (/RETURNING\s+id,\s*uid/.test(sql)) return { rows: [confirmedRow()], rowCount: 1 };
    if (sql.includes('DELETE FROM contacts')) {
      return { rows: [{ address_book_id: activeContact.address_book_id }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  };
}

function commitHandler({ row = confirmedRow(), revisionMatches = true, mapping } = {}) {
  return async sql => {
    const attemptedVCard = mocks.putCardResource.mock.calls[0]?.[0]?.vcard;
    const activeMapping = typeof mapping === 'function'
      ? mapping()
      : mapping ?? (attemptedVCard ? pendingUpdate(attemptedVCard) : pendingDelete());
    if (sql.startsWith('SET TRANSACTION')) return { rows: [], rowCount: 0 };
    if (sql.includes('FROM user_integrations')) return { rows: [integration] };
    if (sql.includes('FROM carddav_remote_objects') && sql.includes('FOR UPDATE')) {
      return { rows: revisionMatches ? [activeMapping] : [mapped({ mapping_revision: '5' })] };
    }
    if (sql.includes('FROM contacts c')) return { rows: [activeMapping] };
    if (sql.includes('INSERT INTO address_books')) {
      return { rows: [{ id: sql.includes("'Personal'") ? LOCAL_BOOK_ID : BOOK_ID }], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO carddav_remote_objects')) {
      return { rows: [{ mapping_revision: '0' }], rowCount: 1 };
    }
    if (sql.includes('UPDATE carddav_remote_objects')) {
      return { rows: [{ mapping_revision: '4' }], rowCount: 1 };
    }
    if (sql.includes('DELETE FROM carddav_remote_objects')) {
      return { rows: [{ mapping_revision: '3' }], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO carddav_conflicts')) {
      return { rows: [{ id: CONFLICT_ID, status: 'unresolved' }], rowCount: 1 };
    }
    if (/RETURNING\s+id,\s*uid/.test(sql)) return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    if (sql.includes('DELETE FROM contacts')) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  runtime.inTransaction = false;
  runtime.events = [];
  mocks.randomUUID.mockReturnValue(UID);
});

describe('local-only contact mutations', () => {
  it('creates locally without discovery when no remote account exists', async () => {
    const row = confirmedRow();
    transactions(
      async sql => (sql.includes('FROM user_integrations')
        ? { rows: [] }
        : { rows: [], rowCount: 1 }),
      async sql => {
        if (sql.includes('INSERT INTO address_books')) return { rows: [{ id: LOCAL_BOOK_ID }] };
        if (/RETURNING\s+id,\s*uid/.test(sql)) return { rows: [row], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      },
    );

    await expect(createContact(USER_ID, draft())).resolves.toEqual(row);
    expect(mocks.discoverAddressBooks).not.toHaveBeenCalled();
    expect(mocks.putCardResource).not.toHaveBeenCalled();
  });

  it('updates and deletes unmapped contacts in one local transaction', async () => {
    transactions(
      preflightHandler({ contact: mapped({ href: null, source: 'local' }) }),
      preflightHandler({ contact: mapped({ href: null, source: 'local' }) }),
    );

    await expect(updateContact(USER_ID, CONTACT_ID, draft())).resolves.toMatchObject({ id: CONTACT_ID });
    await expect(deleteContact(USER_ID, CONTACT_ID)).resolves.toEqual({ ok: true });
    expect(mocks.putCardResource).not.toHaveBeenCalled();
    expect(mocks.deleteCardResource).not.toHaveBeenCalled();
  });

  it('atomically fences local CardDAV replaces with the supplied ETag', async () => {
    let updates = 0;
    const updateSql = [];
    const handler = async (sql, params) => {
      if (sql.includes('FROM user_integrations')) return { rows: [] };
      if (sql.includes('FROM contacts c')) {
        return { rows: [mapped({ href: null, source: 'local', address_book_id: LOCAL_BOOK_ID })] };
      }
      if (sql.includes('UPDATE contacts SET')) {
        updates++;
        updateSql.push({ sql, params });
        return updates === 1
          ? { rows: [confirmedRow()], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 1 };
    };
    transactions(handler, handler);

    const mutation = {
      localAddressBookId: LOCAL_BOOK_ID,
      uid: UID,
      rawVCard: CANONICAL_VCARD,
      expectedLocalEtag: 'local-etag-before',
    };
    await expect(replaceContactFromVCard(USER_ID, mutation)).resolves.toEqual(confirmedRow());
    await expect(replaceContactFromVCard(USER_ID, mutation)).rejects.toMatchObject({
      code: 'ERR_LOCAL_ETAG_MISMATCH',
    });

    expect(updateSql).toHaveLength(2);
    expect(updateSql.every(({ sql }) => /AND etag = \$16/.test(sql))).toBe(true);
    expect(updateSql.every(({ params }) => params.at(-1) === 'local-etag-before')).toBe(true);
  });

  it('atomically fences local CardDAV deletes with the supplied ETag', async () => {
    let deletes = 0;
    const deleteSql = [];
    const handler = async (sql, params) => {
      if (sql.includes('FROM user_integrations')) return { rows: [] };
      if (sql.includes('FROM contacts c')) {
        return { rows: [mapped({ href: null, source: 'local', address_book_id: LOCAL_BOOK_ID })] };
      }
      if (sql.includes('DELETE FROM contacts')) {
        deletes++;
        deleteSql.push({ sql, params });
        return { rows: [], rowCount: deletes === 1 ? 1 : 0 };
      }
      return { rows: [], rowCount: 1 };
    };
    transactions(handler, handler);

    const mutation = {
      localAddressBookId: LOCAL_BOOK_ID,
      uid: UID,
      expectedLocalEtag: 'local-etag-before',
    };
    await expect(deleteContactFromVCard(USER_ID, mutation)).resolves.toEqual({ ok: true });
    await expect(deleteContactFromVCard(USER_ID, mutation)).rejects.toMatchObject({
      code: 'ERR_LOCAL_ETAG_MISMATCH',
    });

    expect(deleteSql).toHaveLength(2);
    expect(deleteSql.every(({ sql }) => /AND etag = \$3/.test(sql))).toBe(true);
    expect(deleteSql.every(({ params }) => params.at(-1) === 'local-etag-before')).toBe(true);
  });
});

describe('remote-first mapped lifecycle', () => {
  it.each([
    ['create', () => createContact(USER_ID, draft())],
    ['update', () => updateContact(USER_ID, CONTACT_ID, draft())],
    ['delete', () => deleteContact(USER_ID, CONTACT_ID)],
  ])('blocks %s before pending intent or network while Retry-After is active', async (
    operation,
    mutate,
  ) => {
    const retryAfterAt = '2999-07-12T12:00:00.000Z';
    const throttledIntegration = {
      ...integration,
      config: { ...integration.config, retryAfterAt },
    };
    transactions(async sql => {
      if (sql.includes('FROM user_integrations')) return { rows: [throttledIntegration] };
      if (sql.includes('FROM contacts c')) return { rows: [mapped()] };
      return { rows: [], rowCount: 1 };
    });
    mocks.discoverAddressBooks.mockResolvedValue([book()]);

    await expect(mutate()).rejects.toMatchObject({
      name: 'CardDavError',
      operation,
      retryAfterAt,
      status: 429,
    });

    expect(mocks.discoverAddressBooks).not.toHaveBeenCalled();
    expect(mocks.putCardResource).not.toHaveBeenCalled();
    expect(mocks.deleteCardResource).not.toHaveBeenCalled();
    expect(mocks.fetchCardResource).not.toHaveBeenCalled();
  });

  it('skips pending-intent recovery on the transitional schema', async () => {
    mocks.query.mockImplementation(async sql => {
      if (sql.includes('information_schema.columns')) {
        return { rows: [{ supports_pending_intent: false }] };
      }
      throw new Error('queried pending-intent columns on the transitional schema');
    });

    await expect(recoverPendingCarddavMutations(USER_ID, { integration }))
      .resolves.toEqual([]);

    expect(mocks.query).toHaveBeenCalledOnce();
    expect(mocks.fetchCardResource).not.toHaveBeenCalled();
  });

  it('loads pending intents on the contracted schema', async () => {
    mocks.query.mockImplementation(async sql => {
      if (sql.includes('information_schema.columns')) {
        return { rows: [{ supports_pending_intent: true }] };
      }
      if (sql.includes('mapping.pending_operation')) return { rows: [] };
      throw new Error('unexpected pending-intent recovery query');
    });

    await expect(recoverPendingCarddavMutations(USER_ID, { integration }))
      .resolves.toEqual([]);

    expect(mocks.query).toHaveBeenCalledTimes(2);
    expect(mocks.query.mock.calls[1][0]).toContain('mapping.pending_operation');
  });

  it('updates only after preflight commit, conditional PUT, and canonical GET', async () => {
    transactions(preflightHandler(), commitHandler());
    protocolMock(mocks.putCardResource, { href: HREF, etag: '"intermediate"' });
    protocolMock(mocks.fetchCardResource, () => ({
      href: HREF,
      etag: '"remote-2"',
      vcard: mocks.putCardResource.mock.calls[0][0].vcard,
    }));

    await expect(updateContact(USER_ID, CONTACT_ID, draft())).resolves.toEqual(confirmedRow());

    expect(runtime.events).toEqual([
      'tx:1:begin', 'tx:1:commit', 'remote:put', 'remote:get', 'tx:2:begin', 'tx:2:commit',
    ]);
    expect(mocks.putCardResource).toHaveBeenCalledWith(expect.objectContaining({
      url: BOOK_URL,
      href: HREF,
      etag: '"remote-1"',
      vcard: expect.stringContaining('FN:After'),
    }));
  });

  it.each([
    ['remote write', mocks.putCardResource],
    ['canonical fetch', mocks.fetchCardResource],
  ])('does not start the compare-and-commit after %s failure', async (_label, failedMock) => {
    transactions(preflightHandler());
    protocolMock(mocks.putCardResource, failedMock === mocks.putCardResource
      ? new CardDavError('write failed', { status: 500 })
      : { href: HREF, etag: '"intermediate"' });
    protocolMock(mocks.fetchCardResource, new CardDavError('fetch failed', { status: 500 }));

    await expect(updateContact(USER_ID, CONTACT_ID, draft())).rejects.toBeInstanceOf(
      CardDavAmbiguousWriteError,
    );
    expect(mocks.withTransaction).toHaveBeenCalledOnce();
  });

  it('returns a typed ambiguous result and preserves baselines on revision mismatch', async () => {
    const finalClient = { query: vi.fn(commitHandler({ revisionMatches: false })) };
    mocks.withTransaction
      .mockImplementationOnce(async callback => callback({ query: vi.fn(preflightHandler()) }))
      .mockImplementationOnce(async callback => callback(finalClient));
    protocolMock(mocks.putCardResource, { href: HREF, etag: '"intermediate"' });
    protocolMock(mocks.fetchCardResource, {
      href: HREF,
      etag: '"remote-2"',
      vcard: CANONICAL_VCARD,
    });

    await expect(updateContact(USER_ID, CONTACT_ID, draft())).rejects.toBeInstanceOf(
      CardDavAmbiguousWriteError,
    );
    expect(finalClient.query.mock.calls.some(([sql]) => (
      /UPDATE carddav_remote_objects/.test(sql) && /remote_semantic_hash/.test(sql)
    ))).toBe(false);
  });

  it('does not compensate or repeat a confirmed remote write when final commit fails', async () => {
    transactions(preflightHandler(), async sql => {
      if (sql.startsWith('SET TRANSACTION')) return { rows: [] };
      throw new Error('commit path unavailable');
    });
    protocolMock(mocks.putCardResource, { href: HREF, etag: '"intermediate"' });
    protocolMock(mocks.fetchCardResource, {
      href: HREF,
      etag: '"remote-2"',
      vcard: CANONICAL_VCARD,
    });

    await expect(updateContact(USER_ID, CONTACT_ID, draft())).rejects.toBeInstanceOf(
      CardDavAmbiguousWriteError,
    );
    expect(mocks.putCardResource).toHaveBeenCalledOnce();
    expect(mocks.deleteCardResource).not.toHaveBeenCalled();
  });

  it('treats remote delete 404 as confirmed before removing local state', async () => {
    transactions(preflightHandler(), commitHandler({ row: null }));
    protocolMock(mocks.deleteCardResource, { href: HREF, status: 404 });
    protocolMock(mocks.fetchCardResource, new CardDavError('missing', { status: 404 }));

    await expect(deleteContact(USER_ID, CONTACT_ID)).resolves.toEqual({ ok: true });
    expect(runtime.events).toEqual([
      'tx:1:begin', 'tx:1:commit', 'remote:delete', 'remote:get',
      'tx:2:begin', 'tx:2:commit',
    ]);
  });

  it('fails a denied mapped operation before local or remote mutation', async () => {
    transactions(preflightHandler({
      contact: mapped({ remote_update_capability: 'denied' }),
    }));

    await expect(updateContact(USER_ID, CONTACT_ID, draft())).rejects.toMatchObject({
      code: 'ERR_CARDDAV_READ_ONLY',
    });
    expect(mocks.putCardResource).not.toHaveBeenCalled();
    expect(mocks.withTransaction).toHaveBeenCalledOnce();
  });

  it('rejects a different interactive update while an intent awaits recovery', async () => {
    transactions(preflightHandler({ contact: pendingUpdate(CANONICAL_VCARD) }));

    await expect(updateContact(USER_ID, CONTACT_ID, draft({ displayName: 'Different Edit' })))
      .rejects.toMatchObject({ code: 'ERR_CARDDAV_PENDING_INTENT' });

    expect(mocks.putCardResource).not.toHaveBeenCalled();
    expect(mocks.fetchCardResource).not.toHaveBeenCalled();
  });

  it('recovers a timeout after an applied PUT with one PUT total', async () => {
    let attemptedVCard;
    transactions(
      preflightHandler(),
      async (sql, params) => {
        if (sql.includes('FROM carddav_remote_objects') && sql.includes('FOR UPDATE')) {
          return { rows: [pendingUpdate(attemptedVCard)] };
        }
        return commitHandler({ mapping: pendingUpdate(attemptedVCard) })(sql, params);
      },
    );
    mocks.putCardResource.mockImplementation(async options => {
      expect(runtime.inTransaction).toBe(false);
      runtime.events.push('remote:put');
      attemptedVCard = options.vcard;
      throw new CardDavError('response timed out', { operation: 'update' });
    });
    mocks.fetchCardResource.mockImplementation(async () => ({
      href: HREF,
      etag: '"remote-2"',
      vcard: attemptedVCard,
    }));

    await expect(updateContact(USER_ID, CONTACT_ID, draft())).resolves.toEqual(confirmedRow());

    expect(mocks.putCardResource).toHaveBeenCalledOnce();
    expect(mocks.fetchCardResource).toHaveBeenCalledOnce();
  });

  it('recovers a canonical GET failure on retry without a second PUT', async () => {
    let attemptedVCard;
    transactions(
      preflightHandler(),
      preflightHandler({ contact: () => pendingUpdate(attemptedVCard) }),
      async (sql, params) => {
        if (sql.includes('FROM carddav_remote_objects') && sql.includes('FOR UPDATE')) {
          return { rows: [pendingUpdate(attemptedVCard)] };
        }
        return commitHandler({ mapping: pendingUpdate(attemptedVCard) })(sql, params);
      },
    );
    mocks.putCardResource.mockImplementation(async options => {
      attemptedVCard = options.vcard;
      return { href: HREF, etag: '"intermediate"' };
    });
    mocks.fetchCardResource
      .mockRejectedValueOnce(new CardDavError('canonical GET failed', { status: 500 }))
      .mockImplementationOnce(async () => ({
        href: HREF,
        etag: '"remote-2"',
        vcard: attemptedVCard,
      }));

    await expect(updateContact(USER_ID, CONTACT_ID, draft())).rejects.toBeInstanceOf(
      CardDavAmbiguousWriteError,
    );
    await expect(updateContact(USER_ID, CONTACT_ID, draft())).resolves.toEqual(confirmedRow());

    expect(mocks.putCardResource).toHaveBeenCalledOnce();
    expect(mocks.fetchCardResource).toHaveBeenCalledTimes(2);
  });

  it('recovers a failed final transaction on retry without a second PUT', async () => {
    let attemptedVCard;
    transactions(
      preflightHandler(),
      async () => { throw new Error('final transaction unavailable'); },
      preflightHandler({ contact: () => pendingUpdate(attemptedVCard) }),
      async (sql, params) => {
        if (sql.includes('FROM carddav_remote_objects') && sql.includes('FOR UPDATE')) {
          return { rows: [pendingUpdate(attemptedVCard)] };
        }
        return commitHandler({ mapping: pendingUpdate(attemptedVCard) })(sql, params);
      },
    );
    mocks.putCardResource.mockImplementation(async options => {
      attemptedVCard = options.vcard;
      return { href: HREF, etag: '"intermediate"' };
    });
    mocks.fetchCardResource.mockImplementation(async () => ({
      href: HREF,
      etag: '"remote-2"',
      vcard: attemptedVCard,
    }));

    await expect(updateContact(USER_ID, CONTACT_ID, draft())).rejects.toBeInstanceOf(
      CardDavAmbiguousWriteError,
    );
    await expect(updateContact(USER_ID, CONTACT_ID, draft())).resolves.toEqual(confirmedRow());

    expect(mocks.putCardResource).toHaveBeenCalledOnce();
    expect(mocks.fetchCardResource).toHaveBeenCalledTimes(2);
  });

  it('recovers an applied DELETE with a lost response using one DELETE total', async () => {
    transactions(preflightHandler(), commitHandler({ row: null, mapping: pendingDelete() }));
    protocolMock(
      mocks.deleteCardResource,
      new CardDavError('response timed out', { operation: 'delete' }),
    );
    protocolMock(mocks.fetchCardResource, new CardDavError('missing', { status: 404 }));

    await expect(deleteContact(USER_ID, CONTACT_ID)).resolves.toEqual({ ok: true });

    expect(mocks.deleteCardResource).toHaveBeenCalledOnce();
    expect(mocks.fetchCardResource).toHaveBeenCalledOnce();
  });

  it('turns a concurrent local edit after intent creation into exactly one lossless conflict', async () => {
    let attemptedVCard;
    let conflictInsert;
    // The retained remote vCard carries unmodeled server properties the lossy
    // contacts.vcard drops.
    const retained = `BEGIN:VCARD\r\nVERSION:3.0\r\nUID:${UID}\r\nFN:Before\r\nCATEGORIES:VIP\r\nX-KEEP:me\r\nEND:VCARD\r\n`;
    const concurrentlyEdited = () => pendingUpdate(attemptedVCard, {
      display_name: 'Concurrent Local Edit',
      mapping_vcard: retained,
    });
    transactions(
      preflightHandler({ contact: () => mapped({ mapping_vcard: retained }) }),
      preflightHandler({ contact: concurrentlyEdited }),
      async (sql, params) => {
        if (sql.includes('FROM carddav_remote_objects') && sql.includes('FOR UPDATE')) {
          return { rows: [pendingUpdate(attemptedVCard)] };
        }
        if (sql.includes('FROM contacts c')) return { rows: [concurrentlyEdited()] };
        if (sql.includes('INSERT INTO carddav_conflicts')) {
          conflictInsert = params;
          return { rows: [{ id: CONFLICT_ID, status: 'unresolved' }], rowCount: 1 };
        }
        return commitHandler({ mapping: pendingUpdate(attemptedVCard) })(sql, params);
      },
    );
    mocks.putCardResource.mockImplementation(async options => {
      attemptedVCard = options.vcard;
      return { href: HREF, etag: '"intermediate"' };
    });
    mocks.fetchCardResource
      .mockRejectedValueOnce(new CardDavError('canonical GET failed', { status: 500 }))
      .mockImplementationOnce(async () => ({
        href: HREF,
        etag: '"remote-2"',
        vcard: attemptedVCard,
      }));

    await expect(updateContact(USER_ID, CONTACT_ID, draft())).rejects.toBeInstanceOf(
      CardDavAmbiguousWriteError,
    );
    const error = await updateContact(USER_ID, CONTACT_ID, draft()).catch(value => value);

    expect(error).toBeInstanceOf(CardDavConflictError);
    expect(error.conflictId).toBe(CONFLICT_ID);
    expect(mocks.putCardResource).toHaveBeenCalledOnce();
    expect(mocks.fetchCardResource).toHaveBeenCalledTimes(2);
    // The preserved-current-local snapshot overlays the edited contact onto the
    // retained remote vCard: the local edit AND the unmodeled properties survive, so
    // a later keep-mailflow resolution does not strip them.
    const localVCard = conflictInsert[5];
    expect(localVCard).toContain('FN:Concurrent Local Edit');
    expect(localVCard).toContain('CATEGORIES:VIP');
    expect(localVCard).toContain('X-KEEP:me');
  });
});

describe('stale remote writes', () => {
  it('records one durable conflict with the rejected draft and latest remote snapshot', async () => {
    const stale = new CardDavError('precondition failed', { status: 412, operation: 'update' });
    const conflictClient = { query: vi.fn(commitHandler()) };
    mocks.withTransaction
      .mockImplementationOnce(async callback => callback({ query: vi.fn(preflightHandler()) }))
      .mockImplementationOnce(async callback => callback(conflictClient));
    protocolMock(mocks.putCardResource, stale);
    protocolMock(mocks.fetchCardResource, {
      href: HREF,
      etag: '"remote-2"',
      vcard: BASE_VCARD,
    });

    const error = await updateContact(USER_ID, CONTACT_ID, draft()).catch(value => value);
    expect(error).toBeInstanceOf(CardDavConflictError);
    expect(error.conflictId).toBe(CONFLICT_ID);
    const conflictInsert = conflictClient.query.mock.calls.find(([sql]) => (
      sql.includes('INSERT INTO carddav_conflicts')
    ));
    expect(conflictInsert[1]).toEqual([
      BOOK_ID,
      HREF,
      USER_ID,
      'local-hash-before',
      '"remote-2"',
      expect.stringContaining('FN:After'),
      BASE_VCARD,
      false,
      false,
    ]);
  });

  it.each([
    ['malformed', 'not a vCard', /BEGIN:VCARD/],
    [
      'oversized',
      `BEGIN:VCARD\r\nVERSION:3.0\r\nUID:${UID}\r\nFN:${'x'.repeat(1024 * 1024)}\r\nEND:VCARD\r\n`,
      /1 MiB|64 KiB/,
    ],
  ])('rejects a %s latest remote vCard before opening the conflict transaction', async (
    _kind,
    remoteVCard,
    expectedMessage,
  ) => {
    const stale = new CardDavError('precondition failed', { status: 412, operation: 'update' });
    transactions(preflightHandler(), commitHandler());
    protocolMock(mocks.putCardResource, stale);
    protocolMock(mocks.fetchCardResource, {
      href: HREF,
      etag: '"remote-2"',
      vcard: remoteVCard,
    });

    await expect(updateContact(USER_ID, CONTACT_ID, draft())).rejects.toThrow(expectedMessage);

    expect(mocks.withTransaction).toHaveBeenCalledOnce();
  });
});

describe('remote creates and export', () => {
  it.each([
    {
      label: 'found',
      result: { href: HREF, etag: '"remote-1"', vcard: CANONICAL_VCARD },
      expected: { kind: 'found', remote: expect.objectContaining({ href: HREF }) },
    },
    {
      label: 'missing',
      result: new CardDavError('missing', { status: 404 }),
      expected: { kind: 'missing' },
    },
    {
      label: 'unknown',
      result: new CardDavError('failed', { status: 500 }),
      expected: { kind: 'unknown', cause: expect.objectContaining({ status: 500 }) },
    },
  ])('classifies the deterministic create fetch as $label', async ({ result, expected }) => {
    protocolMock(mocks.fetchCardResource, result);

    await expect(fetchCreated({
      book: book(),
      href: `${UID}.vcf`,
      uid: UID,
      creds: { username: 'user', password: 'secret', allowPrivate: false },
    })).resolves.toEqual(expected);
  });

  it.each([409, 500])('does not retry an authoritative create HTTP %i result', async status => {
    transactions(preflightHandler({ contact: null }));
    mocks.discoverAddressBooks.mockResolvedValue([book()]);
    protocolMock(mocks.putCardResource, new CardDavError('create rejected', {
      status,
      operation: 'create',
    }));

    await expect(createContact(USER_ID, draft())).rejects.toMatchObject({ status });

    expect(mocks.putCardResource).toHaveBeenCalledOnce();
    expect(mocks.fetchCardResource).not.toHaveBeenCalled();
  });

  it('validates an interactive draft before discovery or any external request', async () => {
    transactions(preflightHandler({ contact: null }));

    await expect(createContact(USER_ID, draft({ displayName: '', emails: [] })))
      .rejects.toMatchObject({ code: 'ERR_CONTACT_VALIDATION' });

    expect(mocks.withTransaction).not.toHaveBeenCalled();
    expect(mocks.discoverAddressBooks).not.toHaveBeenCalled();
    expect(mocks.putCardResource).not.toHaveBeenCalled();
  });

  it('discovers, selects the first writable book, and uses one UID for the href and vCard', async () => {
    const denied = book({
      url: 'https://dav.example.test/books/denied/',
      capabilities: { create: 'denied', update: 'denied', delete: 'denied' },
    });
    const versionFour = book({
      addressData: [{ contentType: 'text/vcard', version: '4.0' }],
    });
    transactions(preflightHandler({ contact: null }), commitHandler());
    mocks.discoverAddressBooks.mockResolvedValue([denied, versionFour]);
    protocolMock(mocks.putCardResource, { href: HREF, etag: '"created"' });
    protocolMock(mocks.fetchCardResource, {
      href: HREF,
      etag: '"remote-1"',
      vcard: CANONICAL_VCARD.replace('VERSION:3.0', 'VERSION:4.0'),
    });

    await createContact(USER_ID, draft());

    expect(mocks.discoverAddressBooks).toHaveBeenCalledOnce();
    expect(mocks.putCardResource).toHaveBeenCalledWith(expect.objectContaining({
      url: BOOK_URL,
      href: `${UID}.vcf`,
      vcard: expect.stringMatching(new RegExp(`VERSION:4\\.0[\\s\\S]+UID:${UID}`)),
    }));
  });

  it('checks the deterministic UID href after an ambiguous create before retrying PUT', async () => {
    transactions(preflightHandler({ contact: null }), commitHandler());
    mocks.discoverAddressBooks.mockResolvedValue([book()]);
    protocolMock(mocks.putCardResource, new CardDavError('connection reset', { operation: 'create' }));
    protocolMock(mocks.fetchCardResource, {
      href: HREF,
      etag: '"remote-1"',
      vcard: CANONICAL_VCARD,
    });

    await createContact(USER_ID, draft());

    expect(mocks.fetchCardResource).toHaveBeenCalledOnce();
    expect(mocks.putCardResource).toHaveBeenCalledOnce();
  });

  it('retries the same deterministic href only after an ambiguous PUT is confirmed absent', async () => {
    transactions(preflightHandler({ contact: null }), commitHandler());
    mocks.discoverAddressBooks.mockResolvedValue([book()]);
    mocks.putCardResource
      .mockRejectedValueOnce(new CardDavError('connection reset', { operation: 'create' }))
      .mockResolvedValueOnce({ href: HREF, etag: '"created"' });
    mocks.fetchCardResource
      .mockRejectedValueOnce(new CardDavError('missing', { status: 404 }))
      .mockResolvedValueOnce({ href: HREF, etag: '"remote-1"', vcard: CANONICAL_VCARD });

    await createContact(USER_ID, draft());

    expect(mocks.putCardResource).toHaveBeenCalledTimes(2);
    expect(mocks.putCardResource.mock.calls.map(([options]) => options.href))
      .toEqual([`${UID}.vcf`, `${UID}.vcf`]);
    expect(mocks.fetchCardResource).toHaveBeenCalledTimes(2);
  });

  it('recovers an ambiguous bounded retry with one final deterministic GET', async () => {
    transactions(preflightHandler({ contact: null }), commitHandler());
    mocks.discoverAddressBooks.mockResolvedValue([book()]);
    mocks.putCardResource
      .mockRejectedValueOnce(new CardDavError('first reset', { operation: 'create' }))
      .mockRejectedValueOnce(new CardDavError('second reset', { operation: 'create' }));
    mocks.fetchCardResource
      .mockRejectedValueOnce(new CardDavError('missing', { status: 404 }))
      .mockResolvedValueOnce({ href: HREF, etag: '"remote-1"', vcard: CANONICAL_VCARD });

    await createContact(USER_ID, draft());

    expect(mocks.putCardResource).toHaveBeenCalledTimes(2);
    expect(mocks.fetchCardResource).toHaveBeenCalledTimes(2);
  });

  it('recovers retry 412 with one final deterministic GET and one local materialization', async () => {
    let contactInserts = 0;
    let mappingUpserts = 0;
    transactions(
      preflightHandler({ contact: null }),
      async sql => {
        if (sql.startsWith('SET TRANSACTION')) return { rows: [] };
        if (sql.includes('FROM user_integrations')) return { rows: [integration] };
        if (sql.includes("VALUES ($1, 'Personal')")) return { rows: [{ id: LOCAL_BOOK_ID }] };
        if (sql.includes('INSERT INTO address_books')) return { rows: [{ id: BOOK_ID }] };
        if (sql.includes('INSERT INTO contacts')) {
          contactInserts++;
          return { rows: [confirmedRow()], rowCount: 1 };
        }
        if (sql.includes('INSERT INTO carddav_remote_objects')) mappingUpserts++;
        return { rows: [], rowCount: 1 };
      },
    );
    mocks.discoverAddressBooks.mockResolvedValue([book()]);
    mocks.putCardResource
      .mockRejectedValueOnce(new CardDavError('connection reset', { operation: 'create' }))
      .mockRejectedValueOnce(new CardDavError('already exists', { status: 412, operation: 'create' }));
    mocks.fetchCardResource
      .mockRejectedValueOnce(new CardDavError('missing', { status: 404 }))
      .mockResolvedValueOnce({ href: HREF, etag: '"remote-1"', vcard: CANONICAL_VCARD });

    await createContact(USER_ID, draft());

    expect(mocks.putCardResource).toHaveBeenCalledTimes(2);
    expect(mocks.fetchCardResource).toHaveBeenCalledTimes(2);
    expect(contactInserts).toBe(1);
    expect(mappingUpserts).toBe(1);
  });

  it('defaults to vCard 3.0 when discovery advertises mixed versions', async () => {
    transactions(preflightHandler({ contact: null }), commitHandler());
    mocks.discoverAddressBooks.mockResolvedValue([book({
      addressData: [
        { contentType: 'text/x-vcard', version: '3.0' },
        { contentType: 'text/vcard', version: '4.0' },
      ],
    })]);
    protocolMock(mocks.putCardResource, { href: HREF, etag: '"created"' });
    protocolMock(mocks.fetchCardResource, {
      href: HREF,
      etag: '"remote-1"',
      vcard: CANONICAL_VCARD,
    });

    await createContact(USER_ID, draft());

    expect(mocks.putCardResource).toHaveBeenCalledWith(expect.objectContaining({
      vcard: expect.stringContaining('VERSION:3.0'),
    }));
  });

  it('exports with the caller snapshot and does not rediscover', async () => {
    transactions(preflightHandler({ contact: mapped({ href: null, source: 'local' }) }), commitHandler());
    protocolMock(mocks.putCardResource, { href: HREF, etag: '"created"' });
    protocolMock(mocks.fetchCardResource, {
      href: HREF,
      etag: '"remote-1"',
      vcard: CANONICAL_VCARD,
    });

    await exportExistingContact(USER_ID, CONTACT_ID, { books: [book()] });

    expect(mocks.discoverAddressBooks).not.toHaveBeenCalled();
    expect(mocks.putCardResource).toHaveBeenCalledOnce();
  });

  it('rejects an export planned by a stale connection generation before remote I/O', async () => {
    const replacement = {
      ...integration,
      config: { ...integration.config, connectionGeneration: 'generation-2' },
    };
    transactions(async sql => {
      if (sql.includes('FROM user_integrations')) return { rows: [replacement] };
      if (sql.includes('FROM contacts c')) {
        return { rows: [mapped({ href: null, source: 'local' })] };
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(exportExistingContact(USER_ID, CONTACT_ID, {
      books: [book()],
      expectedGeneration: 'generation-1',
    })).rejects.toMatchObject({
      code: 'ERR_CARDDAV_STALE_GENERATION',
      expectedConnectionGeneration: 'generation-1',
      actualConnectionGeneration: 'generation-2',
    });
    expect(mocks.discoverAddressBooks).not.toHaveBeenCalled();
    expect(mocks.putCardResource).not.toHaveBeenCalled();
    expect(mocks.fetchCardResource).not.toHaveBeenCalled();
  });

  it.each([
    {
      sourceVersion: '3.0',
      addressData: [{ contentType: 'text/vcard', version: '4.0' }],
      expectedVersion: '4.0',
    },
    {
      sourceVersion: '4.0',
      addressData: [
        { contentType: 'text/x-vcard', version: '3.0' },
        { contentType: 'text/vcard', version: '4.0' },
      ],
      expectedVersion: '3.0',
    },
  ])('exports retained vCard $sourceVersion as the selected book version $expectedVersion', async ({
    sourceVersion,
    addressData,
    expectedVersion,
  }) => {
    const retained = BASE_VCARD.replace('VERSION:3.0', `VERSION:${sourceVersion}`);
    const canonical = CANONICAL_VCARD.replace('VERSION:3.0', `VERSION:${expectedVersion}`);
    transactions(
      preflightHandler({ contact: mapped({ href: null, source: 'local', vcard: retained }) }),
      commitHandler(),
    );
    protocolMock(mocks.putCardResource, { href: HREF, etag: '"created"' });
    protocolMock(mocks.fetchCardResource, {
      href: HREF,
      etag: '"remote-1"',
      vcard: canonical,
    });

    await exportExistingContact(USER_ID, CONTACT_ID, { books: [book({ addressData })] });

    expect(mocks.putCardResource).toHaveBeenCalledWith(expect.objectContaining({
      vcard: expect.stringContaining(`VERSION:${expectedVersion}`),
    }));
  });

  it('fences export finalization against a concurrent local contact change', async () => {
    let sawLocalEtagFence = false;
    transactions(
      preflightHandler({ contact: mapped({ href: null, source: 'local' }) }),
      async sql => {
        if (sql.startsWith('SET TRANSACTION')) return { rows: [] };
        if (sql.includes('FROM user_integrations')) return { rows: [integration] };
        if (sql.includes('INSERT INTO address_books')) return { rows: [{ id: BOOK_ID }] };
        if (sql.includes('UPDATE contacts')) {
          sawLocalEtagFence = /AND etag = \$16/.test(sql);
          return { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 1 };
      },
    );
    mocks.discoverAddressBooks.mockImplementation(() => {
      throw new Error('export must use its supplied snapshot');
    });
    protocolMock(mocks.putCardResource, { href: HREF, etag: '"created"' });
    protocolMock(mocks.fetchCardResource, {
      href: HREF,
      etag: '"remote-1"',
      vcard: CANONICAL_VCARD,
    });

    await expect(exportExistingContact(USER_ID, CONTACT_ID, { books: [book()] }))
      .rejects.toBeInstanceOf(CardDavAmbiguousWriteError);
    expect(sawLocalEtagFence).toBe(true);
  });

  it('allocates a non-conflicting local name when materializing the selected remote book', async () => {
    let remoteBookAttempts = 0;
    transactions(
      preflightHandler({ contact: null }),
      async sql => {
        if (sql.startsWith('SET TRANSACTION')) return { rows: [] };
        if (sql.includes('FROM user_integrations')) return { rows: [integration] };
        if (sql.includes("VALUES ($1, 'Personal')")) return { rows: [{ id: LOCAL_BOOK_ID }] };
        if (sql.includes('INSERT INTO address_books')) {
          remoteBookAttempts++;
          if (remoteBookAttempts === 1) {
            throw Object.assign(new Error('duplicate book name'), { code: '23505' });
          }
          return { rows: [{ id: BOOK_ID }] };
        }
        if (/RETURNING\s+id,\s*uid/.test(sql)) {
          return { rows: [confirmedRow()], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      },
    );
    mocks.discoverAddressBooks.mockResolvedValue([book({ displayName: 'Personal' })]);
    protocolMock(mocks.putCardResource, { href: HREF, etag: '"created"' });
    protocolMock(mocks.fetchCardResource, {
      href: HREF,
      etag: '"remote-1"',
      vcard: CANONICAL_VCARD,
    });

    await createContact(USER_ID, draft());

    expect(remoteBookAttempts).toBe(2);
  });

  it('persists only create denial after a real rejected create on an unseen remote book', async () => {
    let materializedBook = false;
    let capabilitySql = '';
    transactions(
      preflightHandler({ contact: null }),
      async sql => {
        if (sql.includes('FROM user_integrations')) return { rows: [integration] };
        if (sql.includes('INSERT INTO address_books')) {
          materializedBook = true;
          return { rows: [{ id: BOOK_ID }] };
        }
        if (sql.includes('UPDATE address_books')) capabilitySql = sql;
        return { rows: [], rowCount: 1 };
      },
    );
    mocks.discoverAddressBooks.mockResolvedValue([book()]);
    protocolMock(mocks.putCardResource, new CardDavError('forbidden', {
      status: 403,
      operation: 'create',
    }));

    await expect(createContact(USER_ID, draft())).rejects.toMatchObject({ status: 403 });

    expect(materializedBook).toBe(true);
    expect(capabilitySql).toContain("remote_create_capability = 'denied'");
    expect(capabilitySql).not.toMatch(/remote_(?:update|delete)_capability = 'denied'/);
  });

  it('preserves existing update and delete denials when create is rejected', async () => {
    let materializeSql = '';
    let denialSql = '';
    transactions(
      preflightHandler({ contact: null }),
      async sql => {
        if (sql.includes('FROM user_integrations')) return { rows: [integration] };
        if (sql.includes('INSERT INTO address_books')) {
          materializeSql = sql;
          return { rows: [{ id: BOOK_ID }] };
        }
        if (sql.includes('UPDATE address_books')) denialSql = sql;
        return { rows: [], rowCount: 1 };
      },
    );
    mocks.discoverAddressBooks.mockResolvedValue([book({
      capabilities: { create: 'unknown', update: 'allowed', delete: 'unknown' },
    })]);
    protocolMock(mocks.putCardResource, new CardDavError('forbidden', {
      status: 403,
      operation: 'create',
    }));

    await expect(createContact(USER_ID, draft())).rejects.toMatchObject({ status: 403 });

    const conflictUpdate = materializeSql.split('DO UPDATE SET')[1];
    expect(conflictUpdate).not.toMatch(/remote_(?:create|update|delete)_capability/);
    expect(denialSql).toContain("remote_create_capability = 'denied'");
    expect(denialSql).not.toMatch(/remote_(?:update|delete)_capability/);
  });

  it('uses the established CardDAV fallback when a remote book has no display name', async () => {
    let storedName = null;
    transactions(
      preflightHandler({ contact: null }),
      async (sql, params) => {
        if (sql.startsWith('SET TRANSACTION')) return { rows: [] };
        if (sql.includes('FROM user_integrations')) return { rows: [integration] };
        if (sql.includes("VALUES ($1, 'Personal')")) return { rows: [{ id: LOCAL_BOOK_ID }] };
        if (sql.includes('INSERT INTO address_books')) {
          storedName = params[1];
          return { rows: [{ id: BOOK_ID }] };
        }
        if (sql.includes('INSERT INTO contacts')) {
          return { rows: [confirmedRow()], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      },
    );
    mocks.discoverAddressBooks.mockResolvedValue([book({ displayName: '' })]);
    protocolMock(mocks.putCardResource, { href: HREF, etag: '"created"' });
    protocolMock(mocks.fetchCardResource, {
      href: HREF,
      etag: '"remote-1"',
      vcard: CANONICAL_VCARD,
    });

    await createContact(USER_ID, draft());

    expect(storedName).toBe('CardDAV');
  });
});

describe('MailFlow CardDAV-server seams', () => {
  it('stores the preferred email when it is not listed first', async () => {
    const rawVCard = BASE_VCARD
      .replace('VERSION:3.0', 'VERSION:4.0')
      .replace(
        'FN:Before\r\n',
        'FN:Before\r\nEMAIL:first@example.test\r\nEMAIL;PREF=1: SECOND@EXAMPLE.TEST \r\n',
      );
    let insertParams;
    transactions(async (sql, params) => {
      if (sql.includes('FROM user_integrations')) return { rows: [] };
      if (sql.includes('FROM address_books')) return { rows: [{ id: LOCAL_BOOK_ID, source: 'local' }] };
      if (sql.includes('INSERT INTO contacts')) {
        insertParams = params;
        return { rows: [confirmedRow({ uid: UID })], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });

    await createContactFromVCard(USER_ID, {
      localAddressBookId: LOCAL_BOOK_ID,
      uid: UID,
      rawVCard,
    });

    expect(insertParams[8]).toBe('second@example.test');
  });

  it('preserves a client UID and raw vCard when creating through a local book', async () => {
    transactions(async sql => {
      if (sql.includes('FROM user_integrations')) return { rows: [] };
      if (sql.includes('FROM address_books')) return { rows: [{ id: LOCAL_BOOK_ID, source: 'local' }] };
      if (/RETURNING\s+id,\s*uid/.test(sql)) return { rows: [confirmedRow({ uid: UID })] };
      return { rows: [], rowCount: 1 };
    });

    await createContactFromVCard(USER_ID, {
      localAddressBookId: LOCAL_BOOK_ID,
      uid: UID,
      rawVCard: BASE_VCARD,
    });

    const calls = mocks.withTransaction.mock.calls;
    expect(calls).toHaveLength(1);
    expect(mocks.randomUUID).not.toHaveBeenCalled();
  });

  it('translates the local book/UID unique race for create-only CardDAV PUT', async () => {
    const duplicate = Object.assign(new Error('duplicate contact UID'), {
      code: '23505',
      constraint: 'contacts_address_book_id_uid_key',
    });
    transactions(async sql => {
      if (sql.includes('FROM address_books')) {
        return { rows: [{ id: LOCAL_BOOK_ID, source: 'local' }] };
      }
      if (sql.includes('FROM contacts c')) return { rows: [] };
      if (sql.includes('FROM user_integrations')) return { rows: [] };
      if (sql.includes('INSERT INTO contacts')) throw duplicate;
      return { rows: [], rowCount: 1 };
    });

    await expect(createContactFromVCard(USER_ID, {
      localAddressBookId: LOCAL_BOOK_ID,
      uid: UID,
      rawVCard: BASE_VCARD,
      expectedAbsent: true,
    })).rejects.toMatchObject({ code: 'ERR_LOCAL_PRECONDITION_FAILED' });
  });

  it('leaves unrelated local create SQL failures unchanged', async () => {
    const unrelated = Object.assign(new Error('unrelated unique failure'), {
      code: '23505',
      constraint: 'contacts_pkey',
    });
    transactions(async sql => {
      if (sql.includes('FROM address_books')) {
        return { rows: [{ id: LOCAL_BOOK_ID, source: 'local' }] };
      }
      if (sql.includes('FROM contacts c')) return { rows: [] };
      if (sql.includes('FROM user_integrations')) return { rows: [] };
      if (sql.includes('INSERT INTO contacts')) throw unrelated;
      return { rows: [], rowCount: 1 };
    });

    await expect(createContactFromVCard(USER_ID, {
      localAddressBookId: LOCAL_BOOK_ID,
      uid: UID,
      rawVCard: BASE_VCARD,
      expectedAbsent: true,
    })).rejects.toBe(unrelated);
  });

  it('translates an authoritative remote create-only 412 without local mutation', async () => {
    transactions(async sql => {
      if (sql.includes('FROM address_books')) {
        return { rows: [{ id: LOCAL_BOOK_ID, source: 'local' }] };
      }
      if (sql.includes('FROM contacts c')) return { rows: [] };
      if (sql.includes('FROM user_integrations')) return { rows: [integration] };
      return { rows: [], rowCount: 1 };
    });
    mocks.discoverAddressBooks.mockResolvedValue([book()]);
    protocolMock(mocks.putCardResource, new CardDavError('already exists', {
      status: 412,
      operation: 'create',
    }));

    await expect(createContactFromVCard(USER_ID, {
      localAddressBookId: LOCAL_BOOK_ID,
      uid: UID,
      rawVCard: BASE_VCARD,
      expectedAbsent: true,
    })).rejects.toMatchObject({ code: 'ERR_LOCAL_PRECONDITION_FAILED' });

    expect(mocks.putCardResource).toHaveBeenCalledOnce();
    expect(mocks.putCardResource).toHaveBeenCalledWith(expect.objectContaining({
      href: `${UID}.vcf`,
    }));
    expect(mocks.fetchCardResource).not.toHaveBeenCalled();
    expect(mocks.withTransaction).toHaveBeenCalledOnce();
  });

  it('rejects a stale local ETag before an external request', async () => {
    transactions(preflightHandler({ contact: mapped({ etag: 'current-local-etag' }) }));

    await expect(replaceContactFromVCard(USER_ID, {
      localAddressBookId: BOOK_ID,
      uid: UID,
      rawVCard: CANONICAL_VCARD,
      expectedLocalEtag: 'stale-local-etag',
    })).rejects.toMatchObject({ code: 'ERR_LOCAL_ETAG_MISMATCH' });
    expect(mocks.putCardResource).not.toHaveBeenCalled();
  });

  it('resolves delete ownership by local book plus UID and enforces the ETag', async () => {
    transactions(preflightHandler(), commitHandler({ row: null }));
    protocolMock(mocks.deleteCardResource, { href: HREF, status: 204 });
    protocolMock(mocks.fetchCardResource, new CardDavError('missing', { status: 404 }));

    await expect(deleteContactFromVCard(USER_ID, {
      localAddressBookId: BOOK_ID,
      uid: UID,
      expectedLocalEtag: 'local-etag-before',
    })).resolves.toEqual({ ok: true });
    expect(mocks.deleteCardResource).toHaveBeenCalledOnce();
  });

  it('selects create versus replace from local ownership instead of a caller contact ID', async () => {
    transactions(preflightHandler(), commitHandler());
    protocolMock(mocks.putCardResource, { href: HREF, etag: '"intermediate"' });
    protocolMock(mocks.fetchCardResource, {
      href: HREF,
      etag: '"remote-2"',
      vcard: CANONICAL_VCARD,
    });

    await replaceContactFromVCard(USER_ID, {
      localAddressBookId: BOOK_ID,
      uid: UID,
      rawVCard: CANONICAL_VCARD,
      expectedLocalEtag: 'local-etag-before',
    });

    expect(mocks.putCardResource).toHaveBeenCalledWith(expect.objectContaining({
      etag: '"remote-1"',
    }));
  });
});
