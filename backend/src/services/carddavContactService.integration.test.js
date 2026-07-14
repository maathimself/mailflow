import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCarddavFixtureServer } from './carddavFixtureServer.js';
import {
  assertMinimumPostgresVersion,
  createTestDatabase,
  dropTestDatabase,
  postgresTestContext,
  productionDatabaseEnvironment,
} from './postgresTestHelpers.js';
import { generateVCard } from '../utils/vcard.js';
import {
  contactFromVCardDocument,
  localContactHash,
  parseVCardDocument,
  semanticVCardHash,
} from '../utils/vcardProperties.js';

const { Client } = pg;
const { databaseUrl, connectionStringFor } = postgresTestContext(
  'CardDAV contact integration tests',
);

const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), '../../migrations');
const databaseName = `carddav_contacts_${process.pid}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const encryptionKey = '22'.repeat(32);
const productionEnvironment = productionDatabaseEnvironment(encryptionKey);
const credentials = {
  username: 'fixture-user',
  password: 'fixture-password',
};
const MAX_VCARD_BYTES = 1024 * 1024;
const MAX_CONTENT_LINE_BYTES = 64 * 1024;

let adminClient;
let databaseClient;
let productionDb;
let contactService;
let contactsRouter;
let encrypt;
let activeFixture;
let beforeBegin;
let afterCommit;
let nextInstrumentedClientId = 1;
let transactionEvents = [];

async function instrumentTransactions() {
  const instrumentClient = client => {
    if (client.carddavContactOriginalQuery) return client;

    client.carddavContactOriginalQuery = client.query.bind(client);
    const clientId = nextInstrumentedClientId++;
    client.query = (text, ...args) => {
      if (typeof args.at(-1) === 'function') {
        return client.carddavContactOriginalQuery(text, ...args);
      }
      const sql = typeof text === 'string' ? text.trim().toUpperCase() : '';
      return (async () => {
        if (sql === 'BEGIN' && beforeBegin) await beforeBegin();
        const result = await client.carddavContactOriginalQuery(text, ...args);
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
          transactionEvents.push({
            clientId,
            sql,
            networkRequests: activeFixture?.counters.requests ?? 0,
          });
        }
        if (sql === 'COMMIT' && afterCommit) await afterCommit();
        return result;
      })();
    };
    return client;
  };
  productionDb.pool.on('connect', instrumentClient);
  const client = await productionDb.pool.connect();
  instrumentClient(client);
  client.release();
}

function resetObservation(fixture) {
  activeFixture = fixture;
  beforeBegin = null;
  afterCommit = null;
  transactionEvents = [];
  fixture?.reset();
}

function expectNoNetworkInsideTransactions() {
  const openTransactions = new Map();
  let completed = 0;
  for (const event of transactionEvents) {
    if (event.sql === 'BEGIN') {
      expect(openTransactions.has(event.clientId)).toBe(false);
      openTransactions.set(event.clientId, event);
      continue;
    }
    const openTransaction = openTransactions.get(event.clientId);
    expect(openTransaction).toBeDefined();
    expect(event.networkRequests).toBe(openTransaction.networkRequests);
    openTransactions.delete(event.clientId);
    completed++;
  }
  expect(openTransactions.size).toBe(0);
  expect(completed).toBeGreaterThan(0);
}

function vcard(uid, displayName, email = `${uid}@example.test`) {
  return [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `UID:${uid}`,
    `FN:${displayName}`,
    `EMAIL:${email}`,
    'END:VCARD',
    '',
  ].join('\r\n');
}

function sizedVCard(uid, size) {
  const start = `BEGIN:VCARD\r\nVERSION:3.0\r\nUID:${uid}\r\nFN:Limit\r\n`;
  const end = 'END:VCARD\r\n';
  let remaining = size - Buffer.byteLength(start) - Buffer.byteLength(end);
  const lines = [];

  while (remaining > 0) {
    let lineBytes = Math.min(MAX_CONTENT_LINE_BYTES + 2, remaining);
    const tail = remaining - lineBytes;
    if (tail > 0 && tail < 4) lineBytes -= 4 - tail;
    lines.push(`X:${'a'.repeat(lineBytes - 4)}\r\n`);
    remaining -= lineBytes;
  }

  return start + lines.join('') + end;
}

function draft(displayName, email) {
  return {
    displayName,
    firstName: displayName.split(' ')[0],
    lastName: displayName.split(' ').slice(1).join(' ') || null,
    emails: [{ value: email, type: 'work', primary: true }],
    phones: [],
    organization: null,
    notes: null,
    photoData: null,
    additionalFields: [],
  };
}

async function authoritativeState(userId) {
  const { rows: addressBooks } = await databaseClient.query(`
    SELECT id, name, source, external_url, sync_token,
           remote_create_capability, remote_update_capability, remote_delete_capability
    FROM address_books
    WHERE user_id = $1
    ORDER BY source, external_url NULLS FIRST, id
  `, [userId]);
  const { rows: contacts } = await databaseClient.query(`
    SELECT id, address_book_id, user_id, uid, vcard, etag, display_name,
           first_name, last_name, primary_email, emails, phones, organization,
           notes, photo_data, additional_fields, is_auto, send_count, last_sent
    FROM contacts
    WHERE user_id = $1
    ORDER BY address_book_id, uid
  `, [userId]);
  const { rows: remoteObjects } = await databaseClient.query(`
    SELECT remote.address_book_id, remote.href, remote.remote_etag, remote.vcard,
           remote.primary_email, remote.local_contact_id,
           remote.mapping_status, remote.vcard_version,
           remote.remote_semantic_hash, remote.local_contact_hash,
           remote.mapping_revision::text
    FROM carddav_remote_objects remote
    JOIN address_books book ON book.id = remote.address_book_id
    WHERE book.user_id = $1
    ORDER BY remote.address_book_id, remote.href
  `, [userId]);
  const { rows: conflicts } = await databaseClient.query(`
    SELECT id, address_book_id, href, user_id, base_local_hash, remote_etag,
           local_vcard, remote_vcard, local_tombstone, remote_tombstone,
           status, resolution, resolved_by, resolved_at
    FROM carddav_conflicts
    WHERE user_id = $1
    ORDER BY address_book_id, href
  `, [userId]);
  return { addressBooks, contacts, remoteObjects, conflicts };
}

async function pendingIntentState(userId) {
  const { rows } = await databaseClient.query(`
    SELECT remote.href, remote.pending_operation, remote.pending_vcard,
           remote.pending_local_hash, remote.pending_remote_semantic_hash,
           remote.pending_started_at IS NOT NULL AS pending_started
    FROM carddav_remote_objects remote
    JOIN address_books book ON book.id = remote.address_book_id
    WHERE book.user_id = $1 AND remote.pending_operation IS NOT NULL
    ORDER BY remote.address_book_id, remote.href
  `, [userId]);
  return rows;
}

async function seedUser() {
  const userId = randomUUID();
  await databaseClient.query(
    'INSERT INTO users (id, username) VALUES ($1, $2)',
    [userId, `carddav-contact-${userId}`],
  );
  return userId;
}

async function seedConnectedUser(fixture) {
  const userId = await seedUser();
  const connectionGeneration = randomUUID();
  const { rows: [localBook] } = await databaseClient.query(
    "INSERT INTO address_books (user_id, name) VALUES ($1, 'Personal') RETURNING id",
    [userId],
  );
  await databaseClient.query(`
    INSERT INTO user_integrations (user_id, provider, config)
    VALUES ($1, 'carddav', $2::jsonb)
  `, [userId, JSON.stringify({
    serverUrl: fixture.serverUrl,
    username: credentials.username,
    password: encrypt(credentials.password),
    connectionGeneration,
  })]);
  return { userId, connectionGeneration, localBookId: localBook.id };
}

// Write-target routing (multi-book Slice 2) resolves the stored is_write_target
// book against a *fresh* discovery snapshot; nothing yet assigns that flag to a
// newly discovered book (that bootstrap is out of this slice's scope — see
// Slice 3/5 of the multi-book design), so a brand-new fixture connection must
// have its single book pre-designated the write target, exactly as Slice 1's
// migration backfill does for an already-connected single-book user.
async function seedWriteTargetBook(fixture, userId) {
  const externalUrl = new URL('/addressbooks/fixture-user/contacts/', fixture.serverUrl).href;
  await databaseClient.query(`
    INSERT INTO address_books (
      user_id, name, source, external_url,
      remote_create_capability, remote_update_capability, remote_delete_capability,
      is_write_target, is_subscribed, is_lookup_source
    ) VALUES ($1, 'Fixture Contacts', 'carddav', $2, 'allowed', 'allowed', 'allowed', true, true, true)
  `, [userId, externalUrl]);
  return externalUrl;
}

// `isWriteTarget` defaults to true: these fixtures back tests of pending-intent,
// conflict, and throttle *mechanics*, not the write-target invariant itself, so
// they seed a mapped contact whose book is the write target — mirroring what
// Slice 1's migration backfill (or a real first-sync auto-assignment) already
// established for an already-connected single-book user. A dedicated test
// below covers `isWriteTarget: false` (a subscribed secondary) to prove the
// invariant that a non-write-target book never receives a PUT/DELETE.
async function seedMappedContact(fixture, name = 'Mapped Before', { isWriteTarget = true } = {}) {
  const seeded = await seedConnectedUser(fixture);
  const uid = randomUUID();
  const rawVCard = vcard(uid, name);
  const href = fixture.href(`${uid}.vcf`);
  const remoteEtag = '"mapped-1"';
  const { rows: [remoteBook] } = await databaseClient.query(`
    INSERT INTO address_books (
      user_id, name, source, external_url,
      remote_create_capability, remote_update_capability, remote_delete_capability,
      is_write_target, is_subscribed, is_lookup_source
    ) VALUES ($1, 'Fixture Contacts', 'carddav', $2, 'allowed', 'allowed', 'allowed', $3, true, true)
    RETURNING id
  `, [
    seeded.userId,
    new URL('/addressbooks/fixture-user/contacts/', fixture.serverUrl).href,
    isWriteTarget,
  ]);
  const { rows: [contact] } = await databaseClient.query(`
    INSERT INTO contacts (
      address_book_id, user_id, uid, vcard, etag, display_name,
      primary_email, emails, phones, additional_fields, is_auto
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'[]'::jsonb,'[]'::jsonb,false)
    RETURNING id, etag
  `, [
    seeded.localBookId,
    seeded.userId,
    uid,
    rawVCard,
    createHash('md5').update(rawVCard).digest('hex'),
    name,
    `${uid}@example.test`,
    JSON.stringify([{ value: `${uid}@example.test`, type: 'other', primary: true }]),
  ]);
  await databaseClient.query(`
    INSERT INTO carddav_remote_objects (
      address_book_id, href, remote_etag, vcard, primary_email,
      local_contact_id, mapping_status, vcard_version,
      remote_semantic_hash, local_contact_hash, last_synced_at
    ) VALUES ($1,$2,$3,$4,$5,$6,'synced','3.0','remote-hash','local-hash',NOW())
  `, [
    remoteBook.id,
    href,
    remoteEtag,
    rawVCard,
    `${uid}@example.test`,
    contact.id,
  ]);
  fixture.putContact(href, remoteEtag, rawVCard);
  return { ...seeded, uid, href, remoteEtag, remoteBookId: remoteBook.id, contact };
}

// A sender harvested from an inbound message: an unmapped `is_auto` contacts row
// in the user's local book, exactly as imapManager's collector leaves it. The
// carddav book is seeded create-capable either way, so only its is_write_target
// flag decides whether promotion has a destination.
async function seedAutoContact(fixture, {
  displayName = 'Harvested Sender',
  isWriteTarget = true,
} = {}) {
  const seeded = await seedConnectedUser(fixture);
  const { rows: [remoteBook] } = await databaseClient.query(`
    INSERT INTO address_books (
      user_id, name, source, external_url,
      remote_create_capability, remote_update_capability, remote_delete_capability,
      is_write_target, is_subscribed, is_lookup_source
    ) VALUES ($1, 'Fixture Contacts', 'carddav', $2, 'allowed', 'allowed', 'allowed', $3, true, true)
    RETURNING id
  `, [
    seeded.userId,
    new URL('/addressbooks/fixture-user/contacts/', fixture.serverUrl).href,
    isWriteTarget,
  ]);
  const uid = randomUUID();
  const email = `${uid}@example.test`;
  const rawVCard = vcard(uid, displayName, email);
  const { rows: [contact] } = await databaseClient.query(`
    INSERT INTO contacts (
      address_book_id, user_id, uid, vcard, etag, display_name,
      primary_email, emails, phones, additional_fields, is_auto
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'[]'::jsonb,'[]'::jsonb,true)
    RETURNING id, etag
  `, [
    seeded.localBookId,
    seeded.userId,
    uid,
    rawVCard,
    createHash('md5').update(rawVCard).digest('hex'),
    displayName,
    email,
    JSON.stringify([{ value: email, type: 'other', primary: true }]),
  ]);
  return { ...seeded, uid, email, remoteBookId: remoteBook.id, contact };
}

// Reproduce the state a sync pull leaves behind: the local contacts row holds the
// LOSSY re-serialized vCard (generateVCard drops unmodeled properties) while the
// carddav_remote_objects row retains the FULL remote vCard. The local UID is the
// href hash, exactly as desiredAutomaticContact derives it.
async function seedImportedContact(fixture, remoteVCard, remoteEtag = '"imported-1"') {
  const seeded = await seedConnectedUser(fixture);
  const href = fixture.href(`${randomUUID()}.vcf`);
  const document = parseVCardDocument(remoteVCard);
  const projected = contactFromVCardDocument(document);
  const uid = createHash('sha256').update(href).digest('hex');
  const primaryEmail = projected.emails?.[0]?.value ?? null;
  const desired = {
    ...projected,
    uid,
    primaryEmail,
    additionalFields: projected.additionalFields || [],
  };
  const localVCard = generateVCard(desired);
  const localEtag = createHash('md5').update(localVCard).digest('hex');
  const { rows: [remoteBook] } = await databaseClient.query(`
    INSERT INTO address_books (
      user_id, name, source, external_url,
      remote_create_capability, remote_update_capability, remote_delete_capability,
      is_write_target, is_subscribed, is_lookup_source
    ) VALUES ($1, 'Fixture Contacts', 'carddav', $2, 'allowed', 'allowed', 'allowed', true, true, true)
    RETURNING id
  `, [seeded.userId, new URL('/addressbooks/fixture-user/contacts/', fixture.serverUrl).href]);
  const { rows: [contact] } = await databaseClient.query(`
    INSERT INTO contacts (
      address_book_id, user_id, uid, vcard, etag, display_name,
      first_name, last_name, primary_email, emails, phones,
      organization, notes, additional_fields, is_auto
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14::jsonb,false)
    RETURNING id, etag
  `, [
    seeded.localBookId,
    seeded.userId,
    uid,
    localVCard,
    localEtag,
    desired.displayName,
    desired.firstName,
    desired.lastName,
    primaryEmail,
    JSON.stringify(desired.emails || []),
    JSON.stringify(desired.phones || []),
    desired.organization,
    desired.notes,
    JSON.stringify(desired.additionalFields || []),
  ]);
  await databaseClient.query(`
    INSERT INTO carddav_remote_objects (
      address_book_id, href, remote_etag, vcard, primary_email,
      local_contact_id, mapping_status, vcard_version,
      remote_semantic_hash, local_contact_hash, last_synced_at
    ) VALUES ($1,$2,$3,$4,$5,$6,'synced',$7,$8,$9,NOW())
  `, [
    remoteBook.id,
    href,
    remoteEtag,
    remoteVCard,
    primaryEmail,
    contact.id,
    document.version,
    semanticVCardHash(document),
    localContactHash(desired),
  ]);
  fixture.putContact(href, remoteEtag, remoteVCard);
  return {
    ...seeded,
    uid,
    href,
    remoteEtag,
    remoteBookId: remoteBook.id,
    contact,
    localVCard,
    remoteVCard,
  };
}

describe('CardDAV contact mutations against PostgreSQL 16 and HTTP', () => {
  beforeAll(async () => {
    adminClient = new Client({ connectionString: databaseUrl });
    await adminClient.connect();
    await createTestDatabase(adminClient, databaseName);

    const connectionString = connectionStringFor(databaseName);
    databaseClient = new Client({ connectionString });
    await databaseClient.connect();
    await assertMinimumPostgresVersion(databaseClient);

    productionEnvironment.configure(connectionString);
    productionDb = await import('./db.js');
    const { runMigrationsWithPool } = await import('./migrations.js');
    await runMigrationsWithPool(productionDb.pool, migrationsDirectory);
    await productionDb.pool.query(`
      INSERT INTO system_settings (key, value) VALUES ('allow_private_hosts', 'true')
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `);
    ({ encrypt } = await import('./encryption.js'));
    contactService = await import('./carddavContactService.js');
    ({ default: contactsRouter } = await import('../routes/contacts.js'));
    await instrumentTransactions();
  }, 120_000);

  beforeEach(() => {
    activeFixture = null;
    beforeBegin = null;
    afterCommit = null;
    transactionEvents = [];
  });

  afterAll(async () => {
    activeFixture = null;
    await productionDb?.pool.end();
    await databaseClient?.end();
    if (adminClient) {
      await dropTestDatabase(adminClient, databaseName);
      await adminClient.end();
    }
    productionEnvironment.restore();
  }, 120_000);

  it('executes local create, update, and delete SQL with authoritative read-back', async () => {
    const userId = await seedUser();
    resetObservation(null);

    const created = await contactService.createContact(
      userId,
      draft('Local Created', 'local@example.test'),
    );
    const afterCreate = await authoritativeState(userId);
    expect(afterCreate.addressBooks).toHaveLength(1);
    expect(afterCreate.contacts).toEqual([
      expect.objectContaining({
        id: created.id,
        address_book_id: afterCreate.addressBooks[0].id,
        user_id: userId,
        uid: created.uid,
        display_name: 'Local Created',
        primary_email: 'local@example.test',
        is_auto: false,
      }),
    ]);
    expect(afterCreate.remoteObjects).toEqual([]);
    expect(afterCreate.conflicts).toEqual([]);
    expectNoNetworkInsideTransactions();

    resetObservation(null);
    const updated = await contactService.updateContact(
      userId,
      created.id,
      draft('Local Updated', 'updated@example.test'),
    );
    const afterUpdate = await authoritativeState(userId);
    expect(updated.display_name).toBe('Local Updated');
    expect(afterUpdate.contacts).toEqual([
      expect.objectContaining({
        id: created.id,
        display_name: 'Local Updated',
        primary_email: 'updated@example.test',
      }),
    ]);
    expect(afterUpdate.addressBooks[0].sync_token)
      .not.toBe(afterCreate.addressBooks[0].sync_token);
    expect(afterUpdate.remoteObjects).toEqual([]);
    expect(afterUpdate.conflicts).toEqual([]);
    expectNoNetworkInsideTransactions();

    resetObservation(null);
    await expect(contactService.deleteContact(userId, created.id))
      .resolves.toEqual({ ok: true });
    const afterDelete = await authoritativeState(userId);
    expect(afterDelete.addressBooks).toHaveLength(1);
    expect(afterDelete.addressBooks[0].sync_token)
      .not.toBe(afterUpdate.addressBooks[0].sync_token);
    expect(afterDelete.contacts).toEqual([]);
    expect(afterDelete.remoteObjects).toEqual([]);
    expect(afterDelete.conflicts).toEqual([]);
    expectNoNetworkInsideTransactions();
  });

  it('executes mapped vCard create, replace, and delete with conditional fixture HTTP', async () => {
    const fixture = createCarddavFixtureServer();
    await fixture.listen();
    const { userId, localBookId } = await seedConnectedUser(fixture);
    await seedWriteTargetBook(fixture, userId);
    const uid = randomUUID();

    try {
      resetObservation(fixture);
      const created = await contactService.createContactFromVCard(userId, {
        localAddressBookId: localBookId,
        uid,
        rawVCard: vcard(uid, 'Remote Created'),
      });
      const afterCreate = await authoritativeState(userId);
      expect(afterCreate.addressBooks).toHaveLength(2);
      expect(afterCreate.contacts).toEqual([
        expect.objectContaining({
          id: created.id,
          address_book_id: localBookId,
          uid,
          display_name: 'Remote Created',
        }),
      ]);
      expect(afterCreate.remoteObjects).toEqual([
        expect.objectContaining({
          local_contact_id: created.id,
          mapping_status: 'synced',
          mapping_revision: '0',
        }),
      ]);
      expect(afterCreate.conflicts).toEqual([]);
      expect(fixture.counters).toMatchObject({
        requests: 5,
        propfind: 3,
        create: 1,
        update: 0,
        delete: 0,
        fetch: 1,
      });
      const createRequest = fixture.requests.find(request => request.method === 'PUT');
      expect(createRequest).toMatchObject({
        ifMatch: undefined,
        ifNoneMatch: '*',
      });
      expectNoNetworkInsideTransactions();

      resetObservation(fixture);
      const beforeReplace = await authoritativeState(userId);
      const expectedRemoteEtag = beforeReplace.remoteObjects[0].remote_etag;
      const replaced = await contactService.replaceContactFromVCard(userId, {
        localAddressBookId: localBookId,
        uid,
        rawVCard: vcard(uid, 'Remote Replaced'),
        expectedLocalEtag: beforeReplace.contacts[0].etag,
      });
      const afterReplace = await authoritativeState(userId);
      expect(replaced.display_name).toBe('Remote Replaced');
      expect(afterReplace.contacts).toEqual([
        expect.objectContaining({
          id: created.id,
          display_name: 'Remote Replaced',
        }),
      ]);
      expect(afterReplace.remoteObjects).toEqual([
        expect.objectContaining({
          local_contact_id: created.id,
          mapping_status: 'synced',
          mapping_revision: '2',
        }),
      ]);
      expect(afterReplace.conflicts).toEqual([]);
      expect(await pendingIntentState(userId)).toEqual([]);
      expect(fixture.counters).toMatchObject({
        requests: 2,
        create: 0,
        update: 1,
        delete: 0,
        fetch: 1,
      });
      const updateRequest = fixture.requests.find(request => request.method === 'PUT');
      expect(updateRequest).toMatchObject({
        ifMatch: expectedRemoteEtag,
        ifNoneMatch: undefined,
      });
      expectNoNetworkInsideTransactions();

      resetObservation(fixture);
      const expectedDeleteEtag = afterReplace.remoteObjects[0].remote_etag;
      await expect(contactService.deleteContactFromVCard(userId, {
        localAddressBookId: localBookId,
        uid,
        expectedLocalEtag: afterReplace.contacts[0].etag,
      })).resolves.toEqual({ ok: true });
      const afterDelete = await authoritativeState(userId);
      expect(afterDelete.addressBooks).toHaveLength(2);
      expect(afterDelete.contacts).toEqual([]);
      expect(afterDelete.remoteObjects).toEqual([]);
      expect(afterDelete.conflicts).toEqual([]);
      expect(fixture.counters).toMatchObject({
        requests: 2,
        create: 0,
        update: 0,
        delete: 1,
        fetch: 1,
      });
      const deleteRequest = fixture.requests.find(request => request.method === 'DELETE');
      expect(deleteRequest.ifMatch).toBe(expectedDeleteEtag);
      expectNoNetworkInsideTransactions();
    } finally {
      await fixture.close();
    }
  }, 120_000);

  // carddavSync.js's canonical-URL reconciliation (advanceDiscoveredBookState)
  // rewrites a book's external_url to the canonical URL a redirect resolves
  // to, but records the alias it replaced in discovery_alias_url — because
  // the server keeps advertising that alias in PROPFIND discovery forever
  // afterward. selectedCreateBook matches the write-target by either URL, so
  // an interactive create discovers and PUTs through the alias; persisting
  // that discovered book must resolve back to the *existing* write-target
  // row (by discovery_alias_url), never insert a second, non-write-target
  // row for the same remote collection.
  it('routes a create through the discovery alias into the existing write-target row, never a duplicate', async () => {
    const fixture = createCarddavFixtureServer();
    await fixture.listen();
    const { userId, localBookId } = await seedConnectedUser(fixture);
    const canonicalUrl = new URL('/addressbooks/fixture-user/canonical/', fixture.serverUrl).href;
    const aliasUrl = new URL('/addressbooks/fixture-user/alias/', fixture.serverUrl).href;
    const { rows: [writeTargetBook] } = await databaseClient.query(`
      INSERT INTO address_books (
        user_id, name, source, external_url, discovery_alias_url,
        remote_create_capability, remote_update_capability, remote_delete_capability,
        is_write_target, is_subscribed, is_lookup_source
      ) VALUES ($1, 'Fixture Contacts', 'carddav', $2, $3, 'allowed', 'allowed', 'allowed', true, true, true)
      RETURNING id
    `, [userId, canonicalUrl, aliasUrl]);
    const uid = randomUUID();

    try {
      resetObservation(fixture);
      fixture.queueDiscovery({ books: [{ href: '/addressbooks/fixture-user/alias/', displayName: 'Alias Book' }] });
      const created = await contactService.createContactFromVCard(userId, {
        localAddressBookId: localBookId,
        uid,
        rawVCard: vcard(uid, 'Alias Routed Create'),
      });

      const { rows: books } = await databaseClient.query(`
        SELECT id, external_url, discovery_alias_url, is_write_target,
               remote_update_capability
        FROM address_books
        WHERE user_id = $1 AND source = 'carddav'
      `, [userId]);
      // Still exactly one carddav book — the pre-existing write-target row,
      // untouched — never a second, non-write-target row for the alias URL.
      expect(books).toEqual([{
        id: writeTargetBook.id,
        external_url: canonicalUrl,
        discovery_alias_url: aliasUrl,
        is_write_target: true,
        remote_update_capability: 'allowed',
      }]);
      const afterCreate = await authoritativeState(userId);
      // Mapped into that same write-target row: assertWritable's
      // mapping_is_write_target check (carddavContactService.js) reads this
      // join, so this contact is not stranded on a stray non-target
      // duplicate that would reject every future update/delete as read-only.
      expect(afterCreate.remoteObjects).toEqual([
        expect.objectContaining({
          address_book_id: writeTargetBook.id,
          local_contact_id: created.id,
        }),
      ]);
      expectNoNetworkInsideTransactions();
    } finally {
      await fixture.close();
    }
  }, 120_000);

  // multi-book-design.md, key decision 3: an incidental cleanup of a harvested
  // sender must not publish it. The edit lands locally and the contact stays
  // auto-collected, so the next sync's export sweep (which only claims
  // is_auto = false contacts) still passes it over.
  it('keeps an edited harvested contact auto-collected and writes nothing remote', async () => {
    const fixture = createCarddavFixtureServer();
    await fixture.listen();
    const seeded = await seedAutoContact(fixture);

    try {
      resetObservation(fixture);
      const updated = await contactService.updateContact(
        seeded.userId,
        seeded.contact.id,
        { displayName: 'Harvested Renamed', organization: 'Tidied Up' },
      );

      expect(updated).toMatchObject({
        id: seeded.contact.id,
        display_name: 'Harvested Renamed',
        organization: 'Tidied Up',
        is_auto: true,
      });
      const after = await authoritativeState(seeded.userId);
      expect(after.contacts).toEqual([
        expect.objectContaining({ id: seeded.contact.id, is_auto: true }),
      ]);
      expect(after.remoteObjects).toEqual([]);
      expect(fixture.counters.requests).toBe(0);
      expectNoNetworkInsideTransactions();
    } finally {
      await fixture.close();
    }
  }, 120_000);

  // Promotion is the one deliberate action that makes a harvested contact
  // explicit, and it lands in the designated write-target — never in the first
  // create-capable book discovery happens to return (that was the wrong-book
  // footgun). The local is_auto flip is remote-first: it commits only after the
  // PUT is read back and confirmed.
  it('promotes a harvested contact into the write-target book, never a sibling book', async () => {
    const fixture = createCarddavFixtureServer();
    await fixture.listen();
    const seeded = await seedAutoContact(fixture, { isWriteTarget: false });
    const writeTargetPath = '/addressbooks/fixture-user/shared/';
    const writeTargetUrl = new URL(writeTargetPath, fixture.serverUrl).href;
    const { rows: [writeTargetBook] } = await databaseClient.query(`
      INSERT INTO address_books (
        user_id, name, source, external_url,
        remote_create_capability, remote_update_capability, remote_delete_capability,
        is_write_target, is_subscribed, is_lookup_source
      ) VALUES ($1, 'Shared Contacts', 'carddav', $2, 'allowed', 'allowed', 'allowed', true, true, true)
      RETURNING id
    `, [seeded.userId, writeTargetUrl]);

    try {
      resetObservation(fixture);
      // Discovery returns the sibling book FIRST: only the stored write-target
      // flag stands between this contact and the wrong book.
      fixture.queueDiscovery({ books: [
        { href: '/addressbooks/fixture-user/contacts/', displayName: 'Fixture Contacts' },
        { href: writeTargetPath, displayName: 'Shared Contacts' },
      ] });
      const promoted = await contactService.promoteContact(seeded.userId, seeded.contact.id);

      expect(promoted).toMatchObject({ id: seeded.contact.id, is_auto: false });
      const put = fixture.requests.filter(request => request.method === 'PUT');
      expect(put).toHaveLength(1);
      expect(put[0].path).toBe(`${writeTargetPath}${seeded.uid}.vcf`);
      expect(fixture.counters.create).toBe(1);

      const after = await authoritativeState(seeded.userId);
      expect(after.contacts).toEqual([
        expect.objectContaining({ id: seeded.contact.id, is_auto: false }),
      ]);
      expect(after.remoteObjects).toEqual([
        expect.objectContaining({
          address_book_id: writeTargetBook.id,
          href: new URL(`${seeded.uid}.vcf`, writeTargetUrl).href,
          local_contact_id: seeded.contact.id,
          mapping_status: 'synced',
        }),
      ]);
      expect(after.conflicts).toEqual([]);
      expectNoNetworkInsideTransactions();
    } finally {
      await fixture.close();
    }
  }, 120_000);

  // Promotion is the deliberate act that makes a harvested contact the user's own,
  // so it records the publish intent the export sweep gates on. Without that the
  // contact would be relying on the publish-emailed-contacts setting — OFF here,
  // as it is by default — to stay in the address book it was just added to.
  it('records publish intent when promoting, independently of the emailed-contacts setting', async () => {
    const fixture = createCarddavFixtureServer();
    await fixture.listen();
    const seeded = await seedAutoContact(fixture);

    try {
      resetObservation(fixture);
      const promoted = await contactService.promoteContact(seeded.userId, seeded.contact.id);

      expect(promoted).toMatchObject({ id: seeded.contact.id, is_auto: false });
      expect(fixture.requests.filter(request => request.method === 'PUT')).toHaveLength(1);

      const { rows: [row] } = await databaseClient.query(
        'SELECT is_auto, carddav_publish_intent FROM contacts WHERE id = $1',
        [seeded.contact.id],
      );
      expect(row).toEqual({ is_auto: false, carddav_publish_intent: true });
      expectNoNetworkInsideTransactions();
    } finally {
      await fixture.close();
    }
  }, 120_000);

  // The book is fully create-capable on the server, so only the missing
  // write-target designation refuses this promotion — no silent fallback to
  // "some other writable book", and no local is_auto flip without a remote.
  it('refuses to promote without a write-target and leaves the contact harvested', async () => {
    const fixture = createCarddavFixtureServer();
    await fixture.listen();
    const seeded = await seedAutoContact(fixture, { isWriteTarget: false });

    try {
      resetObservation(fixture);
      const before = await authoritativeState(seeded.userId);
      fixture.queueDiscovery({ books: [
        { href: '/addressbooks/fixture-user/contacts/', displayName: 'Fixture Contacts' },
      ] });
      await expect(contactService.promoteContact(seeded.userId, seeded.contact.id))
        .rejects.toMatchObject({ code: 'ERR_CARDDAV_NO_WRITE_TARGET' });

      expect(await authoritativeState(seeded.userId)).toEqual(before);
      expect(fixture.counters.create).toBe(0);
      expect(fixture.requests.some(request => request.method === 'PUT')).toBe(false);
      expectNoNetworkInsideTransactions();
    } finally {
      await fixture.close();
    }
  }, 120_000);

  it('atomically resolves concurrent mapped create-only requests for one book and UID', async () => {
    const fixture = createCarddavFixtureServer();
    await fixture.listen();
    const { userId, localBookId } = await seedConnectedUser(fixture);
    await seedWriteTargetBook(fixture, userId);
    const uid = randomUUID();
    let preflightCommits = 0;
    let releasePreflightCommits;
    const bothPreflightCommits = new Promise(resolve => { releasePreflightCommits = resolve; });

    try {
      resetObservation(fixture);
      afterCommit = async () => {
        preflightCommits++;
        if (preflightCommits === 2) {
          afterCommit = null;
          releasePreflightCommits();
        }
        await bothPreflightCommits;
      };
      const createOnly = () => contactService.createContactFromVCard(userId, {
        localAddressBookId: localBookId,
        uid,
        rawVCard: vcard(uid, 'Concurrent Remote Create'),
        expectedAbsent: true,
      });

      const outcomes = await Promise.allSettled([createOnly(), createOnly()]);
      const statuses = outcomes.map(outcome => (
        outcome.status === 'fulfilled'
          ? 201
          : outcome.reason.code === 'ERR_LOCAL_PRECONDITION_FAILED' ? 412 : null
      )).sort();
      const after = await authoritativeState(userId);
      const putRequests = fixture.requests.filter(request => request.method === 'PUT');

      expect(statuses).toEqual([201, 412]);
      expect(after.contacts).toEqual([
        expect.objectContaining({ address_book_id: localBookId, uid }),
      ]);
      expect(after.remoteObjects).toEqual([
        expect.objectContaining({
          local_contact_id: after.contacts[0].id,
          href: fixture.href(`${uid}.vcf`),
          mapping_status: 'synced',
        }),
      ]);
      expect(after.conflicts).toEqual([]);
      expect(fixture.counters).toMatchObject({
        requests: 9,
        propfind: 6,
        create: 1,
        update: 0,
        delete: 0,
        fetch: 1,
      });
      expect(putRequests).toHaveLength(2);
      expect(putRequests).toEqual([
        expect.objectContaining({
          path: new URL(fixture.href(`${uid}.vcf`)).pathname,
          ifMatch: undefined,
          ifNoneMatch: '*',
        }),
        expect.objectContaining({
          path: new URL(fixture.href(`${uid}.vcf`)).pathname,
          ifMatch: undefined,
          ifNoneMatch: '*',
        }),
      ]);
      expectNoNetworkInsideTransactions();
    } finally {
      afterCommit = null;
      await fixture.close();
    }
  }, 120_000);

  it('rejects a stale local ETag before HTTP and preserves all authoritative rows', async () => {
    const fixture = createCarddavFixtureServer();
    await fixture.listen();
    const seeded = await seedMappedContact(fixture);

    try {
      resetObservation(fixture);
      const before = await authoritativeState(seeded.userId);
      await expect(contactService.replaceContactFromVCard(seeded.userId, {
        localAddressBookId: seeded.localBookId,
        uid: seeded.uid,
        rawVCard: vcard(seeded.uid, 'Rejected Local ETag'),
        expectedLocalEtag: 'stale-local-etag',
      })).rejects.toMatchObject({ code: 'ERR_LOCAL_ETAG_MISMATCH' });
      expect(await authoritativeState(seeded.userId)).toEqual(before);
      expect(fixture.counters.requests).toBe(0);
      expectNoNetworkInsideTransactions();
    } finally {
      await fixture.close();
    }
  });

  // A subscribed or lookup secondary stays read-only from MailFlow even when
  // the remote server advertises full mutation capability.
  it('never PUTs or DELETEs a contact mapped into a book that is not the write-target', async () => {
    const fixture = createCarddavFixtureServer();
    await fixture.listen();
    const seeded = await seedMappedContact(fixture, 'Secondary Mapped', { isWriteTarget: false });

    try {
      resetObservation(fixture);
      const before = await authoritativeState(seeded.userId);
      await expect(contactService.updateContact(
        seeded.userId,
        seeded.contact.id,
        draft('Rejected Secondary Edit', `${seeded.uid}@example.test`),
      )).rejects.toMatchObject({ code: 'ERR_CARDDAV_READ_ONLY' });
      expect(await authoritativeState(seeded.userId)).toEqual(before);
      expect(fixture.counters.requests).toBe(0);

      await expect(contactService.deleteContact(seeded.userId, seeded.contact.id))
        .rejects.toMatchObject({ code: 'ERR_CARDDAV_READ_ONLY' });
      expect(await authoritativeState(seeded.userId)).toEqual(before);
      expect(fixture.counters.requests).toBe(0);
      expectNoNetworkInsideTransactions();
    } finally {
      await fixture.close();
    }
  });
  // The recovery fetch after a 412 must reject a malformed or oversized remote
  // snapshot before it can persist.
  it.each([
    {
      label: 'malformed remote snapshot',
      remoteVCard: () => 'not a vCard',
      expectedError: /BEGIN:VCARD/,
    },
    {
      label: 'oversized remote snapshot',
      remoteVCard: uid => sizedVCard(uid, MAX_VCARD_BYTES + 1),
      expectedError: /1 MiB/,
    },
  ])('handles mapped 412 with $label before forbidden persistence', async ({
    remoteVCard,
    expectedError,
  }) => {
    const fixture = createCarddavFixtureServer();
    await fixture.listen();
    const seeded = await seedMappedContact(fixture);
    const rejected = vcard(seeded.uid, 'Rejected Local');
    const latest = remoteVCard(seeded.uid);

    try {
      resetObservation(fixture);
      const before = await authoritativeState(seeded.userId);
      fixture.putContact(seeded.href, '"remote-2"', latest);
      fixture.queueWrite('PUT', { status: 412 });

      const error = await contactService.replaceContactFromVCard(seeded.userId, {
        localAddressBookId: seeded.localBookId,
        uid: seeded.uid,
        rawVCard: rejected,
        expectedLocalEtag: seeded.contact.etag,
      }).catch(value => value);

      const after = await authoritativeState(seeded.userId);
      expect(error.message).toMatch(expectedError);
      expect(after.addressBooks).toEqual(before.addressBooks);
      expect(after.contacts).toEqual(before.contacts);
      expect(after.remoteObjects).toEqual([{
        ...before.remoteObjects[0],
        mapping_status: 'pending_push',
        mapping_revision: '1',
      }]);
      // For an unmapped-property-free client body overlaid onto a matching retained
      // document, the overlay reproduces the client body byte-for-byte, so the
      // pending intent snapshots exactly what the client sent.
      expect(await pendingIntentState(seeded.userId)).toEqual([
        expect.objectContaining({
          href: seeded.href,
          pending_operation: 'update',
          pending_vcard: rejected,
          pending_local_hash: expect.any(String),
          pending_remote_semantic_hash: expect.any(String),
          pending_started: true,
        }),
      ]);
      expect(after.conflicts).toEqual([]);
      expect(fixture.counters.requests).toBe(2);
      expectNoNetworkInsideTransactions();
    } finally {
      await fixture.close();
    }
  }, 120_000);

  it('rolls back final SQL when the mapping revision changes after remote update', async () => {
    const fixture = createCarddavFixtureServer();
    await fixture.listen();
    const seeded = await seedMappedContact(fixture);

    try {
      resetObservation(fixture);
      const before = await authoritativeState(seeded.userId);
      beforeBegin = async () => {
        if (fixture.counters.update !== 1) return;
        beforeBegin = null;
        await databaseClient.query(`
          UPDATE carddav_remote_objects
          SET mapping_revision = mapping_revision + 1
          WHERE address_book_id = $1 AND href = $2
        `, [seeded.remoteBookId, seeded.href]);
      };

      await expect(contactService.updateContact(
        seeded.userId,
        seeded.contact.id,
        draft('Rejected Mapping Revision', `${seeded.uid}@example.test`),
      )).rejects.toBeInstanceOf(contactService.CardDavAmbiguousWriteError);

      const after = await authoritativeState(seeded.userId);
      expect(after.addressBooks).toEqual(before.addressBooks);
      expect(after.contacts).toEqual(before.contacts);
      expect(after.remoteObjects).toEqual([{
        ...before.remoteObjects[0],
        mapping_status: 'pending_push',
        mapping_revision: String(Number(before.remoteObjects[0].mapping_revision) + 2),
      }]);
      expect(after.conflicts).toEqual(before.conflicts);
      expect(await pendingIntentState(seeded.userId)).toEqual([
        expect.objectContaining({
          href: seeded.href,
          pending_operation: 'update',
          pending_vcard: expect.stringContaining('FN:Rejected Mapping Revision'),
          pending_local_hash: expect.any(String),
          pending_remote_semantic_hash: expect.any(String),
          pending_started: true,
        }),
      ]);
      expect(fixture.counters).toMatchObject({
        requests: 2,
        update: 1,
        fetch: 1,
      });
      const updateRequest = fixture.requests.find(request => request.method === 'PUT');
      expect(updateRequest.ifMatch).toBe(seeded.remoteEtag);
      expectNoNetworkInsideTransactions();
    } finally {
      await fixture.close();
    }
  });

  it('fences throttle rollback when the connection changes after the 429', async () => {
    const fixture = createCarddavFixtureServer();
    await fixture.listen();
    const seeded = await seedMappedContact(fixture);
    const replacementGeneration = randomUUID();

    try {
      resetObservation(fixture);
      const before = await authoritativeState(seeded.userId);
      fixture.queueWrite('PUT', {
        status: 429,
        headers: { 'Retry-After': '120' },
      });
      let beginCount = 0;
      beforeBegin = async () => {
        beginCount++;
        if (beginCount !== 2) return;
        beforeBegin = null;
        await databaseClient.query(`
          UPDATE user_integrations
          SET config = jsonb_set(
            config, '{connectionGeneration}', to_jsonb($2::text), true
          ), updated_at = NOW()
          WHERE user_id = $1 AND provider = 'carddav'
        `, [seeded.userId, replacementGeneration]);
      };

      const error = await contactService.updateContact(
        seeded.userId,
        seeded.contact.id,
        draft('Replaced During Throttle', `${seeded.uid}@example.test`),
      ).catch(result => result);

      expect(error).toMatchObject({ code: 'ERR_CARDDAV_FINAL_FENCE' });
      const after = await authoritativeState(seeded.userId);
      expect(after.addressBooks).toEqual(before.addressBooks);
      expect(after.contacts).toEqual(before.contacts);
      expect(after.remoteObjects).toEqual([{
        ...before.remoteObjects[0],
        mapping_status: 'pending_push',
        mapping_revision: String(Number(before.remoteObjects[0].mapping_revision) + 1),
      }]);
      expect(after.conflicts).toEqual(before.conflicts);
      expect(await pendingIntentState(seeded.userId)).toEqual([
        expect.objectContaining({
          href: seeded.href,
          pending_operation: 'update',
          pending_vcard: expect.stringContaining('FN:Replaced During Throttle'),
          pending_local_hash: expect.any(String),
          pending_remote_semantic_hash: expect.any(String),
          pending_started: true,
        }),
      ]);
      const { rows: [integration] } = await databaseClient.query(`
        SELECT config FROM user_integrations
        WHERE user_id = $1 AND provider = 'carddav'
      `, [seeded.userId]);
      expect(integration.config).toMatchObject({
        connectionGeneration: replacementGeneration,
      });
      expect(integration.config).not.toHaveProperty('retryAfterAt');
      expect(fixture.requests.map(request => request.method)).toEqual(['PUT']);
      expectNoNetworkInsideTransactions();
    } finally {
      beforeBegin = null;
      await fixture.close();
    }
  });

  it('rolls back a forced final transaction failure after one confirmed remote update', async () => {
    const fixture = createCarddavFixtureServer();
    await fixture.listen();
    const seeded = await seedMappedContact(fixture);

    await databaseClient.query(`
      CREATE FUNCTION fail_carddav_contact_update() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.display_name = 'Forced Final Failure' THEN
          RAISE EXCEPTION 'forced final transaction failure';
        END IF;
        RETURN NEW;
      END
      $$
    `);
    await databaseClient.query(`
      CREATE TRIGGER fail_carddav_contact_update
      BEFORE UPDATE ON contacts
      FOR EACH ROW EXECUTE FUNCTION fail_carddav_contact_update()
    `);

    try {
      resetObservation(fixture);
      const before = await authoritativeState(seeded.userId);
      await expect(contactService.updateContact(
        seeded.userId,
        seeded.contact.id,
        draft('Forced Final Failure', `${seeded.uid}@example.test`),
      )).rejects.toBeInstanceOf(contactService.CardDavAmbiguousWriteError);

      const after = await authoritativeState(seeded.userId);
      expect(after.addressBooks).toEqual(before.addressBooks);
      expect(after.contacts).toEqual(before.contacts);
      expect(after.remoteObjects).toEqual([{
        ...before.remoteObjects[0],
        mapping_status: 'pending_push',
        mapping_revision: String(Number(before.remoteObjects[0].mapping_revision) + 1),
      }]);
      expect(after.conflicts).toEqual(before.conflicts);
      expect(await pendingIntentState(seeded.userId)).toEqual([
        expect.objectContaining({
          href: seeded.href,
          pending_operation: 'update',
          pending_vcard: expect.stringContaining('FN:Forced Final Failure'),
          pending_local_hash: expect.any(String),
          pending_remote_semantic_hash: expect.any(String),
          pending_started: true,
        }),
      ]);
      expect(fixture.counters).toMatchObject({
        requests: 2,
        update: 1,
        fetch: 1,
      });
      const updateRequest = fixture.requests.find(request => request.method === 'PUT');
      expect(updateRequest.ifMatch).toBe(seeded.remoteEtag);
      expectNoNetworkInsideTransactions();
    } finally {
      await databaseClient.query('DROP TRIGGER fail_carddav_contact_update ON contacts');
      await databaseClient.query('DROP FUNCTION fail_carddav_contact_update()');
      await fixture.close();
    }
  });

  it('retains unmodeled remote vCard properties when editing a sync-imported contact', async () => {
    const fixture = createCarddavFixtureServer();
    await fixture.listen();
    const remoteVCard = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'UID:remote-server-uid-123',
      'FN:Imported Person',
      'EMAIL:imported@example.test',
      'CATEGORIES:Friends,VIP',
      'X-CUSTOM-FLAG:keep-me',
      'TZ:America/New_York',
      'END:VCARD',
      '',
    ].join('\r\n');
    const seeded = await seedImportedContact(fixture, remoteVCard);

    try {
      // Sanity: the lossy local vCard dropped the unmodeled properties the pull
      // never modeled, so the retained mapping vCard is the only lossless copy.
      expect(seeded.localVCard).not.toContain('CATEGORIES');
      expect(seeded.localVCard).not.toContain('X-CUSTOM-FLAG');
      expect(seeded.localVCard).not.toContain('TZ:');

      resetObservation(fixture);
      const updated = await contactService.updateContact(
        seeded.userId,
        seeded.contact.id,
        { displayName: 'Imported Renamed' },
      );
      expect(updated.display_name).toBe('Imported Renamed');

      const putRequest = fixture.requests.find(request => request.method === 'PUT');
      expect(putRequest).toBeDefined();
      // The user's edit landed on the remote resource...
      expect(putRequest.body).toContain('FN:Imported Renamed');
      // ...and the unmodeled remote properties survived the round-trip.
      expect(putRequest.body).toContain('CATEGORIES:Friends,VIP');
      expect(putRequest.body).toContain('X-CUSTOM-FLAG:keep-me');
      expect(putRequest.body).toContain('TZ:America/New_York');

      const after = await authoritativeState(seeded.userId);
      expect(after.conflicts).toEqual([]);
      expect(await pendingIntentState(seeded.userId)).toEqual([]);
      // The confirmed local + mapping vCards now both retain the properties too.
      expect(after.contacts[0].vcard).toContain('CATEGORIES:Friends,VIP');
      expect(after.remoteObjects[0].vcard).toContain('X-CUSTOM-FLAG:keep-me');
      expectNoNetworkInsideTransactions();
    } finally {
      await fixture.close();
    }
  }, 120_000);

  it('merges a native client replace: modeled full-state, unmodeled name-level, remote UID kept', async () => {
    const fixture = createCarddavFixtureServer();
    await fixture.listen();
    const remoteUid = 'remote-server-uid-777';
    const remoteVCard = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      `UID:${remoteUid}`,
      'FN:Native Person',
      'EMAIL:native@example.test',
      'ORG:Remote Org',
      'CATEGORIES:Colleagues,Board',
      'X-SURVIVE-ME:keep-this',
      'TZ:Europe/Berlin',
      'END:VCARD',
      '',
    ].join('\r\n');
    const seeded = await seedImportedContact(fixture, remoteVCard);

    try {
      // A native client renamed the contact, CHANGED an unmodeled property (CATEGORIES),
      // ADDED one (X-CLIENT-NOTE), round-tripped TZ, and — as a stripping client would —
      // dropped an unmodeled property (X-SURVIVE-ME) AND a modeled one (ORG).
      const clientBody = [
        'BEGIN:VCARD',
        'VERSION:3.0',
        `UID:${seeded.uid}`,
        'FN:Native Renamed',
        'EMAIL:native@example.test',
        'CATEGORIES:Colleagues,VIP',
        'TZ:Europe/Berlin',
        'X-CLIENT-NOTE:added-by-client',
        'END:VCARD',
        '',
      ].join('\r\n');

      resetObservation(fixture);
      const replaced = await contactService.replaceContactFromVCard(seeded.userId, {
        localAddressBookId: seeded.localBookId,
        uid: seeded.uid,
        rawVCard: clientBody,
        expectedLocalEtag: seeded.contact.etag,
      });
      expect(replaced.display_name).toBe('Native Renamed');

      const putRequest = fixture.requests.find(request => request.method === 'PUT');
      expect(putRequest).toBeDefined();
      // Unmodeled: names present in the client body win (edit + add reach the remote)...
      expect(putRequest.body).toContain('FN:Native Renamed');
      expect(putRequest.body).toContain('CATEGORIES:Colleagues,VIP');
      expect(putRequest.body).toContain('X-CLIENT-NOTE:added-by-client');
      expect(putRequest.body).toContain('TZ:Europe/Berlin');
      // ...and a name the stripping client OMITTED survives from the retained document.
      expect(putRequest.body).toContain('X-SURVIVE-ME:keep-this');
      // Modeled: full-state from the client, so the omitted ORG is removed.
      expect(putRequest.body).not.toContain('ORG:');
      // The outgoing document keeps the remote-owned UID, never the local key.
      expect(contactFromVCardDocument(parseVCardDocument(putRequest.body)).uid).toBe(remoteUid);

      const after = await authoritativeState(seeded.userId);
      expect(after.conflicts).toEqual([]);
      expect(await pendingIntentState(seeded.userId)).toEqual([]);
      expect(contactFromVCardDocument(parseVCardDocument(after.remoteObjects[0].vcard)).uid)
        .toBe(remoteUid);
      expect(after.remoteObjects[0].vcard).toContain('X-SURVIVE-ME:keep-this');
      expect(after.contacts[0].uid).toBe(seeded.uid);
      expectNoNetworkInsideTransactions();
    } finally {
      await fixture.close();
    }
  }, 120_000);

  // Seed a mapped contact whose retained document has `retainedProps`, PUT a client body
  // whose extra lines are `clientProps` (FN/EMAIL held constant so only the merge varies),
  // and return the outgoing PUT document.
  async function mappedReplacePut(fixture, retainedProps, clientProps) {
    const remoteVCard = [
      'BEGIN:VCARD', 'VERSION:3.0', 'UID:merge-remote-uid', 'FN:Merge Person',
      'EMAIL:merge@example.test', ...retainedProps, 'END:VCARD', '',
    ].join('\r\n');
    const seeded = await seedImportedContact(fixture, remoteVCard);
    const clientBody = [
      'BEGIN:VCARD', 'VERSION:3.0', `UID:${seeded.uid}`, 'FN:Merge Person',
      'EMAIL:merge@example.test', ...clientProps, 'END:VCARD', '',
    ].join('\r\n');
    resetObservation(fixture);
    await contactService.replaceContactFromVCard(seeded.userId, {
      localAddressBookId: seeded.localBookId, uid: seeded.uid,
      rawVCard: clientBody, expectedLocalEtag: seeded.contact.etag,
    });
    return parseVCardDocument(fixture.requests.find(request => request.method === 'PUT').body);
  }

  it('merges repeated unmodeled instances all-or-nothing per property name', async () => {
    const fixture = createCarddavFixtureServer();
    await fixture.listen();
    try {
      // Client submits ONE X-CUSTOM-TAG → exactly the client's one on the wire (its full
      // instance set replaces the retained set for that name).
      const replaced = await mappedReplacePut(
        fixture,
        ['X-CUSTOM-TAG:one', 'X-CUSTOM-TAG:two', 'X-CUSTOM-TAG:three'],
        ['X-CUSTOM-TAG:only'],
      );
      const tags = replaced.properties.filter(p => p.name === 'X-CUSTOM-TAG').map(p => p.rawValue);
      expect(tags).toEqual(['only']);
    } finally {
      await fixture.close();
    }
  }, 120_000);

  it('keeps all retained instances of a name the client omits', async () => {
    const fixture = createCarddavFixtureServer();
    await fixture.listen();
    try {
      const replaced = await mappedReplacePut(
        fixture,
        ['X-CUSTOM-TAG:one', 'X-CUSTOM-TAG:two', 'X-CUSTOM-TAG:three'],
        [],
      );
      const tags = replaced.properties.filter(p => p.name === 'X-CUSTOM-TAG').map(p => p.rawValue);
      expect(tags).toEqual(['one', 'two', 'three']);
    } finally {
      await fixture.close();
    }
  }, 120_000);

  it('survives a grouped unmodeled property with its whole item group, including X-ABLABEL', async () => {
    const fixture = createCarddavFixtureServer();
    await fixture.listen();
    try {
      // Client (stripping) omits the whole grouped unmodeled property.
      const replaced = await mappedReplacePut(
        fixture,
        ['item1.X-CUSTOM-FIELD:custom-value', 'item1.X-ABLABEL:Custom Label'],
        [],
      );
      const field = replaced.properties.find(p => p.name === 'X-CUSTOM-FIELD');
      const label = replaced.properties.find(p => p.name === 'X-ABLABEL');
      expect(field?.rawValue).toBe('custom-value');
      // The whole group survives atomically — the label is not orphaned away.
      expect(label?.rawValue).toBe('Custom Label');
      expect(field.group.toLowerCase()).toBe(label.group.toLowerCase());
    } finally {
      await fixture.close();
    }
  }, 120_000);

  it('re-prefixes a surviving group that collides with a group the client body reuses', async () => {
    const fixture = createCarddavFixtureServer();
    await fixture.listen();
    try {
      // Retained item1 is an unmodeled grouped survivor the client omits; the client reuses
      // item1 for its own modeled Additional field (URL). The survivor must move off item1.
      const replaced = await mappedReplacePut(
        fixture,
        ['item1.X-CUSTOM-FIELD:custom-value', 'item1.X-ABLABEL:Custom Label'],
        ['item1.URL:https://client.example.test/', 'item1.X-ABLABEL:Client Link'],
      );
      const field = replaced.properties.find(p => p.name === 'X-CUSTOM-FIELD');
      const url = replaced.properties.find(p => p.name === 'URL');
      expect(field?.rawValue).toBe('custom-value');
      expect(url?.rawValue).toContain('client.example.test');
      // The client keeps item1; the surviving group is re-prefixed to a different group.
      expect(url.group.toLowerCase()).toBe('item1');
      expect(field.group.toLowerCase()).not.toBe('item1');
      // ...and it carries its own label under the new prefix.
      const survivorLabel = replaced.properties.find(
        p => p.name === 'X-ABLABEL' && p.group?.toLowerCase() === field.group.toLowerCase());
      expect(survivorLabel?.rawValue).toBe('Custom Label');
    } finally {
      await fixture.close();
    }
  }, 120_000);

  it('does not duplicate the modeled main when a mixed Apple item-group survives', async () => {
    const fixture = createCarddavFixtureServer();
    await fixture.listen();
    try {
      // Standard Apple layout: a MODELED main (ADR) grouped with an unmodeled sibling
      // (X-ABADR) and its label. The client edits the ADR and, as a stripping client,
      // omits the X-ABADR it does not understand.
      const replaced = await mappedReplacePut(
        fixture,
        ['item1.ADR:;;123 Old St;;;;', 'item1.X-ABADR:us', 'item1.X-ABLABEL:Home'],
        ['item1.ADR:;;456 New Ave;;;;', 'item1.X-ABLABEL:Home'],
      );
      // Exactly ONE ADR on the wire — the client's; the retained modeled main is NOT
      // re-emitted alongside it (no duplicate address).
      const adrs = replaced.properties.filter(p => p.name === 'ADR');
      expect(adrs).toHaveLength(1);
      expect(adrs[0].rawValue).toContain('456 New Ave');
      // The unmodeled annotation and its label still survive (accepted: possibly stale).
      const abadr = replaced.properties.find(p => p.name === 'X-ABADR');
      expect(abadr?.rawValue).toBe('us');
      const survivorLabel = replaced.properties.find(
        p => p.name === 'X-ABLABEL' && p.group?.toLowerCase() === abadr.group?.toLowerCase());
      expect(survivorLabel?.rawValue).toBe('Home');
    } finally {
      await fixture.close();
    }
  }, 120_000);

  function listContacts(userId, query) {
    const handler = contactsRouter.stack
      .find(layer => layer.route?.path === '/' && layer.route.methods.get)
      .route.stack.at(-1).handle;
    return new Promise((resolve, reject) => {
      handler(
        { query, session: { userId } },
        {
          json: resolve,
          status: () => ({ json: body => reject(new Error(JSON.stringify(body))) }),
        },
      ).catch(reject);
    });
  }

  // Contacts that all tie on the list's sort key (no name, no email, same is_auto and
  // send_count) — the tie is what an unstable sort resolves differently per window.
  async function seedTiedContacts(userId, size) {
    const { rows: [book] } = await databaseClient.query(
      "INSERT INTO address_books (user_id, name) VALUES ($1, 'Paging') RETURNING id",
      [userId],
    );
    await databaseClient.query(`
      INSERT INTO contacts (address_book_id, user_id, uid, vcard, etag, is_auto, send_count)
      SELECT $1, $2, 'page-' || i, 'BEGIN:VCARD\r\nEND:VCARD', 'etag-' || i, false, 0
      FROM generate_series(1, $3) AS i
    `, [book.id, userId, size]);
  }

  // LIMIT/OFFSET over an ORDER BY with no unique tiebreaker leaves windows free to
  // overlap, which drops rows from the union — a contact no amount of paging can reach.
  it('pages contacts into disjoint windows that reach every contact', async () => {
    const userId = await seedUser();
    // The production book's size: enough rows that PostgreSQL plans the deeper offsets
    // differently from the first window, which is when an unstable sort reorders ties.
    const size = 900;
    const pageSize = 100;
    await seedTiedContacts(userId, size);

    const windows = [];
    for (let offset = 0; offset < size; offset += pageSize) {
      windows.push(await listContacts(userId, { limit: pageSize, offset }));
    }

    const ids = windows.flatMap(page => page.contacts.map(contact => contact.id));
    expect(windows.every(page => page.total === size)).toBe(true);
    expect(windows.every(page => page.contacts.length === pageSize)).toBe(true);
    expect(ids).toHaveLength(size);
    expect(new Set(ids).size).toBe(size);
  }, 120_000);

  it('returns a stable window for a repeated offset and stops past the end', async () => {
    const userId = await seedUser();
    await seedTiedContacts(userId, 120);

    const [first, repeat, past] = await Promise.all([
      listContacts(userId, { limit: 50, offset: 50 }),
      listContacts(userId, { limit: 50, offset: 50 }),
      listContacts(userId, { limit: 50, offset: 120 }),
    ]);

    expect(repeat.contacts.map(contact => contact.id))
      .toEqual(first.contacts.map(contact => contact.id));
    expect(past.contacts).toEqual([]);
    expect(past.total).toBe(120);
  }, 120_000);
});
