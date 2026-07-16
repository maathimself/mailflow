import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import express from 'express';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCarddavFixtureServer } from './carddavFixtureServer.js';
import {
  applyTestMigrations,
  assertMinimumPostgresVersion,
  createTestDatabase,
  dropTestDatabase,
  postgresTestContext,
  productionDatabaseEnvironment,
  waitForPostgresState,
} from './postgresTestHelpers.js';
import {
  deleteCardResource,
  discoverAddressBooks,
  fetchAddressBookDelta,
  fetchCardResource,
  putCardResource,
} from './carddavClient.js';
import { generateVCard, parseVCard } from '../utils/vcard.js';
import {
  localContactHash,
  parseVCardDocument,
  presentedEtag,
  presentedVCard,
  semanticVCardHash,
} from '../utils/vcardProperties.js';

const credentials = {
  username: 'fixture-user',
  password: 'fixture-password',
  allowPrivate: true,
};

function vcard(uid, name) {
  return [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `UID:${uid}`,
    `FN:${name}`,
    `EMAIL:${uid}@example.test`,
    'END:VCARD',
  ].join('\n');
}

describe('CardDAV sync against a real HTTP fixture', () => {
  let fixture;
  let book;

  beforeAll(async () => {
    fixture = createCarddavFixtureServer();
    await fixture.listen();
    [book] = await discoverAddressBooks({ serverUrl: fixture.serverUrl, ...credentials });
  });

  afterAll(async () => {
    await fixture?.close();
  });

  it('exercises initial, incremental, recovery, paging, and snapshot plans', async () => {
    const alpha = fixture.href('alpha.vcf');
    const beta = fixture.href('beta.vcf');
    const gamma = fixture.href('gamma.vcf');
    const delta = fixture.href('delta.vcf');
    const collectionIdentity = {
      observedUrl: book.url,
      canonicalUrl: book.url,
    };

    fixture.putContact(alpha, '"alpha-1"', vcard('alpha', 'Alpha One'));
    fixture.queueSync('', {
      events: [{ href: alpha, etag: '"alpha-1"' }],
      nextToken: '00123',
    });
    const initial = await fetchAddressBookDelta({
      ...book,
      ...credentials,
      syncToken: null,
    });
    expect(initial).toEqual({
      expectedRemoteToken: null,
      nextRemoteToken: '00123',
      capability: 'sync-collection',
      replaceAll: true,
      upserts: [{ href: alpha, etag: '"alpha-1"', vcard: vcard('alpha', 'Alpha One') }],
      removedHrefs: [],
      collectionIdentity,
    });

    fixture.queueSync('00123', {
      events: [],
      nextToken: 'opaque:2/unchanged',
    });
    const unchanged = await fetchAddressBookDelta({
      ...book,
      ...credentials,
      syncToken: '00123',
    });
    expect(unchanged).toEqual({
      expectedRemoteToken: '00123',
      nextRemoteToken: 'opaque:2/unchanged',
      capability: 'sync-collection',
      replaceAll: false,
      upserts: [],
      removedHrefs: [],
      collectionIdentity,
    });
    expect(fixture.counters.multiget).toBe(1);

    fixture.putContact(beta, '"beta-1"', vcard('beta', 'Beta One'));
    fixture.queueSync('opaque:2/unchanged', {
      events: [{ href: beta, etag: '"beta-1"' }],
      nextToken: 'opaque:3/add',
    });
    const added = await fetchAddressBookDelta({
      ...book,
      ...credentials,
      syncToken: 'opaque:2/unchanged',
    });
    expect(added).toEqual({
      expectedRemoteToken: 'opaque:2/unchanged',
      nextRemoteToken: 'opaque:3/add',
      capability: 'sync-collection',
      replaceAll: false,
      upserts: [{ href: beta, etag: '"beta-1"', vcard: vcard('beta', 'Beta One') }],
      removedHrefs: [],
      collectionIdentity,
    });

    fixture.putContact(alpha, '"alpha-2"', vcard('alpha', 'Alpha Two'));
    fixture.queueSync('opaque:3/add', {
      events: [{ href: alpha, etag: '"alpha-2"' }],
      nextToken: 'opaque:4/edit',
    });
    const edited = await fetchAddressBookDelta({
      ...book,
      ...credentials,
      syncToken: 'opaque:3/add',
    });
    expect(edited).toEqual({
      expectedRemoteToken: 'opaque:3/add',
      nextRemoteToken: 'opaque:4/edit',
      capability: 'sync-collection',
      replaceAll: false,
      upserts: [{ href: alpha, etag: '"alpha-2"', vcard: vcard('alpha', 'Alpha Two') }],
      removedHrefs: [],
      collectionIdentity,
    });

    fixture.deleteContact(beta);
    fixture.queueSync('opaque:4/edit', {
      events: [{ href: beta, status: 404 }],
      nextToken: 'opaque:5/delete',
    });
    const deleted = await fetchAddressBookDelta({
      ...book,
      ...credentials,
      syncToken: 'opaque:4/edit',
    });
    expect(deleted).toEqual({
      expectedRemoteToken: 'opaque:4/edit',
      nextRemoteToken: 'opaque:5/delete',
      capability: 'sync-collection',
      replaceAll: false,
      upserts: [],
      removedHrefs: [beta],
      collectionIdentity,
    });

    fixture.putContact(gamma, '"gamma-1"', vcard('gamma', 'Gamma One'));
    fixture.putContact(delta, '"delta-1"', vcard('delta', 'Delta One'));
    fixture.queueSync('opaque:5/delete', {
      events: [{ href: gamma, etag: '"gamma-1"' }],
      nextToken: 'opaque:page-2',
      truncated: true,
    });
    fixture.queueSync('opaque:page-2', {
      events: [{ href: delta, etag: '"delta-1"' }],
      nextToken: 'opaque:6/paged',
    });
    const paged = await fetchAddressBookDelta({
      ...book,
      ...credentials,
      syncToken: 'opaque:5/delete',
    });
    expect(paged).toEqual({
      expectedRemoteToken: 'opaque:5/delete',
      nextRemoteToken: 'opaque:6/paged',
      capability: 'sync-collection',
      replaceAll: false,
      upserts: [
        { href: gamma, etag: '"gamma-1"', vcard: vcard('gamma', 'Gamma One') },
        { href: delta, etag: '"delta-1"', vcard: vcard('delta', 'Delta One') },
      ],
      removedHrefs: [],
      collectionIdentity,
    });

    fixture.queueSync('opaque:invalid', {
      status: 403,
      precondition: 'valid-sync-token',
    });
    await expect(fetchAddressBookDelta({
      ...book,
      ...credentials,
      syncToken: 'opaque:invalid',
    })).rejects.toMatchObject({
      name: 'CardDavError',
      status: 403,
      precondition: 'valid-sync-token',
    });
    fixture.queueSync('', {
      events: [
        { href: alpha, etag: '"alpha-2"' },
        { href: gamma, etag: '"gamma-1"' },
        { href: delta, etag: '"delta-1"' },
      ],
      nextToken: 'opaque:7/reconciled',
    });
    const reconciled = await fetchAddressBookDelta({
      ...book,
      ...credentials,
      syncToken: '',
    });
    expect(reconciled).toEqual({
      expectedRemoteToken: '',
      nextRemoteToken: 'opaque:7/reconciled',
      capability: 'sync-collection',
      replaceAll: true,
      upserts: [
        { href: alpha, etag: '"alpha-2"', vcard: vcard('alpha', 'Alpha Two') },
        { href: gamma, etag: '"gamma-1"', vcard: vcard('gamma', 'Gamma One') },
        { href: delta, etag: '"delta-1"', vcard: vcard('delta', 'Delta One') },
      ],
      removedHrefs: [],
      collectionIdentity,
    });

    fixture.queueSync('opaque:7/reconciled', { status: 405 });
    const snapshot = await fetchAddressBookDelta({
      ...book,
      ...credentials,
      syncToken: 'opaque:7/reconciled',
    });
    expect(snapshot).toEqual({
      expectedRemoteToken: 'opaque:7/reconciled',
      nextRemoteToken: null,
      capability: 'snapshot',
      replaceAll: true,
      upserts: [
        { href: alpha, etag: '"alpha-2"', vcard: vcard('alpha', 'Alpha Two') },
        { href: delta, etag: '"delta-1"', vcard: vcard('delta', 'Delta One') },
        { href: gamma, etag: '"gamma-1"', vcard: vcard('gamma', 'Gamma One') },
      ],
      removedHrefs: [],
      collectionIdentity,
    });

    expect(fixture.counters).toMatchObject({
      requests: 19,
      propfind: 3,
      sync: 10,
      multiget: 5,
      addressbookQuery: 1,
      requestUri507: 1,
      snapshotFilters: [1],
      syncTokens: [
        '',
        '00123',
        'opaque:2/unchanged',
        'opaque:3/add',
        'opaque:4/edit',
        'opaque:5/delete',
        'opaque:page-2',
        'opaque:invalid',
        '',
        'opaque:7/reconciled',
      ],
      multigetSizes: [1, 1, 1, 2, 3],
    });
    expect(initial.nextRemoteToken).toBe('00123');
    expect(fixture.counters.syncTokens).toContain('00123');
    const fixtureOrigin = new URL(fixture.serverUrl).origin;
    expect(fixture.requests.filter(request => request.authorization)
      .every(request => request.origin === fixtureOrigin)).toBe(true);
    expect(fixture.requests.every(request => request.authorization === 'Basic Zml4dHVyZS11c2VyOmZpeHR1cmUtcGFzc3dvcmQ=')).toBe(true);
    expect(fixture.requests.filter(request => request.method === 'REPORT')
      .every(request => request.depth === '0' || request.depth === '1')).toBe(true);
  });

  it('discovers writable metadata and enforces conditional resource writes', async () => {
    fixture.reset();
    expect(book).toMatchObject({
      capabilities: { create: 'allowed', update: 'allowed', delete: 'allowed' },
      discoveryIndex: 0,
      addressData: [
        { contentType: 'text/vcard', version: '4.0' },
        { contentType: 'text/vcard', version: '3.0' },
      ],
    });
    const href = fixture.href('conditional.vcf');
    const createdCard = vcard('conditional', 'Conditional Create');

    const created = await putCardResource({
      ...credentials,
      url: book.url,
      href,
      vcard: createdCard,
    });
    expect(created).toEqual({ href, etag: expect.any(String) });
    await expect(fetchCardResource({
      ...credentials,
      url: book.url,
      href,
    })).resolves.toEqual({ href, etag: created.etag, vcard: createdCard });

    await expect(putCardResource({
      ...credentials,
      url: book.url,
      href,
      etag: '"stale"',
      vcard: vcard('conditional', 'Rejected Update'),
    })).rejects.toMatchObject({ operation: 'update', status: 412 });

    fixture.queueWrite('PUT', { status: 423, rawBody: '<error>locked</error>' });
    await expect(putCardResource({
      ...credentials,
      url: book.url,
      href: fixture.href('locked.vcf'),
      vcard: vcard('locked', 'Locked Create'),
    })).rejects.toMatchObject({ operation: 'create', status: 423 });

    const updatedCard = vcard('conditional', 'Conditional Update');
    const updated = await putCardResource({
      ...credentials,
      url: book.url,
      href,
      etag: created.etag,
      vcard: updatedCard,
    });
    await expect(fetchCardResource({
      ...credentials,
      url: book.url,
      href,
    })).resolves.toEqual({ href, etag: updated.etag, vcard: updatedCard });

    await expect(deleteCardResource({
      ...credentials,
      url: book.url,
      href,
      etag: updated.etag,
    })).resolves.toEqual({ href });
    await expect(deleteCardResource({
      ...credentials,
      url: book.url,
      href,
      etag: updated.etag,
    })).resolves.toEqual({ href });

    const resourceRequests = fixture.requests.filter(request => (
      request.method === 'GET' || request.method === 'PUT' || request.method === 'DELETE'
    ));
    expect(resourceRequests.map(request => ({
      method: request.method,
      accept: request.accept,
      contentType: request.contentType,
      ifMatch: request.ifMatch,
      ifNoneMatch: request.ifNoneMatch,
    }))).toEqual([
      {
        method: 'PUT', accept: '*/*', contentType: 'text/vcard; charset=utf-8',
        ifMatch: undefined, ifNoneMatch: '*',
      },
      {
        method: 'GET', accept: 'text/vcard', contentType: undefined,
        ifMatch: undefined, ifNoneMatch: undefined,
      },
      {
        method: 'PUT', accept: '*/*', contentType: 'text/vcard; charset=utf-8',
        ifMatch: '"stale"', ifNoneMatch: undefined,
      },
      {
        method: 'PUT', accept: '*/*', contentType: 'text/vcard; charset=utf-8',
        ifMatch: undefined, ifNoneMatch: '*',
      },
      {
        method: 'PUT', accept: '*/*', contentType: 'text/vcard; charset=utf-8',
        ifMatch: created.etag, ifNoneMatch: undefined,
      },
      {
        method: 'GET', accept: 'text/vcard', contentType: undefined,
        ifMatch: undefined, ifNoneMatch: undefined,
      },
      {
        method: 'DELETE', accept: '*/*', contentType: undefined,
        ifMatch: updated.etag, ifNoneMatch: undefined,
      },
      {
        method: 'DELETE', accept: '*/*', contentType: undefined,
        ifMatch: updated.etag, ifNoneMatch: undefined,
      },
    ]);
  });

  it('rejects a resource redirect before the sibling endpoint receives the write', async () => {
    fixture.reset();
    const sourceHref = fixture.href('redirect-source.vcf');
    const sourcePath = new URL(sourceHref).pathname;
    const siblingPath = '/addressbooks/fixture-user/sibling/redirect-target.vcf';
    const siblingHref = new URL(siblingPath, fixture.serverUrl).href;
    fixture.queueRedirect('PUT', sourcePath, siblingPath, 307);

    try {
      await expect(putCardResource({
        ...credentials,
        url: book.url,
        href: sourceHref,
        vcard: vcard('redirect-source', 'Redirect Source'),
      })).rejects.toMatchObject({
        code: 'ERR_DAV_HREF_SCOPE',
        operation: 'create',
      });

      expect(fixture.requests.filter(request => request.path === sourcePath)).toHaveLength(1);
      expect(fixture.requests.filter(request => request.path === siblingPath)).toHaveLength(0);
    } finally {
      fixture.deleteContact(siblingHref);
    }
  });
});

const { databaseUrl, connectionStringFor } = postgresTestContext(
  'CardDAV production integration tests',
);

const { Client } = pg;
const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), '../../migrations');
const databaseName = `carddav_sync_e2e_${process.pid}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const encryptionKey = '11'.repeat(32);
const productionEnvironment = productionDatabaseEnvironment(encryptionKey);
let adminClient;
let databaseClient;
let productionDb;
let carddavSync;
let carddavContactService;
let carddavConflictService;
let carddavConflictsRouter;
let encrypt;

async function applyMigrations(client) {
  await applyTestMigrations(client, { migrationsDirectory });
}

async function projectionState(userId, { timestamps = false } = {}) {
  const { rows: books } = await databaseClient.query(`
    SELECT id, source, external_url, sync_token, remote_sync_token,
           remote_sync_capability, remote_sync_revision::text,
           remote_projection_fingerprint, created_at, updated_at
    FROM address_books
    WHERE user_id = $1
    ORDER BY source, external_url NULLS FIRST, id
  `, [userId]);
  const { rows: contacts } = await databaseClient.query(`
    SELECT id, address_book_id, user_id, uid, vcard, etag, display_name,
           first_name, last_name, primary_email, emails, phones, organization,
           notes, photo_data, created_at, updated_at
    FROM contacts
    WHERE user_id = $1
    ORDER BY address_book_id, uid
  `, [userId]);
  const { rows: ledger } = await databaseClient.query(`
    SELECT o.address_book_id, o.href, o.remote_etag, o.vcard, o.primary_email,
           o.local_contact_id,
           o.created_at, o.updated_at
    FROM carddav_remote_objects o
    JOIN address_books b ON b.id = o.address_book_id
    WHERE b.user_id = $1
    ORDER BY o.address_book_id, o.href
  `, [userId]);
  if (timestamps) return { books, contacts, ledger };
  const strip = rows => rows.map(row => {
    const stable = { ...row };
    delete stable.created_at;
    delete stable.updated_at;
    return stable;
  });
  return { books: strip(books), contacts: strip(contacts), ledger: strip(ledger) };
}

async function integrationState(userId, { timestamps = false } = {}) {
  const { rows } = await databaseClient.query(`
    SELECT id, provider, config, updated_at
    FROM user_integrations
    WHERE user_id = $1 AND provider = 'carddav'
  `, [userId]);
  if (timestamps) return rows;
  return rows.map(row => {
    const stable = { ...row };
    delete stable.updated_at;
    return stable;
  });
}

async function failureBoundaryState(userId) {
  const projection = await projectionState(userId, { timestamps: true });
  const { rows: mappings } = await databaseClient.query(`
    SELECT mapping.address_book_id, mapping.href, mapping.remote_etag,
           mapping.vcard, mapping.primary_email, mapping.local_contact_id,
           mapping.mapping_status, mapping.vcard_version,
           mapping.remote_semantic_hash, mapping.local_contact_hash,
           mapping.mapping_revision::text, mapping.pending_operation,
           mapping.pending_vcard, mapping.pending_local_hash,
           mapping.pending_remote_semantic_hash, mapping.pending_started_at,
           mapping.created_at, mapping.updated_at
    FROM carddav_remote_objects mapping
    JOIN address_books book ON book.id = mapping.address_book_id
    WHERE book.user_id = $1
    ORDER BY mapping.address_book_id, mapping.href
  `, [userId]);
  const { rows: conflicts } = await databaseClient.query(`
    SELECT id, address_book_id, href, user_id, base_local_hash, remote_etag,
           local_vcard, remote_vcard, local_tombstone, remote_tombstone,
           status, resolution, resolved_by, resolved_at, created_at, updated_at
    FROM carddav_conflicts
    WHERE user_id = $1
    ORDER BY address_book_id, href
  `, [userId]);
  return {
    projection,
    mappings,
    conflicts,
    integrations: await integrationState(userId, { timestamps: true }),
  };
}

async function seedConnectedUser(fixture, overrides = {}) {
  const userId = randomUUID();
  const connectionGeneration = overrides.connectionGeneration || randomUUID();
  const password = overrides.password || 'fixture-password';
  const encryptedPassword = encrypt(password);
  await databaseClient.query(
    'INSERT INTO users (id, username) VALUES ($1, $2)',
    [userId, `carddav-e2e-${userId}`],
  );
  const config = {
    serverUrl: fixture.serverUrl,
    username: overrides.username || 'fixture-user',
    password: encryptedPassword,
    intervalMin: 60,
    connectionGeneration,
    lastError: 'seeded-error',
    bookCount: 0,
    contactCount: 0,
  };
  await databaseClient.query(`
    INSERT INTO user_integrations (user_id, provider, config)
    VALUES ($1, 'carddav', $2::jsonb)
  `, [userId, JSON.stringify(config)]);
  return { userId, config, connectionGeneration, encryptedPassword, password };
}

function remoteVcard(uid, name, email = `${uid}@example.test`) {
  return [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `UID:${uid}`,
    `FN:${name}`,
    `EMAIL:${email}`,
    'END:VCARD',
  ].join('\n');
}

function remotePhotoVcard(uid, name, email, photoLine) {
  return [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `UID:${uid}`,
    `FN:${name}`,
    `EMAIL:${email}`,
    photoLine,
    'END:VCARD',
  ].join('\n');
}

function expectedLocalContact(href, vcard, bookId, userId, id) {
  const parsed = parseVCard(vcard);
  const uid = createHash('sha256').update(href).digest('hex');
  const localVcard = generateVCard({ ...parsed, uid });
  return {
    id,
    address_book_id: bookId,
    user_id: userId,
    uid,
    vcard: localVcard,
    etag: createHash('md5').update(localVcard).digest('hex'),
    display_name: parsed.displayName,
    first_name: parsed.firstName,
    last_name: parsed.lastName,
    primary_email: parsed.emails[0].value,
    emails: parsed.emails,
    phones: parsed.phones,
    organization: parsed.organization,
    notes: parsed.notes,
    photo_data: parsed.photoData,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function listenOnLocalhost(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    server.once('error', reject);
  });
}

async function closeServer(server) {
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close(error => (
    error ? reject(error) : resolve()
  )));
}

async function listenConflictApi() {
  const app = express();
  app.use(express.json());
  app.use((request, response, next) => {
    request.session = { userId: request.get('X-Test-User-Id') };
    next();
  });
  app.use('/conflicts', carddavConflictsRouter);
  return listenOnLocalhost(app);
}

async function seedSingleRemoteContact(fixture, userId, {
  uid = 'seeded',
  name = 'Seeded Contact',
  etag = '"seeded-1"',
  token = 'seeded-token',
} = {}) {
  const href = fixture.href(`${uid}.vcf`);
  const card = remoteVcard(uid, name);
  fixture.putContact(href, etag, card);
  fixture.queueSync('', { events: [{ href, etag }], nextToken: token });
  const result = await carddavSync.syncUser(userId);
  expect(result).toMatchObject({ ok: true, bookCount: 1, contactCount: 1 });
  return { href, card, etag, token };
}

async function seedMappedExplicitContact(fixture, userId) {
  const uid = randomUUID();
  const contact = {
    uid,
    displayName: 'Retry After Before',
    firstName: 'Retry',
    lastName: 'After Before',
    emails: [{ value: 'retry-after@example.test', type: 'work', primary: true }],
    phones: [],
    organization: null,
    notes: null,
    photoData: null,
    additionalFields: [],
  };
  const card = generateVCard(contact);
  const href = fixture.href(`${uid}.vcf`);
  const remoteEtag = '"retry-after-1"';
  const { rows: [localBook] } = await databaseClient.query(`
    INSERT INTO address_books (user_id, name)
    VALUES ($1, 'Retry After Local')
    RETURNING id
  `, [userId]);
  const { rows: [remoteBook] } = await databaseClient.query(`
    INSERT INTO address_books (
      user_id, name, source, external_url,
      remote_create_capability, remote_update_capability, remote_delete_capability
    ) VALUES ($1, 'Retry After Remote', 'carddav', $2, 'allowed', 'allowed', 'allowed')
    RETURNING id
  `, [userId, fixture.href('')]);
  const { rows: [row] } = await databaseClient.query(`
    INSERT INTO contacts (
      address_book_id, user_id, uid, vcard, etag, display_name, first_name,
      last_name, primary_email, emails, phones, additional_fields, is_auto
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, '[]'::jsonb,
      '[]'::jsonb, false
    )
    RETURNING id
  `, [
    localBook.id,
    userId,
    uid,
    card,
    createHash('md5').update(card).digest('hex'),
    contact.displayName,
    contact.firstName,
    contact.lastName,
    contact.emails[0].value,
    JSON.stringify(contact.emails),
  ]);
  await databaseClient.query(`
    INSERT INTO carddav_remote_objects (
      address_book_id, href, remote_etag, vcard, primary_email,
      local_contact_id, mapping_status, vcard_version,
      remote_semantic_hash, local_contact_hash, last_synced_at
    ) VALUES ($1, $2, $3, $4, $5, $6, 'synced', '3.0', $7, $8, NOW())
  `, [
    remoteBook.id,
    href,
    remoteEtag,
    card,
    contact.emails[0].value,
    row.id,
    semanticVCardHash(parseVCardDocument(card)),
    localContactHash(contact),
  ]);
  fixture.putContact(href, remoteEtag, card);
  return { ...row, uid, href };
}

async function seedUnmappedExplicitContact(userId, {
  uid = randomUUID(),
  displayName = 'Unmapped Explicit',
} = {}) {
  const contact = {
    uid,
    displayName,
    emails: [{ value: `${uid}@example.test`, type: 'other', primary: true }],
    phones: [],
    organization: null,
    notes: null,
    photoData: null,
    additionalFields: [],
  };
  const card = generateVCard(contact);
  const { rows: [book] } = await databaseClient.query(`
    INSERT INTO address_books (user_id, name)
    VALUES ($1, 'Unmapped Explicit Local') RETURNING id
  `, [userId]);
  const { rows: [row] } = await databaseClient.query(`
    INSERT INTO contacts (
      address_book_id, user_id, uid, vcard, etag, display_name,
      primary_email, emails, phones, additional_fields, is_auto
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8::jsonb, '[]'::jsonb, '[]'::jsonb, false
    )
    RETURNING id
  `, [
    book.id,
    userId,
    uid,
    card,
    createHash('md5').update(card).digest('hex'),
    displayName,
    contact.emails[0].value,
    JSON.stringify(contact.emails),
  ]);
  return { ...row, uid, card };
}

async function seedResolutionConflict(fixture, userId, {
  uid,
  remoteCard,
  remoteEtag = `"${uid}-2"`,
  remoteTombstone = false,
}) {
  const initial = await seedSingleRemoteContact(fixture, userId, {
    uid,
    name: `${uid} Initial`,
    token: `${uid}-token`,
  });
  const { rows: [mapping] } = await databaseClient.query(`
    SELECT mapping.address_book_id, mapping.href, mapping.local_contact_id,
           mapping.local_contact_hash, mapping.mapping_revision::text,
           contact.vcard AS local_vcard, contact.display_name AS local_display_name
    FROM carddav_remote_objects mapping
    JOIN contacts contact ON contact.id = mapping.local_contact_id
    WHERE mapping.href = $1 AND contact.user_id = $2
  `, [initial.href, userId]);
  const { rows: [conflictedMapping] } = await databaseClient.query(`
    UPDATE carddav_remote_objects
    SET mapping_status = 'conflict', mapping_revision = mapping_revision + 1,
        updated_at = NOW()
    WHERE address_book_id = $1 AND href = $2
    RETURNING mapping_revision::text
  `, [mapping.address_book_id, mapping.href]);
  if (remoteTombstone) fixture.deleteContact(initial.href);
  else fixture.putContact(initial.href, remoteEtag, remoteCard);
  const { rows: [conflict] } = await databaseClient.query(`
    INSERT INTO carddav_conflicts (
      address_book_id, href, user_id, base_local_hash, remote_etag,
      local_vcard, remote_vcard, local_tombstone, remote_tombstone
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,false,$8)
    RETURNING id
  `, [
    mapping.address_book_id,
    mapping.href,
    userId,
    mapping.local_contact_hash,
    remoteTombstone ? null : remoteEtag,
    mapping.local_vcard,
    remoteTombstone ? null : remoteCard,
    remoteTombstone,
  ]);
  return {
    ...mapping,
    mappingRevision: conflictedMapping.mapping_revision,
    conflictId: conflict.id,
    initial,
  };
}

async function seedTwoRemoteBooks(fixture, userId) {
  const bookAPath = '/addressbooks/fixture-user/contacts-a/';
  const bookBPath = '/addressbooks/fixture-user/contacts-b/';
  const bookAUrl = new URL(bookAPath, fixture.serverUrl).href;
  const bookBUrl = new URL(bookBPath, fixture.serverUrl).href;
  const hrefA = new URL('person-a.vcf', bookAUrl).href;
  const hrefB = new URL('person-b.vcf', bookBUrl).href;
  const cardA = remoteVcard('person-a', 'Person A');
  const cardB = remoteVcard('person-b', 'Person B');
  fixture.queueDiscovery({ books: [
    { href: bookAPath, displayName: 'Contacts A' },
    { href: bookBPath, displayName: 'Contacts B' },
  ] });
  fixture.putContact(hrefA, '"person-a-1"', cardA);
  fixture.putContact(hrefB, '"person-b-1"', cardB);
  fixture.queueSync('', {
    events: [{ href: hrefA, etag: '"person-a-1"' }],
    nextToken: 'two-book-a-1',
  });
  fixture.queueSync('', {
    events: [{ href: hrefB, etag: '"person-b-1"' }],
    nextToken: 'two-book-b-1',
  });
  expect(await carddavSync.syncUser(userId)).toMatchObject({
    ok: true, bookCount: 2, contactCount: 2,
  });
  const state = await projectionState(userId);
  return {
    bookAPath,
    bookBPath,
    bookAUrl,
    bookBUrl,
    hrefA,
    hrefB,
    cardA,
    cardB,
    bookA: state.books.find(book => book.external_url === bookAUrl),
    bookB: state.books.find(book => book.external_url === bookBUrl),
  };
}

describe('production CardDAV HTTP to PostgreSQL 16', () => {
  beforeAll(async () => {
    adminClient = new Client({ connectionString: databaseUrl });
    await adminClient.connect();
    await createTestDatabase(adminClient, databaseName);
    const connectionString = connectionStringFor(databaseName);
    databaseClient = new Client({ connectionString });
    await databaseClient.connect();
    await assertMinimumPostgresVersion(databaseClient);
    await applyMigrations(databaseClient);
    await databaseClient.query(`
      INSERT INTO system_settings (key, value) VALUES ('allow_private_hosts', 'true')
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `);
    productionEnvironment.configure(connectionString);
    productionDb = await import('./db.js');
    productionEnvironment.configurePool(productionDb.pool);
    carddavSync = await import('./carddavSync.js');
    carddavContactService = await import('./carddavContactService.js');
    carddavConflictService = await import('./carddavConflictService.js');
    ({ default: carddavConflictsRouter } = await import('../routes/carddavConflicts.js'));
    ({ encrypt } = await import('./encryption.js'));
  }, 120_000);

  afterAll(async () => {
    await productionDb?.pool.end();
    await databaseClient?.end();
    if (adminClient) {
      await dropTestDatabase(adminClient, databaseName);
      await adminClient.end();
    }
    productionEnvironment.restore();
  }, 120_000);

  it('schedules a valid Retry-After after 429 without replaying or changing confirmed state', async () => {
    const fixture = createCarddavFixtureServer();
    await fixture.listen();
    try {
      const seeded = await seedConnectedUser(fixture);
      const contact = await seedMappedExplicitContact(fixture, seeded.userId);
      const before = await failureBoundaryState(seeded.userId);
      fixture.reset();
      fixture.queueWrite('PUT', {
        status: 429,
        headers: { 'Retry-After': '120' },
      });

      const startedAt = Date.now();
      const error = await carddavContactService.updateContact(
        seeded.userId,
        contact.id,
        { displayName: 'Retry After Attempted' },
      ).catch(value => value);
      const finishedAt = Date.now();
      const afterThrottle = await failureBoundaryState(seeded.userId);
      const retryAfterAt = afterThrottle.integrations[0].config.retryAfterAt;

      expect.soft(error).toMatchObject({
        name: 'CardDavError',
        operation: 'update',
        status: 429,
        retryAfterAt,
      });
      expect.soft(Date.parse(retryAfterAt)).toBeGreaterThanOrEqual(startedAt + 120_000);
      expect.soft(Date.parse(retryAfterAt)).toBeLessThanOrEqual(finishedAt + 120_000);
      expect.soft(afterThrottle.projection).toEqual(before.projection);
      expect.soft(afterThrottle.mappings).toEqual(before.mappings);
      expect.soft(afterThrottle.conflicts).toEqual(before.conflicts);
      expect.soft(afterThrottle.integrations).toEqual([{
        ...before.integrations[0],
        config: { ...before.integrations[0].config, retryAfterAt },
        updated_at: expect.any(Date),
      }]);
      expect.soft(afterThrottle.integrations[0].updated_at.getTime())
        .toBeGreaterThanOrEqual(before.integrations[0].updated_at.getTime());
      expect.soft(fixture.requests.map(request => request.method)).toEqual(['PUT']);

      const immediateMutation = await carddavContactService.updateContact(
        seeded.userId,
        contact.id,
        { displayName: 'Retry After Attempted Again' },
      ).catch(value => value);
      const immediateSync = await carddavSync.syncUser(seeded.userId);

      expect.soft(immediateMutation).toMatchObject({
        name: 'CardDavError',
        operation: 'update',
        status: 429,
        retryAfterAt,
      });
      expect.soft(immediateSync).toMatchObject({
        ok: false,
        retryAfterAt,
      });
      expect.soft(fixture.requests.map(request => request.method)).toEqual(['PUT']);
      expect.soft(await failureBoundaryState(seeded.userId)).toEqual(afterThrottle);

      await databaseClient.query(`
        UPDATE user_integrations
        SET config = jsonb_set(config, '{retryAfterAt}', to_jsonb($2::text)),
            updated_at = NOW()
        WHERE user_id = $1 AND provider = 'carddav'
      `, [seeded.userId, '2000-01-01T00:00:00.000Z']);
      fixture.reset();
      fixture.queueSync('', {
        events: [{ href: contact.href, etag: '"retry-after-1"' }],
        nextToken: 'retry-after-cleared',
      });

      expect.soft(await carddavSync.syncUser(seeded.userId)).toMatchObject({ ok: true });
      expect.soft((await integrationState(seeded.userId))[0].config.retryAfterAt).toBeNull();
    } finally {
      await fixture.close();
    }
  }, 120_000);

  it('retains a fresh export Retry-After instead of clearing it from stale sync config', async () => {
    const fixture = createCarddavFixtureServer();
    await fixture.listen();
    const seeded = await seedConnectedUser(fixture);
    const local = await seedUnmappedExplicitContact(seeded.userId, {
      displayName: 'Fresh Export Throttle',
    });
    await databaseClient.query(`
      UPDATE user_integrations
      SET config = jsonb_set(config, '{retryAfterAt}', to_jsonb($2::text))
      WHERE user_id = $1 AND provider = 'carddav'
    `, [seeded.userId, '2000-01-01T00:00:00.000Z']);
    fixture.queueSync('', { events: [], nextToken: 'fresh-export-throttle' });
    fixture.queueWrite('PUT', {
      status: 429,
      headers: { 'Retry-After': '120' },
    });
    const startedAt = Date.now();

    const result = await carddavSync.syncUser(seeded.userId);
    const finishedAt = Date.now();
    const [integration] = await integrationState(seeded.userId);
    const retryAfterAt = integration.config.retryAfterAt;

    expect.soft(result).toMatchObject({ ok: false, retryAfterAt });
    expect.soft(Date.parse(retryAfterAt)).toBeGreaterThanOrEqual(startedAt + 120_000);
    expect.soft(Date.parse(retryAfterAt)).toBeLessThanOrEqual(finishedAt + 120_000);
    expect.soft(fixture.requests
      .filter(request => ['GET', 'PUT', 'DELETE'].includes(request.method))
      .map(request => request.method)).toEqual(['PUT']);
    const projection = await projectionState(seeded.userId);
    expect.soft(projection.contacts.find(contact => contact.id === local.id)).toMatchObject({
      vcard: local.card,
      display_name: 'Fresh Export Throttle',
    });
    expect.soft(projection.ledger).toEqual([]);

    fixture.reset();
    expect.soft(await carddavSync.syncUser(seeded.userId)).toMatchObject({
      ok: false,
      retryAfterAt,
    });
    expect.soft(fixture.requests).toEqual([]);
    expect.soft((await integrationState(seeded.userId))[0].config.retryAfterAt)
      .toBe(retryAfterAt);
    await fixture.close();
  }, 120_000);

  it.each([
    ['missing update', undefined, 'PUT'],
    ['malformed delete', 'tomorrow', 'DELETE'],
  ])('keeps confirmed state after 429 with %s Retry-After', async (_label, value, method) => {
    const fixture = createCarddavFixtureServer();
    await fixture.listen();
    const seeded = await seedConnectedUser(fixture);
    const contact = await seedMappedExplicitContact(fixture, seeded.userId);
    const before = await failureBoundaryState(seeded.userId);
    fixture.reset();
    fixture.queueWrite(method, {
      status: 429,
      ...(value === undefined ? {} : { headers: { 'Retry-After': value } }),
    });

    const error = await (method === 'PUT'
      ? carddavContactService.updateContact(
        seeded.userId,
        contact.id,
        { displayName: 'Invalid Retry After Attempted' },
      )
      : carddavContactService.deleteContact(seeded.userId, contact.id)
    ).catch(result => result);

    expect.soft(error).toMatchObject({
      name: 'CardDavError',
      operation: method === 'PUT' ? 'update' : 'delete',
      retryAfterAt: null,
      status: 429,
    });
    expect.soft(await failureBoundaryState(seeded.userId)).toEqual(before);
    expect.soft(fixture.requests.map(request => request.method)).toEqual([method]);
    await fixture.close();
  }, 120_000);

  it('records valid Retry-After for create without materializing or retrying the resource', async () => {
    const fixture = createCarddavFixtureServer();
    await fixture.listen();
    const seeded = await seedConnectedUser(fixture);
    const before = await failureBoundaryState(seeded.userId);
    fixture.queueWrite('PUT', {
      status: 429,
      headers: { 'Retry-After': '60' },
    });
    const draft = {
      displayName: 'Throttled Create',
      firstName: 'Throttled',
      lastName: 'Create',
      emails: [{ value: 'throttled-create@example.test', type: 'work', primary: true }],
      phones: [],
      organization: null,
      notes: null,
      photoData: null,
      additionalFields: [],
    };
    const startedAt = Date.now();

    const error = await carddavContactService.createContact(seeded.userId, draft)
      .catch(result => result);
    const finishedAt = Date.now();
    const after = await failureBoundaryState(seeded.userId);
    const retryAfterAt = after.integrations[0].config.retryAfterAt;

    expect.soft(error).toMatchObject({
      name: 'CardDavError',
      operation: 'create',
      retryAfterAt,
      status: 429,
    });
    expect.soft(Date.parse(retryAfterAt)).toBeGreaterThanOrEqual(startedAt + 60_000);
    expect.soft(Date.parse(retryAfterAt)).toBeLessThanOrEqual(finishedAt + 60_000);
    expect.soft(after.projection).toEqual(before.projection);
    expect.soft(after.mappings).toEqual(before.mappings);
    expect.soft(after.conflicts).toEqual(before.conflicts);
    expect.soft(after.integrations).toEqual([{
      ...before.integrations[0],
      config: { ...before.integrations[0].config, retryAfterAt },
      updated_at: expect.any(Date),
    }]);
    expect.soft(fixture.requests.map(request => request.method))
      .toEqual(['PROPFIND', 'PROPFIND', 'PROPFIND', 'PUT']);

    const immediate = await carddavContactService.createContact(seeded.userId, draft)
      .catch(result => result);
    expect.soft(immediate).toMatchObject({
      name: 'CardDavError',
      operation: 'create',
      retryAfterAt,
      status: 429,
    });
    expect.soft(fixture.requests.map(request => request.method))
      .toEqual(['PROPFIND', 'PROPFIND', 'PROPFIND', 'PUT']);
    expect.soft(await failureBoundaryState(seeded.userId)).toEqual(after);
    await fixture.close();
  }, 120_000);

  it('records discovery Retry-After before create and blocks immediate discovery', async () => {
    const fixture = createCarddavFixtureServer();
    await fixture.listen();
    const seeded = await seedConnectedUser(fixture);
    const draft = {
      displayName: 'Discovery Throttle',
      emails: [{ value: 'discovery-throttle@example.test', type: 'work', primary: true }],
      phones: [],
      organization: null,
      notes: null,
      photoData: null,
      additionalFields: [],
    };
    fixture.queueDiscovery({
      status: 429,
      headers: { 'Retry-After': '120' },
    });
    const startedAt = Date.now();

    const error = await carddavContactService.createContact(seeded.userId, draft)
      .catch(result => result);
    const finishedAt = Date.now();
    const retryAfterAt = error.retryAfterAt;

    expect.soft(error).toMatchObject({
      name: 'CardDavError',
      operation: null,
      retryAfterAt,
      status: 429,
    });
    expect.soft(Date.parse(retryAfterAt)).toBeGreaterThanOrEqual(startedAt + 120_000);
    expect.soft(Date.parse(retryAfterAt)).toBeLessThanOrEqual(finishedAt + 120_000);
    expect.soft((await integrationState(seeded.userId))[0].config.retryAfterAt)
      .toBe(retryAfterAt);
    expect.soft(fixture.requests.map(request => request.method))
      .toEqual(['PROPFIND', 'PROPFIND', 'PROPFIND']);
    expect.soft((await projectionState(seeded.userId)).contacts).toEqual([]);

    fixture.reset();
    await expect(carddavContactService.createContact(seeded.userId, draft)).rejects.toMatchObject({
      name: 'CardDavError',
      operation: 'create',
      retryAfterAt,
      status: 429,
    });
    expect.soft(fixture.requests).toEqual([]);
    await fixture.close();
  }, 120_000);

  it('records canonical-GET Retry-After while retaining initial and recovery-only intent', async () => {
    const fixture = createCarddavFixtureServer();
    await fixture.listen();
    const seeded = await seedConnectedUser(fixture);
    const contact = await seedMappedExplicitContact(fixture, seeded.userId);
    const attempted = { displayName: 'Canonical GET Throttle' };
    fixture.reset();
    fixture.queueWrite('GET', {
      status: 429,
      headers: { 'Retry-After': '120' },
    });

    const firstError = await carddavContactService.updateContact(
      seeded.userId,
      contact.id,
      attempted,
    ).catch(result => result);
    const afterFirst = await failureBoundaryState(seeded.userId);
    const firstRetryAfterAt = afterFirst.integrations[0].config.retryAfterAt;

    expect.soft(firstError).toMatchObject({ name: 'CardDavAmbiguousWriteError' });
    expect.soft(firstError.cause).toMatchObject({
      name: 'CardDavError', retryAfterAt: firstRetryAfterAt, status: 429,
    });
    expect.soft(afterFirst.mappings).toEqual([
      expect.objectContaining({
        mapping_status: 'pending_push',
        pending_operation: 'update',
        pending_started_at: expect.any(Date),
      }),
    ]);
    expect.soft(fixture.requests.map(request => request.method)).toEqual(['PUT', 'GET']);

    await databaseClient.query(`
      UPDATE user_integrations
      SET config = jsonb_set(config, '{retryAfterAt}', to_jsonb($2::text))
      WHERE user_id = $1 AND provider = 'carddav'
    `, [seeded.userId, '2000-01-01T00:00:00.000Z']);
    const beforeRecovery = await failureBoundaryState(seeded.userId);
    fixture.reset();
    fixture.queueWrite('GET', {
      status: 429,
      headers: { 'Retry-After': '240' },
    });

    const recoveryError = await carddavContactService.updateContact(
      seeded.userId,
      contact.id,
      attempted,
    ).catch(result => result);
    const afterRecovery = await failureBoundaryState(seeded.userId);
    const retryAfterAt = afterRecovery.integrations[0].config.retryAfterAt;

    expect.soft(recoveryError).toMatchObject({ name: 'CardDavAmbiguousWriteError' });
    expect.soft(recoveryError.cause).toMatchObject({
      name: 'CardDavError', retryAfterAt, status: 429,
    });
    expect.soft(fixture.requests.map(request => request.method)).toEqual(['GET']);
    expect.soft(afterRecovery.projection).toEqual(beforeRecovery.projection);
    expect.soft(afterRecovery.mappings).toEqual(beforeRecovery.mappings);
    expect.soft(afterRecovery.conflicts).toEqual(beforeRecovery.conflicts);
    expect.soft(Date.parse(retryAfterAt)).toBeGreaterThan(Date.parse(firstRetryAfterAt));

    fixture.reset();
    await expect(carddavContactService.updateContact(
      seeded.userId,
      contact.id,
      attempted,
    )).rejects.toMatchObject({ status: 429, retryAfterAt });
    expect.soft(fixture.requests).toEqual([]);
    expect.soft((await failureBoundaryState(seeded.userId)).mappings)
      .toEqual(afterRecovery.mappings);
    await fixture.close();
  }, 120_000);

  it('makes no export request when the connection is replaced between apply and export', async () => {
    const fixture = createCarddavFixtureServer();
    await fixture.listen();
    const seeded = await seedConnectedUser(fixture);
    const replacementGeneration = randomUUID();
    const { rows: [localBook] } = await databaseClient.query(`
      INSERT INTO address_books (user_id, name)
      VALUES ($1, 'Generation Export Local') RETURNING id
    `, [seeded.userId]);
    const contact = {
      uid: 'generation-export-local',
      displayName: 'Generation Export Local',
      emails: [{ value: 'generation-export@example.test', type: 'other', primary: true }],
      phones: [],
      organization: null,
      notes: null,
      photoData: null,
    };
    const card = generateVCard(contact);
    const { rows: [localContact] } = await databaseClient.query(`
      INSERT INTO contacts (
        address_book_id, user_id, uid, vcard, etag, display_name,
        primary_email, emails, phones, is_auto
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, '[]'::jsonb, false)
      RETURNING id
    `, [
      localBook.id,
      seeded.userId,
      contact.uid,
      card,
      createHash('md5').update(card).digest('hex'),
      contact.displayName,
      contact.emails[0].value,
      JSON.stringify(contact.emails),
    ]);
    fixture.queueSync('', { events: [], nextToken: 'generation-export-token' });
    await databaseClient.query(`
      CREATE FUNCTION replace_generation_before_export() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        UPDATE user_integrations
        SET config = jsonb_set(
          config, '{connectionGeneration}', to_jsonb('${replacementGeneration}'::text)
        )
        WHERE user_id = NEW.user_id AND provider = 'carddav';
        RETURN NEW;
      END
      $$
    `);
    await databaseClient.query(`
      CREATE TRIGGER replace_generation_before_export
      AFTER UPDATE OF remote_sync_revision ON address_books
      FOR EACH ROW WHEN (NEW.source = 'carddav')
      EXECUTE FUNCTION replace_generation_before_export()
    `);

    try {
      expect(await carddavSync.syncUser(seeded.userId)).toMatchObject({
        ok: false,
        error: 'CardDAV sync plan is stale',
      });
      expect(fixture.requests.filter(request => (
        request.method === 'GET' || request.method === 'PUT' || request.method === 'DELETE'
      ))).toEqual([]);
      const state = await projectionState(seeded.userId);
      expect(state.ledger).toEqual([]);
      expect(state.contacts.find(row => row.id === localContact.id)).toMatchObject({
        vcard: card,
        display_name: contact.displayName,
      });
      expect((await integrationState(seeded.userId))[0].config.connectionGeneration)
        .toBe(replacementGeneration);
    } finally {
      await databaseClient.query('DROP TRIGGER replace_generation_before_export ON address_books');
      await databaseClient.query('DROP FUNCTION replace_generation_before_export()');
      await fixture.close();
    }
  }, 120_000);

  it('syncUser recovers once from valid-sync-token and commits one full reconciliation', async () => {
    const fixture = createCarddavFixtureServer();
    await fixture.listen();
    const seeded = await seedConnectedUser(fixture);
    const unrelatedBook = await databaseClient.query(`
      INSERT INTO address_books (user_id, name)
      VALUES ($1, 'Unrelated') RETURNING id, sync_token
    `, [seeded.userId]);
    const retainedHref = fixture.href('retained.vcf');
    const changedHref = fixture.href('changed.vcf');
    const removedHref = fixture.href('removed.vcf');
    const retainedVcard = remoteVcard('retained', 'Retained Contact');
    const changedBeforeVcard = remoteVcard('changed', 'Changed Before');
    const removedVcard = remoteVcard('removed', 'Removed Contact');
    fixture.putContact(retainedHref, '"retained-1"', retainedVcard);
    fixture.putContact(changedHref, '"changed-1"', changedBeforeVcard);
    fixture.putContact(removedHref, '"removed-1"', removedVcard);
    fixture.queueSync('', {
      events: [
        { href: retainedHref, etag: '"retained-1"' },
        { href: changedHref, etag: '"changed-1"' },
        { href: removedHref, etag: '"removed-1"' },
      ],
      nextToken: 'seed-token',
    });
    expect(await carddavSync.syncUser(seeded.userId)).toMatchObject({
      ok: true, bookCount: 1, contactCount: 3,
    });
    await databaseClient.query(`
      UPDATE address_books
      SET remote_sync_token = 'stored-invalid-token', remote_sync_revision = 7
      WHERE user_id = $1 AND source = 'carddav'
    `, [seeded.userId]);
    const before = await projectionState(seeded.userId);
    const remoteBook = before.books.find(row => row.source === 'carddav');
    const retainedContact = before.contacts.find(row => row.primary_email === 'retained@example.test');
    const changedContact = before.contacts.find(row => row.primary_email === 'changed@example.test');
    const changedVcard = remoteVcard('changed', 'Changed After');
    const addedVcard = remoteVcard('added', 'Added Contact');
    const addedHref = fixture.href('added.vcf');
    fixture.putContact(changedHref, '"changed-2"', changedVcard);
    fixture.putContact(addedHref, '"added-1"', addedVcard);
    fixture.deleteContact(removedHref);
    fixture.reset();
    fixture.queueSync('stored-invalid-token', {
      status: 403,
      rawBody: '<D:error xmlns:D="DAV:"><D:other/><D:valid-sync-token/></D:error>',
    });
    fixture.queueSync('', {
      events: [
        { href: retainedHref, etag: '"retained-1"' },
        { href: changedHref, etag: '"changed-2"' },
        { href: addedHref, etag: '"added-1"' },
      ],
      nextToken: 'recovered-token',
    });

    const result = await carddavSync.syncUser(seeded.userId);

    expect(result).toEqual({
      ok: true,
      bookCount: 1,
      contactCount: 3,
      remote: 3,
      fetched: 3,
      updated: 2,
      removed: 1,
      fallback: 1,
      exportFailures: [],
    });
    const after = await projectionState(seeded.userId);
    const afterBook = after.books.find(row => row.id === remoteBook.id);
    expect(afterBook).toEqual({
      ...remoteBook,
      remote_sync_token: 'recovered-token',
      remote_sync_capability: 'sync-collection',
      remote_sync_revision: '8',
      sync_token: expect.any(String),
      remote_projection_fingerprint: createHash('sha256').update(JSON.stringify([[
        unrelatedBook.rows[0].id,
        unrelatedBook.rows[0].sync_token,
      ]])).digest('hex'),
    });
    expect(afterBook.sync_token).not.toBe(remoteBook.sync_token);
    expect(after.books.find(row => row.id === unrelatedBook.rows[0].id)).toEqual({
      id: unrelatedBook.rows[0].id,
      source: 'local',
      external_url: null,
      sync_token: unrelatedBook.rows[0].sync_token,
      remote_sync_token: null,
      remote_sync_capability: 'unknown',
      remote_sync_revision: '0',
      remote_projection_fingerprint: null,
    });
    const addedContact = after.contacts.find(row => row.primary_email === 'added@example.test');
    expect(after.contacts).toEqual([
      expectedLocalContact(retainedHref, retainedVcard, remoteBook.id, seeded.userId, retainedContact.id),
      expectedLocalContact(changedHref, changedVcard, remoteBook.id, seeded.userId, changedContact.id),
      expectedLocalContact(addedHref, addedVcard, remoteBook.id, seeded.userId, addedContact.id),
    ].sort((a, b) => a.uid.localeCompare(b.uid)));
    expect(after.ledger).toEqual([
      [addedHref, '"added-1"', addedVcard, 'added@example.test', addedContact.id],
      [changedHref, '"changed-2"', changedVcard, 'changed@example.test', changedContact.id],
      [retainedHref, '"retained-1"', retainedVcard, 'retained@example.test', retainedContact.id],
    ].map(([href, etag, card, email, contactId]) => ({
      address_book_id: remoteBook.id,
      href,
      remote_etag: etag,
      vcard: card,
      primary_email: email,
      local_contact_id: contactId,
    })));
    const [integration] = await integrationState(seeded.userId);
    expect(integration.provider).toBe('carddav');
    expect(integration.config).toEqual({
      ...seeded.config,
      lastError: null,
      lastSyncAt: expect.any(String),
      bookCount: 1,
      contactCount: 3,
      exportFailures: [],
    });
    expect(integration.config.password).toBe(seeded.encryptedPassword);
    expect(integration.config.password).toMatch(/^enc:v1:/);
    expect(integration.config.password).not.toBe(seeded.password);
    expect(Number.isNaN(Date.parse(integration.config.lastSyncAt))).toBe(false);
    expect(fixture.requests.map(request => ({
      method: request.method,
      path: request.path,
      depth: request.depth,
      token: request.body.match(/<sync-token>([\s\S]*?)<\/sync-token>/)?.[1],
    }))).toEqual([
      { method: 'PROPFIND', path: '/', depth: '0', token: undefined },
      { method: 'PROPFIND', path: '/principals/fixture-user/', depth: '0', token: undefined },
      { method: 'PROPFIND', path: '/addressbooks/fixture-user/', depth: '1', token: undefined },
      { method: 'REPORT', path: '/addressbooks/fixture-user/contacts/', depth: '0', token: 'stored-invalid-token' },
      { method: 'REPORT', path: '/addressbooks/fixture-user/contacts/', depth: '0', token: '' },
      { method: 'REPORT', path: '/addressbooks/fixture-user/contacts/', depth: '0', token: undefined },
    ]);
    expect(fixture.requests.every(request => (
      request.authorization === 'Basic Zml4dHVyZS11c2VyOmZpeHR1cmUtcGFzc3dvcmQ='
    ))).toBe(true);
    expect(fixture.counters).toMatchObject({
      requests: 6,
      propfind: 3,
      sync: 2,
      multiget: 1,
      syncTokens: ['stored-invalid-token', ''],
      multigetSizes: [3],
    });
    await fixture.close();
  }, 120_000);

  it('valid-sync-token recovery is bounded when the empty-token recovery fails again', async () => {
    const fixture = createCarddavFixtureServer();
    await fixture.listen();
    const seeded = await seedConnectedUser(fixture);
    const contact = await seedSingleRemoteContact(fixture, seeded.userId);
    await databaseClient.query(`
      UPDATE address_books
      SET remote_sync_token = 'invalid-twice', remote_sync_revision = 4
      WHERE user_id = $1 AND source = 'carddav'
    `, [seeded.userId]);
    const before = await projectionState(seeded.userId, { timestamps: true });
    fixture.reset();
    fixture.queueSync('invalid-twice', { status: 403, precondition: 'valid-sync-token' });
    fixture.queueSync('', { status: 403, precondition: 'valid-sync-token' });

    const failed = await carddavSync.syncUser(seeded.userId);

    expect(failed).toEqual({
      ok: false,
      error: 'CardDAV request failed (403 Forbidden)',
      remote: 0,
      fetched: 0,
      updated: 0,
      removed: 0,
      fallback: 0,
    });
    expect(await projectionState(seeded.userId, { timestamps: true })).toEqual(before);
    const [failedIntegration] = await integrationState(seeded.userId);
    expect(failedIntegration.config).toEqual({
      ...seeded.config,
      lastError: 'CardDAV request failed (403 Forbidden)',
      lastSyncAt: expect.any(String),
      bookCount: 1,
      contactCount: 1,
      exportFailures: [],
    });
    expect(fixture.counters).toMatchObject({
      requests: 5,
      propfind: 3,
      sync: 2,
      multiget: 0,
      syncTokens: ['invalid-twice', ''],
    });

    fixture.reset();
    fixture.queueSync('invalid-twice', {
      events: [{ href: contact.href, etag: contact.etag }],
      nextToken: 'guard-released-token',
    });
    expect(await carddavSync.syncUser(seeded.userId)).toMatchObject({ ok: true });
    expect(fixture.counters.syncTokens).toEqual(['invalid-twice']);
    await fixture.close();
  }, 120_000);

  it('malformed empty-token recovery page leaves projection exact and releases the guard', async () => {
    const fixture = createCarddavFixtureServer();
    await fixture.listen();
    const seeded = await seedConnectedUser(fixture);
    const contact = await seedSingleRemoteContact(fixture, seeded.userId);
    await databaseClient.query(`
      UPDATE address_books
      SET remote_sync_token = 'invalid-malformed', remote_sync_revision = 9
      WHERE user_id = $1 AND source = 'carddav'
    `, [seeded.userId]);
    const before = await projectionState(seeded.userId, { timestamps: true });
    fixture.reset();
    fixture.queueSync('invalid-malformed', { status: 403, precondition: 'valid-sync-token' });
    fixture.queueSync('', {
      status: 207,
      rawBody: '<?xml version="1.0"?><not-a-multistatus/>',
    });

    const failed = await carddavSync.syncUser(seeded.userId);

    expect(failed.ok).toBe(false);
    expect(failed.error).toMatch(/multistatus/i);
    expect(await projectionState(seeded.userId, { timestamps: true })).toEqual(before);
    const [failedIntegration] = await integrationState(seeded.userId);
    expect(failedIntegration.config).toEqual({
      ...seeded.config,
      lastError: failed.error,
      lastSyncAt: expect.any(String),
      bookCount: 1,
      contactCount: 1,
      exportFailures: [],
    });
    expect(fixture.counters).toMatchObject({
      requests: 5,
      propfind: 3,
      sync: 2,
      multiget: 0,
      syncTokens: ['invalid-malformed', ''],
    });

    fixture.reset();
    fixture.queueSync('invalid-malformed', {
      events: [{ href: contact.href, etag: contact.etag }],
      nextToken: 'malformed-guard-released',
    });
    expect(await carddavSync.syncUser(seeded.userId)).toMatchObject({ ok: true });
    await fixture.close();
  }, 120_000);

  it('late multiget recovery failure rolls back the complete production plan', async () => {
    const fixture = createCarddavFixtureServer();
    await fixture.listen();
    const seeded = await seedConnectedUser(fixture);
    await seedSingleRemoteContact(fixture, seeded.userId);
    await databaseClient.query(`
      UPDATE address_books
      SET remote_sync_token = 'invalid-late-batch', remote_sync_revision = 12
      WHERE user_id = $1 AND source = 'carddav'
    `, [seeded.userId]);
    const before = await projectionState(seeded.userId, { timestamps: true });
    const events = [];
    for (let index = 0; index < 101; index++) {
      const uid = `batch-${String(index).padStart(3, '0')}`;
      const href = fixture.href(`${uid}.vcf`);
      const card = remoteVcard(uid, `Batch ${index}`);
      const etag = `"${uid}-1"`;
      fixture.putContact(href, etag, card);
      events.push({ href, etag });
    }
    fixture.reset();
    fixture.queueSync('invalid-late-batch', { status: 403, precondition: 'valid-sync-token' });
    fixture.queueSync('', { events, nextToken: 'must-not-commit' });
    fixture.queueMultiget({});
    fixture.queueMultiget({ status: 500, rawBody: '<error>late batch failed</error>' });

    const failed = await carddavSync.syncUser(seeded.userId);

    expect(failed).toEqual({
      ok: false,
      error: 'CardDAV request failed (500 Internal Server Error)',
      remote: 0,
      fetched: 0,
      updated: 0,
      removed: 0,
      fallback: 0,
    });
    expect(await projectionState(seeded.userId, { timestamps: true })).toEqual(before);
    const [failedIntegration] = await integrationState(seeded.userId);
    expect(failedIntegration.config).toEqual({
      ...seeded.config,
      lastError: failed.error,
      lastSyncAt: expect.any(String),
      bookCount: 1,
      contactCount: 1,
      exportFailures: [],
    });
    expect(fixture.counters).toMatchObject({
      requests: 7,
      propfind: 3,
      sync: 2,
      multiget: 2,
      syncTokens: ['invalid-late-batch', ''],
      multigetSizes: [100, 1],
    });
    fixture.reset();
    fixture.queueSync('invalid-late-batch', { status: 403, precondition: 'valid-sync-token' });
    fixture.queueSync('', {
      events: [{ href: before.ledger[0].href, etag: before.ledger[0].remote_etag }],
      nextToken: 'late-batch-guard-released',
    });
    expect(await carddavSync.syncUser(seeded.userId)).toMatchObject({ ok: true });
    await fixture.close();
  }, 120_000);

  it('rollback from a database trigger preserves projection and writes only guarded failure status', async () => {
    const fixture = createCarddavFixtureServer();
    await fixture.listen();
    const seeded = await seedConnectedUser(fixture);
    const contact = await seedSingleRemoteContact(fixture, seeded.userId);
    const before = await projectionState(seeded.userId, { timestamps: true });
    const changedCard = remoteVcard('seeded', 'Trigger Changed');
    fixture.putContact(contact.href, '"seeded-2"', changedCard);
    fixture.reset();
    fixture.queueSync(contact.token, {
      events: [{ href: contact.href, etag: '"seeded-2"' }],
      nextToken: 'trigger-must-not-commit',
    });
    await databaseClient.query(`
      CREATE FUNCTION task24_force_book_rollback() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'forced sync rollback';
      END
      $$
    `);
    await databaseClient.query(`
      CREATE TRIGGER task24_force_book_rollback
      BEFORE UPDATE ON address_books
      FOR EACH ROW EXECUTE FUNCTION task24_force_book_rollback()
    `);

    const failed = await carddavSync.syncUser(seeded.userId);
    await databaseClient.query('DROP TRIGGER task24_force_book_rollback ON address_books');
    await databaseClient.query('DROP FUNCTION task24_force_book_rollback()');

    expect(failed).toEqual({
      ok: false,
      error: 'forced sync rollback',
      remote: 0,
      fetched: 0,
      updated: 0,
      removed: 0,
      fallback: 0,
    });
    expect(await projectionState(seeded.userId, { timestamps: true })).toEqual(before);
    const [failedIntegration] = await integrationState(seeded.userId);
    expect(failedIntegration.config).toEqual({
      ...seeded.config,
      lastError: 'forced sync rollback',
      lastSyncAt: expect.any(String),
      bookCount: 1,
      contactCount: 1,
      exportFailures: [],
    });
    expect(fixture.counters).toMatchObject({
      requests: 5,
      propfind: 3,
      sync: 1,
      multiget: 1,
      syncTokens: [contact.token],
      multigetSizes: [1],
    });

    fixture.reset();
    fixture.queueSync(contact.token, {
      events: [{ href: contact.href, etag: '"seeded-2"' }],
      nextToken: 'trigger-released-token',
    });
    expect(await carddavSync.syncUser(seeded.userId)).toMatchObject({ ok: true });
    await fixture.close();
  }, 120_000);

  it('stale recovery CAS retries once and never regresses concurrent token or revision state', async () => {
    const fixture = createCarddavFixtureServer();
    await fixture.listen();
    const seeded = await seedConnectedUser(fixture);
    const contact = await seedSingleRemoteContact(fixture, seeded.userId);
    await databaseClient.query(`
      UPDATE address_books
      SET remote_sync_token = 'stored-invalid-cas', remote_sync_revision = 7
      WHERE user_id = $1 AND source = 'carddav'
    `, [seeded.userId]);
    const before = await projectionState(seeded.userId);
    const changedCard = remoteVcard('seeded', 'Stale Changed');
    fixture.putContact(contact.href, '"stale-2"', changedCard);
    const firstBarrier = deferred();
    const firstReached = deferred();
    const secondBarrier = deferred();
    const secondReached = deferred();
    fixture.reset();
    fixture.queueSync('stored-invalid-cas', {
      status: 403,
      precondition: 'valid-sync-token',
    });
    fixture.queueSync('', {
      events: [{ href: contact.href, etag: '"stale-2"' }],
      nextToken: 'stale-plan-one',
      waitFor: firstBarrier.promise,
      reached: firstReached.resolve,
    });
    fixture.queueSync('concurrent-token-one', {
      events: [{ href: contact.href, etag: '"stale-2"' }],
      nextToken: 'stale-plan-two',
      waitFor: secondBarrier.promise,
      reached: secondReached.resolve,
    });

    const pending = carddavSync.syncUser(seeded.userId);
    await firstReached.promise;
    await databaseClient.query(`
      UPDATE address_books
      SET remote_sync_token = 'concurrent-token-one', remote_sync_revision = 8
      WHERE user_id = $1 AND source = 'carddav'
    `, [seeded.userId]);
    firstBarrier.resolve();
    await secondReached.promise;
    await databaseClient.query(`
      UPDATE address_books
      SET remote_sync_token = 'concurrent-token-two', remote_sync_revision = 9
      WHERE user_id = $1 AND source = 'carddav'
    `, [seeded.userId]);
    secondBarrier.resolve();

    const failed = await pending;

    expect(failed).toEqual({
      ok: false,
      error: 'CardDAV sync plan is stale',
      remote: 0,
      fetched: 0,
      updated: 0,
      removed: 0,
      fallback: 0,
    });
    const after = await projectionState(seeded.userId);
    expect(after).toEqual({
      ...before,
      books: before.books.map(book => book.source === 'carddav' ? {
        ...book,
        remote_sync_token: 'concurrent-token-two',
        remote_sync_revision: '9',
      } : book),
    });
    expect(after.contacts).toHaveLength(1);
    expect(after.contacts[0].display_name).toBe('Seeded Contact');
    expect(after.ledger).toHaveLength(1);
    expect(after.ledger[0].remote_etag).toBe(contact.etag);
    const [failedIntegration] = await integrationState(seeded.userId);
    expect(failedIntegration.config).toEqual({
      ...seeded.config,
      lastError: 'CardDAV sync plan is stale',
      lastSyncAt: expect.any(String),
      bookCount: 1,
      contactCount: 1,
      exportFailures: [],
    });
    expect(fixture.counters).toMatchObject({
      requests: 8,
      propfind: 3,
      sync: 3,
      multiget: 2,
      syncTokens: ['stored-invalid-cas', '', 'concurrent-token-one'],
      multigetSizes: [1, 1],
    });
    fixture.reset();
    fixture.queueSync('concurrent-token-two', {
      events: [],
      nextToken: 'stale-guard-released',
    });
    expect(await carddavSync.syncUser(seeded.userId)).toMatchObject({ ok: true });
    await fixture.close();
  }, 120_000);

  it('initial no-change changed removed and snapshot filter paths advance one revision each', async () => {
    const fixture = createCarddavFixtureServer();
    await fixture.listen();
    const seeded = await seedConnectedUser(fixture);
    const href = fixture.href('lifecycle.vcf');
    const initialCard = remoteVcard('lifecycle', 'Lifecycle Initial');
    fixture.putContact(href, '"lifecycle-1"', initialCard);
    fixture.queueSync('', {
      events: [{ href, etag: '"lifecycle-1"' }],
      nextToken: 'lifecycle-1',
    });

    expect(await carddavSync.syncUser(seeded.userId)).toEqual({
      ok: true, bookCount: 1, contactCount: 1,
      remote: 1, fetched: 1, updated: 1, removed: 0,
      fallback: 0, exportFailures: [],
    });
    const initial = await projectionState(seeded.userId);
    const initialBook = initial.books.find(row => row.source === 'carddav');
    expect(initialBook.remote_sync_revision).toBe('1');

    fixture.reset();
    fixture.queueSync('lifecycle-1', { events: [], nextToken: 'lifecycle-2' });
    expect(await carddavSync.syncUser(seeded.userId)).toMatchObject({
      ok: true, fetched: 0, updated: 0, removed: 0,
    });
    const unchanged = await projectionState(seeded.userId);
    expect(unchanged.books.find(row => row.id === initialBook.id)).toMatchObject({
      remote_sync_token: 'lifecycle-2',
      remote_sync_revision: '2',
      sync_token: initialBook.sync_token,
    });
    expect(unchanged.contacts).toEqual(initial.contacts);
    expect(unchanged.ledger).toEqual(initial.ledger);
    expect((await integrationState(seeded.userId))[0].config.contactCount).toBe(1);
    expect(fixture.counters.multiget).toBe(0);

    const changedCard = remoteVcard('lifecycle', 'Lifecycle Changed');
    fixture.putContact(href, '"lifecycle-2"', changedCard);
    fixture.reset();
    fixture.queueSync('lifecycle-2', {
      events: [{ href, etag: '"lifecycle-2"' }],
      nextToken: 'lifecycle-3',
    });
    expect(await carddavSync.syncUser(seeded.userId)).toMatchObject({
      ok: true, fetched: 1, updated: 1, removed: 0,
    });
    const changed = await projectionState(seeded.userId);
    const changedBook = changed.books.find(row => row.id === initialBook.id);
    expect(changedBook).toMatchObject({
      remote_sync_token: 'lifecycle-3',
      remote_sync_revision: '3',
    });
    expect(changedBook.sync_token).not.toBe(initialBook.sync_token);
    expect(changed.contacts[0].display_name).toBe('Lifecycle Changed');
    expect((await integrationState(seeded.userId))[0].config.contactCount).toBe(1);

    fixture.deleteContact(href);
    fixture.reset();
    fixture.queueSync('lifecycle-3', {
      events: [{ href, status: 404 }],
      nextToken: 'lifecycle-4',
    });
    expect(await carddavSync.syncUser(seeded.userId)).toMatchObject({
      ok: true, fetched: 0, updated: 0, removed: 1,
    });
    const removed = await projectionState(seeded.userId);
    const removedBook = removed.books.find(row => row.id === initialBook.id);
    expect(removedBook).toMatchObject({
      remote_sync_token: 'lifecycle-4',
      remote_sync_revision: '4',
    });
    expect(removedBook.sync_token).not.toBe(changedBook.sync_token);
    expect(removed.contacts).toEqual([]);
    expect(removed.ledger).toEqual([]);
    expect((await integrationState(seeded.userId))[0].config.contactCount).toBe(0);

    fixture.reset();
    fixture.queueSync('lifecycle-4', { status: 405 });
    expect(await carddavSync.syncUser(seeded.userId)).toMatchObject({
      ok: true, fetched: 0, updated: 0, removed: 0, fallback: 1,
    });
    const snapshot = await projectionState(seeded.userId);
    expect(snapshot.books.find(row => row.id === initialBook.id)).toEqual({
      ...removedBook,
      remote_sync_token: null,
      remote_sync_capability: 'snapshot',
      remote_sync_revision: '5',
    });
    expect(snapshot.contacts).toEqual([]);
    expect(snapshot.ledger).toEqual([]);
    expect(fixture.counters).toMatchObject({
      propfind: 3,
      sync: 1,
      multiget: 0,
      addressbookQuery: 1,
      snapshotFilters: [1],
      syncTokens: ['lifecycle-4'],
    });
    await fixture.close();
  }, 120_000);

  it('reconciles the mapped-contact pull matrix without disturbing durable conflicts', async () => {
    const fixture = createCarddavFixtureServer();
    await fixture.listen();
    const seeded = await seedConnectedUser(fixture);
    const cases = ['additional', 'pending-etag', 'conflict-edit', 'conflict-delete', 'sibling'];
    const hrefs = Object.fromEntries(cases.map(name => [name, fixture.href(`${name}.vcf`)]));
    const cards = Object.fromEntries(cases.map(name => [
      name,
      remoteVcard(name, `${name} Initial`),
    ]));
    for (const name of cases) fixture.putContact(hrefs[name], `"${name}-1"`, cards[name]);
    fixture.queueSync('', {
      events: cases.map(name => ({ href: hrefs[name], etag: `"${name}-1"` })),
      nextToken: 'mapping-matrix-1',
    });
    expect(await carddavSync.syncUser(seeded.userId)).toMatchObject({
      ok: true, contactCount: 5,
    });

    const { rows: initialMappings } = await databaseClient.query(`
      SELECT o.href, o.address_book_id, o.local_contact_id,
             o.remote_semantic_hash, o.local_contact_hash
      FROM carddav_remote_objects o
      JOIN address_books b ON b.id = o.address_book_id
      WHERE b.user_id = $1
      ORDER BY o.href
    `, [seeded.userId]);
    const initialByHref = new Map(initialMappings.map(mapping => [mapping.href, mapping]));
    const localNames = {
      'pending-etag': 'Pending Local Edit',
      'conflict-edit': 'Conflict Local Edit',
      'conflict-delete': 'Delete Conflict Local Edit',
    };
    for (const [name, displayName] of Object.entries(localNames)) {
      await databaseClient.query(
        `UPDATE contacts SET display_name = $1, updated_at = NOW() WHERE id = $2`,
        [displayName, initialByHref.get(hrefs[name]).local_contact_id],
      );
    }
    await databaseClient.query(`
      UPDATE carddav_remote_objects
      SET mapping_status = CASE
            WHEN href = $1 THEN 'pending_push'
            WHEN href = ANY($2::text[]) THEN 'conflict'
            ELSE mapping_status
          END,
          mapping_revision = 10
      WHERE address_book_id = $3
    `, [
      hrefs['pending-etag'],
      [hrefs['conflict-edit'], hrefs['conflict-delete']],
      initialMappings[0].address_book_id,
    ]);
    const conflictIds = {};
    const conflictLocalSnapshots = {};
    for (const name of ['conflict-edit', 'conflict-delete']) {
      const mapping = initialByHref.get(hrefs[name]);
      const localVCard = remoteVcard(name, localNames[name]);
      const localTombstone = name === 'conflict-delete';
      const { rows: [conflict] } = await databaseClient.query(`
        INSERT INTO carddav_conflicts (
          address_book_id, href, user_id, base_local_hash, remote_etag,
          local_vcard, remote_vcard, local_tombstone, remote_tombstone
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,false)
        RETURNING id
      `, [
        mapping.address_book_id,
        mapping.href,
        seeded.userId,
        mapping.local_contact_hash,
        `"${name}-1"`,
        localVCard,
        cards[name],
        localTombstone,
      ]);
      conflictIds[name] = conflict.id;
      conflictLocalSnapshots[name] = { localVCard, localTombstone };
    }

    const additionalCard = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'UID:additional',
      'FN:additional Initial',
      'EMAIL:additional@example.test',
      'item1.URL:https://example.test/profile',
      'item1.X-ABLabel:Portfolio',
      'END:VCARD',
    ].join('\n');
    const conflictEditCard = remoteVcard('conflict-edit', 'Conflict Remote Edit');
    const siblingCard = remoteVcard('sibling', 'Sibling Remote Edit');
    fixture.putContact(hrefs.additional, '"additional-2"', additionalCard);
    fixture.putContact(hrefs['pending-etag'], '"pending-etag-2"', cards['pending-etag']);
    fixture.putContact(hrefs['conflict-edit'], '"conflict-edit-2"', conflictEditCard);
    fixture.deleteContact(hrefs['conflict-delete']);
    fixture.putContact(hrefs.sibling, '"sibling-2"', siblingCard);
    fixture.reset();
    fixture.queueSync('mapping-matrix-1', {
      events: [
        { href: hrefs.additional, etag: '"additional-2"' },
        { href: hrefs['pending-etag'], etag: '"pending-etag-2"' },
        { href: hrefs['conflict-edit'], etag: '"conflict-edit-2"' },
        { href: hrefs['conflict-delete'], status: 404 },
        { href: hrefs.sibling, etag: '"sibling-2"' },
      ],
      nextToken: 'mapping-matrix-2',
    });

    expect(await carddavSync.syncUser(seeded.userId)).toMatchObject({
      ok: true, contactCount: 5,
    });
    const { rows: state } = await databaseClient.query(`
      SELECT o.href, o.remote_etag, o.vcard, o.mapping_status,
             o.remote_semantic_hash, o.local_contact_hash,
             o.pending_operation, o.pending_vcard, o.pending_local_hash,
             o.pending_remote_semantic_hash, o.pending_started_at,
             o.mapping_revision::text, c.uid, c.display_name, c.first_name,
             c.last_name, c.emails, c.phones, c.organization, c.notes,
             c.photo_data, c.additional_fields,
             conflict.id AS conflict_id, conflict.remote_etag AS conflict_remote_etag,
             conflict.remote_vcard AS conflict_remote_vcard,
             conflict.local_vcard AS conflict_local_vcard,
             conflict.local_tombstone,
             conflict.remote_tombstone
      FROM carddav_remote_objects o
      JOIN contacts c ON c.id = o.local_contact_id
      LEFT JOIN carddav_conflicts conflict
        ON conflict.address_book_id = o.address_book_id
       AND conflict.href = o.href AND conflict.status = 'unresolved'
      WHERE c.user_id = $1
      ORDER BY o.href
    `, [seeded.userId]);
    const byHref = new Map(state.map(mapping => [mapping.href, mapping]));
    const { rows: [bookState] } = await databaseClient.query(`
      SELECT remote_sync_token FROM address_books
      WHERE user_id = $1 AND source = 'carddav'
    `, [seeded.userId]);

    expect(bookState.remote_sync_token).toBe('mapping-matrix-2');
    expect(byHref.get(hrefs.additional)).toMatchObject({
      remote_etag: '"additional-2"',
      vcard: additionalCard,
      mapping_status: 'synced',
      remote_semantic_hash: semanticVCardHash(parseVCardDocument(additionalCard)),
      mapping_revision: '11',
      display_name: 'additional Initial',
      additional_fields: [expect.objectContaining({
        kind: 'url', label: 'Portfolio', value: 'https://example.test/profile',
      })],
      conflict_id: null,
    });
    const storedContactHash = contact => localContactHash({
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
    expect(byHref.get(hrefs.additional).local_contact_hash).toBe(
      storedContactHash(byHref.get(hrefs.additional)),
    );
    expect(byHref.get(hrefs['pending-etag'])).toMatchObject({
      remote_etag: '"pending-etag-2"',
      vcard: cards['pending-etag'],
      mapping_status: 'pending_push',
      remote_semantic_hash: initialByHref.get(hrefs['pending-etag']).remote_semantic_hash,
      local_contact_hash: initialByHref.get(hrefs['pending-etag']).local_contact_hash,
      mapping_revision: '11',
      display_name: localNames['pending-etag'],
      pending_operation: null,
      pending_vcard: null,
      pending_local_hash: null,
      pending_remote_semantic_hash: null,
      pending_started_at: null,
      conflict_id: null,
    });
    expect(byHref.get(hrefs['conflict-edit'])).toMatchObject({
      remote_etag: '"conflict-edit-1"',
      vcard: cards['conflict-edit'],
      mapping_status: 'conflict',
      remote_semantic_hash: initialByHref.get(hrefs['conflict-edit']).remote_semantic_hash,
      local_contact_hash: initialByHref.get(hrefs['conflict-edit']).local_contact_hash,
      mapping_revision: '11',
      display_name: localNames['conflict-edit'],
      conflict_id: conflictIds['conflict-edit'],
      conflict_local_vcard: conflictLocalSnapshots['conflict-edit'].localVCard,
      local_tombstone: conflictLocalSnapshots['conflict-edit'].localTombstone,
      conflict_remote_etag: '"conflict-edit-2"',
      conflict_remote_vcard: conflictEditCard,
      remote_tombstone: false,
    });
    expect(byHref.get(hrefs['conflict-delete'])).toMatchObject({
      remote_etag: '"conflict-delete-1"',
      vcard: cards['conflict-delete'],
      mapping_status: 'conflict',
      remote_semantic_hash: initialByHref.get(hrefs['conflict-delete']).remote_semantic_hash,
      local_contact_hash: initialByHref.get(hrefs['conflict-delete']).local_contact_hash,
      mapping_revision: '11',
      display_name: localNames['conflict-delete'],
      conflict_id: conflictIds['conflict-delete'],
      conflict_local_vcard: conflictLocalSnapshots['conflict-delete'].localVCard,
      local_tombstone: conflictLocalSnapshots['conflict-delete'].localTombstone,
      conflict_remote_etag: null,
      conflict_remote_vcard: null,
      remote_tombstone: true,
    });
    expect(byHref.get(hrefs.sibling)).toMatchObject({
      remote_etag: '"sibling-2"',
      vcard: siblingCard,
      mapping_status: 'synced',
      remote_semantic_hash: semanticVCardHash(parseVCardDocument(siblingCard)),
      mapping_revision: '11',
      display_name: 'Sibling Remote Edit',
      conflict_id: null,
    });
    expect(byHref.get(hrefs.sibling).local_contact_hash).toBe(
      storedContactHash(byHref.get(hrefs.sibling)),
    );
    await fixture.close();
  }, 120_000);

  async function createPushOriginContact(fixture, userId, draft) {
    const created = await carddavContactService.createContact(userId, {
      firstName: null,
      lastName: null,
      phones: [],
      organization: null,
      notes: null,
      photoData: null,
      additionalFields: [],
      ...draft,
    });
    const { rows: [row] } = await databaseClient.query(`
      SELECT o.address_book_id, o.href, o.remote_etag, o.vcard,
             o.remote_semantic_hash, o.local_contact_hash, o.mapping_status,
             o.mapping_revision::text,
             c.id AS contact_id, c.address_book_id AS contact_book_id, c.uid,
             c.display_name, c.first_name, c.last_name, c.organization, c.notes,
             c.emails, c.phones, c.photo_data, c.additional_fields,
             cb.source AS contact_book_source
      FROM carddav_remote_objects o
      JOIN contacts c ON c.id = o.local_contact_id
      JOIN address_books cb ON cb.id = c.address_book_id
      WHERE c.user_id = $1
    `, [userId]);
    // A push-origin mapping links a contact that lives OUTSIDE the CardDAV book.
    expect(row.contact_book_source).not.toBe('carddav');
    expect(row.contact_book_id).not.toBe(row.address_book_id);
    expect(row.contact_id).toBe(created.id);
    return { created, mapping: row };
  }

  async function pushOriginState(userId) {
    const { rows: [row] } = await databaseClient.query(`
      SELECT o.address_book_id, o.href, o.remote_etag, o.vcard,
             o.remote_semantic_hash, o.local_contact_hash, o.mapping_status,
             o.mapping_revision::text,
             c.id AS contact_id, c.address_book_id AS contact_book_id, c.uid,
             c.display_name, c.first_name, c.last_name, c.organization, c.notes,
             c.emails, c.phones, c.photo_data, c.additional_fields
      FROM carddav_remote_objects o
      JOIN contacts c ON c.id = o.local_contact_id
      WHERE c.user_id = $1
    `, [userId]);
    return row;
  }

  function contactRowHash(row) {
    return localContactHash({
      uid: row.uid,
      displayName: row.display_name,
      firstName: row.first_name,
      lastName: row.last_name,
      emails: row.emails,
      phones: row.phones,
      organization: row.organization,
      notes: row.notes,
      photoData: row.photo_data,
      additionalFields: row.additional_fields,
    });
  }

  it('applies a remote edit to a push-origin contact and stays converged', async () => {
    const fixture = createCarddavFixtureServer();
    await fixture.listen();
    try {
      const seeded = await seedConnectedUser(fixture);
      const { created, mapping: before } = await createPushOriginContact(fixture, seeded.userId, {
        displayName: 'Push Origin',
        firstName: 'Push',
        lastName: 'Origin',
        emails: [{ value: 'push-origin@example.test', type: 'work', primary: true }],
        organization: 'Origin Co',
      });

      // A remote-only edit of the resource MailFlow created: same UID, new content.
      const editedVcard = [
        'BEGIN:VCARD',
        'VERSION:3.0',
        `UID:${created.uid}`,
        'FN:Push Origin',
        'EMAIL:push-origin@example.test',
        'ORG:Edited Remotely',
        'NOTE:remote-only-edit',
        'END:VCARD',
      ].join('\n');
      fixture.putContact(before.href, '"push-origin-edited"', editedVcard);
      fixture.queueSync('', {
        events: [{ rawHref: before.href, etag: '"push-origin-edited"' }],
        nextToken: 'push-origin-edited-token',
      });

      expect(await carddavSync.syncUser(seeded.userId)).toMatchObject({ ok: true });

      const after = await pushOriginState(seeded.userId);
      // The local contact adopted the edit in place: same IDs, same local book.
      expect(after.contact_id).toBe(before.contact_id);
      expect(after.contact_book_id).toBe(before.contact_book_id);
      expect(after.uid).toBe(before.uid);
      expect(after.organization).toBe('Edited Remotely');
      expect(after.notes).toBe('remote-only-edit');
      // The mapping advanced its ETag, retained the lossless remote vCard, stays synced.
      expect(after.remote_etag).toBe('"push-origin-edited"');
      expect(after.vcard).toBe(editedVcard);
      expect(after.mapping_status).toBe('synced');
      expect(after.remote_semantic_hash)
        .toBe(semanticVCardHash(parseVCardDocument(editedVcard)));
      // Hashes converge: the mapping's local hash matches the stored contact.
      expect(after.local_contact_hash).toBe(contactRowHash(after));
      // No spurious conflict.
      const { rows: conflicts } = await databaseClient.query(
        "SELECT 1 FROM carddav_conflicts WHERE user_id = $1 AND status = 'unresolved'",
        [seeded.userId],
      );
      expect(conflicts).toEqual([]);

      // A byte-identical incremental no-change sync leaves the mapping + contact untouched.
      fixture.queueSync('push-origin-edited-token', {
        events: [],
        nextToken: 'push-origin-noop-token',
      });
      expect(await carddavSync.syncUser(seeded.userId)).toMatchObject({ ok: true });
      const settled = await pushOriginState(seeded.userId);
      expect(settled).toMatchObject({
        remote_etag: after.remote_etag,
        vcard: after.vcard,
        remote_semantic_hash: after.remote_semantic_hash,
        local_contact_hash: after.local_contact_hash,
        mapping_status: 'synced',
        mapping_revision: after.mapping_revision,
        organization: 'Edited Remotely',
        notes: 'remote-only-edit',
      });
    } finally {
      await fixture.close();
    }
  }, 120_000);

  it('creates a conflict when a push-origin contact is edited on both sides', async () => {
    const fixture = createCarddavFixtureServer();
    await fixture.listen();
    try {
      const seeded = await seedConnectedUser(fixture);
      const { created, mapping: before } = await createPushOriginContact(fixture, seeded.userId, {
        displayName: 'Push Both',
        emails: [{ value: 'push-both@example.test', type: 'work', primary: true }],
        organization: 'Origin Co',
      });

      // Concurrent local edit (no push yet) plus a remote-only edit of the same resource.
      await databaseClient.query(
        'UPDATE contacts SET organization = $1, updated_at = NOW() WHERE id = $2',
        ['Local Edit', created.id],
      );
      const remoteVcard = [
        'BEGIN:VCARD',
        'VERSION:3.0',
        `UID:${created.uid}`,
        'FN:Push Both',
        'EMAIL:push-both@example.test',
        'ORG:Remote Edit',
        'END:VCARD',
      ].join('\n');
      fixture.putContact(before.href, '"push-both-remote"', remoteVcard);
      fixture.queueSync('', {
        events: [{ rawHref: before.href, etag: '"push-both-remote"' }],
        nextToken: 'push-both-token',
      });

      expect(await carddavSync.syncUser(seeded.userId)).toMatchObject({ ok: true });

      // The simultaneous edit surfaces as a normal conflict; the local edit is retained.
      const { rows: [conflict] } = await databaseClient.query(
        `SELECT status, remote_tombstone, local_tombstone
         FROM carddav_conflicts WHERE user_id = $1 AND href = $2`,
        [seeded.userId, before.href],
      );
      expect(conflict).toMatchObject({
        status: 'unresolved',
        remote_tombstone: false,
        local_tombstone: false,
      });
      const state = await pushOriginState(seeded.userId);
      expect(state.mapping_status).toBe('conflict');
      expect(state.organization).toBe('Local Edit');
    } finally {
      await fixture.close();
    }
  }, 120_000);

  it('snapshots a lossless local vCard when sync creates a conflict, so keep-mailflow preserves unmodeled properties', async () => {
    const fixture = createCarddavFixtureServer();
    await fixture.listen();
    try {
      const seeded = await seedConnectedUser(fixture);

      // Import a remote contact whose retained vCard carries unmodeled server
      // properties the local projection drops.
      const uid = 'conflict-lossless';
      const href = fixture.href(`${uid}.vcf`);
      const importedCard = [
        'BEGIN:VCARD',
        'VERSION:3.0',
        `UID:${uid}`,
        'FN:Conflict Lossless',
        'EMAIL:conflict-lossless@example.test',
        'CATEGORIES:Friends,VIP',
        'X-CUSTOM-FLAG:keep-me',
        'TZ:America/New_York',
        'END:VCARD',
      ].join('\n');
      fixture.putContact(href, '"lossless-1"', importedCard);
      fixture.queueSync('', { events: [{ href, etag: '"lossless-1"' }], nextToken: 'lossless-token' });
      expect(await carddavSync.syncUser(seeded.userId)).toMatchObject({ ok: true, contactCount: 1 });

      const { rows: [imported] } = await databaseClient.query(`
        SELECT c.id, c.vcard, o.vcard AS mapping_vcard
        FROM contacts c
        JOIN carddav_remote_objects o ON o.local_contact_id = c.id
        WHERE c.user_id = $1
      `, [seeded.userId]);
      // Precondition: the local contacts.vcard is lossy; only the mapping is lossless.
      expect(imported.vcard).not.toContain('CATEGORIES');
      expect(imported.mapping_vcard).toContain('CATEGORIES:Friends,VIP');

      // A local edit and a concurrent remote edit make sync raise a conflict.
      await databaseClient.query(
        'UPDATE contacts SET organization = $1, updated_at = NOW() WHERE id = $2',
        ['Local Edit', imported.id],
      );
      const remoteEdit = [
        'BEGIN:VCARD',
        'VERSION:3.0',
        `UID:${uid}`,
        'FN:Conflict Remote Edit',
        'EMAIL:conflict-lossless@example.test',
        'END:VCARD',
      ].join('\n');
      fixture.putContact(href, '"lossless-2"', remoteEdit);
      fixture.queueSync('lossless-token', {
        events: [{ href, etag: '"lossless-2"' }],
        nextToken: 'lossless-token-2',
      });
      expect(await carddavSync.syncUser(seeded.userId)).toMatchObject({ ok: true });

      const { rows: [conflict] } = await databaseClient.query(
        `SELECT id, local_vcard, status FROM carddav_conflicts
         WHERE user_id = $1 AND href = $2`,
        [seeded.userId, href],
      );
      expect(conflict.status).toBe('unresolved');
      // The snapshot overlays the current local contact onto the retained remote
      // vCard: the local edit is present AND the unmodeled properties survive.
      expect(conflict.local_vcard).toContain('ORG:Local Edit');
      expect(conflict.local_vcard).toContain('CATEGORIES:Friends,VIP');
      expect(conflict.local_vcard).toContain('X-CUSTOM-FLAG:keep-me');
      expect(conflict.local_vcard).toContain('TZ:America/New_York');

      // keep-mailflow pushes that snapshot verbatim, so the unmodeled properties
      // reach the remote instead of being stripped.
      fixture.reset();
      fixture.putContact(href, '"lossless-2"', remoteEdit);
      await carddavConflictService.resolveConflict(seeded.userId, conflict.id, 'keep-mailflow');

      const putRequest = fixture.requests.find(request => request.method === 'PUT');
      expect(putRequest).toBeDefined();
      expect(putRequest.body).toContain('ORG:Local Edit');
      expect(putRequest.body).toContain('CATEGORIES:Friends,VIP');
      expect(putRequest.body).toContain('X-CUSTOM-FLAG:keep-me');
      expect(putRequest.body).toContain('TZ:America/New_York');
    } finally {
      await fixture.close();
    }
  }, 120_000);

  it('removes a push-origin contact when its remote resource is deleted', async () => {
    const fixture = createCarddavFixtureServer();
    await fixture.listen();
    try {
      const seeded = await seedConnectedUser(fixture);
      const { created, mapping } = await createPushOriginContact(fixture, seeded.userId, {
        displayName: 'Push Delete',
        emails: [{ value: 'push-delete@example.test', type: 'work', primary: true }],
      });

      // Delete the remote resource, then sync with no concurrent local change.
      fixture.reset();
      fixture.deleteContact(mapping.href);
      fixture.queueSync('', { events: [], nextToken: 'push-delete-token' });

      expect(await carddavSync.syncUser(seeded.userId)).toMatchObject({ ok: true });

      // The local contact and its mapping are removed once, matching a pull-origin delete.
      const { rows: contactRows } = await databaseClient.query(
        'SELECT 1 FROM contacts WHERE id = $1',
        [created.id],
      );
      expect(contactRows).toEqual([]);
      const { rows: mappingRows } = await databaseClient.query(`
        SELECT 1 FROM carddav_remote_objects o
        JOIN address_books b ON b.id = o.address_book_id
        WHERE b.user_id = $1
      `, [seeded.userId]);
      expect(mappingRows).toEqual([]);
      // MailFlow must not resurrect the resource it saw deleted.
      expect(fixture.counters.create).toBe(0);
      expect(fixture.counters.update).toBe(0);
      const { rows: conflicts } = await databaseClient.query(
        "SELECT 1 FROM carddav_conflicts WHERE user_id = $1 AND status = 'unresolved'",
        [seeded.userId],
      );
      expect(conflicts).toEqual([]);
    } finally {
      await fixture.close();
    }
  }, 120_000);

  it('rotates the book sync token and advances the served ETag when a remote-only unmodeled change lands', async () => {
    const fixture = createCarddavFixtureServer();
    await fixture.listen();
    try {
      const seeded = await seedConnectedUser(fixture);
      const href = fixture.href('etag-lifecycle.vcf');
      const first = [
        'BEGIN:VCARD', 'VERSION:3.0', 'UID:etag-lifecycle-remote', 'FN:Etag Person',
        'EMAIL:etag@example.test', 'CATEGORIES:Alpha', 'END:VCARD',
      ].join('\n');
      fixture.putContact(href, '"etag-1"', first);
      fixture.queueSync('', { events: [{ href, etag: '"etag-1"' }], nextToken: 'etag-token-1' });
      expect(await carddavSync.syncUser(seeded.userId)).toMatchObject({ ok: true });

      const servedRow = async () => {
        const { rows: [row] } = await databaseClient.query(`
          SELECT c.uid, c.display_name, c.first_name, c.last_name, c.emails, c.phones,
                 c.organization, c.notes, c.photo_data, c.additional_fields, c.vcard, c.etag,
                 mapping.vcard AS mapping_vcard, mapping.address_book_id AS book_id
          FROM contacts c
          JOIN carddav_remote_objects mapping ON mapping.local_contact_id = c.id
          WHERE c.user_id = $1
        `, [seeded.userId]);
        return row;
      };
      const before = await servedRow();
      const bookBefore = await databaseClient.query(
        'SELECT sync_token FROM address_books WHERE id = $1', [before.book_id]);

      // A remote-only change to an UNMODELED property (CATEGORIES): the modeled columns
      // and contacts.etag stay identical, but the presented document changes.
      const second = [
        'BEGIN:VCARD', 'VERSION:3.0', 'UID:etag-lifecycle-remote', 'FN:Etag Person',
        'EMAIL:etag@example.test', 'CATEGORIES:Beta', 'END:VCARD',
      ].join('\n');
      fixture.putContact(href, '"etag-2"', second);
      fixture.reset();
      fixture.queueSync('etag-token-1', { events: [{ href, etag: '"etag-2"' }], nextToken: 'etag-token-2' });
      expect(await carddavSync.syncUser(seeded.userId)).toMatchObject({ ok: true });

      const after = await servedRow();
      const bookAfter = await databaseClient.query(
        'SELECT sync_token FROM address_books WHERE id = $1', [before.book_id]);

      // Modeled state is unchanged...
      expect(after.etag).toBe(before.etag);
      // ...but the presented document (hence the served ETag) advanced...
      expect(presentedVCard(after)).toContain('CATEGORIES:Beta');
      expect(presentedEtag(after)).not.toBe(presentedEtag(before));
      // ...so the book sync token (getctag) must rotate for pollers to re-fetch.
      expect(bookAfter.rows[0].sync_token).not.toBe(bookBefore.rows[0].sync_token);
    } finally {
      await fixture.close();
    }
  }, 120_000);

  it('preserves the remote UID when a Mailflow edit of an email-merged contact syncs, keeping it locally authoritative', async () => {
    const fixture = createCarddavFixtureServer();
    await fixture.listen();
    try {
      const seeded = await seedConnectedUser(fixture);
      const { rows: [localBook] } = await databaseClient.query(`
        INSERT INTO address_books (user_id, name)
        VALUES ($1, 'Email Merge Local') RETURNING id
      `, [seeded.userId]);
      const local = {
        uid: 'email-merge-local',
        displayName: 'Merge Person',
        emails: [{ value: 'email-merge@example.test', type: 'work', primary: true }],
        phones: [], organization: 'Local Co', notes: null, photoData: null,
      };
      const localVcard = generateVCard(local);
      const { rows: [localRow] } = await databaseClient.query(`
        INSERT INTO contacts (
          address_book_id, user_id, uid, vcard, etag, display_name, organization,
          primary_email, emails, phones, additional_fields, is_auto
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,'[]'::jsonb,'[]'::jsonb,false)
        RETURNING id
      `, [
        localBook.id, seeded.userId, local.uid, localVcard,
        createHash('md5').update(localVcard).digest('hex'),
        local.displayName, local.organization, local.emails[0].value,
        JSON.stringify(local.emails),
      ]);

      // The remote carries a DISTINCT, server-owned UID but the same primary email,
      // so the initial sync email-merges it to the local contact (locally authoritative).
      const remoteUid = 'email-merge-remote-uid';
      const href = fixture.href('email-merge.vcf');
      const remoteVcard = [
        'BEGIN:VCARD', 'VERSION:3.0', `UID:${remoteUid}`, 'FN:Merge Person',
        'EMAIL:email-merge@example.test', 'CATEGORIES:Remote', 'END:VCARD',
      ].join('\n');
      fixture.putContact(href, '"merge-1"', remoteVcard);
      fixture.queueSync('', { events: [{ href, etag: '"merge-1"' }], nextToken: 'merge-token-1' });
      expect(await carddavSync.syncUser(seeded.userId)).toMatchObject({ ok: true });

      const mappingUidAfterMerge = await databaseClient.query(
        'SELECT vcard FROM carddav_remote_objects o JOIN address_books b ON b.id = o.address_book_id WHERE b.user_id = $1',
        [seeded.userId],
      );
      expect(parseVCard(mappingUidAfterMerge.rows[0].vcard).uid).toBe(remoteUid);

      // The user edits the merged contact in Mailflow.
      fixture.reset();
      fixture.putContact(href, '"merge-1"', remoteVcard);
      await carddavContactService.updateContact(seeded.userId, localRow.id, {
        organization: 'Edited In Mailflow',
      });

      // The outgoing PUT must keep the remote-owned UID — never coerce it to the local key.
      const putRequest = fixture.requests.find(request => request.method === 'PUT');
      expect(putRequest).toBeDefined();
      expect(parseVCard(putRequest.body).uid).toBe(remoteUid);

      const afterEdit = await databaseClient.query(
        'SELECT o.vcard AS mapping_vcard, c.uid AS local_uid FROM carddav_remote_objects o JOIN contacts c ON c.id = o.local_contact_id JOIN address_books b ON b.id = o.address_book_id WHERE b.user_id = $1',
        [seeded.userId],
      );
      expect(parseVCard(afterEdit.rows[0].mapping_vcard).uid).toBe(remoteUid);
      expect(afterEdit.rows[0].local_uid).toBe(local.uid);

      // A subsequent remote delete must only UNLINK an email-merged contact, never
      // remove it — provenance stayed distinct through the edit.
      fixture.reset();
      fixture.deleteContact(href);
      fixture.queueSync('merge-token-1', { events: [{ href, status: 404 }], nextToken: 'merge-token-2' });
      expect(await carddavSync.syncUser(seeded.userId)).toMatchObject({ ok: true });

      const survivor = await databaseClient.query(
        'SELECT display_name, organization FROM contacts WHERE id = $1',
        [localRow.id],
      );
      expect(survivor.rows).toEqual([
        { display_name: 'Merge Person', organization: 'Edited In Mailflow' },
      ]);
    } finally {
      await fixture.close();
    }
  }, 120_000);

  it('keeps the remote UID when keep-mailflow resolves an email-merged conflict, staying locally authoritative', async () => {
    const fixture = createCarddavFixtureServer();
    await fixture.listen();
    try {
      const seeded = await seedConnectedUser(fixture);
      const { rows: [localBook] } = await databaseClient.query(`
        INSERT INTO address_books (user_id, name)
        VALUES ($1, 'Email Merge Conflict Local') RETURNING id
      `, [seeded.userId]);
      const local = {
        uid: 'em-conflict-local',
        displayName: 'Merge Conflict',
        emails: [{ value: 'em-conflict@example.test', type: 'work', primary: true }],
        phones: [], organization: 'Local Co', notes: null, photoData: null,
      };
      const localVcard = generateVCard(local);
      const { rows: [localRow] } = await databaseClient.query(`
        INSERT INTO contacts (
          address_book_id, user_id, uid, vcard, etag, display_name, organization,
          primary_email, emails, phones, additional_fields, is_auto
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,'[]'::jsonb,'[]'::jsonb,false)
        RETURNING id
      `, [
        localBook.id, seeded.userId, local.uid, localVcard,
        createHash('md5').update(localVcard).digest('hex'),
        local.displayName, local.organization, local.emails[0].value,
        JSON.stringify(local.emails),
      ]);

      const remoteUid = 'em-conflict-remote-uid';
      const href = fixture.href('em-conflict.vcf');
      const remoteVcard = [
        'BEGIN:VCARD', 'VERSION:3.0', `UID:${remoteUid}`, 'FN:Merge Conflict',
        'EMAIL:em-conflict@example.test', 'END:VCARD',
      ].join('\n');
      fixture.putContact(href, '"emc-1"', remoteVcard);
      fixture.queueSync('', { events: [{ href, etag: '"emc-1"' }], nextToken: 'emc-token-1' });
      expect(await carddavSync.syncUser(seeded.userId)).toMatchObject({ ok: true });

      // Concurrent local edit + remote edit → sync raises a conflict for this email-merged
      // contact, snapshotting the local vCard that keep-mailflow will push verbatim.
      await databaseClient.query(
        'UPDATE contacts SET organization = $1, updated_at = NOW() WHERE id = $2',
        ['Local Edit', localRow.id],
      );
      const remoteEdit = [
        'BEGIN:VCARD', 'VERSION:3.0', `UID:${remoteUid}`, 'FN:Remote Edit',
        'EMAIL:em-conflict@example.test', 'END:VCARD',
      ].join('\n');
      fixture.putContact(href, '"emc-2"', remoteEdit);
      fixture.queueSync('emc-token-1', { events: [{ href, etag: '"emc-2"' }], nextToken: 'emc-token-2' });
      expect(await carddavSync.syncUser(seeded.userId)).toMatchObject({ ok: true });

      const { rows: [conflict] } = await databaseClient.query(
        `SELECT id FROM carddav_conflicts WHERE user_id = $1 AND href = $2 AND status = 'unresolved'`,
        [seeded.userId, href],
      );
      expect(conflict).toBeDefined();

      // keep-mailflow pushes the snapshot; it must carry the ORIGINAL remote UID.
      fixture.reset();
      fixture.putContact(href, '"emc-2"', remoteEdit);
      await carddavConflictService.resolveConflict(seeded.userId, conflict.id, 'keep-mailflow');

      const putRequest = fixture.requests.find(request => request.method === 'PUT');
      expect(putRequest).toBeDefined();
      expect(parseVCard(putRequest.body).uid).toBe(remoteUid);

      // The mapping keeps the remote UID and the contact keeps its local key, so it
      // remains locally authoritative — a later remote delete only unlinks it.
      const afterResolve = await databaseClient.query(
        'SELECT o.vcard AS mapping_vcard, c.uid AS local_uid FROM carddav_remote_objects o JOIN contacts c ON c.id = o.local_contact_id JOIN address_books b ON b.id = o.address_book_id WHERE b.user_id = $1',
        [seeded.userId],
      );
      expect(parseVCard(afterResolve.rows[0].mapping_vcard).uid).toBe(remoteUid);
      expect(afterResolve.rows[0].local_uid).toBe(local.uid);

      fixture.reset();
      fixture.deleteContact(href);
      fixture.queueSync('emc-token-2', { events: [{ href, status: 404 }], nextToken: 'emc-token-3' });
      expect(await carddavSync.syncUser(seeded.userId)).toMatchObject({ ok: true });
      const survivor = await databaseClient.query('SELECT 1 FROM contacts WHERE id = $1', [localRow.id]);
      expect(survivor.rows).toEqual([{ '?column?': 1 }]);
    } finally {
      await fixture.close();
    }
  }, 120_000);

  it('applies a 507-truncated multi-page sync as one delta and never drops unlisted contacts', async () => {
    const fixture = createCarddavFixtureServer();
    await fixture.listen();
    try {
      const seeded = await seedConnectedUser(fixture);
      // An existing local contact, imported by a first sync, that no later page mentions.
      await seedSingleRemoteContact(fixture, seeded.userId, {
        uid: 'multipage-survivor', name: 'Survivor', token: 'multipage-token-1',
      });

      // A remote delta delivered across TWO pages: page 1 is 507-truncated with a
      // continuation token, page 2 completes it.
      const hrefA = fixture.href('multipage-a.vcf');
      const hrefB = fixture.href('multipage-b.vcf');
      fixture.putContact(hrefA, '"a-1"', remoteVcard('multipage-a', 'Page One'));
      fixture.putContact(hrefB, '"b-1"', remoteVcard('multipage-b', 'Page Two'));
      fixture.queueSync('multipage-token-1', {
        events: [{ href: hrefA, etag: '"a-1"' }],
        nextToken: 'multipage-page-2',
        truncated: true,
      });
      fixture.queueSync('multipage-page-2', {
        events: [{ href: hrefB, etag: '"b-1"' }],
        nextToken: 'multipage-token-final',
      });

      const before507 = fixture.counters.requestUri507;
      expect(await carddavSync.syncUser(seeded.userId)).toMatchObject({ ok: true });

      // The 507-truncated page was actually exercised as one welded delta.
      expect(fixture.counters.requestUri507).toBe(before507 + 1);
      const state = await projectionState(seeded.userId);
      const names = state.contacts.map(contact => contact.display_name).sort();
      // Both pages' contacts imported AND the unlisted survivor is never dropped.
      expect(names).toEqual(['Page One', 'Page Two', 'Survivor']);
      // The remote token advances only once, to the final page's token.
      const book = state.books.find(row => row.source === 'carddav');
      expect(book.remote_sync_token).toBe('multipage-token-final');
    } finally {
      await fixture.close();
    }
  }, 120_000);

  it('retains an owned resolved tombstone for repeat 409 and fixed cleanup', async () => {
    const fixture = createCarddavFixtureServer();
    let apiServer;
    await fixture.listen();
    try {
      const owner = await seedConnectedUser(fixture);
      const foreign = await seedConnectedUser(fixture);
      const seeded = await seedResolutionConflict(fixture, owner.userId, {
        uid: 'retained-tombstone',
        remoteTombstone: true,
      });
      fixture.reset();
      apiServer = await listenConflictApi();
      const origin = `http://127.0.0.1:${apiServer.address().port}`;
      const resolve = userId => fetch(
        `${origin}/conflicts/${seeded.conflictId}/resolve`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Test-User-Id': userId,
          },
          body: JSON.stringify({ resolution: 'keep-carddav' }),
        },
      );

      const first = await resolve(owner.userId);
      expect(first.status).toBe(200);
      expect(await first.json()).toMatchObject({
        id: seeded.conflictId,
        status: 'resolved',
        resolution: 'keep-carddav',
        remote: { tombstone: true },
      });
      expect(fixture.counters).toMatchObject({ fetch: 1, update: 0, delete: 0 });

      const { rows: [retained] } = await databaseClient.query(`
        SELECT conflict.status, conflict.resolution,
               conflict.resolved_at IS NOT NULL AS resolved,
               mapping.href AS mapping_href, contact.id AS contact_id
        FROM carddav_conflicts conflict
        LEFT JOIN carddav_remote_objects mapping
          ON mapping.address_book_id = conflict.address_book_id
         AND mapping.href = conflict.href
        LEFT JOIN contacts contact ON contact.id = $2
        WHERE conflict.id = $1
      `, [seeded.conflictId, seeded.local_contact_id]);
      expect(retained).toEqual({
        status: 'resolved',
        resolution: 'keep-carddav',
        resolved: true,
        mapping_href: null,
        contact_id: null,
      });

      const detail = await fetch(`${origin}/conflicts/${seeded.conflictId}`, {
        headers: { 'X-Test-User-Id': owner.userId },
      });
      expect(detail.status).toBe(200);
      expect(await detail.json()).toMatchObject({
        id: seeded.conflictId,
        status: 'resolved',
      });
      expect((await resolve(foreign.userId)).status).toBe(404);
      expect((await resolve(owner.userId)).status).toBe(409);

      await carddavConflictService.deleteResolvedConflictsBefore(
        databaseClient,
        new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      );
      const recent = await databaseClient.query(
        'SELECT id FROM carddav_conflicts WHERE id = $1',
        [seeded.conflictId],
      );
      expect(recent.rowCount).toBe(1);
      await databaseClient.query(
        "UPDATE carddav_conflicts SET resolved_at = NOW() - INTERVAL '31 days' WHERE id = $1",
        [seeded.conflictId],
      );
      await carddavConflictService.deleteResolvedConflictsBefore(
        databaseClient,
        new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      );
      const expired = await databaseClient.query(
        'SELECT id FROM carddav_conflicts WHERE id = $1',
        [seeded.conflictId],
      );
      expect(expired.rowCount).toBe(0);
    } finally {
      if (apiServer) await closeServer(apiServer);
      await fixture.close();
    }
  }, 120_000);

  it('retains an aged unresolved conflict through the resolved-only cleanup', async () => {
    const fixture = createCarddavFixtureServer();
    await fixture.listen();
    try {
      const seededUser = await seedConnectedUser(fixture);
      const seeded = await seedResolutionConflict(fixture, seededUser.userId, {
        uid: 'aged-unresolved',
        remoteCard: remoteVcard('aged-unresolved', 'Aged Unresolved Remote'),
      });
      // Age the still-unresolved conflict well past the 30-day retention window;
      // it must survive because the cleanup only deletes resolved rows.
      await databaseClient.query(`
        UPDATE carddav_conflicts
        SET created_at = NOW() - INTERVAL '60 days', updated_at = NOW() - INTERVAL '60 days'
        WHERE id = $1
      `, [seeded.conflictId]);

      await carddavConflictService.deleteResolvedConflictsBefore(
        databaseClient,
        new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      );

      const { rows } = await databaseClient.query(
        'SELECT status, resolved_at FROM carddav_conflicts WHERE id = $1',
        [seeded.conflictId],
      );
      expect(rows).toEqual([{ status: 'unresolved', resolved_at: null }]);
    } finally {
      await fixture.close();
    }
  }, 120_000);

  it('reports URI PHOTO presence through the real conflict request boundary', async () => {
    const fixture = createCarddavFixtureServer();
    let apiServer;
    await fixture.listen();
    try {
      const seededUser = await seedConnectedUser(fixture);
      const uri = 'https://images.example.test/private.jpg';
      const remoteCard = remotePhotoVcard(
        'uri-photo-conflict',
        'URI Photo Conflict',
        'uri-photo@example.test',
        `PHOTO;VALUE=URI:${uri}`,
      );
      const seeded = await seedResolutionConflict(fixture, seededUser.userId, {
        uid: 'uri-photo-conflict',
        remoteCard,
      });
      apiServer = await listenConflictApi();
      const response = await fetch(
        `http://127.0.0.1:${apiServer.address().port}/conflicts/${seeded.conflictId}`,
        { headers: { 'X-Test-User-Id': seededUser.userId } },
      );
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(JSON.parse(body)).toMatchObject({
        id: seeded.conflictId,
        remote: { tombstone: false, hasPhoto: true },
      });
      expect(body).not.toContain(uri);
      expect(body).not.toContain('BEGIN:VCARD');
    } finally {
      if (apiServer) await closeServer(apiServer);
      await fixture.close();
    }
  }, 120_000);

  it('rolls back contact and mapping state when the conflict transition loses its CAS', async () => {
    const fixture = createCarddavFixtureServer();
    let apiServer;
    await fixture.listen();
    try {
      const seededUser = await seedConnectedUser(fixture);
      const remoteCard = remoteVcard('resolution-cas', 'Resolution CAS Remote');
      const seeded = await seedResolutionConflict(fixture, seededUser.userId, {
        uid: 'resolution-cas',
        remoteCard,
      });
      await databaseClient.query(`
        CREATE FUNCTION force_conflict_resolution_cas_miss() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          RETURN NULL;
        END;
        $$
      `);
      await databaseClient.query(`
        CREATE TRIGGER force_conflict_resolution_cas_miss
        BEFORE UPDATE OF status ON carddav_conflicts
        FOR EACH ROW
        WHEN (OLD.status = 'unresolved' AND NEW.status = 'resolved')
        EXECUTE FUNCTION force_conflict_resolution_cas_miss()
      `);
      fixture.reset();
      apiServer = await listenConflictApi();
      const response = await fetch(
        `http://127.0.0.1:${apiServer.address().port}/conflicts/${seeded.conflictId}/resolve`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Test-User-Id': seededUser.userId,
          },
          body: JSON.stringify({ resolution: 'keep-carddav' }),
        },
      );

      expect(response.status).toBe(409);
      const { rows: [state] } = await databaseClient.query(`
        SELECT mapping.mapping_revision::text, mapping.mapping_status,
               conflict.status, conflict.resolution, conflict.resolved_at,
               contact.display_name
        FROM carddav_remote_objects mapping
        JOIN carddav_conflicts conflict
          ON conflict.address_book_id = mapping.address_book_id
         AND conflict.href = mapping.href
        JOIN contacts contact ON contact.id = mapping.local_contact_id
        WHERE conflict.id = $1
      `, [seeded.conflictId]);
      expect(state).toEqual({
        mapping_revision: seeded.mappingRevision,
        mapping_status: 'conflict',
        status: 'unresolved',
        resolution: null,
        resolved_at: null,
        display_name: seeded.local_display_name,
      });
      expect(fixture.counters).toMatchObject({ fetch: 1, update: 0, delete: 0 });
    } finally {
      await databaseClient.query(
        'DROP TRIGGER IF EXISTS force_conflict_resolution_cas_miss ON carddav_conflicts',
      );
      await databaseClient.query('DROP FUNCTION IF EXISTS force_conflict_resolution_cas_miss()');
      if (apiServer) await closeServer(apiServer);
      await fixture.close();
    }
  }, 120_000);

  it('recovers old pending update and delete intents after restart without replaying writes', async () => {
    const fixture = createCarddavFixtureServer();
    await fixture.listen();
    const seeded = await seedConnectedUser(fixture);
    const initial = await seedSingleRemoteContact(fixture, seeded.userId, {
      uid: 'restart-recovery',
      name: 'Before Restart',
      token: 'restart-recovery-1',
    });
    const { rows: [before] } = await databaseClient.query(`
      SELECT o.address_book_id, o.href, o.local_contact_id,
             o.local_contact_hash, o.mapping_revision::text,
             c.uid
      FROM carddav_remote_objects o
      JOIN contacts c ON c.id = o.local_contact_id
      WHERE c.user_id = $1 AND o.href = $2
    `, [seeded.userId, initial.href]);
    const attemptedVCard = remoteVcard(
      before.uid,
      'Recovered After Restart',
      'restart-recovery@example.test',
    );
    fixture.putContact(initial.href, '"restart-recovery-2"', attemptedVCard);
    await databaseClient.query(`
      UPDATE carddav_remote_objects SET
        mapping_status = 'pending_push',
        pending_operation = 'update', pending_vcard = $1,
        pending_local_hash = $2, pending_remote_semantic_hash = $3,
        pending_started_at = '2000-01-01T00:00:00Z',
        mapping_revision = mapping_revision + 1
      WHERE address_book_id = $4 AND href = $5
    `, [
      attemptedVCard,
      before.local_contact_hash,
      semanticVCardHash(parseVCardDocument(attemptedVCard)),
      before.address_book_id,
      before.href,
    ]);

    fixture.reset();
    fixture.queueSync('restart-recovery-1', {
      events: [],
      nextToken: 'restart-recovery-2',
    });
    await expect(carddavSync.syncUser(seeded.userId)).resolves.toMatchObject({ ok: true });

    expect(fixture.requests.filter(request => request.method === 'PUT')).toHaveLength(0);
    expect(fixture.requests.filter(request => request.method === 'DELETE')).toHaveLength(0);
    expect(fixture.requests.filter(request => request.method === 'GET')).toHaveLength(1);
    const { rows: [updated] } = await databaseClient.query(`
      SELECT o.mapping_status, o.pending_operation, o.pending_vcard,
             o.pending_local_hash, o.pending_remote_semantic_hash,
             o.pending_started_at, o.local_contact_hash,
             c.display_name
      FROM carddav_remote_objects o
      JOIN contacts c ON c.id = o.local_contact_id
      WHERE c.user_id = $1 AND o.href = $2
    `, [seeded.userId, initial.href]);
    expect(updated).toMatchObject({
      mapping_status: 'synced',
      pending_operation: null,
      pending_vcard: null,
      pending_local_hash: null,
      pending_remote_semantic_hash: null,
      pending_started_at: null,
      display_name: 'Recovered After Restart',
    });

    await databaseClient.query(`
      UPDATE carddav_remote_objects SET
        mapping_status = 'pending_push',
        pending_operation = 'delete', pending_vcard = NULL,
        pending_local_hash = $1, pending_remote_semantic_hash = NULL,
        pending_started_at = '2000-01-01T00:00:00Z',
        mapping_revision = mapping_revision + 1
      WHERE address_book_id = $2 AND href = $3
    `, [updated.local_contact_hash, before.address_book_id, before.href]);
    fixture.deleteContact(initial.href);
    fixture.reset();
    fixture.queueSync('restart-recovery-2', {
      events: [],
      nextToken: 'restart-recovery-3',
    });

    await expect(carddavSync.syncUser(seeded.userId)).resolves.toMatchObject({ ok: true });

    expect(fixture.requests.filter(request => request.method === 'PUT')).toHaveLength(0);
    expect(fixture.requests.filter(request => request.method === 'DELETE')).toHaveLength(0);
    expect(fixture.requests.filter(request => request.method === 'GET')).toHaveLength(1);
    const { rows: [deleted] } = await databaseClient.query(`
      SELECT
        (SELECT COUNT(*)::int FROM carddav_remote_objects
         WHERE address_book_id = $1 AND href = $2) AS mappings,
        (SELECT COUNT(*)::int FROM contacts
         WHERE user_id = $3 AND id = $4) AS contacts
    `, [before.address_book_id, before.href, seeded.userId, before.local_contact_id]);
    expect(deleted).toEqual({ mappings: 0, contacts: 0 });
    await fixture.close();
  }, 120_000);

  it('preserves the visible count across a same-identity password replacement and no-change delta', async () => {
    const fixture = createCarddavFixtureServer();
    await fixture.listen();
    const seeded = await seedConnectedUser(fixture);
    const contact = await seedSingleRemoteContact(fixture, seeded.userId, {
      uid: 'password-count',
      name: 'Password Count',
      token: 'password-count-1',
    });

    const replacement = await carddavSync.replaceCarddavConnection(seeded.userId, {
      serverUrl: fixture.serverUrl,
      username: 'fixture-user',
      password: encrypt('replacement-password'),
      intervalMin: 60,
    });
    fixture.reset();
    fixture.queueSync(contact.token, { events: [], nextToken: 'password-count-2' });

    const result = await carddavSync.syncUser(seeded.userId);
    const state = await projectionState(seeded.userId);
    const [integration] = await integrationState(seeded.userId);

    expect(result).toMatchObject({ ok: true, contactCount: 1 });
    expect(state.contacts).toHaveLength(1);
    expect(state.ledger).toHaveLength(1);
    expect(integration.config).toMatchObject({
      connectionGeneration: replacement.connectionGeneration,
      contactCount: 1,
    });
    await fixture.close();
  }, 120_000);

  it('keeps the cached count aligned when one book commits before the next book fails', async () => {
    const fixture = createCarddavFixtureServer();
    await fixture.listen();
    const seeded = await seedConnectedUser(fixture);
    const twoBooks = await seedTwoRemoteBooks(fixture, seeded.userId);
    const changedCardB = remoteVcard('person-b', 'Person B Changed');
    fixture.deleteContact(twoBooks.hrefA);
    fixture.putContact(twoBooks.hrefB, '"person-b-2"', changedCardB);
    fixture.reset();
    fixture.queueDiscovery({ books: [
      { href: twoBooks.bookAPath, displayName: 'Contacts A' },
      { href: twoBooks.bookBPath, displayName: 'Contacts B' },
    ] });
    fixture.queueSync('two-book-a-1', {
      events: [{ href: twoBooks.hrefA, status: 404 }],
      nextToken: 'two-book-a-2',
    });
    fixture.queueSync('two-book-b-1', {
      events: [{ href: twoBooks.hrefB, etag: '"person-b-2"' }],
      nextToken: 'two-book-b-2',
    });
    await databaseClient.query(`
      CREATE FUNCTION fail_second_count_book() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.id = '${twoBooks.bookB.id}'::uuid THEN
          RAISE EXCEPTION 'forced second count book failure';
        END IF;
        RETURN NEW;
      END
      $$
    `);
    await databaseClient.query(`
      CREATE TRIGGER fail_second_count_book
      BEFORE UPDATE ON address_books
      FOR EACH ROW EXECUTE FUNCTION fail_second_count_book()
    `);

    const failed = await carddavSync.syncUser(seeded.userId);
    await databaseClient.query('DROP TRIGGER fail_second_count_book ON address_books');
    await databaseClient.query('DROP FUNCTION fail_second_count_book()');
    const failedState = await projectionState(seeded.userId);
    const [failedIntegration] = await integrationState(seeded.userId);

    expect(failed).toMatchObject({
      ok: false,
      error: 'forced second count book failure',
    });
    expect(failedState.contacts).toHaveLength(1);
    expect(failedState.ledger).toHaveLength(1);
    expect(failedIntegration.config.contactCount).toBe(1);

    fixture.reset();
    fixture.queueDiscovery({ books: [
      { href: twoBooks.bookAPath, displayName: 'Contacts A' },
      { href: twoBooks.bookBPath, displayName: 'Contacts B' },
    ] });
    fixture.queueSync('two-book-a-2', { events: [], nextToken: 'two-book-a-3' });
    fixture.queueSync('two-book-b-1', {
      events: [{ href: twoBooks.hrefB, etag: '"person-b-2"' }],
      nextToken: 'two-book-b-2',
    });

    const retried = await carddavSync.syncUser(seeded.userId);
    const retriedState = await projectionState(seeded.userId);
    const [retriedIntegration] = await integrationState(seeded.userId);

    expect(retried).toMatchObject({ ok: true, contactCount: 1 });
    expect(retriedState.contacts).toHaveLength(1);
    expect(retriedState.ledger).toHaveLength(1);
    expect(retriedIntegration.config.contactCount).toBe(1);
    await fixture.close();
  }, 120_000);

  it('returns the authoritative count after retaining one discovered book and pruning another', async () => {
    const fixture = createCarddavFixtureServer();
    await fixture.listen();
    const seeded = await seedConnectedUser(fixture);
    const twoBooks = await seedTwoRemoteBooks(fixture, seeded.userId);
    fixture.reset();
    fixture.queueDiscovery({ books: [
      { href: twoBooks.bookAPath, displayName: 'Contacts A' },
    ] });
    fixture.queueSync('two-book-a-1', { events: [], nextToken: 'two-book-a-2' });

    const result = await carddavSync.syncUser(seeded.userId);
    const state = await projectionState(seeded.userId);
    const [integration] = await integrationState(seeded.userId);

    expect(result).toMatchObject({ ok: true, bookCount: 1, contactCount: 1 });
    expect(state.books.filter(book => book.source === 'carddav')).toHaveLength(1);
    expect(state.contacts).toHaveLength(1);
    expect(state.ledger).toHaveLength(1);
    expect(integration.config.contactCount).toBe(1);
    await fixture.close();
  }, 120_000);

  it('snapshot discovery without sync-collection sends exactly one CardDAV filter', async () => {
    const fixture = createCarddavFixtureServer();
    await fixture.listen();
    const seeded = await seedConnectedUser(fixture);
    const href = fixture.href('snapshot-only.vcf');
    const card = remoteVcard('snapshot-only', 'Snapshot Only');
    fixture.putContact(href, '"snapshot-only-1"', card);
    fixture.queueDiscovery({ books: [{
      href: '/addressbooks/fixture-user/contacts/',
      displayName: 'Snapshot Only',
      reports: false,
    }] });

    expect(await carddavSync.syncUser(seeded.userId)).toEqual({
      ok: true,
      bookCount: 1,
      contactCount: 1,
      remote: 1,
      fetched: 1,
      updated: 1,
      removed: 0,
      fallback: 1,
      exportFailures: [],
    });
    const state = await projectionState(seeded.userId);
    expect(state.books).toHaveLength(1);
    expect(state.books[0]).toMatchObject({
      source: 'carddav',
      remote_sync_token: null,
      remote_sync_capability: 'snapshot',
      remote_sync_revision: '1',
    });
    expect(state.contacts).toHaveLength(1);
    expect(state.contacts[0].primary_email).toBe('snapshot-only@example.test');
    expect(state.ledger).toHaveLength(1);
    expect(fixture.counters).toMatchObject({
      requests: 4,
      propfind: 3,
      sync: 0,
      multiget: 0,
      addressbookQuery: 1,
      snapshotFilters: [1],
    });
    await fixture.close();
  }, 120_000);

  it('valid empty discovery prunes projection while malformed empty discovery changes only status', async () => {
    const emptyFixture = createCarddavFixtureServer();
    await emptyFixture.listen();
    const emptySeeded = await seedConnectedUser(emptyFixture);
    await seedSingleRemoteContact(emptyFixture, emptySeeded.userId);
    const unrelatedBook = await databaseClient.query(`
      INSERT INTO address_books (user_id, name)
      VALUES ($1, 'Empty Discovery Unrelated') RETURNING id, sync_token
    `, [emptySeeded.userId]);
    emptyFixture.reset();
    emptyFixture.queueDiscovery({ books: [] });

    expect(await carddavSync.syncUser(emptySeeded.userId)).toEqual({
      ok: true,
      bookCount: 0,
      contactCount: 0,
      remote: 0,
      fetched: 0,
      updated: 0,
      removed: 0,
      fallback: 0,
      exportFailures: [],
    });
    expect(await projectionState(emptySeeded.userId)).toEqual({
      books: [{
        id: unrelatedBook.rows[0].id,
        source: 'local',
        external_url: null,
        sync_token: unrelatedBook.rows[0].sync_token,
        remote_sync_token: null,
        remote_sync_capability: 'unknown',
        remote_sync_revision: '0',
        remote_projection_fingerprint: null,
      }],
      contacts: [],
      ledger: [],
    });
    const [emptyIntegration] = await integrationState(emptySeeded.userId);
    expect(emptyIntegration.config).toEqual({
      ...emptySeeded.config,
      lastError: null,
      lastSyncAt: expect.any(String),
      bookCount: 0,
      contactCount: 0,
      exportFailures: [],
    });
    expect(emptyFixture.counters).toMatchObject({
      requests: 3,
      propfind: 3,
      sync: 0,
      multiget: 0,
      addressbookQuery: 0,
    });
    await emptyFixture.close();

    const malformedFixture = createCarddavFixtureServer();
    await malformedFixture.listen();
    const malformedSeeded = await seedConnectedUser(malformedFixture);
    await seedSingleRemoteContact(malformedFixture, malformedSeeded.userId);
    const malformedBefore = await projectionState(malformedSeeded.userId, { timestamps: true });
    malformedFixture.reset();
    malformedFixture.queueDiscovery({
      rawBody: '<?xml version="1.0"?><D:multistatus xmlns:D="DAV:"></D:multistatus>',
    });

    const malformed = await carddavSync.syncUser(malformedSeeded.userId);

    expect(malformed.ok).toBe(false);
    expect(malformed.error).toMatch(/home collection|home-set|multistatus/i);
    expect(await projectionState(malformedSeeded.userId, { timestamps: true }))
      .toEqual(malformedBefore);
    const [malformedIntegration] = await integrationState(malformedSeeded.userId);
    expect(malformedIntegration.config).toEqual({
      ...malformedSeeded.config,
      lastError: malformed.error,
      lastSyncAt: expect.any(String),
      bookCount: 1,
      contactCount: 1,
      exportFailures: [],
    });
    expect(malformedFixture.counters).toMatchObject({
      requests: 3,
      propfind: 3,
      sync: 0,
      multiget: 0,
      addressbookQuery: 0,
    });
    await malformedFixture.close();
  }, 120_000);

  it('duplicate discovery aliases collapse once and conflicting duplicate metadata performs no plan', async () => {
    const fixture = createCarddavFixtureServer();
    await fixture.listen();
    const seeded = await seedConnectedUser(fixture);
    fixture.queueDiscovery({ books: [
      { href: '/addressbooks/fixture-user/contacts/', displayName: 'Fixture Contacts' },
      { href: '/addressbooks/fixture-user/contacts/./', displayName: 'Fixture Contacts' },
    ] });
    fixture.queueSync('', { events: [], nextToken: 'duplicate-token' });

    expect(await carddavSync.syncUser(seeded.userId)).toEqual({
      ok: true,
      bookCount: 1,
      contactCount: 0,
      remote: 0,
      fetched: 0,
      updated: 0,
      removed: 0,
      fallback: 0,
      exportFailures: [],
    });
    const duplicateState = await projectionState(seeded.userId);
    expect(duplicateState.books).toHaveLength(1);
    expect(duplicateState.books[0]).toMatchObject({
      source: 'carddav',
      external_url: fixture.href(''),
      remote_sync_token: 'duplicate-token',
      remote_sync_revision: '1',
    });
    expect(duplicateState.contacts).toEqual([]);
    expect(duplicateState.ledger).toEqual([]);
    expect(fixture.counters).toMatchObject({
      requests: 4,
      propfind: 3,
      sync: 1,
      multiget: 0,
      syncTokens: [''],
    });
    await fixture.close();

    const conflictFixture = createCarddavFixtureServer();
    await conflictFixture.listen();
    const conflictSeeded = await seedConnectedUser(conflictFixture);
    await seedSingleRemoteContact(conflictFixture, conflictSeeded.userId);
    const before = await projectionState(conflictSeeded.userId, { timestamps: true });
    conflictFixture.reset();
    conflictFixture.queueDiscovery({ books: [
      { href: '/addressbooks/fixture-user/contacts/', displayName: 'First Name' },
      { href: '/addressbooks/fixture-user/contacts/./', displayName: 'Conflicting Name' },
    ] });

    const conflict = await carddavSync.syncUser(conflictSeeded.userId);

    expect(conflict.ok).toBe(false);
    expect(conflict.error).toMatch(/conflicting.*metadata|metadata.*conflict/i);
    expect(await projectionState(conflictSeeded.userId, { timestamps: true })).toEqual(before);
    expect(conflictFixture.counters).toMatchObject({
      requests: 3,
      propfind: 3,
      sync: 0,
      multiget: 0,
    });
    await conflictFixture.close();
  }, 120_000);

  it('alias redirect performs full reconciliation and preserves the production book identity', async () => {
    const fixture = createCarddavFixtureServer();
    await fixture.listen();
    const seeded = await seedConnectedUser(fixture);
    const aliasPath = '/addressbooks/fixture-user/alias/';
    const canonicalPath = '/addressbooks/fixture-user/canonical/';
    const aliasUrl = new URL(aliasPath, fixture.serverUrl).href;
    const canonicalUrl = new URL(canonicalPath, fixture.serverUrl).href;
    const aliasHref = new URL('person.vcf', aliasUrl).href;
    const canonicalHref = new URL('person.vcf', canonicalUrl).href;
    const card = remoteVcard('alias-person', 'Alias Person');
    fixture.queueDiscovery({ books: [{ href: aliasPath, displayName: 'Alias Book' }] });
    fixture.putContact(aliasHref, '"alias-1"', card);
    fixture.queueSync('', {
      events: [{ href: aliasHref, etag: '"alias-1"' }],
      nextToken: 'alias-token',
    });
    expect(await carddavSync.syncUser(seeded.userId)).toMatchObject({ ok: true });
    const before = await projectionState(seeded.userId);
    const beforeBook = before.books.find(row => row.source === 'carddav');
    expect(beforeBook.external_url).toBe(aliasUrl);

    fixture.deleteContact(aliasHref);
    fixture.putContact(canonicalHref, '"canonical-1"', card);
    fixture.reset();
    fixture.queueDiscovery({ books: [{ href: aliasPath, displayName: 'Alias Book' }] });
    fixture.queueRedirect('REPORT', aliasPath, canonicalPath);
    fixture.queueSync('alias-token', { events: [], nextToken: 'redirect-intermediate' });
    fixture.queueSync('', {
      events: [{ rawHref: 'person.vcf', etag: '"canonical-1"' }],
      nextToken: 'canonical-token',
    });

    expect(await carddavSync.syncUser(seeded.userId)).toMatchObject({
      ok: true, bookCount: 1, contactCount: 1, fallback: 1,
    });
    const after = await projectionState(seeded.userId);
    const afterBook = after.books[0];
    expect(after.books).toEqual([{
      ...beforeBook,
      external_url: canonicalUrl,
      sync_token: afterBook.sync_token,
      remote_sync_token: 'canonical-token',
      remote_sync_revision: '2',
    }]);
    expect(afterBook.sync_token).not.toBe(beforeBook.sync_token);
    expect(after.contacts).toHaveLength(1);
    const afterContact = after.contacts[0];
    expect(afterContact).toEqual(expectedLocalContact(
      canonicalHref, card, beforeBook.id, seeded.userId, afterContact.id,
    ));
    expect(after.ledger).toEqual([{
      address_book_id: beforeBook.id,
      href: canonicalHref,
      remote_etag: '"canonical-1"',
      vcard: card,
      primary_email: 'alias-person@example.test',
      local_contact_id: afterContact.id,
    }]);
    expect(fixture.requests.map(request => `${request.method} ${request.path}`)).toEqual([
      'PROPFIND /',
      'PROPFIND /principals/fixture-user/',
      'PROPFIND /addressbooks/fixture-user/',
      `REPORT ${aliasPath}`,
      `REPORT ${canonicalPath}`,
      `REPORT ${canonicalPath}`,
      `REPORT ${canonicalPath}`,
    ]);
    expect(fixture.counters).toMatchObject({
      requests: 7,
      propfind: 3,
      sync: 2,
      multiget: 1,
      syncTokens: ['alias-token', ''],
      multigetSizes: [1],
    });
    await fixture.close();
  }, 120_000);

  it('disconnect during paused planning restores merges and prevents old work from recreating projection', async () => {
    const fixture = createCarddavFixtureServer();
    await fixture.listen();
    const seeded = await seedConnectedUser(fixture);
    const { rows: [localBook] } = await databaseClient.query(`
      INSERT INTO address_books (user_id, name)
      VALUES ($1, 'Disconnect Local') RETURNING id, sync_token
    `, [seeded.userId]);
    const localContact = {
      uid: 'disconnect-local',
      displayName: 'Disconnect Original',
      firstName: 'Disconnect',
      lastName: 'Original',
      emails: [{ value: 'disconnect@example.test', type: 'other', primary: true }],
      phones: [],
      organization: null,
      notes: null,
      photoData: null,
    };
    const localVcard = generateVCard(localContact);
    const { rows: [insertedContact] } = await databaseClient.query(`
      INSERT INTO contacts (
        address_book_id, user_id, uid, vcard, etag, display_name, first_name,
        last_name, primary_email, emails, phones, organization, notes, photo_data
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, '[]'::jsonb, NULL, NULL, NULL
      ) RETURNING id
    `, [
      localBook.id,
      seeded.userId,
      localContact.uid,
      localVcard,
      createHash('md5').update(localVcard).digest('hex'),
      localContact.displayName,
      localContact.firstName,
      localContact.lastName,
      localContact.emails[0].value,
      JSON.stringify(localContact.emails),
    ]);
    const href = fixture.href('disconnect.vcf');
    const remoteCard = remoteVcard('disconnect-remote', 'Disconnect Remote', 'disconnect@example.test');
    fixture.putContact(href, '"disconnect-1"', remoteCard);
    fixture.queueSync('', {
      events: [{ href, etag: '"disconnect-1"' }],
      nextToken: 'disconnect-token',
    });
    expect(await carddavSync.syncUser(seeded.userId)).toMatchObject({
      ok: true,
    });
    const linked = await projectionState(seeded.userId);
    expect(linked.ledger[0].local_contact_id).toBe(insertedContact.id);
    expect(linked.contacts.find(row => row.id === insertedContact.id).display_name)
      .toBe('Disconnect Original');

    const barrier = deferred();
    const reached = deferred();
    fixture.reset();
    fixture.queueSync('disconnect-token', {
      events: [],
      nextToken: 'old-disconnect-plan',
      waitFor: barrier.promise,
      reached: reached.resolve,
    });
    const pending = carddavSync.syncUser(seeded.userId);
    await reached.promise;
    expect(await carddavSync.disconnectCarddavAccount(seeded.userId)).toBe(true);
    const disconnected = await projectionState(seeded.userId);
    expect(disconnected.books).toEqual([{
      id: localBook.id,
      source: 'local',
      external_url: null,
      sync_token: disconnected.books[0].sync_token,
      remote_sync_token: null,
      remote_sync_capability: 'unknown',
      remote_sync_revision: '0',
      remote_projection_fingerprint: null,
    }]);
    expect(disconnected.books[0].sync_token).toBe(localBook.sync_token);
    expect(disconnected.contacts).toEqual([{
      id: insertedContact.id,
      address_book_id: localBook.id,
      user_id: seeded.userId,
      uid: localContact.uid,
      vcard: localVcard,
      etag: createHash('md5').update(localVcard).digest('hex'),
      display_name: localContact.displayName,
      first_name: localContact.firstName,
      last_name: localContact.lastName,
      primary_email: localContact.emails[0].value,
      emails: localContact.emails,
      phones: [],
      organization: null,
      notes: null,
      photo_data: null,
    }]);
    expect(disconnected.ledger).toEqual([]);
    expect(await integrationState(seeded.userId)).toEqual([]);
    barrier.resolve();

    expect(await pending).toMatchObject({ ok: false });
    expect(await projectionState(seeded.userId)).toEqual(disconnected);
    expect(await integrationState(seeded.userId)).toEqual([]);
    expect(fixture.counters).toMatchObject({
      requests: 4,
      propfind: 3,
      sync: 1,
      multiget: 0,
      syncTokens: ['disconnect-token'],
      multigetSizes: [],
    });
    await fixture.close();
  }, 120_000);

  it('photo-only sync persists bytes and production CardDAV GET and REPORT expose the same vCard and ETag', async () => {
    const fixture = createCarddavFixtureServer();
    await fixture.listen();
    const seeded = await seedConnectedUser(fixture);
    const href = fixture.href('photo.vcf');
    const jpegCard = remotePhotoVcard(
      'photo', 'Photo Contact', 'photo@example.test', 'PHOTO;ENCODING=b;TYPE=JPEG:AQID',
    );
    fixture.putContact(href, '"photo-1"', jpegCard);
    fixture.queueSync('', {
      events: [{ href, etag: '"photo-1"' }],
      nextToken: 'photo-token-1',
    });
    expect(await carddavSync.syncUser(seeded.userId)).toMatchObject({ ok: true, updated: 1 });
    const jpegState = await projectionState(seeded.userId);
    const jpegBook = jpegState.books.find(row => row.source === 'carddav');
    expect(jpegState.contacts[0].photo_data).toBe('data:image/jpeg;base64,AQID');
    expect(jpegState.contacts[0].vcard).toContain('PHOTO;ENCODING=b;TYPE=JPEG:AQID\r\n');

    const pngCard = remotePhotoVcard(
      'photo', 'Photo Contact', 'photo@example.test', 'PHOTO;ENCODING=b;TYPE=PNG:BAUG',
    );
    fixture.putContact(href, '"photo-2"', pngCard);
    fixture.reset();
    fixture.queueSync('photo-token-1', {
      events: [{ href, etag: '"photo-2"' }],
      nextToken: 'photo-token-2',
    });
    expect(await carddavSync.syncUser(seeded.userId)).toMatchObject({ ok: true, updated: 1 });
    const pngState = await projectionState(seeded.userId);
    const pngBook = pngState.books.find(row => row.id === jpegBook.id);
    const pngContact = pngState.contacts[0];
    expect(pngContact.photo_data).toBe('data:image/png;base64,BAUG');
    expect(pngContact.vcard).toContain('PHOTO;ENCODING=b;TYPE=PNG:BAUG\r\n');
    expect(pngContact.etag).toBe(createHash('md5').update(pngContact.vcard).digest('hex'));
    expect(pngContact.etag).not.toBe(jpegState.contacts[0].etag);
    expect(pngBook.sync_token).not.toBe(jpegBook.sync_token);

    await databaseClient.query(
      'UPDATE users SET password_hash = $2 WHERE id = $1',
      [seeded.userId, await bcrypt.hash('carddav-output-password', 4)],
    );
    const app = express();
    const { default: carddavRouter } = await import('../routes/carddav.js');
    app.use('/carddav', carddavRouter);
    const outputServer = await listenOnLocalhost(app);
    const outputOrigin = `http://127.0.0.1:${outputServer.address().port}`;
    const authorization = `Basic ${Buffer.from(
      `carddav-e2e-${seeded.userId}:carddav-output-password`,
    ).toString('base64')}`;
    const cardPath = `/carddav/${seeded.userId}/${pngBook.id}/${encodeURIComponent(pngContact.uid)}.vcf`;
    // The CardDAV server serves the retained remote document overlaid with the local
    // contact (presentedVCard), so the photo round-trips losslessly. The ETag stays
    // the local contacts.etag.
    const { rows: [pngRow] } = await databaseClient.query(`
      SELECT c.uid, c.display_name, c.first_name, c.last_name, c.emails, c.phones,
             c.organization, c.notes, c.photo_data, c.additional_fields, c.vcard,
             mapping.vcard AS mapping_vcard
      FROM contacts c
      LEFT JOIN carddav_remote_objects mapping
        ON mapping.local_contact_id = c.id
       AND mapping.mapping_status <> 'pending_materialization'
      WHERE c.id = $1
    `, [pngContact.id]);
    const presentedPng = presentedVCard(pngRow);
    const servedEtag = `"${presentedEtag(pngRow)}"`;
    expect(presentedPng).toContain('PHOTO;ENCODING=b;TYPE=PNG:BAUG');
    const getResponse = await fetch(`${outputOrigin}${cardPath}`, {
      headers: { Authorization: authorization },
    });
    expect(getResponse.status).toBe(200);
    // The served ETag derives from the presented document.
    expect(getResponse.headers.get('etag')).toBe(servedEtag);
    expect(await getResponse.text()).toBe(presentedPng);
    const reportResponse = await fetch(
      `${outputOrigin}/carddav/${seeded.userId}/${pngBook.id}/`,
      {
        method: 'REPORT',
        headers: {
          Authorization: authorization,
          Depth: '1',
          'Content-Type': 'application/xml',
        },
        body: '<?xml version="1.0"?><C:addressbook-query xmlns:C="urn:ietf:params:xml:ns:carddav"/>',
      },
    );
    expect(reportResponse.status).toBe(207);
    const reportBody = await reportResponse.text();
    expect(reportBody).toContain(servedEtag);
    expect(reportBody).toContain(presentedPng
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;'));
    await closeServer(outputServer);

    fixture.reset();
    fixture.queueSync('photo-token-2', {
      events: [{ href, etag: '"photo-2"' }],
      nextToken: 'photo-token-3',
    });
    expect(await carddavSync.syncUser(seeded.userId)).toMatchObject({ ok: true, updated: 0 });
    const noOp = await projectionState(seeded.userId);
    expect(noOp.books.find(row => row.id === pngBook.id)).toMatchObject({
      sync_token: pngBook.sync_token,
      remote_sync_revision: '3',
      remote_sync_token: 'photo-token-3',
    });
    expect(noOp.contacts).toEqual(pngState.contacts);

    const externalCard = remotePhotoVcard(
      'photo', 'Photo Contact', 'photo@example.test',
      'PHOTO;VALUE=URI:https://images.example.test/private.jpg',
    );
    fixture.putContact(href, '"photo-3"', externalCard);
    fixture.reset();
    fixture.queueSync('photo-token-3', {
      events: [{ href, etag: '"photo-3"' }],
      nextToken: 'photo-token-4',
    });
    expect(await carddavSync.syncUser(seeded.userId)).toMatchObject({ ok: true, updated: 1 });
    const external = await projectionState(seeded.userId);
    expect(external.contacts[0].photo_data).toBeNull();
    expect(external.contacts[0].vcard).not.toContain('PHOTO');
    expect(external.books[0].sync_token).not.toBe(pngBook.sync_token);
    await fixture.close();
  }, 120_000);

  it('gates and merges a mapped PUT through the real CardDAV server route', async () => {
    const fixture = createCarddavFixtureServer();
    let outputServer;
    await fixture.listen();
    try {
      const seeded = await seedConnectedUser(fixture);
      const href = fixture.href('http-merge.vcf');
      const remoteCard = [
        'BEGIN:VCARD', 'VERSION:3.0', 'UID:http-merge-remote', 'FN:Http Merge',
        'EMAIL:http-merge@example.test', 'CATEGORIES:Original', 'X-KEEP:survive', 'END:VCARD',
      ].join('\n');
      fixture.putContact(href, '"http-1"', remoteCard);
      fixture.queueSync('', { events: [{ href, etag: '"http-1"' }], nextToken: 'http-token-1' });
      expect(await carddavSync.syncUser(seeded.userId)).toMatchObject({ ok: true });

      const { rows: [row] } = await databaseClient.query(`
        SELECT c.uid, c.address_book_id FROM contacts c
        JOIN carddav_remote_objects o ON o.local_contact_id = c.id
        JOIN address_books b ON b.id = o.address_book_id
        WHERE b.user_id = $1
      `, [seeded.userId]);

      await databaseClient.query('UPDATE users SET password_hash = $2 WHERE id = $1',
        [seeded.userId, await bcrypt.hash('http-merge-password', 4)]);
      const app = express();
      const { default: carddavRouter } = await import('../routes/carddav.js');
      app.use('/carddav', carddavRouter);
      outputServer = await listenOnLocalhost(app);
      const origin = `http://127.0.0.1:${outputServer.address().port}`;
      const authorization = `Basic ${Buffer.from(`carddav-e2e-${seeded.userId}:http-merge-password`).toString('base64')}`;
      const cardUrl = `${origin}/carddav/${seeded.userId}/${row.address_book_id}/${encodeURIComponent(row.uid)}.vcf`;
      const put = (headers, body) => fetch(cardUrl, { method: 'PUT', headers: { Authorization: authorization, ...headers }, body });

      const getResponse = await fetch(cardUrl, { headers: { Authorization: authorization } });
      const servedEtag = getResponse.headers.get('etag');

      const mergeBody = [
        'BEGIN:VCARD', 'VERSION:3.0', `UID:${row.uid}`, 'FN:Http Merge',
        'EMAIL:http-merge@example.test', 'CATEGORIES:Changed', 'END:VCARD', '',
      ].join('\r\n');

      // Gate: an unconditional PUT is rejected and nothing reaches upstream.
      fixture.reset();
      expect((await put({}, mergeBody)).status).toBe(428);
      // Malformed body with a valid If-Match → 400 before any network.
      expect((await put({ 'If-Match': servedEtag, 'Content-Type': 'text/vcard' }, 'not a vcard')).status).toBe(400);
      expect(fixture.requests.some(request => request.method === 'PUT')).toBe(false);

      // Conditional merge through the gate: 204, and the upstream PUT is the two-tier merge
      // with the remote UID preserved.
      fixture.putContact(href, '"http-1"', remoteCard);
      const merged = await put({ 'If-Match': servedEtag, 'Content-Type': 'text/vcard' }, mergeBody);
      expect(merged.status).toBe(204);
      const upstream = fixture.requests.find(request => request.method === 'PUT');
      expect(upstream).toBeDefined();
      expect(upstream.body).toContain('CATEGORIES:Changed');   // client's unmodeled edit lands
      expect(upstream.body).toContain('X-KEEP:survive');       // omitted unmodeled survives
      expect(parseVCard(upstream.body).uid).toBe('http-merge-remote'); // remote UID preserved
    } finally {
      if (outputServer) await closeServer(outputServer);
      await fixture.close();
    }
  }, 120_000);

  it('keeps an automatically linked local photo unchanged across remote photo updates', async () => {
    const fixture = createCarddavFixtureServer();
    await fixture.listen();
    const seeded = await seedConnectedUser(fixture);
    const { rows: [localBook] } = await databaseClient.query(`
      INSERT INTO address_books (user_id, name)
      VALUES ($1, 'Merged Photo Local') RETURNING id, sync_token
    `, [seeded.userId]);
    const local = {
      uid: 'merged-photo-local',
      displayName: 'Merged Photo',
      firstName: null,
      lastName: null,
      emails: [{ value: 'merged-photo@example.test', type: 'other', primary: true }],
      phones: [],
      organization: null,
      notes: null,
      photoData: null,
    };
    const originalVcard = generateVCard(local);
    const originalEtag = createHash('md5').update(originalVcard).digest('hex');
    const { rows: [localRow] } = await databaseClient.query(`
      INSERT INTO contacts (
        address_book_id, user_id, uid, vcard, etag, display_name, primary_email,
        emails, phones, photo_data
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, '[]'::jsonb, NULL)
      RETURNING id
    `, [
      localBook.id,
      seeded.userId,
      local.uid,
      originalVcard,
      originalEtag,
      local.displayName,
      local.emails[0].value,
      JSON.stringify(local.emails),
    ]);
    const href = fixture.href('merged-photo.vcf');
    const jpeg = remotePhotoVcard(
      'merged-photo-remote', 'Merged Photo', local.emails[0].value,
      'PHOTO;ENCODING=b;TYPE=JPEG:AQID',
    );
    fixture.putContact(href, '"merged-photo-1"', jpeg);
    fixture.queueSync('', {
      events: [{ href, etag: '"merged-photo-1"' }],
      nextToken: 'merged-photo-1',
    });
    expect(await carddavSync.syncUser(seeded.userId)).toMatchObject({ ok: true });
    const jpegState = await projectionState(seeded.userId);
    const jpegLocal = jpegState.contacts.find(row => row.id === localRow.id);
    const jpegBook = jpegState.books.find(row => row.id === localBook.id);
    expect(jpegLocal.photo_data).toBeNull();
    expect(jpegLocal.vcard).toBe(originalVcard);
    expect(jpegBook.sync_token).toBe(localBook.sync_token);

    const png = remotePhotoVcard(
      'merged-photo-remote', 'Merged Photo', local.emails[0].value,
      'PHOTO;ENCODING=b;TYPE=PNG:BAUG',
    );
    fixture.putContact(href, '"merged-photo-2"', png);
    fixture.reset();
    fixture.queueSync('merged-photo-1', {
      events: [{ href, etag: '"merged-photo-2"' }],
      nextToken: 'merged-photo-2',
    });
    expect(await carddavSync.syncUser(seeded.userId)).toMatchObject({ ok: true });
    const pngState = await projectionState(seeded.userId);
    const pngLocal = pngState.contacts.find(row => row.id === localRow.id);
    const pngBook = pngState.books.find(row => row.id === localBook.id);
    expect(pngLocal).toEqual(jpegLocal);
    expect(pngBook.sync_token).toBe(jpegBook.sync_token);

    fixture.reset();
    fixture.queueSync('merged-photo-2', {
      events: [{ href, etag: '"merged-photo-2"' }],
      nextToken: 'merged-photo-3',
    });
    expect(await carddavSync.syncUser(seeded.userId)).toMatchObject({ ok: true, updated: 0 });
    const noOp = await projectionState(seeded.userId);
    expect(noOp.books.find(row => row.id === localBook.id).sync_token).toBe(pngBook.sync_token);
    expect(noOp.contacts.find(row => row.id === localRow.id)).toEqual(pngLocal);

    fixture.deleteContact(href);
    fixture.reset();
    fixture.queueSync('merged-photo-3', {
      events: [{ href, status: 404 }],
      nextToken: 'merged-photo-4',
    });
    expect(await carddavSync.syncUser(seeded.userId)).toMatchObject({ ok: true, removed: 0 });
    const restored = await projectionState(seeded.userId);
    const restoredLocal = restored.contacts.find(row => row.id === localRow.id);
    expect(restoredLocal).toMatchObject({
      id: localRow.id,
      display_name: local.displayName,
      primary_email: local.emails[0].value,
      emails: local.emails,
      photo_data: null,
    });
    expect(parseVCard(restoredLocal.vcard)).toMatchObject({
      uid: local.uid,
      displayName: local.displayName,
      emails: local.emails,
      photoData: null,
    });
    expect(restored.books.find(row => row.id === localBook.id).sync_token)
      .not.toBe(pngBook.sync_token);
    expect(restored.ledger).toEqual([expect.objectContaining({
      href: fixture.href(`${local.uid}.vcf`),
      vcard: restoredLocal.vcard,
      primary_email: local.emails[0].value,
      local_contact_id: localRow.id,
    })]);
    expect(fixture.counters.create).toBe(1);
    await fixture.close();
  }, 120_000);

  it('replacement queues exactly one latest generation after old planning releases', async () => {
    const oldFixture = createCarddavFixtureServer();
    const newFixture = createCarddavFixtureServer();
    await oldFixture.listen();
    await newFixture.listen();
    const seeded = await seedConnectedUser(oldFixture);
    const oldContact = await seedSingleRemoteContact(oldFixture, seeded.userId, {
      uid: 'old-generation',
      name: 'Old Generation',
      token: 'old-generation-token',
    });
    const oldState = await projectionState(seeded.userId);
    const oldBook = oldState.books.find(row => row.source === 'carddav');
    const oldBarrier = deferred();
    const oldReached = deferred();
    oldFixture.reset();
    oldFixture.queueSync(oldContact.token, {
      events: [],
      nextToken: 'old-generation-must-not-commit',
      waitFor: oldBarrier.promise,
      reached: oldReached.resolve,
    });

    const newHref = newFixture.href('new-generation.vcf');
    const newCard = remoteVcard('new-generation', 'New Generation');
    newFixture.putContact(newHref, '"new-generation-1"', newCard);
    newFixture.queueSync('', {
      events: [{ href: newHref, etag: '"new-generation-1"' }],
      nextToken: 'new-generation-token',
    });
    const oldPending = carddavSync.syncUser(seeded.userId);
    await oldReached.promise;

    const app = express();
    app.use(express.json());
    app.use((request, response, next) => {
      request.session = { userId: seeded.userId };
      next();
    });
    const { default: carddavAccountRouter } = await import('../routes/carddavAccount.js');
    app.use('/carddav-account', carddavAccountRouter);
    const accountServer = await listenOnLocalhost(app);
    const accountOrigin = `http://127.0.0.1:${accountServer.address().port}`;
    const replacementResponse = await fetch(`${accountOrigin}/carddav-account/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        serverUrl: newFixture.serverUrl,
        username: 'replacement-user',
        password: 'replacement-password',
        intervalMin: 60,
      }),
    });
    expect(replacementResponse.status).toBe(200);
    expect(await replacementResponse.json()).toEqual({
      connected: true,
      serverUrl: newFixture.serverUrl,
      username: 'replacement-user',
      intervalMin: 60,
      lastSyncAt: null,
      lastError: null,
      bookCount: null,
      contactCount: 1,
    });
    const [replacement] = await integrationState(seeded.userId);
    expect(replacement.config).toEqual({
      serverUrl: newFixture.serverUrl,
      username: 'replacement-user',
      password: expect.stringMatching(/^enc:v1:/),
      intervalMin: 60,
      connectionGeneration: expect.any(String),
      lastError: null,
      contactCount: 1,
    });
    expect(replacement.config.connectionGeneration).not.toBe(seeded.connectionGeneration);
    expect(replacement.config.password).not.toBe('replacement-password');
    oldBarrier.resolve();

    expect(await oldPending).toEqual({
      ok: false,
      error: 'CardDAV sync plan is stale',
      remote: 0,
      fetched: 0,
      updated: 0,
      removed: 0,
      fallback: 0,
    });
    await waitForPostgresState({
      description: 'queued replacement generation to finish',
      probe: async () => {
        const [integration] = await integrationState(seeded.userId);
        const state = {
          connectionGeneration: integration?.config?.connectionGeneration ?? null,
          hasLastError: integration?.config?.lastError != null,
          bookCount: integration?.config?.bookCount ?? null,
          contactCount: integration?.config?.contactCount ?? null,
          lastSyncAt: integration?.config?.lastSyncAt ?? null,
        };
        return {
          done: state.connectionGeneration === replacement.config.connectionGeneration
            && !state.hasLastError
            && state.bookCount === 1
            && state.contactCount === 1
            && Boolean(state.lastSyncAt),
          state,
        };
      },
    });

    const finalProjection = await projectionState(seeded.userId);
    expect(finalProjection.books).toHaveLength(1);
    expect(finalProjection.books[0]).toMatchObject({
      source: 'carddav',
      external_url: newFixture.href(''),
      remote_sync_token: 'new-generation-token',
      remote_sync_capability: 'sync-collection',
      remote_sync_revision: '1',
      remote_projection_fingerprint: expect.any(String),
    });
    expect(finalProjection.books[0].id).not.toBe(oldBook.id);
    const finalContact = finalProjection.contacts[0];
    expect(finalProjection.contacts).toEqual([
      expectedLocalContact(
        newHref,
        newCard,
        finalProjection.books[0].id,
        seeded.userId,
        finalContact.id,
      ),
    ]);
    expect(finalProjection.ledger).toEqual([{
      address_book_id: finalProjection.books[0].id,
      href: newHref,
      remote_etag: '"new-generation-1"',
      vcard: newCard,
      primary_email: 'new-generation@example.test',
      local_contact_id: finalContact.id,
    }]);
    const [finalIntegration] = await integrationState(seeded.userId);
    expect(finalIntegration.config).toEqual({
      ...replacement.config,
      lastSyncAt: expect.any(String),
      lastError: null,
      bookCount: 1,
      contactCount: 1,
      exportFailures: [],
    });
    expect(Number.isNaN(Date.parse(finalIntegration.config.lastSyncAt))).toBe(false);
    expect(oldFixture.counters).toMatchObject({
      requests: 4,
      propfind: 3,
      sync: 1,
      multiget: 0,
      syncTokens: ['old-generation-token'],
    });
    expect(newFixture.counters).toMatchObject({
      requests: 8,
      propfind: 6,
      sync: 1,
      multiget: 1,
      syncTokens: [''],
      multigetSizes: [1],
    });
    const newAuthorization = `Basic ${Buffer.from(
      'replacement-user:replacement-password',
    ).toString('base64')}`;
    expect(newFixture.requests.every(request => request.authorization === newAuthorization))
      .toBe(true);
    expect(oldFixture.requests.every(request => (
      request.authorization === 'Basic Zml4dHVyZS11c2VyOmZpeHR1cmUtcGFzc3dvcmQ='
    ))).toBe(true);

    carddavSync.stopCardavUser(seeded.userId);
    await closeServer(accountServer);
    await oldFixture.close();
    await newFixture.close();
  }, 120_000);

  it('changed username on the same collection invalidates the old token and fully reconciles', async () => {
    const fixture = createCarddavFixtureServer();
    await fixture.listen();
    const seeded = await seedConnectedUser(fixture, {
      username: 'identity-old-user',
      password: 'identity-old-password',
    });
    const retainedHref = fixture.href('identity-retained.vcf');
    const oldOnlyHref = fixture.href('identity-old-only.vcf');
    const retainedBefore = remoteVcard('identity-retained', 'Identity Retained Before');
    const oldOnly = remoteVcard('identity-old-only', 'Identity Old Only');
    fixture.putContact(retainedHref, '"identity-retained-1"', retainedBefore);
    fixture.putContact(oldOnlyHref, '"identity-old-only-1"', oldOnly);
    fixture.queueSync('', {
      events: [
        { href: retainedHref, etag: '"identity-retained-1"' },
        { href: oldOnlyHref, etag: '"identity-old-only-1"' },
      ],
      nextToken: 'identity-old-token',
    });
    expect(await carddavSync.syncUser(seeded.userId)).toMatchObject({
      ok: true, contactCount: 2,
    });
    const beforeReplacement = await projectionState(seeded.userId);
    const beforeBook = beforeReplacement.books.find(book => book.source === 'carddav');

    fixture.reset();
    const retainedAfter = remoteVcard('identity-retained', 'Identity Retained After');
    fixture.putContact(retainedHref, '"identity-retained-2"', retainedAfter);
    fixture.deleteContact(oldOnlyHref);
    fixture.queueSync('identity-old-token', {
      events: [],
      nextToken: 'identity-wrong-partial-token',
    });
    fixture.queueSync('', {
      events: [{ href: retainedHref, etag: '"identity-retained-2"' }],
      nextToken: 'identity-new-token',
    });
    const replacement = await carddavSync.replaceCarddavConnection(seeded.userId, {
      serverUrl: fixture.serverUrl,
      username: 'identity-new-user',
      password: encrypt('identity-new-password'),
      intervalMin: 60,
    });
    expect(replacement.connectionGeneration).not.toBe(seeded.connectionGeneration);
    const invalidated = await projectionState(seeded.userId);
    expect(invalidated.books.find(book => book.id === beforeBook.id)).toMatchObject({
      remote_sync_token: null,
      remote_sync_capability: 'unknown',
      remote_sync_revision: String(Number(beforeBook.remote_sync_revision) + 1),
      remote_projection_fingerprint: null,
    });
    expect(invalidated.contacts).toEqual(beforeReplacement.contacts);
    expect(invalidated.ledger).toEqual(beforeReplacement.ledger);

    expect(await carddavSync.syncUser(seeded.userId)).toMatchObject({
      ok: true, contactCount: 1, removed: 1,
    });
    const after = await projectionState(seeded.userId);
    expect(after.books).toHaveLength(1);
    expect(after.books[0]).toMatchObject({
      id: beforeBook.id,
      remote_sync_token: 'identity-new-token',
      remote_sync_capability: 'sync-collection',
    });
    expect(after.contacts).toHaveLength(1);
    expect(after.contacts[0].display_name).toBe('Identity Retained After');
    expect(after.ledger.map(object => object.href)).toEqual([retainedHref]);
    expect(fixture.counters.syncTokens).toEqual(['']);
    const expectedAuthorization = `Basic ${Buffer.from(
      'identity-new-user:identity-new-password',
    ).toString('base64')}`;
    expect(fixture.requests.filter(request => request.authorization)
      .every(request => request.authorization === expectedAuthorization)).toBe(true);
    await fixture.close();
  }, 120_000);

  async function materializedCarddavContactCount(userId) {
    const { rows: [row] } = await databaseClient.query(`
      SELECT count(*)::int AS count
      FROM contacts c
      JOIN address_books b ON b.id = c.address_book_id
      WHERE c.user_id = $1 AND b.source = 'carddav'
    `, [userId]);
    return row.count;
  }

  // Puts `size` contacts in the remote book and scripts the snapshot that reports all of
  // them for `syncToken` — re-callable, so a full re-fetch can be replayed after a reset.
  function queueRemoteSnapshot(fixture, { size, syncToken = '', nextToken }) {
    const events = [];
    for (let index = 0; index < size; index++) {
      const uid = `count-${index}`;
      const href = fixture.href(`${uid}.vcf`);
      const etag = `"etag-${uid}"`;
      fixture.putContact(href, etag, remoteVcard(uid, `Count Contact ${index}`));
      events.push({ href, etag });
    }
    fixture.queueSync(syncToken, { events, nextToken });
  }

  async function clearRemoteSyncTokens(userId) {
    await databaseClient.query(`
      UPDATE address_books
      SET remote_sync_token = NULL, remote_projection_fingerprint = NULL
      WHERE user_id = $1 AND source = 'carddav'
    `, [userId]);
  }

  // contactCount was accumulated (a per-book delta added to the stored total), so a
  // full snapshot against an empty ledger added the book's contacts on top of a total that
  // already counted them — exactly what an upgrade from the read-only sync leaves behind.
  it('includes contacts published by the export sweep in the finalized contactCount', async () => {
    const fixture = createCarddavFixtureServer();
    await fixture.listen();
    const seeded = await seedConnectedUser(fixture);
    await seedUnmappedExplicitContact(seeded.userId, {
      uid: 'export-count',
      displayName: 'Export Count',
    });
    fixture.queueSync('', { events: [], nextToken: 'export-count-token' });

    const result = await carddavSync.syncUser(seeded.userId);
    const state = await projectionState(seeded.userId);
    const [integration] = await integrationState(seeded.userId);

    expect(result).toMatchObject({ ok: true, contactCount: 1, exportFailures: [] });
    expect(state.ledger).toHaveLength(1);
    expect(integration.config.contactCount).toBe(1);
    await fixture.close();
  }, 120_000);

  it('recounts contactCount on a full snapshot inheriting a read-only total', async () => {
    const fixture = createCarddavFixtureServer();
    await fixture.listen();
    const seeded = await seedConnectedUser(fixture);
    queueRemoteSnapshot(fixture, { size: 3, nextToken: 'count-token-1' });

    expect(await carddavSync.syncUser(seeded.userId)).toMatchObject({ ok: true });
    expect((await integrationState(seeded.userId))[0].config.contactCount).toBe(3);

    // The state an upgrade from the read-only sync lands in: contacts are materialized and
    // config carries their (correct) count, but the mapping ledger is new and empty, and
    // the cleared remote token forces the next sync down the full-snapshot path.
    await databaseClient.query(`
      DELETE FROM carddav_remote_objects o
      USING address_books b
      WHERE b.id = o.address_book_id AND b.user_id = $1
    `, [seeded.userId]);
    await clearRemoteSyncTokens(seeded.userId);
    fixture.reset();
    queueRemoteSnapshot(fixture, { size: 3, nextToken: 'count-token-2' });

    expect(await carddavSync.syncUser(seeded.userId)).toMatchObject({ ok: true });

    expect(await materializedCarddavContactCount(seeded.userId)).toBe(3);
    expect((await integrationState(seeded.userId))[0].config.contactCount).toBe(3);
    await fixture.close();
  }, 120_000);

  it('heals an already inflated contactCount on the next sync', async () => {
    const fixture = createCarddavFixtureServer();
    await fixture.listen();
    const seeded = await seedConnectedUser(fixture);
    queueRemoteSnapshot(fixture, { size: 2, nextToken: 'inflated-token-1' });

    expect(await carddavSync.syncUser(seeded.userId)).toMatchObject({ ok: true });
    await databaseClient.query(`
      UPDATE user_integrations
      SET config = jsonb_set(config, '{contactCount}', to_jsonb(1772))
      WHERE user_id = $1 AND provider = 'carddav'
    `, [seeded.userId]);
    fixture.reset();
    fixture.queueSync('inflated-token-1', { events: [], nextToken: 'inflated-token-2' });

    // An idempotent sync: nothing changed remotely, so only a derived count converges.
    expect(await carddavSync.syncUser(seeded.userId)).toMatchObject({
      ok: true,
      contactCount: 2,
    });

    expect(await materializedCarddavContactCount(seeded.userId)).toBe(2);
    expect((await integrationState(seeded.userId))[0].config.contactCount).toBe(2);
    await fixture.close();
  }, 120_000);

  it('keeps contactCount equal to the row count across repeated full re-fetches', async () => {
    const fixture = createCarddavFixtureServer();
    await fixture.listen();
    const seeded = await seedConnectedUser(fixture);
    queueRemoteSnapshot(fixture, { size: 4, nextToken: 'refetch-token-0' });

    expect(await carddavSync.syncUser(seeded.userId)).toMatchObject({ ok: true });

    for (let pass = 1; pass <= 2; pass++) {
      await clearRemoteSyncTokens(seeded.userId);
      fixture.reset();
      queueRemoteSnapshot(fixture, { size: 4, nextToken: `refetch-token-${pass}` });

      expect(await carddavSync.syncUser(seeded.userId)).toMatchObject({ ok: true });
      expect((await integrationState(seeded.userId))[0].config.contactCount)
        .toBe(await materializedCarddavContactCount(seeded.userId));
    }

    expect(await materializedCarddavContactCount(seeded.userId)).toBe(4);
    await fixture.close();
  }, 120_000);
});
