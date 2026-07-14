import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  localContactHash,
  parseVCardDocument,
  semanticVCardHash,
} from '../utils/vcardProperties.js';

const mocks = vi.hoisted(() => ({
  decrypt: vi.fn(value => value),
  deleteResolvedConflictsBefore: vi.fn(),
  discoverAddressBooks: vi.fn(),
  exportExistingContact: vi.fn(),
  fetchAddressBookDelta: vi.fn(),
  getConnectionPolicy: vi.fn(async () => ({ allowPrivateHosts: false })),
  parseVCard: vi.fn(),
  query: vi.fn(),
  recoverPendingCarddavMutations: vi.fn(),
  withTransaction: vi.fn(),
}));

vi.mock('./db.js', () => ({
  query: mocks.query,
  withTransaction: mocks.withTransaction,
}));
vi.mock('./encryption.js', () => ({ decrypt: mocks.decrypt }));
vi.mock('./connectionPolicy.js', () => ({ getConnectionPolicy: mocks.getConnectionPolicy }));
vi.mock('./carddavClient.js', () => ({
  discoverAddressBooks: mocks.discoverAddressBooks,
  fetchAddressBookDelta: mocks.fetchAddressBookDelta,
}));
vi.mock('./carddavContactService.js', () => ({
  exportExistingContact: mocks.exportExistingContact,
  recoverPendingCarddavMutations: mocks.recoverPendingCarddavMutations,
}));
vi.mock('./carddavConflictService.js', () => ({
  deleteResolvedConflictsBefore: mocks.deleteResolvedConflictsBefore,
}));
vi.mock('../utils/vcard.js', async importOriginal => {
  const original = await importOriginal();
  mocks.parseVCard.mockImplementation(original.parseVCard);
  return { ...original, parseVCard: mocks.parseVCard };
});

const carddavSync = await import('./carddavSync.js');
const { CardDavError } = await vi.importActual('./carddavTransport.js');
const { generateVCard } = await vi.importActual('../utils/vcard.js');
const USER_ID = '00000000-0000-4000-8000-000000000001';
const BOOK_ID = '00000000-0000-4000-8000-000000000002';
const TARGET_ID = '00000000-0000-4000-8000-000000000004';
const LOCAL_BOOK_ID = '00000000-0000-4000-8000-000000000005';
const BOOK_URL = 'https://dav.example.test/addressbooks/default/';
const ALIAS_BOOK_URL = 'https://dav.example.test/addressbooks/alias/';
const CANONICAL_BOOK_URL = 'https://dav.example.test/addressbooks/canonical/';
const CONNECTION_GENERATION = 'generation-current';
const EMPTY_COUNTERS = {
  remote: 0,
  fetched: 0,
  updated: 0,
  removed: 0,
  fallback: 0,
};

afterEach(() => {
  vi.useRealTimers();
});

const STALE_REASON_POLICIES = [
  ['invalid-plan-fence', 'abort', 0],
  ['not-connected', 'abort', 0],
  ['connection-generation-changed', 'abort', 0],
  ['projection-footprint-changed', 'retry-apply', 1],
  ['mapping-revision-changed', 'abort', 0],
  ['mapping-contact-missing', 'abort', 0],
  ['canonical-url-conflict', 'abort', 0],
  ['book-update-missed', 'abort', 0],
  ['canonical-reconciliation-required', 'abort', 0],
  ['observed-alias-missing', 'abort', 0],
  ['remote-revision-changed', 'refetch-once', 1],
  ['remote-token-changed', 'refetch-once', 1],
];

function completePlan(overrides = {}) {
  return {
    userId: USER_ID,
    book: { url: BOOK_URL, displayName: 'Remote' },
    connectionGeneration: CONNECTION_GENERATION,
    expectedRemoteRevision: '0',
    expectedRemoteToken: null,
    nextRemoteToken: null,
    capability: 'snapshot',
    replaceAll: true,
    upserts: [],
    removedHrefs: [],
    ...overrides,
  };
}

function applyClient({
  remoteToken = null,
  remoteRevision = '0',
  connectionGeneration = CONNECTION_GENERATION,
  integrationPresent = true,
  bookPresent = true,
  bookUpdateCount = 1,
  lifecycleBooks = [],
  contactCount = 0,
  ledger = new Set(),
} = {}) {
  return {
    query: vi.fn(async (sql, params) => {
      if (/SELECT id, config\s+FROM user_integrations[\s\S]+FOR UPDATE/.test(sql)) {
        return integrationPresent ? {
          rows: [{
            id: '00000000-0000-4000-8000-000000000006',
            config: {
              connectionGeneration,
              contactCount,
            },
          }],
        } : { rows: [] };
      }
      if (/SELECT id, source, external_url, sync_token[\s\S]+FROM address_books/.test(sql)) {
        return { rows: lifecycleBooks };
      }
      if (/external_url = ANY\(\$2::text\[\]\)[\s\S]+FOR UPDATE/.test(sql)) {
        return bookPresent ? {
          rows: [{
            id: BOOK_ID,
            external_url: params[1][0],
            remote_sync_token: remoteToken,
            remote_sync_revision: remoteRevision,
            sync_token: 'local-token-before',
          }],
        } : { rows: [] };
      }
      if (/FROM user_integrations[\s\S]+FOR (?:SHARE|UPDATE)/.test(sql)) {
        return integrationPresent
          ? { rows: [{
            id: '00000000-0000-4000-8000-000000000006',
            has_legacy_projection: false,
            connection_generation: connectionGeneration,
            contact_count: String(contactCount),
          }] }
          : { rows: [] };
      }
      // The materialized-mapping recount that derives contactCount: answer it from the
      // mapping rows this fake ledger has actually taken, so the count is observed rather
      // than accumulated (as it is in PostgreSQL).
      if (/count\(\*\)::int AS count[\s\S]+FROM carddav_remote_objects/.test(sql)) {
        return { rows: [{ count: ledger.size }] };
      }
      if (sql.includes('FROM carddav_remote_objects')) return { rows: [] };
      if (sql.includes('FROM contacts')) return { rows: [] };
      if (sql.includes('INSERT INTO contacts')) {
        return { rows: [{ id: '00000000-0000-4000-8000-000000000003' }], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO carddav_remote_objects')) {
        if (params[5]) ledger.add(`${params[0]}|${params[1]}`);
        return { rows: [{ mapping_revision: '0' }], rowCount: 1 };
      }
      if (/UPDATE user_integrations/.test(sql)) {
        if (/jsonb_build_object\('contactCount'/.test(sql)) contactCount = params[1];
        else if (/config = config \|\| \$2::jsonb/.test(sql)) {
          contactCount = JSON.parse(params[1]).contactCount ?? contactCount;
        }
        return { rows: [], rowCount: 1 };
      }
      if (/UPDATE address_books\s+SET/.test(sql)) return { rows: [], rowCount: bookUpdateCount };
      return { rows: [], rowCount: 0 };
    }),
  };
}

function projectionClient({
  objects = [],
  contacts = [],
  connectionGeneration = CONNECTION_GENERATION,
  contactCount = 0,
} = {}) {
  return {
    query: vi.fn(async (sql, params) => {
      if (/external_url = ANY\(\$2::text\[\]\)[\s\S]+FOR UPDATE/.test(sql)) {
        return {
          rows: [{
            id: BOOK_ID,
            external_url: BOOK_URL,
            remote_sync_token: null,
            remote_sync_revision: '0',
            sync_token: 'local-token-before',
          }],
        };
      }
      if (/FROM address_books[\s\S]+source <> 'carddav'[\s\S]+FOR UPDATE/.test(sql)) {
        const books = new Map(contacts
          .filter(contact => contact.address_book_source !== 'carddav')
          .map(contact => [contact.address_book_id, {
            id: contact.address_book_id,
            source: 'local',
            sync_token: 'target-token-before',
          }]));
        return { rows: [...books.values()] };
      }
      if (/SELECT id[\s\S]+source <> 'carddav'/.test(sql)) {
        const ids = [...new Set(contacts
          .filter(contact => contact.address_book_source !== 'carddav')
          .map(contact => contact.address_book_id))];
        return { rows: ids.sort().map(id => ({
          id,
          source: 'local',
          sync_token: 'target-token-before',
        })) };
      }
      if (/FROM user_integrations[\s\S]+FOR (?:SHARE|UPDATE)/.test(sql)) {
        return { rows: [{
          id: '00000000-0000-4000-8000-000000000006',
          has_legacy_projection: false,
          connection_generation: connectionGeneration,
          contact_count: String(contactCount),
        }] };
      }
      if (/FROM carddav_remote_objects[\s\S]+address_book_id <>/.test(sql)) return { rows: [] };
      if (/^(?:\s*)(?:INSERT INTO|UPDATE|DELETE FROM) carddav_remote_objects/.test(sql)) {
        return { rows: [{ mapping_revision: '1' }], rowCount: 1 };
      }
      if (sql.includes('FROM carddav_remote_objects')) return { rows: objects };
      if (/SELECT c\.id[\s\S]+FROM contacts/.test(sql) && !sql.includes('c.uid')) {
        return { rows: contacts.map(contact => ({ id: contact.id })) };
      }
      if (/SELECT[\s\S]+FROM contacts/.test(sql)) return { rows: contacts };
      if (sql.includes('INSERT INTO contacts')) {
        return { rows: [{ id: '00000000-0000-4000-8000-000000000003' }], rowCount: 1 };
      }
      if (/UPDATE address_books[\s\S]+RETURNING id, source, sync_token/.test(sql)) {
        return {
          rows: params[1].map(id => ({ id, source: 'local', sync_token: `${id}-after` })),
          rowCount: params[1].length,
        };
      }
      if (/UPDATE user_integrations/.test(sql)) {
        if (/jsonb_build_object\('contactCount'/.test(sql)) contactCount = params[1];
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    }),
  };
}

function targetContactRow(overrides = {}) {
  const vcard = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    'UID:local-target',
    'FN:Original Name',
    'N:Name;Original;;;',
    'EMAIL:duplicate@example.test',
    'END:VCARD',
    '',
  ].join('\r\n');
  return {
    id: TARGET_ID,
    address_book_id: LOCAL_BOOK_ID,
    address_book_source: 'local',
    uid: 'local-target',
    vcard,
    etag: createHash('md5').update(vcard).digest('hex'),
    display_name: 'Original Name',
    first_name: 'Original',
    last_name: 'Name',
    primary_email: 'duplicate@example.test',
    emails: [{ value: 'duplicate@example.test', type: 'other', primary: true }],
    phones: [],
    organization: null,
    notes: null,
    photo_data: null,
    additional_fields: [],
    is_auto: false,
    ...overrides,
  };
}

function remoteCard(name, email) {
  const href = `${BOOK_URL}${name}.vcf`;
  const vcard = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `UID:remote-${name}`,
    `FN:${name}`,
    `N:${name};${name};;;`,
    `EMAIL:${email}`,
    'END:VCARD',
    '',
  ].join('\r\n');
  return {
    href,
    remoteEtag: `W/"remote-etag-${name}"`,
    vcard,
    contact: {
      uid: `remote-${name}`,
      displayName: name,
      firstName: name,
      lastName: name,
      primaryEmail: email,
      emails: [{ value: email, type: 'other', primary: true }],
      phones: [],
      organization: null,
      notes: null,
      photoData: null,
    },
  };
}

function persistedSeparate(name, email) {
  const card = remoteCard(name, email);
  const localUid = createHash('sha256').update(card.href).digest('hex');
  const vcard = generateVCard({ ...card.contact, uid: localUid });
  return {
    card,
    object: {
      address_book_id: BOOK_ID,
      href: card.href,
      remote_etag: card.remoteEtag,
      vcard: card.vcard,
      primary_email: email,
      disposition: 'separate',
      local_contact_id: TARGET_ID,
      merge_before: null,
      merge_applied: null,
    },
    contact: targetContactRow({
      address_book_id: BOOK_ID,
      address_book_source: 'carddav',
      uid: localUid,
      vcard,
      etag: createHash('md5').update(vcard).digest('hex'),
      display_name: name,
      first_name: name,
      last_name: name,
      primary_email: email,
      emails: [{ value: email, type: 'other', primary: true }],
    }),
  };
}

function configureOneBookSync({ remoteToken = null } = {}) {
  mocks.query.mockImplementation(async (sql, params) => {
    if (sql.includes("provider = 'carddav'") && sql.includes('SELECT config')) {
      return {
        rows: [{
          config: {
            serverUrl: 'https://dav.example.test/',
            username: 'user',
            password: 'encrypted',
            connectionGeneration: CONNECTION_GENERATION,
          },
        }],
      };
    }
    if (sql.includes('SELECT remote_sync_token')) {
      expect(params).toEqual([USER_ID, BOOK_URL]);
      return { rows: [{
        remote_sync_token: remoteToken,
        remote_sync_capability: 'sync-collection',
        remote_sync_revision: '0',
        connection_generation: CONNECTION_GENERATION,
      }] };
    }
    return { rows: [], rowCount: 0 };
  });
  mocks.discoverAddressBooks.mockResolvedValue([
    { url: BOOK_URL, displayName: 'Remote', supportsSyncCollection: true },
  ]);
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

describe('disconnectCarddavAccount', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns false without lifecycle mutation when the integration is already absent', async () => {
    const client = applyClient({ integrationPresent: false });
    mocks.withTransaction.mockImplementation(callback => callback(client));

    await expect(carddavSync.disconnectCarddavAccount(USER_ID)).resolves.toBe(false);

    expect(client.query).toHaveBeenCalledOnce();
    expect(client.query.mock.calls[0][0]).toMatch(/FROM user_integrations[\s\S]+FOR UPDATE/);
  });

  it('reconciles stale books through one helper that returns changed book IDs', async () => {
    const client = applyClient({
      contactCount: 2,
      lifecycleBooks: [{
        id: BOOK_ID,
        source: 'carddav',
        external_url: BOOK_URL,
        sync_token: 'local-before',
      }],
    });

    await expect(carddavSync.reconcileStaleCarddavBooks(client, USER_ID, {
      seenUrls: [],
    })).resolves.toEqual([BOOK_ID]);
  });

  it('keeps finalization status-only and disconnect integration-delete-only', async () => {
    const finalizationClient = applyClient();
    await carddavSync.finalizeCarddavSyncTransaction(finalizationClient, USER_ID, {
      connectionGeneration: CONNECTION_GENERATION,
      seenUrls: [],
      status: { lastError: null },
    });
    const finalizationMutations = finalizationClient.query.mock.calls
      .map(([sql]) => sql)
      .filter(sql => /(?:UPDATE|DELETE FROM) user_integrations/.test(sql));
    expect(finalizationMutations).toHaveLength(1);
    expect(finalizationMutations[0]).toContain('UPDATE user_integrations');

    const disconnectClient = applyClient();
    const query = disconnectClient.query.getMockImplementation();
    disconnectClient.query.mockImplementation(async (sql, params) => (
      sql.includes('DELETE FROM user_integrations')
        ? { rows: [{ id: USER_ID }], rowCount: 1 }
        : query(sql, params)
    ));
    await carddavSync.disconnectCarddavTransaction(disconnectClient, USER_ID);
    const disconnectMutations = disconnectClient.query.mock.calls
      .map(([sql]) => sql)
      .filter(sql => /(?:UPDATE|DELETE FROM) user_integrations/.test(sql));
    expect(disconnectMutations).toHaveLength(1);
    expect(disconnectMutations[0]).toContain('DELETE FROM user_integrations');
  });
});

describe('applyBookDelta', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is exported as the transactional CardDAV apply boundary', () => {
    expect(carddavSync.applyBookDelta).toBeTypeOf('function');
  });

  it.each(STALE_REASON_POLICIES)(
    'maps stale reason %s to %s with at most %i retry',
    (reason, action, maximumRetryCount) => {
      const selected = carddavSync.stalePlanAction(reason);
      expect(selected).toBe(action);
      expect({ abort: 0, 'retry-apply': 1, 'refetch-once': 1 }[selected])
        .toBe(maximumRetryCount);
    },
  );

  it('rejects unknown stale reasons and ignores diagnostic fields when selecting policy', () => {
    expect(() => carddavSync.stalePlanAction('unknown')).toThrow(/unknown stale/i);
    const stale = Object.assign(
      new carddavSync.StaleCarddavPlanError({ reason: 'mapping-contact-missing' }),
      {
        expectedRemoteToken: 'before',
        actualRemoteToken: 'after',
        expectedConnectionGeneration: 'before',
        actualConnectionGeneration: 'before',
      },
    );
    expect(carddavSync.stalePlanAction(stale.reason)).toBe('abort');
  });

  it('rejects an unfenced plan before executing SQL', async () => {
    const client = applyClient();
    const plan = completePlan();
    delete plan.connectionGeneration;

    await expect(carddavSync.applyBookDelta(client, plan)).rejects.toMatchObject({
      reason: 'invalid-plan-fence',
    });
    expect(client.query).not.toHaveBeenCalled();
  });

  it('uses only the passed client and locks the integration before the mirrored book', async () => {
    mocks.query.mockRejectedValue(new Error('global query must not be used'));
    const client = applyClient();

    await carddavSync.applyBookDelta(client, completePlan());

    expect(mocks.query).not.toHaveBeenCalled();
    expect(client.query).toHaveBeenCalled();
    expect(client.query.mock.calls[0][0]).toMatch(
      /SELECT[\s\S]+FROM user_integrations[\s\S]+FOR UPDATE/,
    );
    expect(client.query.mock.calls[1][0]).toMatch(
      /SELECT[\s\S]+FROM address_books[\s\S]+FOR UPDATE/,
    );
  });

  it('locks eligible target books before locking projection contacts', async () => {
    const client = applyClient();

    await carddavSync.applyBookDelta(client, completePlan());

    const queries = client.query.mock.calls.map(([sql]) => sql);
    const targetBooks = queries.findIndex(sql => (
      /FROM address_books/.test(sql) && /source <> 'carddav'/.test(sql) && /FOR UPDATE/.test(sql)
    ));
    const contacts = queries.findIndex(sql => /FROM contacts/.test(sql));
    expect(targetBooks).toBeGreaterThan(0);
    expect(contacts).toBeGreaterThan(targetBooks);
    expect(queries[contacts]).toMatch(/ORDER BY c\.id[\s\S]+FOR UPDATE OF c/);
  });

  it('increments the remote revision in the final guarded book update', async () => {
    const client = applyClient();

    await carddavSync.applyBookDelta(client, completePlan());

    const update = client.query.mock.calls.find(([sql]) => (
      /UPDATE address_books SET/.test(sql)
    ));
    expect(update?.[0]).toMatch(
      /remote_sync_revision = remote_sync_revision \+ 1/,
    );
  });

  it('rejects a stale connection generation before book lookup or creation', async () => {
    const client = applyClient({ connectionGeneration: 'generation-new' });

    const error = await carddavSync.applyBookDelta(client, completePlan()).catch(caught => caught);

    expect(error).toBeInstanceOf(carddavSync.StaleCarddavPlanError);
    expect(error).toMatchObject({
      expectedConnectionGeneration: CONNECTION_GENERATION,
      actualConnectionGeneration: 'generation-new',
    });
    expect(client.query).toHaveBeenCalledOnce();
    expect(client.query.mock.calls[0][0]).toMatch(/FROM user_integrations[\s\S]+FOR UPDATE/);
  });

  it('treats a missing integration as stale before book lookup or creation', async () => {
    const client = applyClient({ integrationPresent: false });

    const error = await carddavSync.applyBookDelta(client, completePlan()).catch(caught => caught);

    expect(error).toBeInstanceOf(carddavSync.StaleCarddavPlanError);
    expect(error).toMatchObject({
      expectedConnectionGeneration: CONNECTION_GENERATION,
      actualConnectionGeneration: null,
    });
    expect(client.query).toHaveBeenCalledOnce();
  });

  it('rejects a stale remote revision before reading projection state', async () => {
    const client = applyClient({ remoteRevision: '8' });

    const error = await carddavSync.applyBookDelta(client, completePlan({
      expectedRemoteRevision: '7',
    })).catch(caught => caught);

    expect(error).toBeInstanceOf(carddavSync.StaleCarddavPlanError);
    expect(error).toMatchObject({
      expectedRemoteRevision: '7',
      actualRemoteRevision: '8',
    });
    expect(client.query).toHaveBeenCalledTimes(2);
    expect(client.query.mock.calls.some(([sql]) => /FROM carddav_remote_objects/.test(sql)))
      .toBe(false);
  });

  it('rejects a stale opaque remote token before reading or mutating projection state', async () => {
    const client = applyClient({ remoteToken: 'opaque-token' });

    const error = await carddavSync.applyBookDelta(client, completePlan({
      expectedRemoteToken: ' opaque-token ',
    })).catch(caught => caught);

    expect(carddavSync.StaleCarddavPlanError).toBeTypeOf('function');
    expect(error).toBeInstanceOf(carddavSync.StaleCarddavPlanError);
    expect(error).toMatchObject({
      expectedRemoteToken: ' opaque-token ',
      actualRemoteToken: 'opaque-token',
    });
    expect(client.query).toHaveBeenCalledTimes(2);
  });

  it('rejects an incremental alias replacement before reading projection state', async () => {
    const client = applyClient();

    const error = await carddavSync.applyBookDelta(client, completePlan({
      book: { url: ALIAS_BOOK_URL, displayName: 'Remote' },
      replaceAll: false,
      collectionIdentity: {
        observedUrl: ALIAS_BOOK_URL,
        canonicalUrl: CANONICAL_BOOK_URL,
      },
    })).catch(caught => caught);

    expect(error).toBeInstanceOf(carddavSync.StaleCarddavPlanError);
    expect(error).toMatchObject({ reason: 'canonical-reconciliation-required' });
    expect(client.query).toHaveBeenCalledOnce();
    expect(client.query.mock.calls.some(([sql]) => /FROM carddav_remote_objects/.test(sql)))
      .toBe(false);
  });

  it('rejects a missing observed alias instead of recreating it', async () => {
    const client = applyClient({ bookPresent: false });

    const error = await carddavSync.applyBookDelta(client, completePlan({
      book: { url: ALIAS_BOOK_URL, displayName: 'Remote' },
      collectionIdentity: {
        observedUrl: ALIAS_BOOK_URL,
        canonicalUrl: CANONICAL_BOOK_URL,
      },
    })).catch(caught => caught);

    expect(error).toBeInstanceOf(carddavSync.StaleCarddavPlanError);
    expect(error).toMatchObject({
      reason: 'observed-alias-missing',
      observedUrl: ALIAS_BOOK_URL,
    });
    expect(client.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO address_books')))
      .toBe(false);
  });

  it('locks observed and canonical books together in stable id order', async () => {
    const client = applyClient();

    await carddavSync.applyBookDelta(client, completePlan({
      book: { url: ALIAS_BOOK_URL, displayName: 'Remote' },
      collectionIdentity: {
        observedUrl: ALIAS_BOOK_URL,
        canonicalUrl: CANONICAL_BOOK_URL,
      },
    }));

    const bookLocks = client.query.mock.calls.filter(([sql]) => (
      /external_url = ANY\(\$2::text\[\]\)[\s\S]+FOR UPDATE/.test(sql)
    ));
    expect(bookLocks).toHaveLength(1);
    expect(bookLocks[0][0]).toMatch(/external_url = ANY\(\$2::text\[\]\)[\s\S]+ORDER BY id[\s\S]+FOR UPDATE/);
    expect(bookLocks[0][1]).toEqual([
      USER_ID,
      [ALIAS_BOOK_URL, CANONICAL_BOOK_URL],
    ]);
  });

  it('rejects a zero-row final book update as stale', async () => {
    const client = applyClient({ bookUpdateCount: 0 });

    const error = await carddavSync.applyBookDelta(client, completePlan())
      .catch(caught => caught);

    expect(error).toBeInstanceOf(carddavSync.StaleCarddavPlanError);
    expect(error).toMatchObject({ reason: 'book-update-missed', bookId: BOOK_ID });
  });

  it('recovers from an address-book name collision without aborting the transaction', async () => {
    let insertAttempts = 0;
    const client = {
      query: vi.fn(async sql => {
        if (/FROM address_books[\s\S]+FOR UPDATE/.test(sql)) return { rows: [] };
        if (sql.includes('INSERT INTO address_books')) {
          insertAttempts++;
          if (insertAttempts === 1) {
            const error = new Error('duplicate name');
            error.code = '23505';
            throw error;
          }
          return {
            rows: [{
            id: BOOK_ID,
            external_url: BOOK_URL,
            remote_sync_token: null,
            remote_sync_revision: '0',
            sync_token: 'local-token-before',
            }],
          };
        }
        if (/FROM user_integrations[\s\S]+FOR (?:SHARE|UPDATE)/.test(sql)) {
          return { rows: [{
            id: USER_ID,
            dup_mode: 'separate',
            connection_generation: CONNECTION_GENERATION,
            contact_count: '0',
          }] };
        }
        if (sql.includes('FROM carddav_remote_objects')) return { rows: [] };
        if (sql.includes('FROM contacts')) return { rows: [] };
        if (/UPDATE address_books SET/.test(sql)) return { rows: [], rowCount: 1 };
        if (/UPDATE user_integrations/.test(sql)) return { rows: [], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }),
    };

    await carddavSync.applyBookDelta(client, completePlan());

    expect(insertAttempts).toBe(2);
    expect(client.query.mock.calls.map(([sql]) => sql)).toContain('ROLLBACK TO SAVEPOINT carddav_book_name');
  });

  it('preserves the exact remote ETag in the provenance ledger', async () => {
    const client = applyClient();
    const card = remoteCard('quoted-etag', 'quoted@example.test');

    await carddavSync.applyBookDelta(client, completePlan({ upserts: [card] }));

    const ledgerInsert = client.query.mock.calls.find(([sql]) => (
      sql.includes('INSERT INTO carddav_remote_objects')
    ));
    expect(ledgerInsert[1][2]).toBe('W/"remote-etag-quoted-etag"');
  });

  it('performs no ledger write for a no-change incremental plan', async () => {
    const fixture = persistedSeparate('unchanged', 'unchanged@example.test');
    const client = projectionClient({
      objects: [fixture.object],
      contacts: [fixture.contact],
    });

    const result = await carddavSync.applyBookDelta(client, completePlan({
      replaceAll: false,
    }));

    const ledgerWrites = client.query.mock.calls.filter(([sql]) => (
      /(?:INSERT INTO|DELETE FROM|UPDATE) carddav_remote_objects/.test(sql)
    ));
    expect(ledgerWrites).toEqual([]);
    expect(result).toMatchObject({ ledgerChanged: false, changedBookIds: [] });
  });

  it('classifies an unreported local-only edit as pending push', async () => {
    const fixture = persistedSeparate('local-only', 'local-only@example.test');
    fixture.object.mapping_status = 'synced';
    fixture.object.mapping_revision = '4';
    fixture.object.remote_semantic_hash = semanticVCardHash(parseVCardDocument(fixture.card.vcard));
    fixture.object.local_contact_hash = localContactHash(fixture.contact);
    fixture.contact.display_name = 'Local Only Changed';
    const client = projectionClient({
      objects: [fixture.object],
      contacts: [fixture.contact],
    });

    const result = await carddavSync.applyBookDelta(client, completePlan({
      replaceAll: false,
    }));

    const mappingWrite = client.query.mock.calls.find(([sql]) => (
      /UPDATE carddav_remote_objects/.test(sql)
    ));
    expect(mappingWrite[0]).toContain("mapping_status = 'pending_push'");
    expect(result).toMatchObject({
      ledgerChanged: true,
      changedBookIds: [],
      updated: 0,
      removed: 0,
    });
  });

  it('writes only the changed href for a ledger-only ETag delta', async () => {
    const fixture = persistedSeparate('etag-only', 'etag-only@example.test');
    const client = projectionClient({
      objects: [fixture.object],
      contacts: [fixture.contact],
    });
    const changed = { ...fixture.card, remoteEtag: 'W/"changed-etag"' };

    const result = await carddavSync.applyBookDelta(client, completePlan({
      replaceAll: false,
      upserts: [changed],
    }));

    const ledgerWrites = client.query.mock.calls.filter(([sql]) => (
      /(?:INSERT INTO|DELETE FROM|UPDATE) carddav_remote_objects/.test(sql)
    ));
    expect(ledgerWrites).toHaveLength(1);
    expect(ledgerWrites[0][0]).toContain('UPDATE carddav_remote_objects');
    expect(ledgerWrites[0][1]).toEqual(expect.arrayContaining([
      fixture.card.href,
      'W/"changed-etag"',
    ]));
    expect(result).toMatchObject({ ledgerChanged: true, changedBookIds: [] });
  });

  it('regenerates a separate local vCard and ETag from its final contact fields', async () => {
    const client = applyClient();
    const card = remoteCard('local-materialization', 'materialized@example.test');

    await carddavSync.applyBookDelta(client, completePlan({ upserts: [card] }));

    const contactInsert = client.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO contacts'));
    const localUid = createHash('sha256').update(card.href).digest('hex');
    expect(contactInsert[1][2]).toBe(localUid);
    expect(contactInsert[1][3]).toContain(`UID:${localUid}\r\n`);
    expect(contactInsert[1][3]).toContain('FN:local-materialization\r\n');
    expect(contactInsert[1][3]).not.toBe(card.vcard);
    expect(contactInsert[1][4]).toBe(createHash('md5').update(contactInsert[1][3]).digest('hex'));
  });

  it('reports automatic projection counters from the transactional apply boundary', async () => {
    const client = projectionClient({ contacts: [targetContactRow()] });
    const cards = [
      remoteCard('separate', 'new@example.test'),
      remoteCard('merge', 'duplicate@example.test'),
      remoteCard('skip', 'duplicate@example.test'),
    ];

    const result = await carddavSync.applyBookDelta(client, completePlan({ upserts: cards }));

    expect(result).toMatchObject({
      ledgerChanged: true,
      remote: 3,
      updated: 2,
      removed: 0,
    });
    expect(result).not.toHaveProperty('count');
    expect(result).not.toHaveProperty('contactCount');
    expect(result).not.toHaveProperty('skipped');
    expect(result).not.toHaveProperty('merged');
  });

  it('counts a deleted separately projected contact at the apply boundary', async () => {
    const card = remoteCard('gone', 'gone@example.test');
    const client = projectionClient({
      objects: [{
        address_book_id: BOOK_ID,
        href: card.href,
        remote_etag: card.remoteEtag,
        vcard: card.vcard,
        primary_email: 'gone@example.test',
        local_contact_id: TARGET_ID,
        legacy_projection: null,
      }],
      contacts: [targetContactRow({
        id: TARGET_ID,
        address_book_id: BOOK_ID,
        uid: 'owned-remote',
        primary_email: 'gone@example.test',
      })],
    });

    const result = await carddavSync.applyBookDelta(client, completePlan({
      replaceAll: false,
      removedHrefs: [card.href],
    }));

    expect(result).toMatchObject({ remote: 0, updated: 0, removed: 1 });
  });
});

describe('automatic apply boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('persists observed capabilities inside the guarded book transaction', async () => {
    const plan = completePlan({
      book: {
        url: BOOK_URL,
        displayName: 'Remote',
        discoveryIndex: 0,
        capabilities: { create: 'allowed', update: 'unknown', delete: 'denied' },
      },
    });
    const client = {
      query: vi.fn(async (sql, params) => {
        if (/information_schema\.columns[\s\S]+AS has_legacy_projection/.test(sql)) {
          return { rows: [{
            id: USER_ID,
            has_legacy_projection: false,
            connection_generation: CONNECTION_GENERATION,
            contact_count: '0',
          }] };
        }
        if (/external_url = ANY\(\$2::text\[\]\)/.test(sql)) {
          return { rows: [{
            id: BOOK_ID,
            external_url: BOOK_URL,
            remote_sync_token: null,
            remote_sync_revision: '0',
            sync_token: 'local-token',
            remote_projection_fingerprint: null,
          }] };
        }
        if (/UPDATE address_books SET/.test(sql)) {
          expect(sql).toMatch(/remote_create_capability = \$7/);
          expect(sql).toMatch(/remote_update_capability = \$8/);
          expect(sql).toMatch(/remote_delete_capability = \$9/);
          expect(params.slice(6)).toEqual(['allowed', 'unknown', 'denied']);
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }),
    };

    await expect(carddavSync.applyBookDelta(client, plan)).resolves.toMatchObject({
      remote: 0,
      updated: 0,
      removed: 0,
    });
  });

  it('refreshes an imported projection when its remote contact changes', async () => {
    const card = remoteCard('projected', 'projected@example.test');
    const updatedVcard = card.vcard.replace(
      'FN:projected\r\n',
      'FN:Projected After\r\n',
    );
    const updated = {
      ...card,
      vcard: updatedVcard,
      contact: { ...card.contact, displayName: 'Projected After' },
    };
    const localUid = createHash('sha256').update(card.href).digest('hex');
    const beforeVcard = generateVCard({
      ...card.contact,
      uid: localUid,
      displayName: 'Projected Before',
    });
    const client = projectionClient({
      objects: [{
        address_book_id: BOOK_ID,
        href: card.href,
        remote_etag: card.remoteEtag,
        vcard: card.vcard,
        primary_email: card.contact.primaryEmail,
        local_contact_id: TARGET_ID,
        legacy_projection: null,
      }],
      contacts: [targetContactRow({
        id: TARGET_ID,
        address_book_id: BOOK_ID,
        address_book_source: 'carddav',
        uid: localUid,
        vcard: beforeVcard,
        etag: createHash('md5').update(beforeVcard).digest('hex'),
        display_name: 'Projected Before',
        primary_email: card.contact.primaryEmail,
        emails: card.contact.emails,
      })],
      contactCount: 1,
    });

    const result = await carddavSync.applyBookDelta(client, completePlan({
      replaceAll: false,
      upserts: [updated],
    }));

    const contactUpdate = client.query.mock.calls.find(([sql]) => (
      /UPDATE contacts\s+SET/.test(sql)
    ));
    expect(contactUpdate).toBeDefined();
    expect(contactUpdate[1]).toEqual(expect.arrayContaining([
      USER_ID,
      TARGET_ID,
      'Projected After',
    ]));
    expect(result.changedBookIds).toEqual([BOOK_ID]);
  });
});

describe('prepareBookPlan fences', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('carries connection generation and opaque remote revision into the plan', async () => {
    const collectionIdentity = {
      observedUrl: BOOK_URL,
      canonicalUrl: BOOK_URL,
    };
    mocks.query.mockResolvedValue({
      rows: [{
        connection_generation: CONNECTION_GENERATION,
        remote_sync_token: 'opaque-before',
        remote_sync_capability: 'sync-collection',
        remote_sync_revision: '9223372036854775806',
      }],
    });
    mocks.fetchAddressBookDelta.mockResolvedValue({
      expectedRemoteToken: 'opaque-before',
      nextRemoteToken: 'opaque-after',
      capability: 'sync-collection',
      replaceAll: false,
      collectionIdentity,
      upserts: [],
      removedHrefs: [],
    });

    const plan = await carddavSync.prepareBookPlan(
      USER_ID,
      { url: BOOK_URL, displayName: 'Remote', supportsSyncCollection: true },
      'separate',
      { username: 'user', password: 'password' },
    );

    expect(plan).toMatchObject({
      connectionGeneration: CONNECTION_GENERATION,
      expectedRemoteRevision: '9223372036854775806',
      expectedRemoteToken: 'opaque-before',
      collectionIdentity,
    });
    expect(mocks.query).toHaveBeenCalledOnce();
    expect(mocks.query.mock.calls[0][0]).toMatch(/connectionGeneration/);
    expect(mocks.query.mock.calls[0][0]).toMatch(/remote_sync_revision/);
    expect(mocks.query.mock.calls.some(([sql]) => /UPDATE address_books/.test(sql))).toBe(false);
  });

  it('carries the complete discovery book without duplicate-mode state', async () => {
    const book = {
      url: BOOK_URL,
      displayName: 'Remote',
      supportsSyncCollection: true,
      discoveryIndex: 2,
      capabilities: { create: 'allowed', update: 'unknown', delete: 'denied' },
      addressData: [{ contentType: 'text/vcard', version: '4.0' }],
    };
    mocks.query.mockResolvedValue({ rows: [{
      connection_generation: CONNECTION_GENERATION,
      remote_sync_token: 'before',
      remote_sync_capability: 'sync-collection',
      remote_sync_revision: '7',
    }] });
    mocks.fetchAddressBookDelta.mockResolvedValue({
      expectedRemoteToken: 'before',
      nextRemoteToken: 'after',
      capability: 'sync-collection',
      replaceAll: false,
      collectionIdentity: { observedUrl: BOOK_URL, canonicalUrl: BOOK_URL },
      upserts: [],
      removedHrefs: [],
    });

    const plan = await carddavSync.prepareBookPlan(
      USER_ID,
      book,
      { username: 'user', password: 'password' },
    );

    expect(plan).toMatchObject({
      book,
      connectionGeneration: CONNECTION_GENERATION,
      expectedRemoteRevision: '7',
      expectedRemoteToken: 'before',
    });
    expect(plan).not.toHaveProperty('dupMode');
  });

  it('carries required generation and revision zero when the remote book is absent', async () => {
    mocks.query.mockResolvedValue({
      rows: [{
        connection_generation: CONNECTION_GENERATION,
        book_id: null,
        remote_sync_token: null,
        remote_sync_capability: null,
        remote_sync_revision: null,
      }],
    });
    mocks.fetchAddressBookDelta.mockResolvedValue({
      expectedRemoteToken: null,
      nextRemoteToken: null,
      capability: 'snapshot',
      replaceAll: true,
      collectionIdentity: { observedUrl: BOOK_URL, canonicalUrl: BOOK_URL },
      upserts: [],
      removedHrefs: [],
    });

    const plan = await carddavSync.prepareBookPlan(
      USER_ID,
      { url: BOOK_URL, displayName: 'Remote', supportsSyncCollection: true },
      'separate',
      { username: 'user', password: 'password' },
    );

    expect(plan).toMatchObject({
      connectionGeneration: CONNECTION_GENERATION,
      expectedRemoteRevision: '0',
      expectedRemoteToken: null,
    });
    expect(mocks.query.mock.calls[0][0]).toMatch(
      /FROM user_integrations ui[\s\S]+LEFT JOIN address_books/,
    );
  });

  it('replaces an alias delta with one full canonical reconciliation', async () => {
    const discarded = remoteCard('discarded', 'discarded@example.test');
    const retained = remoteCard('retained', 'retained@example.test');
    mocks.query.mockResolvedValue({
      rows: [{
        connection_generation: CONNECTION_GENERATION,
        remote_sync_token: 'alias-token-before',
        remote_sync_capability: 'sync-collection',
        remote_sync_revision: '7',
      }],
    });
    mocks.fetchAddressBookDelta
      .mockResolvedValueOnce({
        expectedRemoteToken: 'alias-token-before',
        nextRemoteToken: 'discarded-token',
        capability: 'sync-collection',
        replaceAll: false,
        collectionIdentity: {
          observedUrl: ALIAS_BOOK_URL,
          canonicalUrl: CANONICAL_BOOK_URL,
        },
        upserts: [{
          href: discarded.href,
          etag: discarded.remoteEtag,
          vcard: discarded.vcard,
        }],
        removedHrefs: ['discarded.vcf'],
      })
      .mockResolvedValueOnce({
        expectedRemoteToken: null,
        nextRemoteToken: 'canonical-token-after',
        capability: 'sync-collection',
        replaceAll: true,
        collectionIdentity: {
          observedUrl: CANONICAL_BOOK_URL,
          canonicalUrl: CANONICAL_BOOK_URL,
        },
        upserts: [{ href: retained.href, etag: retained.remoteEtag, vcard: retained.vcard }],
        removedHrefs: [],
      });

    const plan = await carddavSync.prepareBookPlan(
      USER_ID,
      { url: ALIAS_BOOK_URL, displayName: 'Remote', supportsSyncCollection: true },
      'separate',
      { username: 'user', password: 'password' },
    );

    expect(mocks.fetchAddressBookDelta.mock.calls).toEqual([
      [expect.objectContaining({ url: ALIAS_BOOK_URL, syncToken: 'alias-token-before' })],
      [expect.objectContaining({ url: CANONICAL_BOOK_URL, syncToken: '' })],
    ]);
    expect(plan).toMatchObject({
      connectionGeneration: CONNECTION_GENERATION,
      expectedRemoteRevision: '7',
      expectedRemoteToken: 'alias-token-before',
      nextRemoteToken: 'canonical-token-after',
      replaceAll: true,
      collectionIdentity: {
        observedUrl: ALIAS_BOOK_URL,
        canonicalUrl: CANONICAL_BOOK_URL,
      },
      removedHrefs: [],
    });
    expect(plan.upserts.map(card => card.href)).toEqual([retained.href]);
  });

  it('does not refetch an alias plan that is already a full reconciliation', async () => {
    mocks.query.mockResolvedValue({ rows: [{
      book_id: null,
      remote_sync_token: null,
      remote_sync_capability: null,
      remote_sync_revision: null,
      connection_generation: CONNECTION_GENERATION,
    }] });
    mocks.fetchAddressBookDelta.mockResolvedValue({
      expectedRemoteToken: null,
      nextRemoteToken: 'canonical-token-after',
      capability: 'snapshot',
      replaceAll: true,
      collectionIdentity: {
        observedUrl: ALIAS_BOOK_URL,
        canonicalUrl: CANONICAL_BOOK_URL,
      },
      upserts: [],
      removedHrefs: [],
    });

    await carddavSync.prepareBookPlan(
      USER_ID,
      { url: ALIAS_BOOK_URL, displayName: 'Remote', supportsSyncCollection: true },
      'separate',
      { username: 'user', password: 'password' },
    );

    expect(mocks.fetchAddressBookDelta).toHaveBeenCalledOnce();
  });

  it('rejects a canonical reconciliation that finishes at another identity', async () => {
    const changedUrl = 'https://dav.example.test/addressbooks/changed-again/';
    mocks.query.mockResolvedValue({ rows: [{
      remote_sync_token: 'alias-token-before',
      remote_sync_capability: 'sync-collection',
      remote_sync_revision: '7',
      connection_generation: CONNECTION_GENERATION,
    }] });
    mocks.fetchAddressBookDelta
      .mockResolvedValueOnce({
        expectedRemoteToken: 'alias-token-before', nextRemoteToken: 'discarded',
        capability: 'sync-collection', replaceAll: false,
        collectionIdentity: {
          observedUrl: ALIAS_BOOK_URL,
          canonicalUrl: CANONICAL_BOOK_URL,
        },
        upserts: [], removedHrefs: [],
      })
      .mockResolvedValueOnce({
        expectedRemoteToken: null, nextRemoteToken: 'changed',
        capability: 'sync-collection', replaceAll: true,
        collectionIdentity: { observedUrl: CANONICAL_BOOK_URL, canonicalUrl: changedUrl },
        upserts: [], removedHrefs: [],
      });

    const error = await carddavSync.prepareBookPlan(
      USER_ID,
      { url: ALIAS_BOOK_URL, displayName: 'Remote', supportsSyncCollection: true },
      'separate',
      { username: 'user', password: 'password' },
    ).catch(caught => caught);

    expect(error).toBeInstanceOf(carddavSync.StaleCarddavPlanError);
    expect(error).toMatchObject({ reason: 'canonical-reconciliation-required' });
    expect(mocks.fetchAddressBookDelta).toHaveBeenCalledTimes(2);
    expect(mocks.withTransaction).not.toHaveBeenCalled();
  });
});

describe('pull-first automatic export orchestration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches and applies every book before exporting with the same snapshot', async () => {
    const books = [
      {
        url: BOOK_URL,
        displayName: 'Remote',
        supportsSyncCollection: true,
        discoveryIndex: 0,
        capabilities: { create: 'allowed', update: 'allowed', delete: 'allowed' },
      },
      {
        url: `${BOOK_URL}team/`,
        displayName: 'Team',
        supportsSyncCollection: true,
        discoveryIndex: 1,
        capabilities: { create: 'unknown', update: 'unknown', delete: 'unknown' },
      },
    ];
    mocks.query.mockImplementation(async (sql) => {
      if (/SELECT config FROM user_integrations/.test(sql)) {
        return { rows: [{ config: {
          serverUrl: 'https://dav.example.test/',
          username: 'user',
          password: 'encrypted',
          connectionGeneration: CONNECTION_GENERATION,
        } }] };
      }
      if (/SELECT remote_sync_token/.test(sql)) {
        return { rows: [{
          remote_sync_token: null,
          remote_sync_capability: 'unknown',
          remote_sync_revision: '0',
          connection_generation: CONNECTION_GENERATION,
        }] };
      }
      if (/mapping.local_contact_id = c.id/.test(sql)) {
        return { rows: [{ id: 'local-a' }, { id: 'local-b' }] };
      }
      return { rows: [], rowCount: 0 };
    });
    mocks.discoverAddressBooks.mockResolvedValue(books);
    mocks.fetchAddressBookDelta.mockImplementation(async ({ url }) => ({
      expectedRemoteToken: null,
      nextRemoteToken: `${url}token`,
      capability: 'sync-collection',
      replaceAll: true,
      collectionIdentity: { observedUrl: url, canonicalUrl: url },
      upserts: [],
      removedHrefs: [],
    }));
    mocks.withTransaction
      .mockResolvedValueOnce({ remote: 0, updated: 0, removed: 0, skipped: 0, merged: 0 })
      .mockResolvedValueOnce({ remote: 0, updated: 0, removed: 0, skipped: 0, merged: 0 })
      .mockResolvedValueOnce(0);
    mocks.exportExistingContact
      .mockRejectedValueOnce(Object.assign(new Error('read only'), {
        code: 'ERR_CARDDAV_READ_ONLY',
      }))
      .mockResolvedValueOnce({ id: 'local-b' });

    const result = await carddavSync.syncUser(USER_ID);

    expect(mocks.fetchAddressBookDelta).toHaveBeenCalledTimes(2);
    expect(mocks.exportExistingContact.mock.calls).toEqual([
      [USER_ID, 'local-a', { books, expectedGeneration: CONNECTION_GENERATION }],
      [USER_ID, 'local-b', { books, expectedGeneration: CONNECTION_GENERATION }],
    ]);
    expect(mocks.fetchAddressBookDelta.mock.invocationCallOrder[1])
      .toBeLessThan(mocks.withTransaction.mock.invocationCallOrder[0]);
    expect(mocks.withTransaction.mock.invocationCallOrder[1])
      .toBeLessThan(mocks.exportExistingContact.mock.invocationCallOrder[0]);
    expect(mocks.exportExistingContact.mock.invocationCallOrder[1])
      .toBeLessThan(mocks.withTransaction.mock.invocationCallOrder[2]);
    expect(result).toMatchObject({
      ok: true,
      exportFailures: [{
        localContactId: 'local-a',
        code: 'ERR_CARDDAV_READ_ONLY',
        message: 'read only',
      }],
    });
  });
});

describe('network planning orchestration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs read-only pending-intent recovery before planning the scheduled pull', async () => {
    configureOneBookSync();
    const client = applyClient();
    mocks.fetchAddressBookDelta.mockResolvedValue({
      expectedRemoteToken: null,
      nextRemoteToken: null,
      capability: 'sync-collection',
      replaceAll: false,
      upserts: [],
      removedHrefs: [],
    });
    mocks.withTransaction
      .mockImplementationOnce(callback => callback(client))
      .mockResolvedValueOnce(0);

    await expect(carddavSync.syncUser(USER_ID)).resolves.toMatchObject({ ok: true });

    expect(mocks.recoverPendingCarddavMutations).toHaveBeenCalledOnce();
    expect(mocks.recoverPendingCarddavMutations.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.fetchAddressBookDelta.mock.invocationCallOrder[0]);
  });

  it('settles every book fetch and vCard parse before opening the first transaction', async () => {
    let discoverySettled = false;
    const fetchedBooks = [];
    let insideTransaction = false;
    const client = applyClient();
    const secondBookUrl = 'https://dav.example.test/addressbooks/team/';
    const cards = [
      remoteCard('alpha', 'alpha@example.test'),
      remoteCard('beta', 'beta@example.test'),
    ].map(card => ({ href: card.href, etag: card.remoteEtag, vcard: card.vcard }));

    mocks.query.mockImplementation(async sql => {
      if (sql.includes("provider = 'carddav'") && sql.includes('SELECT config')) {
        return {
          rows: [{
            config: {
              serverUrl: 'https://dav.example.test/',
              username: 'user',
              password: 'encrypted',
              connectionGeneration: CONNECTION_GENERATION,
            },
          }],
        };
      }
      if (sql.includes('SELECT remote_sync_token')) {
        return { rows: [{
          remote_sync_token: null,
          remote_sync_capability: 'unknown',
          remote_sync_revision: '0',
          connection_generation: CONNECTION_GENERATION,
        }] };
      }
      return { rows: [], rowCount: 0 };
    });
    mocks.discoverAddressBooks.mockImplementation(async () => {
      expect(insideTransaction).toBe(false);
      discoverySettled = true;
      return [
        { url: BOOK_URL, displayName: 'Remote', supportsSyncCollection: true },
        { url: secondBookUrl, displayName: 'Team', supportsSyncCollection: true },
      ];
    });
    mocks.fetchAddressBookDelta.mockImplementation(async ({ url, syncToken, supportsSyncCollection }) => {
      expect(insideTransaction).toBe(false);
      expect(syncToken).toBeNull();
      expect(supportsSyncCollection).toBe(true);
      const index = url === BOOK_URL ? 0 : 1;
      fetchedBooks.push(index);
      return {
        expectedRemoteToken: null,
        nextRemoteToken: `remote-token-${index}`,
        capability: 'sync-collection',
        replaceAll: true,
        upserts: [cards[index]],
        removedHrefs: [],
      };
    });
    mocks.withTransaction.mockImplementation(async callback => {
      expect(discoverySettled).toBe(true);
      expect(fetchedBooks).toEqual([0, 1]);
      expect(mocks.parseVCard.mock.calls.map(([vcard]) => vcard)).toEqual([
        cards[0].vcard,
        cards[1].vcard,
      ]);
      insideTransaction = true;
      try {
        return await callback(client);
      } finally {
        insideTransaction = false;
      }
    });

    const result = await carddavSync.syncUser(USER_ID);

    expect(result.error).toBeUndefined();
    expect(result).toMatchObject({
      ok: true,
      bookCount: 2,
      contactCount: 2,
      remote: 2,
      fetched: 2,
      updated: 2,
      removed: 0,
      fallback: 0,
    });
    expect(mocks.withTransaction).toHaveBeenCalledTimes(3);
    expect(mocks.fetchAddressBookDelta).toHaveBeenCalledTimes(2);
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining('SELECT remote_sync_token'),
      [USER_ID, BOOK_URL],
    );
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining('SELECT remote_sync_token'),
      [USER_ID, secondBookUrl],
    );
    expect(mocks.query.mock.calls.some(([sql]) => (
      /DELETE FROM address_books/.test(sql)
    ))).toBe(false);
  });

  it('finalizes a replaced alias under its canonical collection URL', async () => {
    mocks.query.mockImplementation(async sql => {
      if (sql.includes("provider = 'carddav'") && sql.includes('SELECT config')) {
        return { rows: [{ config: {
          serverUrl: 'https://dav.example.test/',
          username: 'user',
          password: 'encrypted',
          connectionGeneration: CONNECTION_GENERATION,
        } }] };
      }
      if (sql.includes('SELECT remote_sync_token')) return { rows: [{
        remote_sync_token: null,
        remote_sync_capability: 'unknown',
        remote_sync_revision: '0',
        connection_generation: CONNECTION_GENERATION,
      }] };
      return { rows: [], rowCount: 0 };
    });
    mocks.discoverAddressBooks.mockResolvedValue([
      { url: ALIAS_BOOK_URL, displayName: 'Remote', supportsSyncCollection: true },
    ]);
    mocks.fetchAddressBookDelta.mockResolvedValue({
      expectedRemoteToken: null,
      nextRemoteToken: 'canonical-token-after',
      capability: 'sync-collection',
      replaceAll: true,
      collectionIdentity: {
        observedUrl: ALIAS_BOOK_URL,
        canonicalUrl: CANONICAL_BOOK_URL,
      },
      upserts: [],
      removedHrefs: [],
    });
    const apply = applyClient();
    const finalize = applyClient({
      lifecycleBooks: [{
        id: BOOK_ID,
        source: 'carddav',
        external_url: CANONICAL_BOOK_URL,
        sync_token: 'local-token-before',
      }],
    });
    mocks.withTransaction
      .mockImplementationOnce(callback => callback(apply))
      .mockImplementationOnce(callback => callback(finalize));

    const result = await carddavSync.syncUser(USER_ID);

    expect(result).toMatchObject({ ok: true, bookCount: 1 });
    expect(finalize.query.mock.calls.some(([sql]) => (
      /DELETE FROM address_books/.test(sql)
    ))).toBe(false);
  });

  it('does not prune when discovery fails before returning a complete book list', async () => {
    mocks.query.mockImplementation(async sql => {
      if (sql.includes("provider = 'carddav'") && sql.includes('SELECT config')) {
        return { rows: [{ config: {
          serverUrl: 'https://dav.example.test/', username: 'user', password: 'encrypted',
        } }] };
      }
      return { rows: [], rowCount: 0 };
    });
    mocks.discoverAddressBooks.mockRejectedValue(new Error('discovery incomplete'));

    const result = await carddavSync.syncUser(USER_ID);

    expect(result).toEqual({ ok: false, error: 'discovery incomplete', ...EMPTY_COUNTERS });
    expect(mocks.fetchAddressBookDelta).not.toHaveBeenCalled();
    expect(mocks.withTransaction).not.toHaveBeenCalled();
    expect(mocks.query.mock.calls.some(([sql]) => sql.includes('DELETE FROM address_books'))).toBe(false);
  });

  it('prunes stale books after a complete empty discovery through finalization', async () => {
    mocks.query.mockImplementation(async sql => {
      if (sql.includes("provider = 'carddav'") && sql.includes('SELECT config')) {
        return { rows: [{ config: {
          serverUrl: 'https://dav.example.test/', username: 'user', password: 'encrypted',
        } }] };
      }
      return { rows: [], rowCount: 0 };
    });
    mocks.discoverAddressBooks.mockResolvedValue([]);
    mocks.withTransaction.mockImplementation(callback => callback(applyClient()));

    const result = await carddavSync.syncUser(USER_ID);

    expect(result).toMatchObject({ ok: true, bookCount: 0, contactCount: 0 });
    expect(mocks.fetchAddressBookDelta).not.toHaveBeenCalled();
    expect(mocks.withTransaction).toHaveBeenCalledOnce();
    expect(mocks.query.mock.calls.some(([sql]) => (
      /DELETE FROM address_books/.test(sql)
    ))).toBe(false);
  });

  it('reports not connected when the integration vanishes before finalization', async () => {
    mocks.query.mockImplementation(async sql => {
      if (sql.includes("provider = 'carddav'") && sql.includes('SELECT config')) {
        return { rows: [{ config: {
          serverUrl: 'https://dav.example.test/',
          username: 'user',
          password: 'encrypted',
          connectionGeneration: CONNECTION_GENERATION,
        } }] };
      }
      return { rows: [], rowCount: 0 };
    });
    mocks.discoverAddressBooks.mockResolvedValue([]);
    const finalize = applyClient({ integrationPresent: false });
    mocks.withTransaction.mockImplementation(callback => callback(finalize));

    const result = await carddavSync.syncUser(USER_ID);

    expect(result).toEqual({ ok: false, error: 'not connected', ...EMPTY_COUNTERS });
    expect(finalize.query).toHaveBeenCalledOnce();
    expect(finalize.query.mock.calls[0][0]).toMatch(/FROM user_integrations[\s\S]+FOR UPDATE/);
    expect(mocks.query).toHaveBeenCalledTimes(2);
    expect(mocks.query.mock.calls[1][0]).toMatch(/c\.is_auto = false/);
  });

  it('does not open a transaction or write when a later book multiget batch fails', async () => {
    const secondBookUrl = 'https://dav.example.test/addressbooks/team/';
    const client = applyClient();
    const raw = remoteCard('alpha', 'alpha@example.test');

    mocks.query.mockImplementation(async sql => {
      if (sql.includes("provider = 'carddav'") && sql.includes('SELECT config')) {
        return {
          rows: [{
            config: {
              serverUrl: 'https://dav.example.test/',
              username: 'user',
              password: 'encrypted',
            },
          }],
        };
      }
      if (sql.includes('SELECT remote_sync_token')) return { rows: [{
        book_id: null,
        remote_sync_token: null,
        remote_sync_capability: null,
        remote_sync_revision: null,
        connection_generation: CONNECTION_GENERATION,
      }] };
      return { rows: [], rowCount: 0 };
    });
    mocks.discoverAddressBooks.mockResolvedValue([
      { url: BOOK_URL, displayName: 'Remote', supportsSyncCollection: true },
      { url: secondBookUrl, displayName: 'Team', supportsSyncCollection: true },
    ]);
    mocks.fetchAddressBookDelta
      .mockResolvedValueOnce({
        expectedRemoteToken: null,
        nextRemoteToken: 'first-token',
        capability: 'sync-collection',
        replaceAll: true,
        upserts: [{ href: raw.href, etag: raw.remoteEtag, vcard: raw.vcard }],
        removedHrefs: [],
      })
      .mockRejectedValueOnce(new Error('multiget batch 2 failed'));
    mocks.withTransaction.mockImplementation(callback => callback(client));

    const result = await carddavSync.syncUser(USER_ID);

    expect(result).toEqual({ ok: false, error: 'multiget batch 2 failed', ...EMPTY_COUNTERS });
    expect(mocks.withTransaction).not.toHaveBeenCalled();
    expect(client.query).not.toHaveBeenCalled();
    expect(mocks.query.mock.calls.some(([sql]) => sql.includes('DELETE FROM address_books'))).toBe(false);
  });

  it('keeps persisted snapshot mode even when discovery later advertises sync support', async () => {
    const client = applyClient();
    mocks.query.mockImplementation(async sql => {
      if (sql.includes("provider = 'carddav'") && sql.includes('SELECT config')) {
        return {
          rows: [{
            config: {
              serverUrl: 'https://dav.example.test/',
              username: 'user',
              password: 'encrypted',
            },
          }],
        };
      }
      if (sql.includes('SELECT remote_sync_token')) {
        return { rows: [{
          remote_sync_token: null,
          remote_sync_capability: 'snapshot',
          remote_sync_revision: '0',
          connection_generation: CONNECTION_GENERATION,
        }] };
      }
      return { rows: [], rowCount: 0 };
    });
    mocks.discoverAddressBooks.mockResolvedValue([
      { url: BOOK_URL, displayName: 'Remote', supportsSyncCollection: true },
    ]);
    mocks.fetchAddressBookDelta.mockResolvedValue({
      expectedRemoteToken: null,
      nextRemoteToken: null,
      capability: 'snapshot',
      replaceAll: true,
      upserts: [],
      removedHrefs: [],
    });
    mocks.withTransaction.mockImplementation(callback => callback(client));

    const result = await carddavSync.syncUser(USER_ID);

    expect(result).toMatchObject({ ok: true, bookCount: 1, fallback: 1 });
    expect(mocks.fetchAddressBookDelta).toHaveBeenCalledWith(expect.objectContaining({
      url: BOOK_URL,
      supportsSyncCollection: false,
    }));
  });

  it('performs exactly one empty-token reconciliation after a valid-sync-token error', async () => {
    configureOneBookSync({ remoteToken: 'opaque-before' });
    const client = applyClient({ remoteToken: 'opaque-before' });
    mocks.fetchAddressBookDelta
      .mockRejectedValueOnce(new CardDavError('Stored sync token is invalid', {
        status: 403,
        precondition: 'valid-sync-token',
      }))
      .mockResolvedValueOnce({
        expectedRemoteToken: '',
        nextRemoteToken: 'opaque-after',
        capability: 'sync-collection',
        replaceAll: true,
        upserts: [],
        removedHrefs: [],
      });
    mocks.withTransaction.mockImplementation(callback => callback(client));

    const result = await carddavSync.syncUser(USER_ID);

    expect(result).toMatchObject({ ok: true, bookCount: 1, fallback: 1 });
    expect(mocks.fetchAddressBookDelta).toHaveBeenCalledTimes(2);
    expect(mocks.fetchAddressBookDelta.mock.calls.map(([request]) => request.syncToken))
      .toEqual(['opaque-before', '']);
    const updateBook = client.query.mock.calls.find(([sql]) => sql.includes('UPDATE address_books SET'));
    expect(updateBook[1][1]).toBe('opaque-after');
  });

  it('does not recurse when the empty-token reconciliation gets valid-sync-token again', async () => {
    configureOneBookSync({ remoteToken: 'opaque-before' });
    const invalidToken = () => new CardDavError('Stored sync token is invalid', {
      status: 403,
      precondition: 'valid-sync-token',
    });
    mocks.fetchAddressBookDelta
      .mockRejectedValueOnce(invalidToken())
      .mockRejectedValueOnce(invalidToken());

    const result = await carddavSync.syncUser(USER_ID);

    expect(result).toEqual({
      ok: false,
      error: 'Stored sync token is invalid',
      ...EMPTY_COUNTERS,
    });
    expect(mocks.fetchAddressBookDelta).toHaveBeenCalledTimes(2);
    expect(mocks.fetchAddressBookDelta.mock.calls.map(([request]) => request.syncToken))
      .toEqual(['opaque-before', '']);
    expect(mocks.withTransaction).not.toHaveBeenCalled();
  });

  it('refetches one stale book after rollback without reapplying successful books', async () => {
    const secondBookUrl = 'https://dav.example.test/addressbooks/team/';
    const storedTokens = new Map([
      [BOOK_URL, 'first-before'],
      [secondBookUrl, 'second-before'],
    ]);
    let insideTransaction = false;
    let secondTokenReads = 0;
    mocks.query.mockImplementation(async (sql, params) => {
      if (sql.includes("provider = 'carddav'") && sql.includes('SELECT config')) {
        return {
          rows: [{ config: {
            serverUrl: 'https://dav.example.test/',
            username: 'user',
            password: 'encrypted',
          } }],
        };
      }
      if (sql.includes('SELECT remote_sync_token')) {
        const url = params[1];
        if (url === secondBookUrl && secondTokenReads++ > 0) storedTokens.set(url, 'second-concurrent');
        return { rows: [{
          remote_sync_token: storedTokens.get(url),
          remote_sync_capability: 'sync-collection',
          remote_sync_revision: '0',
          connection_generation: CONNECTION_GENERATION,
        }] };
      }
      return { rows: [], rowCount: 0 };
    });
    mocks.discoverAddressBooks.mockResolvedValue([
      { url: BOOK_URL, displayName: 'Remote', supportsSyncCollection: true },
      { url: secondBookUrl, displayName: 'Team', supportsSyncCollection: true },
    ]);
    mocks.fetchAddressBookDelta.mockImplementation(async request => {
      expect(insideTransaction).toBe(false);
      return {
        expectedRemoteToken: request.syncToken,
        nextRemoteToken: `${request.syncToken}-after`,
        capability: 'sync-collection',
        replaceAll: false,
        upserts: [],
        removedHrefs: [],
      };
    });
    let transactionCount = 0;
    mocks.withTransaction.mockImplementation(async callback => {
      transactionCount++;
      const remoteToken = transactionCount === 2 ? 'second-concurrent'
        : transactionCount === 1 ? 'first-before' : 'second-concurrent';
      insideTransaction = true;
      try {
        return await callback(applyClient({ remoteToken }));
      } finally {
        insideTransaction = false;
      }
    });

    const result = await carddavSync.syncUser(USER_ID);

    expect(result).toMatchObject({ ok: true, bookCount: 2 });
    expect(mocks.withTransaction).toHaveBeenCalledTimes(4);
    expect(mocks.fetchAddressBookDelta.mock.calls.map(([request]) => [request.url, request.syncToken]))
      .toEqual([
        [BOOK_URL, 'first-before'],
        [secondBookUrl, 'second-before'],
        [secondBookUrl, 'second-concurrent'],
      ]);
  });

  it('does not refetch a generation-stale plan with captured credentials', async () => {
    configureOneBookSync({ remoteToken: 'opaque-before' });
    mocks.fetchAddressBookDelta.mockResolvedValue({
      expectedRemoteToken: 'opaque-before',
      nextRemoteToken: 'must-not-apply',
      capability: 'sync-collection',
      replaceAll: false,
      upserts: [],
      removedHrefs: [],
    });
    mocks.withTransaction.mockImplementation(callback => callback(applyClient({
      remoteToken: 'opaque-before',
      connectionGeneration: 'generation-replaced',
    })));

    const result = await carddavSync.syncUser(USER_ID);

    expect(result).toEqual({ ok: false, error: 'CardDAV sync plan is stale', ...EMPTY_COUNTERS });
    expect(mocks.fetchAddressBookDelta).toHaveBeenCalledOnce();
    expect(mocks.withTransaction).toHaveBeenCalledOnce();
  });

  it('bounds a repeated stale token to one fresh refetch', async () => {
    let tokenReads = 0;
    configureOneBookSync({ remoteToken: 'unused' });
    mocks.query.mockImplementation(async sql => {
      if (sql.includes("provider = 'carddav'") && sql.includes('SELECT config')) {
        return { rows: [{ config: {
          serverUrl: 'https://dav.example.test/', username: 'user', password: 'encrypted',
        } }] };
      }
      if (sql.includes('SELECT remote_sync_token')) {
        tokenReads++;
        return { rows: [{
          remote_sync_token: tokenReads === 1 ? 'opaque-before' : 'opaque-concurrent',
          remote_sync_capability: 'sync-collection',
          remote_sync_revision: '0',
          connection_generation: CONNECTION_GENERATION,
        }] };
      }
      return { rows: [], rowCount: 0 };
    });
    mocks.fetchAddressBookDelta.mockImplementation(async request => ({
      expectedRemoteToken: request.syncToken,
      nextRemoteToken: `${request.syncToken}-after`,
      capability: 'sync-collection',
      replaceAll: false,
      upserts: [],
      removedHrefs: [],
    }));
    mocks.withTransaction.mockImplementation(callback => callback(applyClient({
      remoteToken: 'always-newer',
    })));

    const result = await carddavSync.syncUser(USER_ID);

    expect(result).toEqual({ ok: false, error: 'CardDAV sync plan is stale', ...EMPTY_COUNTERS });
    expect(mocks.fetchAddressBookDelta).toHaveBeenCalledTimes(2);
    expect(mocks.withTransaction).toHaveBeenCalledTimes(2);
  });

  it('does not prune when an apply fails after an earlier book committed', async () => {
    const secondBookUrl = 'https://dav.example.test/addressbooks/team/';
    mocks.query.mockImplementation(async sql => {
      if (sql.includes("provider = 'carddav'") && sql.includes('SELECT config')) {
        return { rows: [{ config: {
          serverUrl: 'https://dav.example.test/', username: 'user', password: 'encrypted',
        } }] };
      }
      if (sql.includes('SELECT remote_sync_token')) return { rows: [{
        book_id: null,
        remote_sync_token: null,
        remote_sync_capability: null,
        remote_sync_revision: null,
        connection_generation: CONNECTION_GENERATION,
      }] };
      return { rows: [], rowCount: 0 };
    });
    mocks.discoverAddressBooks.mockResolvedValue([
      { url: BOOK_URL, displayName: 'Remote', supportsSyncCollection: true },
      { url: secondBookUrl, displayName: 'Team', supportsSyncCollection: true },
    ]);
    mocks.fetchAddressBookDelta.mockResolvedValue({
      expectedRemoteToken: null,
      nextRemoteToken: 'opaque-after',
      capability: 'sync-collection',
      replaceAll: true,
      upserts: [],
      removedHrefs: [],
    });
    mocks.withTransaction
      .mockImplementationOnce(callback => callback(applyClient()))
      .mockRejectedValueOnce(new Error('second apply failed'));

    const result = await carddavSync.syncUser(USER_ID);

    expect(result).toEqual({ ok: false, error: 'second apply failed', ...EMPTY_COUNTERS });
    expect(mocks.withTransaction).toHaveBeenCalledTimes(2);
    expect(mocks.query.mock.calls.some(([sql]) => sql.includes('DELETE FROM address_books'))).toBe(false);
  });

  it('retries a changed projection footprint once without refetching the remote plan', async () => {
    configureOneBookSync();
    mocks.fetchAddressBookDelta.mockResolvedValue({
      expectedRemoteToken: null,
      nextRemoteToken: 'footprint-token',
      capability: 'sync-collection',
      replaceAll: true,
      upserts: [],
      removedHrefs: [],
    });
    mocks.withTransaction
      .mockRejectedValueOnce(new carddavSync.StaleCarddavPlanError({
        reason: 'projection-footprint-changed',
      }))
      .mockImplementationOnce(callback => callback(applyClient()))
      .mockImplementationOnce(callback => callback(applyClient({ lifecycleBooks: [] })));

    const result = await carddavSync.syncUser(USER_ID);

    expect(result).toMatchObject({ ok: true, bookCount: 1 });
    expect(mocks.fetchAddressBookDelta).toHaveBeenCalledOnce();
    expect(mocks.withTransaction).toHaveBeenCalledTimes(3);
  });

  it('runs the latest committed replacement despite delayed queue request order', async () => {
    let currentGeneration = 'generation-a';
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const latestStarted = deferred();
    const latestFinished = deferred();
    let activeDiscoveries = 0;
    let maxActiveDiscoveries = 0;

    mocks.query.mockImplementation(async (sql, params) => {
      if (sql.includes("provider = 'carddav'") && sql.includes('SELECT config')) {
        return { rows: [{ config: {
          serverUrl: 'https://dav.example.test/',
          username: 'user',
          password: currentGeneration,
          connectionGeneration: currentGeneration,
        } }] };
      }
      if (/UPDATE user_integrations/.test(sql)) {
        return { rows: [], rowCount: params[2] === currentGeneration ? 1 : 0 };
      }
      return { rows: [], rowCount: 0 };
    });
    mocks.discoverAddressBooks.mockImplementation(async ({ password }) => {
      activeDiscoveries++;
      maxActiveDiscoveries = Math.max(maxActiveDiscoveries, activeDiscoveries);
      try {
        if (password === 'generation-a') {
          firstStarted.resolve();
          await releaseFirst.promise;
        } else if (password === 'generation-c') {
          latestStarted.resolve();
        }
        return [];
      } finally {
        activeDiscoveries--;
      }
    });
    mocks.withTransaction.mockImplementation(async callback => {
      const result = await callback(applyClient({
        connectionGeneration: currentGeneration,
        lifecycleBooks: [],
      }));
      if (currentGeneration === 'generation-c') latestFinished.resolve();
      return result;
    });

    expect(carddavSync.requestCarddavSync(USER_ID, 'generation-a')).toBe(true);
    await firstStarted.promise;
    currentGeneration = 'generation-c';
    expect(carddavSync.requestCarddavSync(USER_ID, 'generation-c')).toBe(false);
    expect(carddavSync.requestCarddavSync(USER_ID, 'generation-b')).toBe(false);
    expect(mocks.discoverAddressBooks).toHaveBeenCalledOnce();

    releaseFirst.resolve();
    const launchedLatest = await Promise.race([
      latestStarted.promise.then(() => true),
      new Promise(resolve => setImmediate(() => resolve(false))),
    ]);
    expect(launchedLatest).toBe(true);
    await latestFinished.promise;

    expect(mocks.discoverAddressBooks.mock.calls.map(([request]) => request.password))
      .toEqual(['generation-a', 'generation-c']);
    expect(maxActiveDiscoveries).toBe(1);
  });

  it('does not queue manual or same-generation overlaps', async () => {
    const started = deferred();
    const release = deferred();
    const finished = deferred();
    mocks.query.mockImplementation(async sql => {
      if (sql.includes("provider = 'carddav'") && sql.includes('SELECT config')) {
        return { rows: [{ config: {
          serverUrl: 'https://dav.example.test/',
          username: 'user',
          password: 'encrypted',
          connectionGeneration: CONNECTION_GENERATION,
        } }] };
      }
      return { rows: [], rowCount: 0 };
    });
    mocks.discoverAddressBooks.mockImplementation(async () => {
      started.resolve();
      await release.promise;
      return [];
    });
    mocks.withTransaction.mockImplementation(async callback => {
      const result = await callback(applyClient({
        connectionGeneration: CONNECTION_GENERATION,
        lifecycleBooks: [],
      }));
      finished.resolve();
      return result;
    });

    expect(carddavSync.requestCarddavSync(USER_ID, CONNECTION_GENERATION)).toBe(true);
    await started.promise;
    await expect(carddavSync.syncUser(USER_ID)).resolves.toMatchObject({
      ok: false,
      error: 'A sync is already in progress',
    });
    expect(carddavSync.requestCarddavSync(USER_ID, CONNECTION_GENERATION)).toBe(false);
    release.resolve();
    await finished.promise;
    await new Promise(resolve => setImmediate(resolve));

    expect(mocks.discoverAddressBooks).toHaveBeenCalledOnce();
  });
});

describe('CardDAV scheduler maintenance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('cleans resolved conflicts older than a fixed 30 days after fake time advances', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-12T12:00:00.000Z'));
    const client = { query: vi.fn() };
    mocks.query.mockResolvedValueOnce({ rows: [] });
    mocks.withTransaction.mockImplementation(callback => callback(client));
    mocks.deleteResolvedConflictsBefore.mockResolvedValue(2);

    await carddavSync.startCardavScheduler();

    expect(mocks.deleteResolvedConflictsBefore).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);

    expect(mocks.withTransaction).toHaveBeenCalledOnce();
    expect(mocks.deleteResolvedConflictsBefore).toHaveBeenCalledWith(
      client,
      new Date('2026-06-13T12:00:00.000Z'),
    );
  });
});
