import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  applyTestMigrations,
  assertMinimumPostgresVersion,
  createTestDatabase,
  dropTestDatabase,
  postgresTestContext,
  waitForPostgresState,
} from './postgresTestHelpers.js';

const mocks = vi.hoisted(() => ({
  decrypt: vi.fn(value => value),
  discoverAddressBooks: vi.fn(),
  fetchAddressBookDelta: vi.fn(),
  getConnectionPolicy: vi.fn(async () => ({ allowPrivateHosts: false })),
  parseVCard: vi.fn(),
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
  discoverAddressBooks: mocks.discoverAddressBooks,
  fetchAddressBookDelta: mocks.fetchAddressBookDelta,
}));
vi.mock('../utils/vcard.js', async importOriginal => {
  const original = await importOriginal();
  mocks.parseVCard.mockImplementation(original.parseVCard);
  return { ...original, parseVCard: mocks.parseVCard };
});

const carddavSync = await import('./carddavSync.js');
const carddavMappingState = await import('./carddavMappingState.js');
const { generateVCard } = await vi.importActual('../utils/vcard.js');
const {
  localContactHash,
  parseVCardDocument,
  semanticVCardHash,
} = await vi.importActual('../utils/vcardProperties.js');
const { Client } = pg;

const USER_ID = '00000000-0000-4000-8000-000000000001';
const BOOK_URL = 'https://dav.example.test/addressbooks/default/';
const CONNECTION_GENERATION = 'generation-current';

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

const { databaseUrl, connectionStringFor } = postgresTestContext('CardDAV transaction tests');
const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), '../../migrations');
const databaseName = `carddav_sync_${process.pid}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
let adminClient;
let databaseClient;

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function applyMigrations(client, through = '0035') {
  await applyTestMigrations(client, { migrationsDirectory, through });
}

async function beginApply(plan, queryOverride) {
  await databaseClient.query('BEGIN');
  try {
    const client = queryOverride
      ? { query: (sql, params) => queryOverride(databaseClient, sql, params) }
      : databaseClient;
    const result = await carddavSync.applyBookDelta(client, plan);
    await databaseClient.query('COMMIT');
    return result;
  } catch (error) {
    await databaseClient.query('ROLLBACK');
    throw error;
  }
}

function useDatabaseTransactions(queryOverride) {
  mocks.withTransaction.mockImplementation(async callback => {
    await databaseClient.query('BEGIN');
    try {
      const client = queryOverride
        ? { query: (sql, params) => queryOverride(databaseClient, sql, params) }
        : databaseClient;
      const result = await callback(client);
      await databaseClient.query('COMMIT');
      return result;
    } catch (error) {
      await databaseClient.query('ROLLBACK');
      throw error;
    }
  });
}

async function persistedState(userId = USER_ID) {
  const { rows: books } = await databaseClient.query(`
    SELECT id, external_url, sync_token, remote_sync_token, remote_sync_capability,
           remote_sync_revision::text, remote_projection_fingerprint
    FROM address_books
    WHERE user_id = $1 AND source = 'carddav'
    ORDER BY external_url
  `, [userId]);
  const { rows: contacts } = await databaseClient.query(`
    SELECT address_book_id, uid, vcard, etag, display_name, first_name,
           last_name, primary_email, emails, phones, organization, notes, photo_data
    FROM contacts
    WHERE user_id = $1
    ORDER BY address_book_id, uid
  `, [userId]);
  const { rows: ledger } = await databaseClient.query(`
    SELECT o.address_book_id, o.href, o.remote_etag, o.vcard, o.primary_email, o.disposition,
           o.local_contact_id, o.merge_before, o.merge_applied
    FROM carddav_remote_objects o
    JOIN address_books b ON b.id = o.address_book_id
    WHERE b.user_id = $1
    ORDER BY o.href
  `, [userId]);
  const { rows: integrations } = await databaseClient.query(`
    SELECT provider, config
    FROM user_integrations
    WHERE user_id = $1 AND provider = 'carddav'
  `, [userId]);
  return { books, contacts, ledger, integrations };
}

async function persistedLifecycleState(userId) {
  const state = await persistedState(userId);
  const { rows: allBooks } = await databaseClient.query(`
    SELECT id, source, external_url, sync_token, remote_sync_token,
           remote_sync_capability, remote_sync_revision::text,
           remote_projection_fingerprint
    FROM address_books
    WHERE user_id = $1
    ORDER BY id
  `, [userId]);
  return { ...state, allBooks };
}

async function seedLifecycleUser() {
  const userId = randomUUID();
  const generation = randomUUID();
  const remoteUrl = `https://dav.example.test/addressbooks/${userId}/a/`;
  const secondRemoteUrl = `https://dav.example.test/addressbooks/${userId}/b/`;
  await databaseClient.query(
    'INSERT INTO users (id, username) VALUES ($1, $2)',
    [userId, `carddav-lifecycle-${userId}`],
  );
  await databaseClient.query(
    `INSERT INTO user_integrations (user_id, provider, config)
     VALUES ($1, 'carddav', jsonb_build_object(
       'connectionGeneration', $2::text,
       'lastError', 'before-error',
       'bookCount', 1,
       'contactCount', 1
     ))`,
    [userId, generation],
  );
  const { rows: [localBook] } = await databaseClient.query(
    "INSERT INTO address_books (user_id, name) VALUES ($1, 'Lifecycle Personal') RETURNING id, sync_token",
    [userId],
  );
  const { rows: [unrelatedBook] } = await databaseClient.query(
    "INSERT INTO address_books (user_id, name) VALUES ($1, 'Lifecycle Unrelated') RETURNING id, sync_token",
    [userId],
  );
  const targetVcard = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    'UID:lifecycle-target',
    'FN:Lifecycle Original',
    'EMAIL:lifecycle-duplicate@example.test',
    'END:VCARD',
    '',
  ].join('\r\n');
  const { rows: [target] } = await databaseClient.query(`
    INSERT INTO contacts (
      address_book_id, user_id, uid, vcard, etag, display_name, first_name,
      primary_email, emails, phones, is_auto
    ) VALUES (
      $1, $2, 'lifecycle-target', $3, $4, 'Lifecycle Original', 'Lifecycle',
      'lifecycle-duplicate@example.test', $5::jsonb, '[]'::jsonb, false
    )
    RETURNING id
  `, [
    localBook.id,
    userId,
    targetVcard,
    createHash('md5').update(targetVcard).digest('hex'),
    JSON.stringify([{
      value: 'lifecycle-duplicate@example.test', type: 'other', primary: true,
    }]),
  ]);
  const secondTargetVcard = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    'UID:lifecycle-target-b',
    'FN:Lifecycle Original B',
    'EMAIL:lifecycle-duplicate-b@example.test',
    'END:VCARD',
    '',
  ].join('\r\n');
  const { rows: [secondTarget] } = await databaseClient.query(`
    INSERT INTO contacts (
      address_book_id, user_id, uid, vcard, etag, display_name, first_name,
      primary_email, emails, phones, is_auto
    ) VALUES (
      $1, $2, 'lifecycle-target-b', $3, $4, 'Lifecycle Original B', 'Lifecycle',
      'lifecycle-duplicate-b@example.test', $5::jsonb, '[]'::jsonb, false
    )
    RETURNING id
  `, [
    localBook.id,
    userId,
    secondTargetVcard,
    createHash('md5').update(secondTargetVcard).digest('hex'),
    JSON.stringify([{
      value: 'lifecycle-duplicate-b@example.test', type: 'other', primary: true,
    }]),
  ]);
  const card = {
    ...remoteCard('lifecycle-remote', 'lifecycle-duplicate@example.test'),
    href: `${remoteUrl}lifecycle.vcf`,
  };
  const skippedCard = {
    ...remoteCard('lifecycle-b-skip', 'lifecycle-duplicate-b@example.test'),
    href: `${secondRemoteUrl}lifecycle-b-skip.vcf`,
  };
  const separateCard = {
    ...remoteCard('lifecycle-separate', 'lifecycle-separate@example.test'),
    href: `${remoteUrl}lifecycle-separate.vcf`,
  };
  const secondMergeCard = {
    ...remoteCard('lifecycle-b-merge', 'lifecycle-duplicate-b@example.test'),
    href: `${secondRemoteUrl}lifecycle-b-merge.vcf`,
  };
  for (const [url, name, upserts] of [
    [remoteUrl, 'Lifecycle Remote A', [card, separateCard]],
    [secondRemoteUrl, 'Lifecycle Remote B', [secondMergeCard, skippedCard]],
  ]) {
    await beginApply(completePlan({
      userId,
      book: { url, displayName: name },
      connectionGeneration: generation,
      collectionIdentity: { observedUrl: url, canonicalUrl: url },
      upserts,
    }));
  }
  const editedTargetVcard = targetVcard.replace(
    'END:VCARD\r\n',
    'NOTE:local lifecycle edit\r\nEND:VCARD\r\n',
  );
  const editedSecondTargetVcard = secondTargetVcard.replace(
    'END:VCARD\r\n',
    'NOTE:local lifecycle edit B\r\nEND:VCARD\r\n',
  );
  await databaseClient.query(
    `UPDATE contacts SET
       notes = CASE id
         WHEN $1 THEN 'local lifecycle edit'
         WHEN $2 THEN 'local lifecycle edit B'
       END,
       vcard = CASE id WHEN $1 THEN $3 ELSE $4 END,
       etag = CASE id WHEN $1 THEN $5 ELSE $6 END
     WHERE id = ANY($7::uuid[])`,
    [
      target.id,
      secondTarget.id,
      editedTargetVcard,
      editedSecondTargetVcard,
      createHash('md5').update(editedTargetVcard).digest('hex'),
      createHash('md5').update(editedSecondTargetVcard).digest('hex'),
      [target.id, secondTarget.id],
    ],
  );
  const { rows: [seededLocalBook] } = await databaseClient.query(
    'SELECT id, sync_token FROM address_books WHERE id = $1',
    [localBook.id],
  );
  const { rows: remoteBooks } = await databaseClient.query(
    `SELECT id, external_url, sync_token, remote_sync_revision::text
     FROM address_books
     WHERE user_id = $1 AND source = 'carddav'
     ORDER BY external_url`,
    [userId],
  );
  return {
    userId,
    generation,
    remoteUrl,
    secondRemoteUrl,
    remoteBooks,
    localBook: seededLocalBook,
    unrelatedBook,
    target,
    secondTarget,
  };
}

async function seedLegacyCrossBookUser() {
  const userId = randomUUID();
  const generation = randomUUID();
  const [bookAId, bookBId] = [randomUUID(), randomUUID()].sort();
  const bookAUrl = `https://dav.example.test/addressbooks/${userId}/legacy-a/`;
  const bookBUrl = `https://dav.example.test/addressbooks/${userId}/legacy-b/`;
  await databaseClient.query(
    'INSERT INTO users (id, username) VALUES ($1, $2)',
    [userId, `carddav-legacy-cross-book-${userId}`],
  );
  await databaseClient.query(
    `INSERT INTO user_integrations (user_id, provider, config)
     VALUES ($1, 'carddav', jsonb_build_object(
       'connectionGeneration', $2::text
     ))`,
    [userId, generation],
  );
  const { rows: books } = await databaseClient.query(
    `INSERT INTO address_books (id, user_id, name, source, external_url)
     VALUES
       ($1, $3, 'Legacy A', 'carddav', $4),
       ($2, $3, 'Legacy B', 'carddav', $5)
     RETURNING id, external_url, sync_token, remote_sync_revision::text`,
    [bookAId, bookBId, userId, bookAUrl, bookBUrl],
  );
  const { rows: [unrelatedBook] } = await databaseClient.query(
    `INSERT INTO address_books (user_id, name)
     VALUES ($1, 'Legacy Unrelated') RETURNING id, sync_token`,
    [userId],
  );
  const aMerge = {
    ...remoteCard('legacy-a-merge', 'legacy-merge@example.test'),
    href: `${bookAUrl}merge.vcf`,
  };
  const aSkip = {
    ...remoteCard('legacy-a-skip', 'legacy-skip@example.test'),
    href: `${bookAUrl}skip.vcf`,
  };
  const bMerge = {
    ...remoteCard('legacy-b-merge', 'legacy-merge@example.test'),
    href: `${bookBUrl}merge.vcf`,
  };
  const bSkip = {
    ...remoteCard('legacy-b-skip', 'legacy-skip@example.test'),
    href: `${bookBUrl}skip.vcf`,
  };
  for (const [book, cards] of [
    [{ url: bookAUrl, displayName: 'Legacy A' }, [aMerge, aSkip]],
    [{ url: bookBUrl, displayName: 'Legacy B' }, [bMerge, bSkip]],
  ]) {
    await beginApply(completePlan({
      userId,
      book,
      connectionGeneration: generation,
      collectionIdentity: { observedUrl: book.url, canonicalUrl: book.url },
      upserts: cards,
    }));
  }
  const bookA = books.find(book => book.id === bookAId);
  const bookB = books.find(book => book.id === bookBId);
  const { rows: bContacts } = await databaseClient.query(
    `SELECT c.id, c.uid, c.primary_email, c.emails
     FROM contacts c
     WHERE c.address_book_id = $1
     ORDER BY c.primary_email`,
    [bookB.id],
  );
  const bMergeContact = bContacts.find(contact => (
    contact.primary_email === 'legacy-merge@example.test'
  ));
  const bSkipContact = bContacts.find(contact => (
    contact.primary_email === 'legacy-skip@example.test'
  ));
  const mergeBefore = {
    displayName: bMerge.contact.displayName,
    firstName: bMerge.contact.firstName,
    lastName: bMerge.contact.lastName,
    phones: bMerge.contact.phones,
    organization: bMerge.contact.organization,
    notes: bMerge.contact.notes,
    photoData: bMerge.contact.photoData,
  };
  const mergeApplied = {
    displayName: aMerge.contact.displayName,
    firstName: aMerge.contact.firstName,
    lastName: aMerge.contact.lastName,
    phones: aMerge.contact.phones,
    organization: aMerge.contact.organization,
    notes: aMerge.contact.notes,
    photoData: aMerge.contact.photoData,
  };
  const mergedVcard = generateVCard({
    uid: bMergeContact.uid,
    primaryEmail: bMergeContact.primary_email,
    emails: bMergeContact.emails,
    ...mergeApplied,
  });
  await databaseClient.query(
    `UPDATE contacts SET
       display_name = $2, first_name = $3, last_name = $4,
       phones = $5::jsonb, organization = $6, notes = $7, photo_data = $8,
       vcard = $9, etag = $10
     WHERE id = $1`,
    [
      bMergeContact.id,
      mergeApplied.displayName,
      mergeApplied.firstName,
      mergeApplied.lastName,
      JSON.stringify(mergeApplied.phones),
      mergeApplied.organization,
      mergeApplied.notes,
      mergeApplied.photoData,
      mergedVcard,
      createHash('md5').update(mergedVcard).digest('hex'),
    ],
  );
  const { rows: aObjects } = await databaseClient.query(
    `SELECT href, local_contact_id
     FROM carddav_remote_objects
     WHERE address_book_id = $1`,
    [bookA.id],
  );
  const aMergeObject = aObjects.find(object => object.href === aMerge.href);
  const aSkipObject = aObjects.find(object => object.href === aSkip.href);
  await databaseClient.query(
    `UPDATE carddav_remote_objects SET
       disposition = 'skip', local_contact_id = NULL,
       merge_before = NULL, merge_applied = NULL,
       mapping_status = 'pending_materialization',
       legacy_projection = jsonb_build_object(
         'disposition', disposition,
         'merge_before', merge_before,
         'merge_applied', merge_applied
       )
     WHERE address_book_id = $1`,
    [bookB.id],
  );
  await databaseClient.query(
    `UPDATE carddav_remote_objects SET
       disposition = 'merge', local_contact_id = $3,
       merge_before = $4::jsonb, merge_applied = $5::jsonb,
       mapping_status = 'pending_materialization',
       legacy_projection = jsonb_build_object(
         'disposition', 'merge',
         'merge_before', $4::jsonb,
         'merge_applied', $5::jsonb
       )
     WHERE address_book_id = $1 AND href = $2`,
    [
      bookA.id,
      aMerge.href,
      bMergeContact.id,
      JSON.stringify(mergeBefore),
      JSON.stringify(mergeApplied),
    ],
  );
  await databaseClient.query(
    `UPDATE carddav_remote_objects SET
       disposition = 'skip', local_contact_id = $3,
       merge_before = NULL, merge_applied = NULL,
       mapping_status = 'pending_materialization',
       legacy_projection = jsonb_build_object(
         'disposition', 'skip',
         'merge_before', NULL,
         'merge_applied', NULL
       )
     WHERE address_book_id = $1 AND href = $2`,
    [bookA.id, aSkip.href, bSkipContact.id],
  );
  await databaseClient.query(
    'DELETE FROM contacts WHERE id = ANY($1::uuid[])',
    [[aMergeObject.local_contact_id, aSkipObject.local_contact_id]],
  );
  const { rows: seededBooks } = await databaseClient.query(
    `SELECT id, external_url, sync_token, remote_sync_revision::text
     FROM address_books WHERE id = ANY($1::uuid[]) ORDER BY id`,
    [[bookA.id, bookB.id]],
  );
  return {
    userId,
    generation,
    bookA: seededBooks.find(book => book.id === bookA.id),
    bookB: seededBooks.find(book => book.id === bookB.id),
    bookAUrl,
    bookBUrl,
    unrelatedBook,
    aMerge,
    aSkip,
    bMerge,
    bSkip,
    bMergeContact,
    bSkipContact,
  };
}

async function probeBackendLock(pid) {
  const { rows } = await adminClient.query(
    'SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1',
    [pid],
  );
  const state = { wait_event_type: rows[0]?.wait_event_type ?? null };
  return { done: state.wait_event_type === 'Lock', state };
}

async function applyWithClient(client, plan, queryOverride) {
  await client.query('BEGIN');
  try {
    const transactionClient = queryOverride
      ? { query: (sql, params) => queryOverride(client, sql, params) }
      : client;
    const result = await carddavSync.applyBookDelta(transactionClient, plan);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function automaticState(userId) {
  const { rows: books } = await databaseClient.query(
    `SELECT id, source, external_url, sync_token, remote_sync_token,
            remote_sync_revision::text
     FROM address_books WHERE user_id = $1 ORDER BY id`,
    [userId],
  );
  const { rows: contacts } = await databaseClient.query(
    `SELECT id, address_book_id, display_name, photo_data, vcard, etag
     FROM contacts WHERE user_id = $1 ORDER BY id`,
    [userId],
  );
  const { rows: ledger } = await databaseClient.query(
    `SELECT o.address_book_id, o.href, o.disposition, o.local_contact_id,
            o.merge_before, o.merge_applied
     FROM carddav_remote_objects o
     JOIN address_books b ON b.id = o.address_book_id
     WHERE b.user_id = $1 ORDER BY o.href`,
    [userId],
  );
  const { rows: [integration] } = await databaseClient.query(
    `SELECT config FROM user_integrations
     WHERE user_id = $1 AND provider = 'carddav'`,
    [userId],
  );
  return { books, contacts, ledger, integration };
}

async function seedAutomaticPair() {
  const userId = randomUUID();
  const generation = randomUUID();
  const [bookAId, bookBId] = [randomUUID(), randomUUID()].sort();
  const bookAUrl = `https://dav.example.test/addressbooks/${userId}/automatic-a/`;
  const bookBUrl = `https://dav.example.test/addressbooks/${userId}/automatic-b/`;
  await databaseClient.query(
    'INSERT INTO users (id, username) VALUES ($1, $2)',
    [userId, `carddav-automatic-${userId}`],
  );
  await databaseClient.query(
    `INSERT INTO user_integrations (user_id, provider, config)
     VALUES ($1, 'carddav', jsonb_build_object(
       'connectionGeneration', $2::text
     ))`,
    [userId, generation],
  );
  const { rows: [targetBook] } = await databaseClient.query(
    "INSERT INTO address_books (user_id, name) VALUES ($1, 'Automatic Target') RETURNING id",
    [userId],
  );
  const { rows: [unrelatedBook] } = await databaseClient.query(
    "INSERT INTO address_books (user_id, name) VALUES ($1, 'Automatic Unrelated') RETURNING id",
    [userId],
  );
  await databaseClient.query(
    `INSERT INTO address_books (id, user_id, name, source, external_url)
     VALUES ($1, $3, 'Automatic Remote A', 'carddav', $4),
            ($2, $3, 'Automatic Remote B', 'carddav', $5)`,
    [bookAId, bookBId, userId, bookAUrl, bookBUrl],
  );
  const target = {
    uid: `automatic-target-${userId}`,
    displayName: 'Automatic Original',
    firstName: 'Automatic',
    lastName: 'Original',
    primaryEmail: `automatic-duplicate-${userId}@example.test`,
    emails: [{
      value: `automatic-duplicate-${userId}@example.test`, type: 'other', primary: true,
    }],
    phones: [],
    organization: null,
    notes: 'Automatic local note',
    photoData: null,
  };
  const targetVcard = generateVCard(target);
  const { rows: [targetContact] } = await databaseClient.query(
    `INSERT INTO contacts (
       address_book_id, user_id, uid, vcard, etag, display_name, first_name,
       last_name, primary_email, emails, phones, organization, notes, photo_data, is_auto
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, '[]'::jsonb,
       NULL, $11, NULL, false
     ) RETURNING id`,
    [
      targetBook.id, userId, target.uid, targetVcard,
      createHash('md5').update(targetVcard).digest('hex'), target.displayName,
      target.firstName, target.lastName, target.primaryEmail,
      JSON.stringify(target.emails), target.notes,
    ],
  );
  const duplicate = {
    ...remoteCard('Automatic Remote Duplicate', target.primaryEmail),
    href: `${bookAUrl}duplicate.vcf`,
  };
  const unique = {
    ...remoteCard('Automatic Remote Unique', `automatic-unique-${userId}@example.test`),
    href: `${bookBUrl}unique.vcf`,
  };
  for (const [url, name, card, token] of [
    [bookAUrl, 'Automatic Remote A', duplicate, 'automatic-a-token'],
    [bookBUrl, 'Automatic Remote B', unique, 'automatic-b-token'],
  ]) {
    await beginApply(completePlan({
      userId,
      book: { url, displayName: name },
      connectionGeneration: generation,
      expectedRemoteRevision: '0',
      expectedRemoteToken: null,
      nextRemoteToken: token,
      capability: 'sync-collection',
      collectionIdentity: { observedUrl: url, canonicalUrl: url },
      upserts: [card],
    }));
  }
  return {
    userId,
    generation,
    bookAId,
    bookBId,
    bookAUrl,
    bookBUrl,
    targetBook,
    unrelatedBook,
    targetContact,
    target,
    targetVcard,
    duplicate,
    unique,
    before: await automaticState(userId),
  };
}

async function seedLargeIncrementalUser() {
  const userId = randomUUID();
  const generation = randomUUID();
  const remoteUrl = `https://dav.example.test/addressbooks/${userId}/large/`;
  await databaseClient.query(
    'INSERT INTO users (id, username) VALUES ($1, $2)',
    [userId, `carddav-large-${userId}`],
  );
  await databaseClient.query(
    `INSERT INTO user_integrations (user_id, provider, config)
     VALUES ($1, 'carddav', jsonb_build_object(
       'serverUrl', 'https://dav.example.test/',
       'username', 'large-user',
       'password', 'encrypted',
       'connectionGeneration', $2::text,
       'contactCount', 10000
     ))`,
    [userId, generation],
  );
  const { rows: [book] } = await databaseClient.query(
    `INSERT INTO address_books (
       user_id, name, source, external_url, remote_sync_token,
       remote_sync_capability, remote_sync_revision, remote_projection_fingerprint
     ) VALUES ($1, 'Large Remote', 'carddav', $2, 'large-token-0',
               'sync-collection', 0, $3)
     RETURNING id, sync_token`,
    [
      userId,
      remoteUrl,
      createHash('sha256').update(JSON.stringify([])).digest('hex'),
    ],
  );
  await databaseClient.query(`
    WITH input AS (
      SELECT
        i,
        $2::text || 'large-' || lpad(i::text, 5, '0') || '.vcf' AS href,
        'large-' || lpad(i::text, 5, '0') AS remote_uid,
        'Large ' || lpad(i::text, 5, '0') AS display_name,
        'Large' AS first_name,
        lpad(i::text, 5, '0') AS last_name,
        'l' || lpad(i::text, 5, '0') || '@example.test' AS email
      FROM generate_series(1, 10000) AS series(i)
    ), materialized AS (
      SELECT *,
        'BEGIN:VCARD' || E'\r\n' ||
        'VERSION:3.0' || E'\r\n' ||
        'UID:' || remote_uid || E'\r\n' ||
        'FN:' || display_name || E'\r\n' ||
        'N:' || last_name || ';' || first_name || ';;;' || E'\r\n' ||
        'EMAIL:' || email || E'\r\n' ||
        'END:VCARD' || E'\r\n' AS remote_vcard,
        encode(sha256(convert_to(href, 'UTF8')), 'hex') AS local_uid
      FROM input
    ), local_materialized AS (
      SELECT *,
        'BEGIN:VCARD' || E'\r\n' ||
        'VERSION:3.0' || E'\r\n' ||
        'UID:' || local_uid || E'\r\n' ||
        'FN:' || display_name || E'\r\n' ||
        'N:' || last_name || ';' || first_name || ';;;' || E'\r\n' ||
        'EMAIL;TYPE=OTHER:' || email || E'\r\n' ||
        'END:VCARD' || E'\r\n' AS local_vcard
      FROM materialized
    ), inserted AS (
      INSERT INTO contacts (
        address_book_id, user_id, uid, vcard, etag, display_name,
        first_name, last_name, primary_email, emails, phones, is_auto
      )
      SELECT $1, $3, local_uid, local_vcard, md5(local_vcard), display_name,
             first_name, last_name, email,
             jsonb_build_array(jsonb_build_object(
               'value', email, 'type', 'other', 'primary', true
             )), '[]'::jsonb, false
      FROM local_materialized
      RETURNING id, uid
    )
    INSERT INTO carddav_remote_objects (
      address_book_id, href, remote_etag, vcard, primary_email,
      disposition, local_contact_id
    )
    SELECT $1, materialized.href, '"large-' || lpad(materialized.i::text, 5, '0') || '-1"',
           materialized.remote_vcard, materialized.email, 'separate', inserted.id
    FROM materialized
    JOIN inserted ON inserted.uid = materialized.local_uid
  `, [book.id, remoteUrl, userId]);
  return { userId, generation, remoteUrl, book };
}

describe('CardDAV full snapshot transaction', () => {
  beforeAll(async () => {
    adminClient = new Client({ connectionString: databaseUrl });
    await adminClient.connect();
    await createTestDatabase(adminClient, databaseName);

    databaseClient = new Client({ connectionString: connectionStringFor(databaseName) });
    await databaseClient.connect();
    await assertMinimumPostgresVersion(databaseClient);
    await applyMigrations(databaseClient);
    await databaseClient.query(
      'INSERT INTO users (id, username) VALUES ($1, $2)',
      [USER_ID, `carddav-sync-${databaseName}`],
    );
    await databaseClient.query(
      `INSERT INTO user_integrations (user_id, provider, config)
       VALUES ($1, 'carddav', jsonb_build_object(
         'connectionGeneration', $2::text
       ))`,
      [USER_ID, CONNECTION_GENERATION],
    );

    const { rows: [localBook] } = await databaseClient.query(
      "INSERT INTO address_books (user_id, name) VALUES ($1, 'Personal') RETURNING id",
      [USER_ID],
    );
    const targetVcard = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'UID:local-target',
      'FN:Local Target',
      'EMAIL:duplicate@example.test',
      'END:VCARD',
      '',
    ].join('\r\n');
    await databaseClient.query(`
      INSERT INTO contacts (
        address_book_id, user_id, uid, vcard, etag, display_name, first_name,
        primary_email, emails, phones, is_auto
      ) VALUES ($1, $2, 'local-target', $3, $4, 'Local Target', 'Local',
                'duplicate@example.test', $5::jsonb, '[]'::jsonb, false)
    `, [
      localBook.id,
      USER_ID,
      targetVcard,
      createHash('md5').update(targetVcard).digest('hex'),
      JSON.stringify([{ value: 'duplicate@example.test', type: 'other', primary: true }]),
    ]);
  }, 120_000);

  afterAll(async () => {
    if (databaseClient) await databaseClient.end();
    if (adminClient) {
      await dropTestDatabase(adminClient, databaseName);
      await adminClient.end();
    }
  }, 120_000);

  it('materializes upgraded separate, merge, and skip mappings atomically on PostgreSQL 16', async () => {
    const transitionDatabase = `carddav_materialize_${process.pid}_${randomUUID()
      .replaceAll('-', '').slice(0, 10)}`;
    let transitionClient;
    try {
      await createTestDatabase(adminClient, transitionDatabase);
      transitionClient = new Client({ connectionString: connectionStringFor(transitionDatabase) });
      await transitionClient.connect();
      await applyMigrations(transitionClient, '0034');

      const userId = randomUUID();
      const generation = randomUUID();
      const localBookId = randomUUID();
      const modes = ['separate', 'merge', 'skip'];
      const books = modes.map(mode => ({
        id: randomUUID(),
        mode,
        url: `https://dav.example.test/addressbooks/${userId}/${mode}/`,
      }));
      const cards = books.map(book => ({
        ...remoteCard(`legacy-${book.mode}`, `legacy-${book.mode}@example.test`),
        href: `${book.url}contact.vcf`,
      }));

      await transitionClient.query(
        'INSERT INTO users (id, username) VALUES ($1, $2)',
        [userId, `carddav-materialize-${userId}`],
      );
      await transitionClient.query(
        `INSERT INTO user_integrations (user_id, provider, config)
         VALUES ($1, 'carddav', jsonb_build_object(
           'connectionGeneration', $2::text, 'contactCount', 2
         ))`,
        [userId, generation],
      );
      await transitionClient.query(
        `INSERT INTO address_books (id, user_id, name)
         VALUES ($1, $2, 'Legacy Explicit')`,
        [localBookId, userId],
      );
      for (const book of books) {
        await transitionClient.query(
          `INSERT INTO address_books (id, user_id, name, source, external_url)
           VALUES ($1, $2, $3, 'carddav', $4)`,
          [book.id, userId, `Legacy ${book.mode}`, book.url],
        );
      }

      const localContacts = new Map();
      for (const mode of ['separate', 'merge']) {
        const card = cards.find(candidate => candidate.href.includes(`/${mode}/`));
        const addressBookId = mode === 'separate'
          ? books.find(book => book.mode === mode).id
          : localBookId;
        const uid = `legacy-${mode}-local`;
        const vcard = generateVCard({ ...card.contact, uid });
        const { rows: [contact] } = await transitionClient.query(
          `INSERT INTO contacts (
             address_book_id, user_id, uid, vcard, etag, display_name, first_name,
             last_name, primary_email, emails, phones, organization, notes, photo_data,
             is_auto
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14,false
           ) RETURNING id`,
          [
            addressBookId, userId, uid, vcard,
            createHash('md5').update(vcard).digest('hex'),
            card.contact.displayName, card.contact.firstName, card.contact.lastName,
            card.contact.primaryEmail, JSON.stringify(card.contact.emails),
            JSON.stringify(card.contact.phones), card.contact.organization,
            card.contact.notes, card.contact.photoData,
          ],
        );
        localContacts.set(mode, contact.id);
      }

      for (const [index, mode] of modes.entries()) {
        const mergeBefore = mode === 'merge' ? { display_name: 'Legacy Before' } : null;
        const mergeApplied = mode === 'merge' ? { display_name: 'Legacy Remote' } : null;
        await transitionClient.query(
          `INSERT INTO carddav_remote_objects (
             address_book_id, href, remote_etag, vcard, primary_email, disposition,
             local_contact_id, merge_before, merge_applied
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)`,
          [
            books[index].id, cards[index].href, cards[index].remoteEtag,
            cards[index].vcard, cards[index].contact.primaryEmail, mode,
            localContacts.get(mode) || null, JSON.stringify(mergeBefore),
            JSON.stringify(mergeApplied),
          ],
        );
      }

      await applyTestMigrations(transitionClient, {
        migrationsDirectory,
        first: '0035',
        through: '0035',
      });
      const { rows: pending } = await transitionClient.query(
        `SELECT disposition, mapping_status, legacy_projection
         FROM carddav_remote_objects ORDER BY disposition`,
      );
      expect(pending).toEqual([
        expect.objectContaining({
          disposition: 'merge',
          mapping_status: 'pending_materialization',
          legacy_projection: expect.objectContaining({ disposition: 'merge' }),
        }),
        expect.objectContaining({
          disposition: 'separate',
          mapping_status: 'pending_materialization',
          legacy_projection: expect.objectContaining({ disposition: 'separate' }),
        }),
        expect.objectContaining({
          disposition: 'skip',
          mapping_status: 'pending_materialization',
          legacy_projection: expect.objectContaining({ disposition: 'skip' }),
        }),
      ]);

      for (const [index, book] of books.entries()) {
        await transitionClient.query('BEGIN');
        try {
          await carddavSync.applyBookDelta(transitionClient, completePlan({
            userId,
            connectionGeneration: generation,
            book: { url: book.url, displayName: `Legacy ${book.mode}` },
            collectionIdentity: { observedUrl: book.url, canonicalUrl: book.url },
            upserts: [cards[index]],
          }));
          await transitionClient.query('COMMIT');
        } catch (error) {
          await transitionClient.query('ROLLBACK');
          throw error;
        }
      }

      const { rows: committed } = await transitionClient.query(
        `SELECT o.href, o.disposition, o.vcard, o.local_contact_id, o.mapping_status,
                o.vcard_version, o.remote_semantic_hash, o.local_contact_hash,
                o.legacy_projection, o.last_synced_at,
                c.uid, c.display_name, c.first_name, c.last_name, c.emails, c.phones,
                c.organization, c.notes, c.photo_data, c.additional_fields
         FROM carddav_remote_objects o
         JOIN contacts c ON c.id = o.local_contact_id
         ORDER BY o.disposition`,
      );
      expect(committed).toHaveLength(3);
      for (const mapping of committed) {
        expect(mapping).toMatchObject({
          mapping_status: 'synced',
          vcard_version: '3.0',
          legacy_projection: null,
          last_synced_at: expect.any(Date),
        });
        expect(mapping.remote_semantic_hash)
          .toBe(semanticVCardHash(parseVCardDocument(mapping.vcard)));
        expect(mapping.local_contact_hash).toBe(localContactHash(mapping));
      }

      const rollbackBook = books.find(book => book.mode === 'separate');
      const rollbackCard = cards.find(card => card.href.includes('/separate/'));
      const rollbackAttempt = {
        ...rollbackCard,
        remoteEtag: '"rollback-attempt"',
        vcard: rollbackCard.vcard
          .replace('FN:legacy-separate', 'FN:Rollback Attempt')
          .replace('END:VCARD\r\n', 'NOTE:must roll back\r\nEND:VCARD\r\n'),
        contact: {
          ...rollbackCard.contact,
          displayName: 'Rollback Attempt',
          notes: 'must roll back',
        },
      };
      await transitionClient.query(
        `UPDATE carddav_remote_objects
         SET mapping_status = 'pending_materialization',
             remote_semantic_hash = NULL,
             local_contact_hash = NULL,
             last_synced_at = NULL,
             legacy_projection = jsonb_build_object(
               'disposition', disposition,
               'merge_before', merge_before,
               'merge_applied', merge_applied
             )
         WHERE address_book_id = $1`,
        [rollbackBook.id],
      );
      const readRollbackState = async () => {
        const { rows: [mapping] } = await transitionClient.query(
          `SELECT href, remote_etag, vcard, primary_email, disposition,
                  local_contact_id, merge_before, merge_applied, mapping_status,
                  mapping_revision::text, vcard_version, remote_semantic_hash,
                  local_contact_hash, legacy_projection, last_synced_at
           FROM carddav_remote_objects WHERE address_book_id = $1`,
          [rollbackBook.id],
        );
        const { rows: [contact] } = await transitionClient.query(
          `SELECT id, address_book_id, user_id, uid, vcard, etag, display_name,
                  first_name, last_name, primary_email, emails, phones, organization,
                  notes, photo_data, additional_fields, is_auto
           FROM contacts WHERE id = $1`,
          [mapping.local_contact_id],
        );
        const { rows: [book] } = await transitionClient.query(
          `SELECT remote_sync_token, remote_sync_revision::text
           FROM address_books WHERE id = $1`,
          [rollbackBook.id],
        );
        return { mapping, contact, book };
      };
      const beforeRollback = await readRollbackState();
      let mappingWritten = false;
      await transitionClient.query('BEGIN');
      try {
        const failingClient = {
          query: async (sql, params) => {
            if (mappingWritten && /UPDATE address_books SET/.test(sql)) {
              throw new Error('forced post-materialization failure');
            }
            const result = await transitionClient.query(sql, params);
            if (/(?:INSERT INTO|UPDATE|DELETE FROM) carddav_remote_objects/.test(sql)) {
              mappingWritten = true;
            }
            return result;
          },
        };
        await expect(carddavSync.applyBookDelta(failingClient, completePlan({
          userId,
          connectionGeneration: generation,
          book: { url: rollbackBook.url, displayName: 'Legacy separate' },
          expectedRemoteRevision: beforeRollback.book.remote_sync_revision,
          expectedRemoteToken: beforeRollback.book.remote_sync_token,
          collectionIdentity: {
            observedUrl: rollbackBook.url,
            canonicalUrl: rollbackBook.url,
          },
          upserts: [rollbackAttempt],
        }))).rejects.toThrow('forced post-materialization failure');
      } finally {
        await transitionClient.query('ROLLBACK');
      }
      expect(mappingWritten).toBe(true);
      expect(await readRollbackState()).toEqual(beforeRollback);
    } finally {
      if (transitionClient) await transitionClient.end();
      await dropTestDatabase(adminClient, transitionDatabase);
    }
  }, 120_000);

  it('uses the contracted 0036 schema even when config contains a stray dupMode key', async () => {
    const contractedDatabase = `carddav_contracted_${process.pid}_${randomUUID()
      .replaceAll('-', '').slice(0, 10)}`;
    let contractedClient;
    try {
      await createTestDatabase(adminClient, contractedDatabase);
      contractedClient = new Client({
        connectionString: connectionStringFor(contractedDatabase),
      });
      await contractedClient.connect();
      await applyMigrations(contractedClient, '0036');
      const userId = randomUUID();
      const generation = randomUUID();
      const remoteUrl = `https://dav.example.test/addressbooks/${userId}/contracted/`;
      await contractedClient.query(
        'INSERT INTO users (id, username) VALUES ($1, $2)',
        [userId, `carddav-contracted-${userId}`],
      );
      await contractedClient.query(
        `INSERT INTO user_integrations (user_id, provider, config)
         VALUES ($1, 'carddav', jsonb_build_object(
           'connectionGeneration', $2::text, 'dupMode', 'merge'
         ))`,
        [userId, generation],
      );

      await contractedClient.query('BEGIN');
      try {
        const contractedCard = remoteCard('contracted', 'contracted@example.test');
        await expect(carddavSync.applyBookDelta(contractedClient, completePlan({
          userId,
          connectionGeneration: generation,
          book: { url: remoteUrl, displayName: 'Contracted' },
          collectionIdentity: { observedUrl: remoteUrl, canonicalUrl: remoteUrl },
          upserts: [{
            ...contractedCard,
            href: `${remoteUrl}contracted.vcf`,
          }],
        }))).resolves.toMatchObject({ remote: 1, updated: 1, removed: 0 });
        await contractedClient.query('COMMIT');
      } catch (error) {
        await contractedClient.query('ROLLBACK');
        throw error;
      }
      const { rows: [beforeStale] } = await contractedClient.query(`
        SELECT o.*, o.mapping_revision::text AS revision
        FROM carddav_remote_objects o
        JOIN address_books b ON b.id = o.address_book_id
        WHERE b.user_id = $1
      `, [userId]);
      await contractedClient.query('BEGIN');
      const stale = await carddavMappingState.applyConfirmedRemoteContact(contractedClient, {
        addressBookId: beforeStale.address_book_id,
        href: beforeStale.href,
        expectedMappingRevision: String(BigInt(beforeStale.revision) + 1n),
        remoteEtag: '"stale-must-not-write"',
        vcard: beforeStale.vcard,
        primaryEmail: beforeStale.primary_email,
        localContactId: beforeStale.local_contact_id,
        vcardVersion: beforeStale.vcard_version,
        remoteSemanticHash: beforeStale.remote_semantic_hash,
        localContactHash: beforeStale.local_contact_hash,
      });
      await contractedClient.query('COMMIT');
      expect(stale).toMatchObject({
        ok: false,
        stale: true,
        code: 'ERR_CARDDAV_MAPPING_STALE',
        expectedMappingRevision: String(BigInt(beforeStale.revision) + 1n),
      });
      const { rows: [afterStale] } = await contractedClient.query(`
        SELECT o.*, o.mapping_revision::text AS revision
        FROM carddav_remote_objects o
        JOIN address_books b ON b.id = o.address_book_id
        WHERE b.user_id = $1
      `, [userId]);
      expect(afterStale).toEqual(beforeStale);
    } finally {
      if (contractedClient) await contractedClient.end();
      await dropTestDatabase(adminClient, contractedDatabase);
    }
  }, 120_000);

  it('rotates connection generation only for committed identity or auth replacements', async () => {
    const userId = randomUUID();
    await databaseClient.query(
      'INSERT INTO users (id, username) VALUES ($1, $2)',
      [userId, `carddav-connection-${userId}`],
    );
    useDatabaseTransactions();

    const initial = await carddavSync.replaceCarddavConnection(userId, {
      serverUrl: 'https://dav-a.example.test/',
      username: 'user-a',
      password: 'encrypted-a',
      intervalMin: 60,
    });
    expect(initial.connectionGeneration).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    const interval = await carddavSync.patchCarddavConnection(userId, { intervalMin: 30 });
    expect(interval).toMatchObject({
      intervalMin: 30,
      connectionGeneration: initial.connectionGeneration,
    });

    const server = await carddavSync.patchCarddavConnection(userId, {
      serverUrl: 'https://dav-b.example.test/',
    });
    expect(server.connectionGeneration).not.toBe(initial.connectionGeneration);
    const username = await carddavSync.patchCarddavConnection(userId, {
      username: 'user-b',
    });
    expect(username.connectionGeneration).not.toBe(server.connectionGeneration);
    const password = await carddavSync.patchCarddavConnection(userId, {
      password: 'encrypted-b',
    });
    expect(password.connectionGeneration).not.toBe(username.connectionGeneration);
    expect(password).toMatchObject({
      serverUrl: 'https://dav-b.example.test/',
      username: 'user-b',
      password: 'encrypted-b',
      intervalMin: 30,
    });

    const patched = await carddavSync.patchCarddavConnection(userId, { dupMode: 'merge' });
    expect(patched.connectionGeneration).toBe(password.connectionGeneration);
    expect(patched).not.toHaveProperty('dupMode');

    const replacement = await carddavSync.replaceCarddavConnection(userId, {
      serverUrl: 'https://dav-c.example.test/',
      username: 'user-c',
      password: 'encrypted-c',
      intervalMin: 45,
    });
    expect(replacement.connectionGeneration).not.toBe(password.connectionGeneration);
    expect(replacement).toMatchObject({
      serverUrl: 'https://dav-c.example.test/',
      username: 'user-c',
      password: 'encrypted-c',
      intervalMin: 45,
      lastError: null,
    });
  }, 120_000);

  it('invalidates remote book identity state while preserving password-only state', async () => {
    const userId = randomUUID();
    const generation = randomUUID();
    const remoteUrl = `https://dav.example.test/addressbooks/${userId}/identity/`;
    await databaseClient.query(
      'INSERT INTO users (id, username) VALUES ($1, $2)',
      [userId, `carddav-identity-${userId}`],
    );
    await databaseClient.query(
      `INSERT INTO user_integrations (user_id, provider, config)
       VALUES ($1, 'carddav', $2::jsonb)`,
      [userId, JSON.stringify({
        serverUrl: 'https://dav.example.test/',
        username: 'identity-a',
        password: 'encrypted-a',
        intervalMin: 60,
        connectionGeneration: generation,
      })],
    );
    await beginApply(completePlan({
      userId,
      book: { url: remoteUrl, displayName: 'Identity Remote' },
      connectionGeneration: generation,
      nextRemoteToken: 'identity-token',
      capability: 'sync-collection',
      collectionIdentity: { observedUrl: remoteUrl, canonicalUrl: remoteUrl },
      upserts: [{
        ...remoteCard('identity-retained', 'identity-retained@example.test'),
        href: `${remoteUrl}retained.vcf`,
      }],
    }));
    const beforePassword = await persistedLifecycleState(userId);
    useDatabaseTransactions();

    const passwordConfig = await carddavSync.patchCarddavConnection(userId, {
      password: 'encrypted-b',
    });
    const afterPassword = await persistedLifecycleState(userId);
    expect(passwordConfig.connectionGeneration).not.toBe(generation);
    expect({
      books: afterPassword.books,
      contacts: afterPassword.contacts,
      ledger: afterPassword.ledger,
      allBooks: afterPassword.allBooks,
    }).toEqual({
      books: beforePassword.books,
      contacts: beforePassword.contacts,
      ledger: beforePassword.ledger,
      allBooks: beforePassword.allBooks,
    });

    const usernameConfig = await carddavSync.patchCarddavConnection(userId, {
      username: 'identity-b',
    });
    const afterUsername = await persistedLifecycleState(userId);
    expect(usernameConfig.connectionGeneration).not.toBe(passwordConfig.connectionGeneration);
    expect(afterUsername.contacts).toEqual(afterPassword.contacts);
    expect(afterUsername.ledger).toEqual(afterPassword.ledger);
    expect(afterUsername.books).toEqual([{
      ...afterPassword.books[0],
      remote_sync_token: null,
      remote_sync_capability: 'unknown',
      remote_sync_revision: String(Number(afterPassword.books[0].remote_sync_revision) + 1),
      remote_projection_fingerprint: null,
    }]);
    expect(afterUsername.allBooks).toEqual([{
      ...afterPassword.allBooks[0],
      remote_sync_token: null,
      remote_sync_capability: 'unknown',
      remote_sync_revision: String(Number(afterPassword.allBooks[0].remote_sync_revision) + 1),
      remote_projection_fingerprint: null,
    }]);
  }, 120_000);

  it('rolls back identity invalidation with a failed connection patch', async () => {
    const userId = randomUUID();
    const generation = randomUUID();
    await databaseClient.query(
      'INSERT INTO users (id, username) VALUES ($1, $2)',
      [userId, `carddav-identity-rollback-${userId}`],
    );
    await databaseClient.query(
      `INSERT INTO user_integrations (user_id, provider, config)
       VALUES ($1, 'carddav', $2::jsonb)`,
      [userId, JSON.stringify({
        serverUrl: 'https://dav-before.example.test/',
        username: 'identity-before',
        password: 'encrypted-before',
        connectionGeneration: generation,
      })],
    );
    await databaseClient.query(
      `INSERT INTO address_books (
         user_id, name, source, external_url, remote_sync_token,
         remote_sync_capability, remote_sync_revision, remote_projection_fingerprint
       ) VALUES ($1, 'Identity Rollback', 'carddav',
                 'https://dav-before.example.test/addressbooks/identity/',
                 'identity-token-before', 'sync-collection', 9, 'fingerprint-before')`,
      [userId],
    );
    const before = await persistedLifecycleState(userId);
    let identityInvalidated = false;
    useDatabaseTransactions(async (client, sql, params) => {
      if (/UPDATE address_books[\s\S]+remote_sync_capability = 'unknown'/.test(sql)) {
        identityInvalidated = true;
      }
      if (/UPDATE user_integrations/.test(sql)) throw new Error('forced identity patch failure');
      return client.query(sql, params);
    });

    await expect(carddavSync.patchCarddavConnection(userId, {
      serverUrl: 'https://dav-after.example.test/',
    })).rejects.toThrow('forced identity patch failure');
    expect(identityInvalidated).toBe(true);
    expect(await persistedLifecycleState(userId)).toEqual(before);
  }, 120_000);

  it('classifies 10,000 mappings deterministically while writing only changed objects', async () => {
    const fixture = await seedLargeIncrementalUser();
    const timestampsBefore = await databaseClient.query(`
      SELECT href, created_at, updated_at
      FROM carddav_remote_objects
      WHERE address_book_id = $1
      ORDER BY href
    `, [fixture.book.id]);
    const noChangeSql = [];
    const noChange = await beginApply(completePlan({
      userId: fixture.userId,
      book: { url: fixture.remoteUrl, displayName: 'Large Remote' },
      connectionGeneration: fixture.generation,
      expectedRemoteToken: 'large-token-0',
      nextRemoteToken: 'large-token-1',
      capability: 'sync-collection',
      replaceAll: false,
    }), async (client, sql, params) => {
      noChangeSql.push([sql, params]);
      return client.query(sql, params);
    });
    expect(noChange).toMatchObject({ changedBookIds: [], ledgerChanged: false });
    expect(noChangeSql.some(([sql]) => (
      /FROM carddav_remote_objects/.test(sql) && /ORDER BY b\.id, o\.href/.test(sql)
    ))).toBe(true);
    expect(noChangeSql.some(([sql]) => /FROM contacts/.test(sql))).toBe(true);
    expect(noChangeSql.some(([sql]) => (
      /(?:INSERT INTO|DELETE FROM|UPDATE) carddav_remote_objects/.test(sql)
    ))).toBe(false);
    const timestampsAfterNoChange = await databaseClient.query(`
      SELECT href, created_at, updated_at
      FROM carddav_remote_objects
      WHERE address_book_id = $1
      ORDER BY href
    `, [fixture.book.id]);
    expect(timestampsAfterNoChange.rows).toEqual(timestampsBefore.rows);

    const changedHref = `${fixture.remoteUrl}large-05000.vcf`;
    const changed = {
      ...remoteCard('Large Changed', 'l05000@example.test'),
      href: changedHref,
      remoteEtag: '"large-05000-2"',
    };
    const unrelatedBefore = await databaseClient.query(`
      SELECT o.*, c.*
      FROM carddav_remote_objects o
      JOIN contacts c ON c.id = o.local_contact_id
      WHERE o.address_book_id = $1 AND o.href = $2
    `, [fixture.book.id, `${fixture.remoteUrl}large-00001.vcf`]);
    const updateSql = [];
    await beginApply(completePlan({
      userId: fixture.userId,
      book: { url: fixture.remoteUrl, displayName: 'Large Remote' },
      connectionGeneration: fixture.generation,
      expectedRemoteRevision: '1',
      expectedRemoteToken: 'large-token-1',
      nextRemoteToken: 'large-token-2',
      capability: 'sync-collection',
      replaceAll: false,
      upserts: [changed],
    }), async (client, sql, params) => {
      updateSql.push([sql, params]);
      return client.query(sql, params);
    });
    const ledgerReads = updateSql.filter(([sql]) => (
      /SELECT[\s\S]+FROM carddav_remote_objects/.test(sql)
    ));
    expect(ledgerReads.length).toBeGreaterThan(0);
    expect(ledgerReads.some(([sql]) => /ORDER BY b\.id, o\.href/.test(sql))).toBe(true);
    expect(updateSql.some(([sql]) => /FROM contacts/.test(sql))).toBe(true);
    const ledgerUpserts = updateSql.filter(([sql]) => (
      /UPDATE carddav_remote_objects/.test(sql)
    ));
    expect(ledgerUpserts).toHaveLength(1);
    expect(ledgerUpserts[0][1]).toContain(changedHref);
    expect(await databaseClient.query(`
      SELECT o.*, c.*
      FROM carddav_remote_objects o
      JOIN contacts c ON c.id = o.local_contact_id
      WHERE o.address_book_id = $1 AND o.href = $2
    `, [fixture.book.id, `${fixture.remoteUrl}large-00001.vcf`]))
      .toEqual(unrelatedBefore);

    const removalSql = [];
    await beginApply(completePlan({
      userId: fixture.userId,
      book: { url: fixture.remoteUrl, displayName: 'Large Remote' },
      connectionGeneration: fixture.generation,
      expectedRemoteRevision: '2',
      expectedRemoteToken: 'large-token-2',
      nextRemoteToken: 'large-token-3',
      capability: 'sync-collection',
      replaceAll: false,
      removedHrefs: [changedHref],
    }), async (client, sql, params) => {
      removalSql.push([sql, params]);
      return client.query(sql, params);
    });
    const ledgerDeletes = removalSql.filter(([sql]) => (
      /DELETE FROM carddav_remote_objects/.test(sql)
    ));
    expect(ledgerDeletes).toHaveLength(1);
    expect(ledgerDeletes[0][1]).toEqual([fixture.book.id, changedHref, '1']);
    expect(removalSql.some(([sql]) => (
      /SELECT[\s\S]+FROM carddav_remote_objects/.test(sql)
      && /ORDER BY b\.id, o\.href/.test(sql)
    ))).toBe(true);
    const { rows: [{ count }] } = await databaseClient.query(
      'SELECT COUNT(*)::int AS count FROM carddav_remote_objects WHERE address_book_id = $1',
      [fixture.book.id],
    );
    expect(count).toBe(9999);

    const { rows: [newTargetBook] } = await databaseClient.query(
      `INSERT INTO address_books (user_id, name)
       VALUES ($1, 'Large New Target') RETURNING id, sync_token`,
      [fixture.userId],
    );
    const fingerprintReconciliationSql = [];
    await beginApply(completePlan({
      userId: fixture.userId,
      book: { url: fixture.remoteUrl, displayName: 'Large Remote' },
      connectionGeneration: fixture.generation,
      expectedRemoteRevision: '3',
      expectedRemoteToken: 'large-token-3',
      nextRemoteToken: 'large-token-4',
      capability: 'sync-collection',
      replaceAll: false,
    }), async (client, sql, params) => {
      fingerprintReconciliationSql.push([sql, params]);
      return client.query(sql, params);
    });
    expect(fingerprintReconciliationSql.some(([sql]) => (
      /FROM carddav_remote_objects/.test(sql) && /ORDER BY b\.id, o\.href/.test(sql)
    ))).toBe(true);
    expect(fingerprintReconciliationSql.some(([sql]) => (
      /FROM contacts/.test(sql) && !/ANY\(/.test(sql)
    ))).toBe(true);
    const { rows: [reconciledBook] } = await databaseClient.query(
      `SELECT remote_projection_fingerprint
       FROM address_books WHERE id = $1`,
      [fixture.book.id],
    );
    expect(reconciledBook.remote_projection_fingerprint).toBe(
      createHash('sha256').update(JSON.stringify([
        [newTargetBook.id, newTargetBook.sync_token],
      ])).digest('hex'),
    );

    const finalizerSql = [];
    useDatabaseTransactions(async (client, sql, params) => {
      finalizerSql.push([sql, params]);
      return client.query(sql, params);
    });
    await carddavSync.finalizeCarddavSync(fixture.userId, {
      connectionGeneration: fixture.generation,
      seenUrls: [fixture.remoteUrl],
      status: { lastError: null },
    });
    expect(finalizerSql.some(([sql]) => /FROM carddav_remote_objects/.test(sql))).toBe(true);
    expect(finalizerSql.some(([sql]) => /FROM contacts/.test(sql))).toBe(false);
  }, 120_000);

  it('rolls back a failed connection patch without changing config or generation', async () => {
    const userId = randomUUID();
    const generation = randomUUID();
    await databaseClient.query(
      'INSERT INTO users (id, username) VALUES ($1, $2)',
      [userId, `carddav-connection-rollback-${userId}`],
    );
    await databaseClient.query(
      `INSERT INTO user_integrations (user_id, provider, config)
       VALUES ($1, 'carddav', $2::jsonb)`,
      [userId, JSON.stringify({
        serverUrl: 'https://dav.example.test/',
        username: 'user',
        password: 'encrypted-before',
        intervalMin: 60,
        connectionGeneration: generation,
      })],
    );
    const before = await persistedState(userId);
    useDatabaseTransactions(async (client, sql, params) => {
      if (/UPDATE user_integrations/.test(sql)) throw new Error('forced connection patch failure');
      return client.query(sql, params);
    });

    await expect(carddavSync.patchCarddavConnection(userId, {
      password: 'encrypted-after',
    })).rejects.toThrow('forced connection patch failure');
    expect(await persistedState(userId)).toEqual(before);
  }, 120_000);

  it('rejects a password patch preflighted against a replaced generation', async () => {
    const userId = randomUUID();
    const preflightedGeneration = randomUUID();
    await databaseClient.query(
      'INSERT INTO users (id, username) VALUES ($1, $2)',
      [userId, `carddav-password-preflight-${userId}`],
    );
    await databaseClient.query(
      `INSERT INTO user_integrations (user_id, provider, config)
       VALUES ($1, 'carddav', $2::jsonb)`,
      [userId, JSON.stringify({
        serverUrl: 'https://dav-a.example.test/',
        username: 'user-a',
        password: 'encrypted-a',
        intervalMin: 60,
        connectionGeneration: preflightedGeneration,
      })],
    );
    useDatabaseTransactions();
    const replacement = await carddavSync.replaceCarddavConnection(userId, {
      serverUrl: 'https://dav-b.example.test/',
      username: 'user-b',
      password: 'encrypted-b',
      intervalMin: 30,
    });
    const beforeStalePatch = await persistedState(userId);

    await expect(carddavSync.patchCarddavConnection(
      userId,
      { password: 'encrypted-after-preflight' },
      preflightedGeneration,
    )).rejects.toMatchObject({
      name: 'StaleCarddavPlanError',
      expectedConnectionGeneration: preflightedGeneration,
      actualConnectionGeneration: replacement.connectionGeneration,
    });
    expect(await persistedState(userId)).toEqual(beforeStalePatch);
  }, 120_000);

  it('records failure status only for the exact expected generation', async () => {
    const userId = randomUUID();
    const generation = randomUUID();
    await databaseClient.query(
      'INSERT INTO users (id, username) VALUES ($1, $2)',
      [userId, `carddav-failure-status-${userId}`],
    );
    await databaseClient.query(
      `INSERT INTO user_integrations (user_id, provider, config)
       VALUES ($1, 'carddav', $2::jsonb)`,
      [userId, JSON.stringify({
        serverUrl: 'https://dav.example.test/',
        connectionGeneration: generation,
        lastError: 'before',
        lastSyncAt: '2026-01-01T00:00:00.000Z',
      })],
    );
    mocks.query.mockImplementation((sql, params) => databaseClient.query(sql, params));

    expect(await carddavSync.recordCarddavSyncFailure(
      userId, 'stale-generation', new Error('stale error'),
    )).toBe(false);
    expect(await carddavSync.recordCarddavSyncFailure(
      userId, generation, new Error('current error'),
    )).toBe(true);
    const { rows: [{ config }] } = await databaseClient.query(
      `SELECT config FROM user_integrations
       WHERE user_id = $1 AND provider = 'carddav'`,
      [userId],
    );
    expect(config).toMatchObject({
      connectionGeneration: generation,
      lastError: 'current error',
    });
    expect(config.lastSyncAt).not.toBe('2026-01-01T00:00:00.000Z');

    await databaseClient.query(
      `UPDATE user_integrations
       SET config = jsonb_set(config, '{connectionGeneration}', 'null'::jsonb)
       WHERE user_id = $1 AND provider = 'carddav'`,
      [userId],
    );
    expect(await carddavSync.recordCarddavSyncFailure(
      userId, null, new Error('legacy null error'),
    )).toBe(true);
  }, 120_000);

  it('fences old planned work after production connection replacement', async () => {
    vi.clearAllMocks();
    const fixture = await seedLifecycleUser();
    await databaseClient.query(
      `UPDATE user_integrations
       SET config = config || $2::jsonb
       WHERE user_id = $1 AND provider = 'carddav'`,
      [fixture.userId, JSON.stringify({
        serverUrl: 'https://dav-a.example.test/',
        username: 'user-a',
        password: 'encrypted-a',
        intervalMin: 60,
        lastSyncAt: '2026-07-10T12:00:00.000Z',
      })],
    );
    const before = await persistedLifecycleState(fixture.userId);
    const staleCard = {
      ...remoteCard('replacement-stale', 'replacement-stale@example.test'),
      href: `${fixture.remoteUrl}replacement-stale.vcf`,
    };
    const oldApplyRequested = deferred();
    const releaseOldApply = deferred();
    let transactionCalls = 0;
    mocks.query.mockImplementation((sql, params) => databaseClient.query(sql, params));
    mocks.discoverAddressBooks.mockResolvedValue([{
      url: fixture.remoteUrl,
      displayName: 'Lifecycle Remote A',
      supportsSyncCollection: true,
    }]);
    mocks.fetchAddressBookDelta.mockImplementationOnce(async request => ({
      expectedRemoteToken: request.syncToken,
      nextRemoteToken: 'replacement-must-not-commit',
      capability: 'sync-collection',
      replaceAll: false,
      upserts: [staleCard],
      removedHrefs: [],
    }));
    mocks.withTransaction.mockImplementation(async callback => {
      transactionCalls++;
      if (transactionCalls === 1) {
        oldApplyRequested.resolve();
        await releaseOldApply.promise;
      }
      await databaseClient.query('BEGIN');
      try {
        const result = await callback(databaseClient);
        await databaseClient.query('COMMIT');
        return result;
      } catch (error) {
        await databaseClient.query('ROLLBACK');
        throw error;
      }
    });

    const oldSync = carddavSync.syncUser(fixture.userId);
    await oldApplyRequested.promise;
    const replacement = await carddavSync.replaceCarddavConnection(fixture.userId, {
      serverUrl: 'https://dav-b.example.test/',
      username: 'user-b',
      password: 'encrypted-b',
      intervalMin: 30,
    });
    const afterReplacement = await persistedLifecycleState(fixture.userId);
    releaseOldApply.resolve();

    await expect(oldSync).resolves.toMatchObject({
      ok: false,
      error: 'CardDAV sync plan is stale',
    });
    expect(replacement).toEqual({
      serverUrl: 'https://dav-b.example.test/',
      username: 'user-b',
      password: 'encrypted-b',
      intervalMin: 30,
      connectionGeneration: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
      lastError: null,
      contactCount: before.integrations[0].config.contactCount,
    });
    expect(replacement.connectionGeneration).not.toBe(fixture.generation);
    expect(afterReplacement.integrations).toEqual([{
      provider: 'carddav',
      config: replacement,
    }]);
    expect(afterReplacement.contacts).toEqual(before.contacts);
    expect(afterReplacement.ledger).toEqual(before.ledger);
    expect(afterReplacement.books).toEqual(before.books.map(book => ({
      ...book,
      remote_sync_token: null,
      remote_sync_capability: 'unknown',
      remote_sync_revision: String(Number(book.remote_sync_revision) + 1),
      remote_projection_fingerprint: null,
    })));
    expect(afterReplacement.allBooks).toEqual(before.allBooks.map(book => (
      book.source === 'carddav' ? {
        ...book,
        remote_sync_token: null,
        remote_sync_capability: 'unknown',
        remote_sync_revision: String(Number(book.remote_sync_revision) + 1),
        remote_projection_fingerprint: null,
      } : book
    )));
    expect(await persistedLifecycleState(fixture.userId)).toEqual(afterReplacement);
    expect(mocks.fetchAddressBookDelta).toHaveBeenCalledOnce();
    expect(mocks.withTransaction).toHaveBeenCalledTimes(2);
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringMatching(/UPDATE user_integrations[\s\S]+connectionGeneration/),
      [fixture.userId, expect.stringContaining('CardDAV sync plan is stale'), fixture.generation],
    );
  }, 120_000);

  it('fences old planned work after production projection-aware disconnect', async () => {
    vi.clearAllMocks();
    const fixture = await seedLifecycleUser();
    await databaseClient.query(
      `UPDATE user_integrations
       SET config = config || $2::jsonb
       WHERE user_id = $1 AND provider = 'carddav'`,
      [fixture.userId, JSON.stringify({
        serverUrl: 'https://dav-a.example.test/',
        username: 'user-a',
        password: 'encrypted-a',
        intervalMin: 60,
        lastSyncAt: '2026-07-10T12:00:00.000Z',
      })],
    );
    const before = await persistedLifecycleState(fixture.userId);
    const staleCard = {
      ...remoteCard('disconnect-stale', 'disconnect-stale@example.test'),
      href: `${fixture.remoteUrl}disconnect-stale.vcf`,
    };
    const oldApplyRequested = deferred();
    const releaseOldApply = deferred();
    let transactionCalls = 0;
    mocks.query.mockImplementation((sql, params) => databaseClient.query(sql, params));
    mocks.discoverAddressBooks.mockResolvedValue([{
      url: fixture.remoteUrl,
      displayName: 'Lifecycle Remote A',
      supportsSyncCollection: true,
    }]);
    mocks.fetchAddressBookDelta.mockImplementationOnce(async request => ({
      expectedRemoteToken: request.syncToken,
      nextRemoteToken: 'disconnect-must-not-commit',
      capability: 'sync-collection',
      replaceAll: false,
      upserts: [staleCard],
      removedHrefs: [],
    }));
    mocks.withTransaction.mockImplementation(async callback => {
      transactionCalls++;
      if (transactionCalls === 1) {
        oldApplyRequested.resolve();
        await releaseOldApply.promise;
      }
      await databaseClient.query('BEGIN');
      try {
        const result = await callback(databaseClient);
        await databaseClient.query('COMMIT');
        return result;
      } catch (error) {
        await databaseClient.query('ROLLBACK');
        throw error;
      }
    });

    const oldSync = carddavSync.syncUser(fixture.userId);
    await oldApplyRequested.promise;
    await expect(carddavSync.disconnectCarddavAccount(fixture.userId)).resolves.toBe(true);
    const afterDisconnect = await persistedLifecycleState(fixture.userId);
    releaseOldApply.resolve();

    await expect(oldSync).resolves.toMatchObject({
      ok: false,
      error: 'CardDAV sync plan is stale',
    });
    expect(afterDisconnect.integrations).toEqual([]);
    expect(afterDisconnect.books).toEqual([]);
    expect(afterDisconnect.ledger).toEqual([]);
    expect(afterDisconnect.allBooks.map(book => ({
      id: book.id,
      tokenChanged: book.sync_token !== before.allBooks.find(beforeBook => (
        beforeBook.id === book.id
      )).sync_token,
    }))).toEqual([
      { id: fixture.localBook.id, tokenChanged: false },
      { id: fixture.unrelatedBook.id, tokenChanged: false },
    ].sort((left, right) => left.id.localeCompare(right.id)));
    expect(afterDisconnect.contacts.find(contact => contact.uid === 'lifecycle-target'))
      .toMatchObject({
        display_name: 'Lifecycle Original',
        notes: 'local lifecycle edit',
      });
    expect(afterDisconnect.contacts.find(contact => contact.uid === 'lifecycle-target-b'))
      .toMatchObject({
        display_name: 'Lifecycle Original B',
        notes: 'local lifecycle edit B',
      });
    const { rows: [orphans] } = await databaseClient.query(
      `SELECT COUNT(*)::int AS count
       FROM carddav_remote_objects o
       LEFT JOIN address_books b ON b.id = o.address_book_id
       WHERE b.id IS NULL`,
    );
    expect(orphans.count).toBe(0);
    expect(await persistedLifecycleState(fixture.userId)).toEqual(afterDisconnect);
    expect(mocks.fetchAddressBookDelta).toHaveBeenCalledOnce();
    expect(mocks.withTransaction).toHaveBeenCalledTimes(2);
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringMatching(/UPDATE user_integrations[\s\S]+connectionGeneration/),
      [fixture.userId, expect.stringContaining('CardDAV sync plan is stale'), fixture.generation],
    );
  }, 120_000);

  it('restarts from the integration lock when the PostgreSQL projection footprint expands', async () => {
    vi.clearAllMocks();
    const fixture = await seedAutomaticPair();
    await databaseClient.query(
      `UPDATE user_integrations
       SET config = config || $2::jsonb
       WHERE user_id = $1 AND provider = 'carddav'`,
      [fixture.userId, JSON.stringify({
        serverUrl: 'https://dav.example.test/',
        username: 'user',
        password: 'encrypted',
      })],
    );
    const source = fixture.before.books.find(book => book.id === fixture.bookAId);
    mocks.query.mockImplementation((sql, params) => databaseClient.query(sql, params));
    mocks.discoverAddressBooks.mockResolvedValue([{
      url: source.external_url,
      displayName: 'Automatic Remote A',
      supportsSyncCollection: true,
    }]);
    mocks.fetchAddressBookDelta.mockImplementation(async request => ({
      expectedRemoteToken: request.syncToken,
      nextRemoteToken: request.syncToken,
      capability: 'sync-collection',
      replaceAll: false,
      upserts: [],
      removedHrefs: [],
    }));
    const targetBooksLocked = deferred();
    const releaseApply = deferred();
    let blocked = false;
    useDatabaseTransactions(async (client, sql, params) => {
      const result = await client.query(sql, params);
      if (!blocked && /source <> 'carddav'[\s\S]+FOR UPDATE/.test(sql)) {
        blocked = true;
        targetBooksLocked.resolve();
        await releaseApply.promise;
      }
      return result;
    });

    const pending = carddavSync.syncUser(fixture.userId);
    await targetBooksLocked.promise;
    const concurrent = new Client({ connectionString: connectionStringFor(databaseName) });
    await concurrent.connect();
    await concurrent.query(
      `INSERT INTO address_books (user_id, name)
       VALUES ($1, 'Concurrent footprint target')`,
      [fixture.userId],
    );
    await concurrent.end();
    releaseApply.resolve();

    await expect(pending).resolves.toMatchObject({ ok: true, bookCount: 1 });
    expect(mocks.fetchAddressBookDelta).toHaveBeenCalledOnce();
    expect(mocks.withTransaction).toHaveBeenCalledTimes(3);
  }, 120_000);

  it('persists projection fingerprint from final eligible target tokens', async () => {
    const userId = randomUUID();
    const generation = randomUUID();
    const remoteUrl = `https://dav.example.test/addressbooks/${userId}/`;
    await databaseClient.query(
      'INSERT INTO users (id, username) VALUES ($1, $2)',
      [userId, `carddav-fingerprint-${userId}`],
    );
    await databaseClient.query(
      `INSERT INTO user_integrations (user_id, provider, config)
       VALUES ($1, 'carddav', jsonb_build_object(
         'connectionGeneration', $2::text
       ))`,
      [userId, generation],
    );
    const { rows: localBooks } = await databaseClient.query(`
      INSERT INTO address_books (user_id, name)
      VALUES ($1, 'Fingerprint Target'), ($1, 'Fingerprint Unrelated')
      RETURNING id, name, sync_token
    `, [userId]);
    const targetBook = localBooks.find(book => book.name === 'Fingerprint Target');
    const unrelatedBook = localBooks.find(book => book.name === 'Fingerprint Unrelated');
    const targetVcard = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'UID:fingerprint-target',
      'FN:Fingerprint Original',
      'EMAIL:fingerprint@example.test',
      'END:VCARD',
      '',
    ].join('\r\n');
    await databaseClient.query(`
      INSERT INTO contacts (
        address_book_id, user_id, uid, vcard, etag, display_name,
        primary_email, emails, phones, is_auto
      ) VALUES (
        $1, $2, 'fingerprint-target', $3, $4, 'Fingerprint Original',
        'fingerprint@example.test', $5::jsonb, '[]'::jsonb, false
      )
    `, [
      targetBook.id,
      userId,
      targetVcard,
      createHash('md5').update(targetVcard).digest('hex'),
      JSON.stringify([{
        value: 'fingerprint@example.test', type: 'other', primary: true,
      }]),
    ]);

    await beginApply(completePlan({
      userId,
      connectionGeneration: generation,
      book: { url: remoteUrl, displayName: 'Fingerprint Remote' },
      upserts: [{
        ...remoteCard('fingerprint-merge', 'fingerprint@example.test'),
        href: `${remoteUrl}fingerprint-merge.vcf`,
      }],
    }));

    const { rows: finalBooks } = await databaseClient.query(`
      SELECT id, source, sync_token, remote_projection_fingerprint
      FROM address_books
      WHERE user_id = $1
      ORDER BY id
    `, [userId]);
    const finalTarget = finalBooks.find(book => book.id === targetBook.id);
    const finalUnrelated = finalBooks.find(book => book.id === unrelatedBook.id);
    const remoteBook = finalBooks.find(book => book.source === 'carddav');
    const fingerprintInputs = [
      [finalTarget.id, finalTarget.sync_token],
      [finalUnrelated.id, finalUnrelated.sync_token],
    ].sort(([left], [right]) => left.localeCompare(right));
    const expectedFingerprint = createHash('sha256')
      .update(JSON.stringify(fingerprintInputs))
      .digest('hex');

    expect({
      targetTokenRotated: finalTarget.sync_token !== targetBook.sync_token,
      unrelatedTokenStable: finalUnrelated.sync_token === unrelatedBook.sync_token,
      fingerprint: remoteBook.remote_projection_fingerprint,
    }).toEqual({
      targetTokenRotated: false,
      unrelatedTokenStable: true,
      fingerprint: expectedFingerprint,
    });
  }, 120_000);

  it('persists complete provenance, applies a delta, and rolls back exact local and remote tokens', async () => {
    const cards = [
      remoteCard('a-separate', 'new@example.test'),
      remoteCard('b-merge', 'duplicate@example.test'),
      remoteCard('c-skip', 'duplicate@example.test'),
    ];
    const plan = completePlan({ upserts: cards });

    const first = await beginApply(plan);
    const afterFirst = await persistedState();

    expect(first).toMatchObject({ remote: 3, updated: 2, removed: 0 });
    expect(first).not.toHaveProperty('count');
    expect(first.changedBookIds).not.toEqual([]);
    expect(first).not.toHaveProperty('visibleChanged');
    expect(afterFirst.ledger.map(row => ({
      href: row.href,
      remoteEtag: row.remote_etag,
      hasLocalContact: row.local_contact_id !== null,
    }))).toEqual([
      {
        href: cards[0].href,
        remoteEtag: cards[0].remoteEtag,
        hasLocalContact: true,
      },
      {
        href: cards[1].href,
        remoteEtag: cards[1].remoteEtag,
        hasLocalContact: true,
      },
      {
        href: cards[2].href,
        remoteEtag: cards[2].remoteEtag,
        hasLocalContact: true,
      },
    ]);
    const { rows: confirmedMappings } = await databaseClient.query(
      `SELECT href, mapping_status, remote_semantic_hash, local_contact_hash,
              legacy_projection, last_synced_at
       FROM carddav_remote_objects
       WHERE address_book_id = $1
       ORDER BY href`,
      [afterFirst.books[0].id],
    );
    expect(confirmedMappings).toHaveLength(3);
    for (const mapping of confirmedMappings) {
      expect(mapping).toMatchObject({
        mapping_status: 'synced',
        remote_semantic_hash: expect.any(String),
        local_contact_hash: expect.any(String),
        legacy_projection: null,
        last_synced_at: expect.any(Date),
      });
    }
    const mirrored = afterFirst.contacts.find(contact => contact.primary_email === 'new@example.test');
    expect(mirrored.uid).toBe(createHash('sha256').update(cards[0].href).digest('hex'));
    expect(mirrored.uid).not.toBe(cards[0].contact.uid);
    expect(mirrored.vcard).toContain(`UID:${mirrored.uid}\r\n`);
    expect(mirrored.vcard).toContain('FN:a-separate\r\n');
    expect(mirrored.etag).toBe(createHash('md5').update(mirrored.vcard).digest('hex'));
    const linked = afterFirst.contacts.find(contact => contact.uid === 'local-target');
    expect(linked).toMatchObject({
      display_name: 'Local Target',
      primary_email: 'duplicate@example.test',
    });
    expect(linked.vcard).toContain('FN:Local Target\r\n');
    const secondImport = afterFirst.contacts.find(contact => (
      contact.uid === createHash('sha256').update(cards[2].href).digest('hex')
    ));
    expect(secondImport).toMatchObject({
      display_name: 'c-skip',
      primary_email: 'duplicate@example.test',
    });

    const unchanged = await beginApply({
      ...plan,
      expectedRemoteRevision: afterFirst.books[0].remote_sync_revision,
    });
    const afterUnchanged = await persistedState();
    expect(unchanged.changedBookIds).toEqual([]);
    expect(unchanged).not.toHaveProperty('visibleChanged');
    expect(afterUnchanged.books[0].sync_token).toBe(afterFirst.books[0].sync_token);

    const tokenPlan = completePlan({
      expectedRemoteRevision: afterUnchanged.books[0].remote_sync_revision,
      nextRemoteToken: ' opaque-token-before ',
      upserts: cards,
    });
    await beginApply(tokenPlan);
    const beforeDelta = await persistedState();
    expect(beforeDelta.books[0].remote_sync_token).toBe(' opaque-token-before ');

    const changed = remoteCard('a-separate', 'new@example.test');
    changed.contact.displayName = 'Changed Name';
    changed.contact.firstName = 'Changed';
    changed.vcard = changed.vcard.replaceAll('a-separate', 'Changed Name');
    const changedPlan = completePlan({
      expectedRemoteRevision: beforeDelta.books[0].remote_sync_revision,
      expectedRemoteToken: ' opaque-token-before ',
      nextRemoteToken: 'remote-token-after',
      replaceAll: false,
      upserts: [changed],
      removedHrefs: [cards[2].href],
    });
    let contactMutated = false;
    await expect(beginApply(changedPlan, async (client, sql, params) => {
      if (/(?:INSERT INTO|UPDATE|DELETE FROM) carddav_remote_objects/.test(sql)) {
        expect(contactMutated).toBe(true);
        throw new Error('forced post-contact failure');
      }
      const result = await client.query(sql, params);
      if (sql.includes('INSERT INTO contacts') || sql.includes('UPDATE contacts SET')
        || sql.includes('DELETE FROM contacts')) {
        contactMutated = true;
      }
      return result;
    })).rejects.toThrow('forced post-contact failure');

    expect(await persistedState()).toEqual(beforeDelta);
  }, 120_000);

  it('replaces a canonical collection alias in place and rolls the rename back atomically', async () => {
    const aliasUrl = 'https://dav.example.test/addressbooks/alias-pg/';
    const canonicalUrl = 'https://dav.example.test/addressbooks/canonical-pg/';
    const retained = {
      ...remoteCard('alias-retained', 'alias-retained@example.test'),
      href: `${canonicalUrl}retained.vcf`,
    };
    const removed = {
      ...remoteCard('alias-removed', 'alias-removed@example.test'),
      href: `${canonicalUrl}removed.vcf`,
    };
    await beginApply(completePlan({
      book: { url: aliasUrl, displayName: 'Alias PG' },
      nextRemoteToken: 'alias-token-before',
      collectionIdentity: { observedUrl: aliasUrl, canonicalUrl: aliasUrl },
      upserts: [retained, removed],
    }));
    const { rows: [beforeBook] } = await databaseClient.query(
      `SELECT id, remote_sync_revision::text
       FROM address_books
       WHERE user_id = $1 AND source = 'carddav' AND external_url = $2`,
      [USER_ID, aliasUrl],
    );
    expect(beforeBook.remote_sync_revision).toBe('1');

    const changed = {
      ...retained,
      remoteEtag: 'W/"canonical-etag"',
      vcard: retained.vcard.replaceAll('alias-retained', 'canonical-retained'),
      contact: {
        ...retained.contact,
        displayName: 'canonical-retained',
        firstName: 'canonical-retained',
        lastName: 'canonical-retained',
      },
    };
    await beginApply(completePlan({
      book: { url: aliasUrl, displayName: 'Alias PG' },
      expectedRemoteRevision: '1',
      expectedRemoteToken: 'alias-token-before',
      nextRemoteToken: 'canonical-token-after',
      collectionIdentity: { observedUrl: aliasUrl, canonicalUrl },
      upserts: [changed],
    }));

    const { rows: books } = await databaseClient.query(
      `SELECT id, external_url, remote_sync_token, remote_sync_revision::text
       FROM address_books
       WHERE id = $1 OR (user_id = $2 AND external_url = $3)
       ORDER BY id`,
      [beforeBook.id, USER_ID, aliasUrl],
    );
    expect(books).toEqual([{
      id: beforeBook.id,
      external_url: canonicalUrl,
      remote_sync_token: 'canonical-token-after',
      remote_sync_revision: '2',
    }]);
    const { rows: ledger } = await databaseClient.query(
      `SELECT address_book_id, href, remote_etag
       FROM carddav_remote_objects
       WHERE address_book_id = $1
       ORDER BY href`,
      [beforeBook.id],
    );
    expect(ledger).toEqual([{
      address_book_id: beforeBook.id,
      href: changed.href,
      remote_etag: changed.remoteEtag,
    }]);

    const beforeRollback = await persistedState();
    await expect(beginApply(completePlan({
      book: { url: canonicalUrl, displayName: 'Alias PG' },
      expectedRemoteRevision: '2',
      expectedRemoteToken: 'canonical-token-after',
      nextRemoteToken: 'rollback-token',
      collectionIdentity: {
        observedUrl: canonicalUrl,
        canonicalUrl: `${canonicalUrl}renamed/`,
      },
      upserts: [changed],
    }), async (client, sql, params) => {
      const result = await client.query(sql, params);
      if (/UPDATE address_books SET/.test(sql)) throw new Error('forced post-rename failure');
      return result;
    })).rejects.toThrow('forced post-rename failure');
    expect(await persistedState()).toEqual(beforeRollback);
  }, 120_000);

  it('rejects a canonical URL conflict before mutating projection state', async () => {
    const aliasUrl = 'https://dav.example.test/addressbooks/conflict-alias/';
    const canonicalUrl = 'https://dav.example.test/addressbooks/conflict-canonical/';
    await beginApply(completePlan({
      book: { url: canonicalUrl, displayName: 'Canonical Owner' },
      collectionIdentity: { observedUrl: canonicalUrl, canonicalUrl },
    }));
    await beginApply(completePlan({
      book: { url: aliasUrl, displayName: 'Conflicting Alias' },
      collectionIdentity: { observedUrl: aliasUrl, canonicalUrl: aliasUrl },
    }));
    const { rows: [owner] } = await databaseClient.query(
      `SELECT id FROM address_books
       WHERE user_id = $1 AND source = 'carddav' AND external_url = $2`,
      [USER_ID, canonicalUrl],
    );
    const before = await persistedState();

    const error = await beginApply(completePlan({
      book: { url: aliasUrl, displayName: 'Conflicting Alias' },
      expectedRemoteRevision: '1',
      collectionIdentity: { observedUrl: aliasUrl, canonicalUrl },
    })).catch(caught => caught);

    expect(error).toBeInstanceOf(carddavSync.StaleCarddavPlanError);
    expect(error).toMatchObject({
      reason: 'canonical-url-conflict',
      observedUrl: aliasUrl,
      canonicalUrl,
      conflictingBookId: owner.id,
    });
    expect(await persistedState()).toEqual(before);
  }, 120_000);

  it('turns a concurrent canonical insert into typed stale state with exact rollback', async () => {
    const aliasUrl = 'https://dav.example.test/addressbooks/racing-alias/';
    const canonicalUrl = 'https://dav.example.test/addressbooks/racing-canonical/';
    await beginApply(completePlan({
      book: { url: aliasUrl, displayName: 'Racing Alias' },
      collectionIdentity: { observedUrl: aliasUrl, canonicalUrl: aliasUrl },
      upserts: [remoteCard('racing-alias', 'racing-alias@example.test')],
    }));
    const { rows: [beforeAlias] } = await databaseClient.query(
      `SELECT id, external_url, remote_sync_revision::text, remote_sync_token, sync_token
       FROM address_books
       WHERE user_id = $1 AND source = 'carddav' AND external_url = $2`,
      [USER_ID, aliasUrl],
    );
    const booksLocked = deferred();
    const releaseApply = deferred();
    const applyPromise = beginApply(completePlan({
      book: { url: aliasUrl, displayName: 'Racing Alias' },
      expectedRemoteRevision: beforeAlias.remote_sync_revision,
      collectionIdentity: { observedUrl: aliasUrl, canonicalUrl },
    }), async (client, sql, params) => {
      const result = await client.query(sql, params);
      if (/external_url = ANY\(\$2::text\[\]\)/.test(sql)) {
        booksLocked.resolve();
        await releaseApply.promise;
      }
      return result;
    });

    await booksLocked.promise;
    const concurrent = new Client({ connectionString: connectionStringFor(databaseName) });
    await concurrent.connect();
    const { rows: [canonicalBook] } = await concurrent.query(
      `INSERT INTO address_books (user_id, name, source, external_url)
       VALUES ($1, 'Racing Canonical', 'carddav', $2)
       RETURNING id`,
      [USER_ID, canonicalUrl],
    );
    await concurrent.end();
    releaseApply.resolve();

    const error = await applyPromise.catch(caught => caught);
    expect(error).toBeInstanceOf(carddavSync.StaleCarddavPlanError);
    expect(error).toMatchObject({
      reason: 'canonical-url-conflict',
      observedUrl: aliasUrl,
      canonicalUrl,
      conflictingBookId: canonicalBook.id,
    });
    const { rows: [afterAlias] } = await databaseClient.query(
      `SELECT id, external_url, remote_sync_revision::text, remote_sync_token, sync_token
       FROM address_books
       WHERE id = $1`,
      [beforeAlias.id],
    );
    expect(afterAlias).toEqual(beforeAlias);
  }, 120_000);

  it('rejects reciprocal alias replacements without a book-lock deadlock', async () => {
    const firstUrl = 'https://dav.example.test/addressbooks/reciprocal-a/';
    const secondUrl = 'https://dav.example.test/addressbooks/reciprocal-b/';
    for (const [url, name] of [[firstUrl, 'A'], [secondUrl, 'B']]) {
      await beginApply(completePlan({
        book: { url, displayName: `Reciprocal ${name}` },
        collectionIdentity: { observedUrl: url, canonicalUrl: url },
      }));
    }
    const before = await persistedState();
    const firstClient = new Client({ connectionString: connectionStringFor(databaseName) });
    const secondClient = new Client({ connectionString: connectionStringFor(databaseName) });
    await Promise.all([firstClient.connect(), secondClient.connect()]);

    async function applyReciprocal(client, observedUrl, canonicalUrl) {
      await client.query('BEGIN');
      try {
        await client.query("SET LOCAL lock_timeout = '5s'");
        const result = await carddavSync.applyBookDelta(client, completePlan({
          book: { url: observedUrl, displayName: 'Reciprocal' },
          expectedRemoteRevision: '1',
          collectionIdentity: { observedUrl, canonicalUrl },
        }));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }

    const results = await Promise.allSettled([
      applyReciprocal(firstClient, firstUrl, secondUrl),
      applyReciprocal(secondClient, secondUrl, firstUrl),
    ]);
    await Promise.all([firstClient.end(), secondClient.end()]);

    expect(results.map(result => result.status)).toEqual(['rejected', 'rejected']);
    for (const result of results) {
      expect(result.reason).toBeInstanceOf(carddavSync.StaleCarddavPlanError);
      expect(result.reason).toMatchObject({ reason: 'canonical-url-conflict' });
      expect(result.reason.code).not.toBe('40P01');
    }
    expect(await persistedState()).toEqual(before);
  }, 120_000);

  it('finalizes a canonical alias replacement without pruning the renamed book', async () => {
    const userId = randomUUID();
    const generation = randomUUID();
    const aliasUrl = `https://dav.example.test/addressbooks/${userId}/alias/`;
    const canonicalUrl = `https://dav.example.test/addressbooks/${userId}/canonical/`;
    const card = {
      ...remoteCard('alias-finalize', 'alias-finalize@example.test'),
      href: `${canonicalUrl}alias-finalize.vcf`,
    };
    await databaseClient.query(
      'INSERT INTO users (id, username) VALUES ($1, $2)',
      [userId, `carddav-alias-finalize-${userId}`],
    );
    await databaseClient.query(
      `INSERT INTO user_integrations (user_id, provider, config)
       VALUES ($1, 'carddav', jsonb_build_object(
         'connectionGeneration', $2::text
       ))`,
      [userId, generation],
    );
    await beginApply(completePlan({
      userId,
      book: { url: aliasUrl, displayName: 'Alias Finalize' },
      connectionGeneration: generation,
      nextRemoteToken: 'alias-before',
      collectionIdentity: { observedUrl: aliasUrl, canonicalUrl: aliasUrl },
      upserts: [card],
    }));
    const { rows: [aliasBook] } = await databaseClient.query(
      `SELECT id, remote_sync_revision::text
       FROM address_books WHERE user_id = $1 AND external_url = $2`,
      [userId, aliasUrl],
    );
    await beginApply(completePlan({
      userId,
      book: { url: aliasUrl, displayName: 'Alias Finalize' },
      connectionGeneration: generation,
      expectedRemoteRevision: aliasBook.remote_sync_revision,
      expectedRemoteToken: 'alias-before',
      nextRemoteToken: 'canonical-after',
      collectionIdentity: { observedUrl: aliasUrl, canonicalUrl },
      upserts: [card],
    }));
    const beforeFinalize = await persistedLifecycleState(userId);
    useDatabaseTransactions();

    await carddavSync.finalizeCarddavSync(userId, {
      connectionGeneration: generation,
      seenUrls: [canonicalUrl],
      status: {
        lastSyncAt: '2026-07-10T12:00:00.000Z',
        lastError: null,
        bookCount: 1,
        contactCount: 1,
      },
    });

    const afterFinalize = await persistedLifecycleState(userId);
    expect(afterFinalize.books).toEqual(beforeFinalize.books);
    expect(afterFinalize.contacts).toEqual(beforeFinalize.contacts);
    expect(afterFinalize.ledger).toEqual(beforeFinalize.ledger);
    expect(afterFinalize.books).toHaveLength(1);
    expect(afterFinalize.books[0]).toMatchObject({
      id: aliasBook.id,
      external_url: canonicalUrl,
      remote_sync_token: 'canonical-after',
    });
  }, 120_000);

  it('finalizes a valid empty account without rewriting linked explicit contacts', async () => {
    const fixture = await seedLifecycleUser();
    useDatabaseTransactions();
    const { rows: [beforeLocal] } = await databaseClient.query(
      'SELECT sync_token FROM address_books WHERE id = $1',
      [fixture.localBook.id],
    );
    const status = {
      lastSyncAt: '2026-07-10T12:00:00.000Z',
      lastError: null,
      bookCount: 0,
      contactCount: 0,
    };

    await carddavSync.finalizeCarddavSync(fixture.userId, {
      connectionGeneration: fixture.generation,
      seenUrls: [],
      status,
    });

    const { rows: remoteBooks } = await databaseClient.query(
      "SELECT id FROM address_books WHERE user_id = $1 AND source = 'carddav'",
      [fixture.userId],
    );
    expect(remoteBooks).toEqual([]);
    const { rows: [restored] } = await databaseClient.query(
      `SELECT display_name, notes, vcard, etag
       FROM contacts WHERE id = $1`,
      [fixture.target.id],
    );
    expect(restored).toMatchObject({
      display_name: 'Lifecycle Original',
      notes: 'local lifecycle edit',
    });
    expect(restored.vcard).toContain('FN:Lifecycle Original\r\n');
    expect(restored.vcard).toContain('NOTE:local lifecycle edit\r\n');
    expect(restored.etag).toBe(createHash('md5').update(restored.vcard).digest('hex'));
    const { rows: tokens } = await databaseClient.query(
      `SELECT id, sync_token FROM address_books
       WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [[fixture.localBook.id, fixture.unrelatedBook.id]],
    );
    expect(tokens.find(row => row.id === fixture.localBook.id).sync_token)
      .toBe(beforeLocal.sync_token);
    expect(tokens.find(row => row.id === fixture.unrelatedBook.id).sync_token)
      .toBe(fixture.unrelatedBook.sync_token);
    const { rows: [integration] } = await databaseClient.query(
      `SELECT config FROM user_integrations
       WHERE user_id = $1 AND provider = 'carddav'`,
      [fixture.userId],
    );
    expect(integration.config).toMatchObject(status);
  }, 120_000);

  it('finalizes valid empty status for a legacy null connection generation', async () => {
    const fixture = await seedLifecycleUser();
    await databaseClient.query(
      `UPDATE user_integrations
       SET config = jsonb_set(config, '{connectionGeneration}', 'null'::jsonb)
       WHERE user_id = $1 AND provider = 'carddav'`,
      [fixture.userId],
    );
    useDatabaseTransactions();
    const status = {
      lastSyncAt: '2026-07-10T13:00:00.000Z',
      lastError: null,
      bookCount: 0,
      contactCount: 0,
    };

    await carddavSync.finalizeCarddavSync(fixture.userId, {
      connectionGeneration: null,
      seenUrls: [],
      status,
    });

    const { rows: remoteBooks } = await databaseClient.query(
      `SELECT id FROM address_books
       WHERE user_id = $1 AND source = 'carddav'`,
      [fixture.userId],
    );
    expect(remoteBooks).toEqual([]);
    const { rows: [integration] } = await databaseClient.query(
      `SELECT config FROM user_integrations
       WHERE user_id = $1 AND provider = 'carddav'`,
      [fixture.userId],
    );
    expect(integration.config).toMatchObject({
      ...status,
      connectionGeneration: null,
    });
  }, 120_000);

  it('prunes one of multiple remote books with the exact lifecycle token and revision set', async () => {
    const fixture = await seedLifecycleUser();
    const staleBook = fixture.remoteBooks.find(book => book.external_url === fixture.remoteUrl);
    const survivingBook = fixture.remoteBooks.find(book => (
      book.external_url === fixture.secondRemoteUrl
    ));
    useDatabaseTransactions();

    await carddavSync.finalizeCarddavSync(fixture.userId, {
      connectionGeneration: fixture.generation,
      seenUrls: [fixture.secondRemoteUrl],
      status: {
        lastSyncAt: '2026-07-10T14:00:00.000Z',
        lastError: null,
        bookCount: 1,
        contactCount: 0,
      },
    });

    const { rows: books } = await databaseClient.query(
      `SELECT id, sync_token, remote_sync_revision::text
       FROM address_books
       WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [[
        staleBook.id,
        survivingBook.id,
        fixture.localBook.id,
        fixture.unrelatedBook.id,
      ]],
    );
    expect(books.find(book => book.id === staleBook.id)).toBeUndefined();
    expect(books.find(book => book.id === survivingBook.id)).toEqual({
      id: survivingBook.id,
      sync_token: survivingBook.sync_token,
      remote_sync_revision: survivingBook.remote_sync_revision,
    });
    expect(books.find(book => book.id === fixture.localBook.id).sync_token)
      .toBe(fixture.localBook.sync_token);
    expect(books.find(book => book.id === fixture.unrelatedBook.id).sync_token)
      .toBe(fixture.unrelatedBook.sync_token);
    const { rows: [restored] } = await databaseClient.query(
      `SELECT display_name, notes, vcard, etag
       FROM contacts WHERE id = $1`,
      [fixture.target.id],
    );
    expect(restored).toMatchObject({
      display_name: 'Lifecycle Original',
      notes: 'local lifecycle edit',
    });
    expect(restored.etag).toBe(createHash('md5').update(restored.vcard).digest('hex'));
  }, 120_000);

  it('prunes a stale book without reclassifying an untouched surviving mapping', async () => {
    const userId = randomUUID();
    const generation = randomUUID();
    const staleUrl = `https://dav.example.test/addressbooks/${userId}/stale/`;
    const survivorUrl = `https://dav.example.test/addressbooks/${userId}/survivor/`;
    await databaseClient.query(
      'INSERT INTO users (id, username) VALUES ($1, $2)',
      [userId, `carddav-reproject-${userId}`],
    );
    await databaseClient.query(
      `INSERT INTO user_integrations (user_id, provider, config)
       VALUES ($1, 'carddav', jsonb_build_object(
         'connectionGeneration', $2::text
       ))`,
      [userId, generation],
    );
    const { rows: books } = await databaseClient.query(
      `INSERT INTO address_books (user_id, name, source, external_url)
       VALUES
         ($1, 'Stale Source', 'carddav', $2),
         ($1, 'Surviving Source', 'carddav', $3)
       RETURNING id, external_url, sync_token`,
      [userId, staleUrl, survivorUrl],
    );
    const staleBook = books.find(book => book.external_url === staleUrl);
    const survivorBook = books.find(book => book.external_url === survivorUrl);
    const vcard = [
      'BEGIN:VCARD', 'VERSION:3.0', 'UID:shared-remote', 'FN:Shared Remote',
      'EMAIL:shared-remote@example.test', 'END:VCARD', '',
    ].join('\r\n');
    const localVcard = generateVCard({
      uid: 'shared-projected',
      displayName: 'Shared Remote',
      firstName: 'Shared',
      lastName: 'Remote',
      primaryEmail: 'shared-remote@example.test',
      emails: [{ value: 'shared-remote@example.test', type: 'other', primary: true }],
      phones: [],
    });
    const { rows: [projected] } = await databaseClient.query(`
      INSERT INTO contacts (
        address_book_id, user_id, uid, vcard, etag, display_name, first_name,
        last_name, primary_email, emails, phones, is_auto
      ) VALUES (
        $1, $2, 'shared-projected', $3, $4, 'Shared Remote', 'Shared', 'Remote',
        'shared-remote@example.test', $5::jsonb, '[]'::jsonb, false
      ) RETURNING id
    `, [
      staleBook.id,
      userId,
      localVcard,
      createHash('md5').update(localVcard).digest('hex'),
      JSON.stringify([{
        value: 'shared-remote@example.test', type: 'other', primary: true,
      }]),
    ]);
    await databaseClient.query(`
      INSERT INTO carddav_remote_objects (
        address_book_id, href, remote_etag, vcard, primary_email,
        disposition, local_contact_id
      ) VALUES
        ($1, $2, '"stale"', $3, 'shared-remote@example.test', 'separate', $4),
        ($5, $6, '"survivor"', $3, 'shared-remote@example.test', 'skip', NULL)
    `, [
      staleBook.id,
      `${staleUrl}shared.vcf`,
      vcard,
      projected.id,
      survivorBook.id,
      `${survivorUrl}shared.vcf`,
    ]);
    useDatabaseTransactions();

    await carddavSync.finalizeCarddavSync(userId, {
      connectionGeneration: generation,
      seenUrls: [survivorUrl],
      status: {
        lastSyncAt: '2026-07-10T12:00:00.000Z',
        lastError: null,
        bookCount: 1,
        contactCount: 1,
      },
    });

    const { rows: [survivorObject] } = await databaseClient.query(
      `SELECT disposition, local_contact_id
       FROM carddav_remote_objects WHERE address_book_id = $1`,
      [survivorBook.id],
    );
    expect(survivorObject).toMatchObject({
      disposition: 'skip',
      local_contact_id: null,
    });
    const { rows: [survivorAfter] } = await databaseClient.query(
      `SELECT sync_token, remote_sync_revision::text
       FROM address_books WHERE id = $1`,
      [survivorBook.id],
    );
    expect(survivorAfter.sync_token).toBe(survivorBook.sync_token);
    expect(survivorAfter.remote_sync_revision).toBe('0');
    const { rows: staleAfter } = await databaseClient.query(
      'SELECT id FROM address_books WHERE id = $1',
      [staleBook.id],
    );
    expect(staleAfter).toEqual([]);
  }, 120_000);

  it('materializes ordered legacy cross-book mappings into unique automatic owners', async () => {
    const fixture = await seedLegacyCrossBookUser();
    for (const [book, cards] of [
      [fixture.bookA, [fixture.aMerge, fixture.aSkip]],
      [fixture.bookB, [fixture.bMerge, fixture.bSkip]],
    ]) {
      await beginApply(completePlan({
        userId: fixture.userId,
        book: { url: book.external_url, displayName: 'Legacy Repair' },
        connectionGeneration: fixture.generation,
        expectedRemoteRevision: book.remote_sync_revision,
        collectionIdentity: {
          observedUrl: book.external_url,
          canonicalUrl: book.external_url,
        },
        upserts: cards,
      }));
    }

    const { rows: books } = await databaseClient.query(
      `SELECT id, sync_token, remote_sync_revision::text
       FROM address_books
       WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [[fixture.bookA.id, fixture.bookB.id, fixture.unrelatedBook.id]],
    );
    const bookA = books.find(book => book.id === fixture.bookA.id);
    const bookB = books.find(book => book.id === fixture.bookB.id);
    const unrelated = books.find(book => book.id === fixture.unrelatedBook.id);
    expect(bookA.sync_token).not.toBe(fixture.bookA.sync_token);
    expect(bookB.sync_token).not.toBe(fixture.bookB.sync_token);
    expect(unrelated.sync_token).toBe(fixture.unrelatedBook.sync_token);
    expect(bookA.remote_sync_revision)
      .toBe(String(BigInt(fixture.bookA.remote_sync_revision) + 1n));
    expect(bookB.remote_sync_revision)
      .toBe(String(BigInt(fixture.bookB.remote_sync_revision) + 1n));
    const { rows: repairedObjects } = await databaseClient.query(
      `SELECT o.href, o.mapping_status, o.legacy_projection, o.local_contact_id,
              c.address_book_id AS contact_book_id
       FROM carddav_remote_objects o
       LEFT JOIN contacts c ON c.id = o.local_contact_id
       WHERE o.address_book_id = $1 ORDER BY o.href`,
      [fixture.bookA.id],
    );
    expect(repairedObjects).toEqual([
      {
        href: fixture.aMerge.href,
        mapping_status: 'synced',
        legacy_projection: null,
        local_contact_id: expect.any(String),
        contact_book_id: fixture.bookA.id,
      },
      {
        href: fixture.aSkip.href,
        mapping_status: 'synced',
        legacy_projection: null,
        local_contact_id: expect.any(String),
        contact_book_id: fixture.bookA.id,
      },
    ]);
    const { rows: [restored] } = await databaseClient.query(
      `SELECT display_name, vcard, etag
       FROM contacts WHERE id = $1`,
      [fixture.bMergeContact.id],
    );
    expect(restored.display_name).toBe(fixture.bMerge.contact.displayName);
    expect(restored.vcard).toContain(`FN:${fixture.bMerge.contact.displayName}\r\n`);
    expect(restored.etag).toBe(createHash('md5').update(restored.vcard).digest('hex'));
  }, 120_000);

  it('prunes a legacy sibling after materializing the surviving automatic owners', async () => {
    const fixture = await seedLegacyCrossBookUser();
    await beginApply(completePlan({
      userId: fixture.userId,
      book: { url: fixture.bookA.external_url, displayName: 'Legacy Survivor' },
      connectionGeneration: fixture.generation,
      expectedRemoteRevision: fixture.bookA.remote_sync_revision,
      collectionIdentity: {
        observedUrl: fixture.bookA.external_url,
        canonicalUrl: fixture.bookA.external_url,
      },
      upserts: [fixture.aMerge, fixture.aSkip],
    }));
    const { rows: [materializedBook] } = await databaseClient.query(
      `SELECT id, sync_token, remote_sync_revision::text
       FROM address_books WHERE id = $1`,
      [fixture.bookA.id],
    );
    const { rows: [unrelatedBefore] } = await databaseClient.query(
      `SELECT id, source, external_url, sync_token, remote_sync_token,
              remote_sync_capability, remote_sync_revision::text,
              remote_projection_fingerprint
       FROM address_books WHERE id = $1`,
      [fixture.unrelatedBook.id],
    );
    useDatabaseTransactions();

    await carddavSync.finalizeCarddavSync(fixture.userId, {
      connectionGeneration: fixture.generation,
      seenUrls: [fixture.bookAUrl],
      status: {
        lastSyncAt: '2026-07-10T16:00:00.000Z',
        lastError: null,
        bookCount: 1,
        contactCount: 2,
      },
    });

    const { rows: books } = await databaseClient.query(
      `SELECT id, sync_token, remote_sync_revision::text
       FROM address_books
       WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [[fixture.bookA.id, fixture.bookB.id]],
    );
    expect(books).toEqual([{
      id: fixture.bookA.id,
      sync_token: materializedBook.sync_token,
      remote_sync_revision: materializedBook.remote_sync_revision,
    }]);
    const { rows: [unrelatedAfter] } = await databaseClient.query(
      `SELECT id, source, external_url, sync_token, remote_sync_token,
              remote_sync_capability, remote_sync_revision::text,
              remote_projection_fingerprint
       FROM address_books WHERE id = $1`,
      [fixture.unrelatedBook.id],
    );
    expect(unrelatedAfter).toEqual(unrelatedBefore);
    const { rows: objects } = await databaseClient.query(
      `SELECT o.href, o.mapping_status, o.legacy_projection, o.local_contact_id,
              c.address_book_id AS contact_book_id,
              c.display_name, c.vcard, c.etag
       FROM carddav_remote_objects o
       LEFT JOIN contacts c ON c.id = o.local_contact_id
       WHERE o.address_book_id = $1 ORDER BY o.href`,
      [fixture.bookA.id],
    );
    expect(objects.map(object => ({
      href: object.href,
      mapping_status: object.mapping_status,
      legacy_projection: object.legacy_projection,
      contact_book_id: object.contact_book_id,
    }))).toEqual([
      {
        href: fixture.aMerge.href,
        mapping_status: 'synced',
        legacy_projection: null,
        contact_book_id: fixture.bookA.id,
      },
      {
        href: fixture.aSkip.href,
        mapping_status: 'synced',
        legacy_projection: null,
        contact_book_id: fixture.bookA.id,
      },
    ]);
    const oldTargetIds = new Set([
      fixture.bMergeContact.id,
      fixture.bSkipContact.id,
    ]);
    for (const object of objects) {
      expect(oldTargetIds.has(object.local_contact_id)).toBe(false);
      const card = object.href === fixture.aMerge.href ? fixture.aMerge : fixture.aSkip;
      expect(object.display_name).toBe(card.contact.displayName);
      expect(object.vcard).toContain(`FN:${card.contact.displayName}\r\n`);
      expect(object.etag).toBe(createHash('md5').update(object.vcard).digest('hex'));
    }
    const { rows: oldTargets } = await databaseClient.query(
      'SELECT id FROM contacts WHERE id = ANY($1::uuid[])',
      [[fixture.bMergeContact.id, fixture.bSkipContact.id]],
    );
    expect(oldTargets).toEqual([]);
  }, 120_000);

  it('refreshes cached ledger primary email during complete reclassification', async () => {
    const userId = randomUUID();
    const generation = randomUUID();
    const remoteUrl = `https://dav.example.test/addressbooks/${userId}/cached/`;
    await databaseClient.query(
      'INSERT INTO users (id, username) VALUES ($1, $2)',
      [userId, `carddav-cached-${userId}`],
    );
    await databaseClient.query(
      `INSERT INTO user_integrations (user_id, provider, config)
       VALUES ($1, 'carddav', jsonb_build_object(
         'connectionGeneration', $2::text
       ))`,
      [userId, generation],
    );
    const { rows: [book] } = await databaseClient.query(
      `INSERT INTO address_books (user_id, name, source, external_url)
       VALUES ($1, 'Cached Source', 'carddav', $2)
       RETURNING id`,
      [userId, remoteUrl],
    );
    const vcard = [
      'BEGIN:VCARD', 'VERSION:3.0', 'UID:cached-primary', 'FN:Cached Primary',
      'EMAIL:fresh@example.test', 'END:VCARD', '',
    ].join('\r\n');
    await databaseClient.query(
      `INSERT INTO carddav_remote_objects (
         address_book_id, href, remote_etag, vcard, primary_email, disposition
       ) VALUES ($1, $2, '"cached"', $3, 'stale@example.test', 'skip')`,
      [book.id, `${remoteUrl}cached.vcf`, vcard],
    );
    await beginApply(completePlan({
      userId,
      book: { url: remoteUrl, displayName: 'Cached Source' },
      connectionGeneration: generation,
      expectedRemoteRevision: '0',
      collectionIdentity: { observedUrl: remoteUrl, canonicalUrl: remoteUrl },
      upserts: [{
        href: `${remoteUrl}cached.vcf`,
        remoteEtag: '"cached"',
        vcard,
        contact: {
          ...remoteCard('cached-primary', 'fresh@example.test').contact,
          displayName: 'Cached Primary',
        },
      }],
    }));

    const { rows: [object] } = await databaseClient.query(
      `SELECT primary_email, mapping_status, local_contact_id
       FROM carddav_remote_objects WHERE address_book_id = $1`,
      [book.id],
    );
    expect(object).toMatchObject({
      primary_email: 'fresh@example.test',
      mapping_status: 'synced',
      local_contact_id: expect.any(String),
    });
  }, 120_000);

  it('repairs legacy ledger-only state through complete reclassification', async () => {
    const userId = randomUUID();
    const generation = randomUUID();
    const remoteUrl = `https://dav.example.test/addressbooks/${userId}/ledger-only/`;
    const card = {
      ...remoteCard('ledger-only', 'ledger-only@example.test'),
      href: `${remoteUrl}ledger-only.vcf`,
    };
    await databaseClient.query(
      'INSERT INTO users (id, username) VALUES ($1, $2)',
      [userId, `carddav-ledger-only-${userId}`],
    );
    await databaseClient.query(
      `INSERT INTO user_integrations (user_id, provider, config)
       VALUES ($1, 'carddav', jsonb_build_object(
         'connectionGeneration', $2::text
       ))`,
      [userId, generation],
    );
    await beginApply(completePlan({
      userId,
      book: { url: remoteUrl, displayName: 'Ledger Only' },
      connectionGeneration: generation,
      collectionIdentity: { observedUrl: remoteUrl, canonicalUrl: remoteUrl },
      upserts: [card],
    }));
    const { rows: [before] } = await databaseClient.query(
      `SELECT id, sync_token, remote_sync_revision::text
       FROM address_books WHERE user_id = $1 AND external_url = $2`,
      [userId, remoteUrl],
    );
    await databaseClient.query(
      `UPDATE carddav_remote_objects SET primary_email = 'stale@example.test'
       WHERE address_book_id = $1`,
      [before.id],
    );
    await beginApply(completePlan({
      userId,
      book: { url: remoteUrl, displayName: 'Ledger Only' },
      connectionGeneration: generation,
      expectedRemoteRevision: before.remote_sync_revision,
      collectionIdentity: { observedUrl: remoteUrl, canonicalUrl: remoteUrl },
      upserts: [card],
    }));

    const { rows: [after] } = await databaseClient.query(
      `SELECT b.sync_token, b.remote_sync_revision::text, o.primary_email
       FROM address_books b
       JOIN carddav_remote_objects o ON o.address_book_id = b.id
       WHERE b.id = $1`,
      [before.id],
    );
    expect(after).toEqual({
      sync_token: before.sync_token,
      remote_sync_revision: String(BigInt(before.remote_sync_revision) + 1n),
      primary_email: 'ledger-only@example.test',
    });
  }, 120_000);

  it('retains an unmapped explicit contact as an automatic export intent', async () => {
    const userId = randomUUID();
    const generation = randomUUID();
    const remoteUrl = `https://dav.example.test/addressbooks/${userId}/unowned/`;
    await databaseClient.query(
      'INSERT INTO users (id, username) VALUES ($1, $2)',
      [userId, `carddav-unowned-${userId}`],
    );
    await databaseClient.query(
      `INSERT INTO user_integrations (user_id, provider, config)
       VALUES ($1, 'carddav', jsonb_build_object(
         'connectionGeneration', $2::text
       ))`,
      [userId, generation],
    );
    const { rows: [book] } = await databaseClient.query(
      `INSERT INTO address_books (user_id, name, source, external_url)
       VALUES ($1, 'Unowned Source', 'carddav', $2)
       RETURNING id, sync_token, remote_sync_revision::text`,
      [userId, remoteUrl],
    );
    const vcard = [
      'BEGIN:VCARD', 'VERSION:3.0', 'UID:unowned-visible', 'FN:Unowned Visible',
      'EMAIL:unowned@example.test', 'END:VCARD', '',
    ].join('\r\n');
    await databaseClient.query(
      `INSERT INTO contacts (
         address_book_id, user_id, uid, vcard, etag, display_name,
         primary_email, emails, phones, is_auto
       ) VALUES (
         $1, $2, 'unowned-visible', $3, $4, 'Unowned Visible',
         'unowned@example.test', $5::jsonb, '[]'::jsonb, false
       )`,
      [
        book.id,
        userId,
        vcard,
        createHash('md5').update(vcard).digest('hex'),
        JSON.stringify([{
          value: 'unowned@example.test', type: 'other', primary: true,
        }]),
      ],
    );
    const applied = await beginApply(completePlan({
      userId,
      book: { url: remoteUrl, displayName: 'Unowned Source' },
      connectionGeneration: generation,
      expectedRemoteRevision: book.remote_sync_revision,
      collectionIdentity: { observedUrl: remoteUrl, canonicalUrl: remoteUrl },
    }));

    const { rows: [after] } = await databaseClient.query(
      `SELECT sync_token, remote_sync_revision::text,
              (SELECT count(*)::int FROM contacts WHERE address_book_id = $1) AS contact_count
       FROM address_books WHERE id = $1`,
      [book.id],
    );
    expect(after).toEqual({
      sync_token: book.sync_token,
      remote_sync_revision: '1',
      contact_count: 1,
    });
    expect(applied).not.toHaveProperty('exports');
  }, 120_000);

  it('preserves a target book inserted while finalization prunes stale remote books', async () => {
    const userId = randomUUID();
    const generation = randomUUID();
    const remoteUrl = `https://dav.example.test/addressbooks/${userId}/footprint/`;
    const email = 'expanded-footprint@example.test';
    await databaseClient.query(
      'INSERT INTO users (id, username) VALUES ($1, $2)',
      [userId, `carddav-footprint-${userId}`],
    );
    await databaseClient.query(
      `INSERT INTO user_integrations (user_id, provider, config)
       VALUES ($1, 'carddav', jsonb_build_object(
         'connectionGeneration', $2::text
       ))`,
      [userId, generation],
    );
    const card = {
      ...remoteCard('expanded-footprint', email),
      href: `${remoteUrl}expanded-footprint.vcf`,
    };
    await beginApply(completePlan({
      userId,
      book: { url: remoteUrl, displayName: 'Footprint Source' },
      connectionGeneration: generation,
      collectionIdentity: { observedUrl: remoteUrl, canonicalUrl: remoteUrl },
      upserts: [card],
    }));
    const staleUrl = `https://dav.example.test/addressbooks/${userId}/stale/`;
    const { rows: [staleBook] } = await databaseClient.query(
      `INSERT INTO address_books (user_id, name, source, external_url)
       VALUES ($1, 'Stale Source', 'carddav', $2) RETURNING id`,
      [userId, staleUrl],
    );
    const booksLocked = deferred();
    const releaseFinalizer = deferred();
    useDatabaseTransactions(async (client, sql, params) => {
      const result = await client.query(sql, params);
      if (/SELECT id, source, external_url, sync_token[\s\S]+FROM address_books/.test(sql)) {
        booksLocked.resolve();
        await releaseFinalizer.promise;
      }
      return result;
    });
    const finalizer = carddavSync.finalizeCarddavSync(userId, {
      connectionGeneration: generation,
      seenUrls: [remoteUrl],
      status: {
        lastSyncAt: '2026-07-10T12:00:00.000Z',
        lastError: null,
        bookCount: 1,
        contactCount: 1,
      },
    });

    await booksLocked.promise;
    const concurrent = new Client({ connectionString: connectionStringFor(databaseName) });
    await concurrent.connect();
    const { rows: [targetBook] } = await concurrent.query(
      `INSERT INTO address_books (user_id, name)
       VALUES ($1, 'Concurrent Target') RETURNING id, sync_token`,
      [userId],
    );
    const targetVcard = [
      'BEGIN:VCARD', 'VERSION:3.0', 'UID:concurrent-target', 'FN:Concurrent Original',
      `EMAIL:${email}`, 'END:VCARD', '',
    ].join('\r\n');
    const { rows: [target] } = await concurrent.query(
      `INSERT INTO contacts (
         address_book_id, user_id, uid, vcard, etag, display_name,
         primary_email, emails, phones, is_auto
       ) VALUES (
         $1, $2, 'concurrent-target', $3, $4, 'Concurrent Original',
         $5, $6::jsonb, '[]'::jsonb, false
       ) RETURNING id`,
      [
        targetBook.id,
        userId,
        targetVcard,
        createHash('md5').update(targetVcard).digest('hex'),
        email,
        JSON.stringify([{ value: email, type: 'other', primary: true }]),
      ],
    );
    await concurrent.end();
    releaseFinalizer.resolve();

    await expect(finalizer).resolves.toBe(1);
    const { rows: [targetAfter] } = await databaseClient.query(
      `SELECT c.display_name, b.sync_token
       FROM contacts c JOIN address_books b ON b.id = c.address_book_id
       WHERE c.id = $1`,
      [target.id],
    );
    expect(targetAfter).toEqual({
      display_name: 'Concurrent Original',
      sync_token: targetBook.sync_token,
    });
    const { rows: [objectAfter] } = await databaseClient.query(
      `SELECT disposition, local_contact_id
       FROM carddav_remote_objects o
       JOIN address_books b ON b.id = o.address_book_id
       WHERE b.user_id = $1 AND o.href = $2`,
      [userId, card.href],
    );
    expect(objectAfter).toMatchObject({
      disposition: 'separate',
      local_contact_id: expect.any(String),
    });
    const { rows: staleAfter } = await databaseClient.query(
      'SELECT id FROM address_books WHERE id = $1',
      [staleBook.id],
    );
    expect(staleAfter).toEqual([]);
  }, 120_000);

  it('fences finalization by generation before pruning or status mutation', async () => {
    const fixture = await seedLifecycleUser();
    useDatabaseTransactions();
    const before = await persistedLifecycleState(fixture.userId);

    const error = await carddavSync.finalizeCarddavSync(fixture.userId, {
      connectionGeneration: 'stale-generation',
      seenUrls: [],
      status: {
        lastSyncAt: '2026-07-10T12:00:00.000Z',
        lastError: null,
        bookCount: 0,
        contactCount: 0,
      },
    }).catch(caught => caught);

    expect(error).toBeInstanceOf(carddavSync.StaleCarddavPlanError);
    expect(error).toMatchObject({
      expectedConnectionGeneration: 'stale-generation',
      actualConnectionGeneration: fixture.generation,
    });
    expect(await persistedLifecycleState(fixture.userId)).toEqual(before);
  }, 120_000);

  it('disconnects multiple remote books with the exact lifecycle token set', async () => {
    const fixture = await seedLifecycleUser();
    useDatabaseTransactions();
    expect(fixture.remoteBooks).toHaveLength(2);
    const { rows: seededObjects } = await databaseClient.query(
      `SELECT mapping_status, local_contact_id FROM carddav_remote_objects o
       JOIN address_books b ON b.id = o.address_book_id
       WHERE b.user_id = $1 ORDER BY o.href`,
      [fixture.userId],
    );
    expect(seededObjects).toHaveLength(4);
    expect(seededObjects.every(object => object.mapping_status === 'synced')).toBe(true);
    expect(new Set(seededObjects.map(object => object.local_contact_id)).size).toBe(4);
    const { rows: [beforeLocal] } = await databaseClient.query(
      'SELECT sync_token FROM address_books WHERE id = $1',
      [fixture.localBook.id],
    );

    await expect(carddavSync.disconnectCarddavAccount(fixture.userId))
      .resolves.toBe(true);

    const { rows: integrations } = await databaseClient.query(
      `SELECT id FROM user_integrations
       WHERE user_id = $1 AND provider = 'carddav'`,
      [fixture.userId],
    );
    expect(integrations).toEqual([]);
    const { rows: remoteBooks } = await databaseClient.query(
      "SELECT id FROM address_books WHERE user_id = $1 AND source = 'carddav'",
      [fixture.userId],
    );
    expect(remoteBooks).toEqual([]);
    const { rows: [restored] } = await databaseClient.query(
      `SELECT display_name, notes FROM contacts WHERE id = $1`,
      [fixture.target.id],
    );
    expect(restored).toEqual({
      display_name: 'Lifecycle Original',
      notes: 'local lifecycle edit',
    });
    const { rows: [secondRestored] } = await databaseClient.query(
      `SELECT display_name, notes FROM contacts WHERE id = $1`,
      [fixture.secondTarget.id],
    );
    expect(secondRestored).toEqual({
      display_name: 'Lifecycle Original B',
      notes: 'local lifecycle edit B',
    });
    const { rows: tokens } = await databaseClient.query(
      `SELECT id, sync_token FROM address_books
       WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [[fixture.localBook.id, fixture.unrelatedBook.id]],
    );
    expect(tokens.find(row => row.id === fixture.localBook.id).sync_token)
      .toBe(beforeLocal.sync_token);
    expect(tokens.find(row => row.id === fixture.unrelatedBook.id).sync_token)
      .toBe(fixture.unrelatedBook.sync_token);
    const afterFirstDisconnect = await persistedLifecycleState(fixture.userId);
    await expect(carddavSync.disconnectCarddavAccount(fixture.userId))
      .resolves.toBe(false);
    expect(await persistedLifecycleState(fixture.userId)).toEqual(afterFirstDisconnect);
  }, 120_000);

  it('rolls back projection-aware finalization when the status write fails', async () => {
    const fixture = await seedLifecycleUser();
    const before = await persistedLifecycleState(fixture.userId);
    useDatabaseTransactions(async (client, sql, params) => {
      if (/UPDATE user_integrations/.test(sql)) throw new Error('forced finalizer status failure');
      return client.query(sql, params);
    });

    await expect(carddavSync.finalizeCarddavSync(fixture.userId, {
      connectionGeneration: fixture.generation,
      seenUrls: [],
      status: {
        lastSyncAt: '2026-07-10T12:00:00.000Z',
        lastError: null,
        bookCount: 0,
        contactCount: 0,
      },
    })).rejects.toThrow('forced finalizer status failure');
    expect(await persistedLifecycleState(fixture.userId)).toEqual(before);
  }, 120_000);

  it('rolls back projection-aware disconnect when integration deletion fails', async () => {
    const fixture = await seedLifecycleUser();
    const before = await persistedLifecycleState(fixture.userId);
    useDatabaseTransactions(async (client, sql, params) => {
      if (/DELETE FROM user_integrations/.test(sql)) {
        throw new Error('forced disconnect deletion failure');
      }
      return client.query(sql, params);
    });

    await expect(carddavSync.disconnectCarddavAccount(fixture.userId))
      .rejects.toThrow('forced disconnect deletion failure');
    expect(await persistedLifecycleState(fixture.userId)).toEqual(before);
  }, 120_000);

  it('keeps automatic projection ownership idempotent across an empty incremental replay', async () => {
    const fixture = await seedAutomaticPair();
    const before = await automaticState(fixture.userId);
    const beforeBooks = new Map(before.books.map(book => [book.id, book]));
    const sourceBefore = beforeBooks.get(fixture.bookAId);
    useDatabaseTransactions();

    const replay = await beginApply(completePlan({
      userId: fixture.userId,
      book: { url: fixture.bookAUrl, displayName: 'Automatic Remote A' },
      connectionGeneration: fixture.generation,
      expectedRemoteRevision: sourceBefore.remote_sync_revision,
      expectedRemoteToken: sourceBefore.remote_sync_token,
      nextRemoteToken: 'automatic-replay-token',
      capability: 'sync-collection',
      replaceAll: false,
      collectionIdentity: {
        observedUrl: fixture.bookAUrl,
        canonicalUrl: fixture.bookAUrl,
      },
    }));

    expect(replay).toMatchObject({
      changedBookIds: [],
      ledgerChanged: false,
      updated: 0,
      removed: 0,
    });
    const after = await automaticState(fixture.userId);
    expect(after.contacts).toEqual(before.contacts);
    expect(after.ledger).toEqual(before.ledger);
    expect(after.integration).toEqual(before.integration);
    const afterBooks = new Map(after.books.map(book => [book.id, book]));
    expect(afterBooks.get(fixture.bookAId)).toEqual({
      ...sourceBefore,
      remote_sync_token: 'automatic-replay-token',
      remote_sync_revision: String(BigInt(sourceBefore.remote_sync_revision) + 1n),
    });
    for (const id of [fixture.bookBId, fixture.targetBook.id, fixture.unrelatedBook.id]) {
      expect(afterBooks.get(id)).toEqual(beforeBooks.get(id));
    }
    const { rows: mappings } = await databaseClient.query(
      `SELECT href, mapping_status, remote_semantic_hash, local_contact_hash,
              legacy_projection, local_contact_id
       FROM carddav_remote_objects o
       JOIN address_books b ON b.id = o.address_book_id
       WHERE b.user_id = $1
       ORDER BY href`,
      [fixture.userId],
    );
    expect(mappings).toHaveLength(2);
    expect(mappings.every(mapping => (
      mapping.mapping_status === 'synced'
      && mapping.remote_semantic_hash
      && mapping.local_contact_hash
      && mapping.legacy_projection === null
      && mapping.local_contact_id
    ))).toBe(true);
    expect(mappings.find(mapping => mapping.href === fixture.duplicate.href).local_contact_id)
      .toBe(fixture.targetContact.id);
  }, 120_000);

  it('rolls back automatic contact and mapping writes when the book revision update fails', async () => {
    const fixture = await seedAutomaticPair();
    const before = await persistedLifecycleState(fixture.userId);
    const sourceBefore = before.allBooks.find(book => book.id === fixture.bookBId);
    const changed = {
      ...fixture.unique,
      remoteEtag: '"automatic-rollback"',
      vcard: fixture.unique.vcard.replace('FN:Automatic Remote Unique', 'FN:Automatic Rollback'),
      contact: { ...fixture.unique.contact, displayName: 'Automatic Rollback' },
    };
    let mappingWritten = false;

    await expect(beginApply(completePlan({
      userId: fixture.userId,
      book: { url: fixture.bookBUrl, displayName: 'Automatic Remote B' },
      connectionGeneration: fixture.generation,
      expectedRemoteRevision: sourceBefore.remote_sync_revision,
      expectedRemoteToken: sourceBefore.remote_sync_token,
      nextRemoteToken: 'automatic-rollback-token',
      capability: 'sync-collection',
      replaceAll: false,
      collectionIdentity: {
        observedUrl: fixture.bookBUrl,
        canonicalUrl: fixture.bookBUrl,
      },
      upserts: [changed],
    }), async (client, sql, params) => {
      if (mappingWritten && /UPDATE address_books SET/.test(sql)) {
        throw new Error('forced automatic projection failure');
      }
      const result = await client.query(sql, params);
      if (/(?:INSERT INTO|UPDATE|DELETE FROM) carddav_remote_objects/.test(sql)) {
        mappingWritten = true;
      }
      return result;
    })).rejects.toThrow('forced automatic projection failure');
    expect(mappingWritten).toBe(true);
    expect(await persistedLifecycleState(fixture.userId)).toEqual(before);
  }, 120_000);

  it('serializes two NULL-token snapshot plans by revision CAS before projection reads', async () => {
    const userId = randomUUID();
    const generation = randomUUID();
    const remoteUrl = `https://dav.example.test/addressbooks/${userId}/snapshot-cas/`;
    await databaseClient.query(
      'INSERT INTO users (id, username) VALUES ($1, $2)',
      [userId, `carddav-snapshot-cas-${userId}`],
    );
    await databaseClient.query(
      `INSERT INTO user_integrations (user_id, provider, config)
       VALUES ($1, 'carddav', jsonb_build_object(
         'connectionGeneration', $2::text
       ))`,
      [userId, generation],
    );
    await databaseClient.query(
      `INSERT INTO address_books (user_id, name, source, external_url)
       VALUES ($1, 'Snapshot CAS', 'carddav', $2)`,
      [userId, remoteUrl],
    );
    const winnerCard = {
      ...remoteCard('Snapshot Winner', `snapshot-${userId}@example.test`),
      href: `${remoteUrl}winner.vcf`,
    };
    const loserCard = {
      ...remoteCard('Snapshot Loser', `snapshot-${userId}@example.test`),
      href: `${remoteUrl}loser.vcf`,
    };
    const plan = card => completePlan({
      userId,
      book: { url: remoteUrl, displayName: 'Snapshot CAS' },
      connectionGeneration: generation,
      expectedRemoteRevision: '0',
      expectedRemoteToken: null,
      nextRemoteToken: null,
      capability: 'snapshot',
      collectionIdentity: { observedUrl: remoteUrl, canonicalUrl: remoteUrl },
      upserts: [card],
    });
    const firstClient = new Client({ connectionString: connectionStringFor(databaseName) });
    const secondClient = new Client({ connectionString: connectionStringFor(databaseName) });
    await Promise.all([firstClient.connect(), secondClient.connect()]);
    await Promise.all([
      firstClient.query("SET lock_timeout = '3s'; SET statement_timeout = '6s'"),
      secondClient.query("SET lock_timeout = '3s'; SET statement_timeout = '6s'"),
    ]);
    const { rows: [{ pid: secondPid }] } = await secondClient.query(
      'SELECT pg_backend_pid() AS pid',
    );
    const firstLocked = deferred();
    const releaseFirst = deferred();
    const first = applyWithClient(firstClient, plan(winnerCard), async (client, sql, params) => {
      const result = await client.query(sql, params);
      if (/external_url = ANY\(\$2::text\[\]\)[\s\S]+FOR UPDATE/.test(sql)) {
        firstLocked.resolve();
        await releaseFirst.promise;
      }
      return result;
    });
    await firstLocked.promise;
    const secondQueries = [];
    const second = applyWithClient(secondClient, plan(loserCard), async (client, sql, params) => {
      secondQueries.push(sql);
      return client.query(sql, params);
    });
    await waitForPostgresState({
      description: 'second snapshot transaction to block on the revision lock',
      probe: () => probeBackendLock(secondPid),
    });
    releaseFirst.resolve();

    await expect(first).resolves.toMatchObject({ updated: 1 });
    const stale = await second.catch(error => error);
    expect(stale).toBeInstanceOf(carddavSync.StaleCarddavPlanError);
    expect(stale).toMatchObject({ expectedRemoteRevision: '0', actualRemoteRevision: '1' });
    expect(secondQueries.some(sql => /FROM contacts|FROM carddav_remote_objects/.test(sql)))
      .toBe(false);
    const afterWinner = await persistedLifecycleState(userId);
    const sourceAfterWinner = afterWinner.allBooks.find(book => book.source === 'carddav');
    expect(sourceAfterWinner).toMatchObject({
      remote_sync_token: null,
      remote_sync_revision: '1',
    });
    expect(afterWinner.contacts).toHaveLength(1);
    expect(afterWinner.contacts[0].display_name).toBe(winnerCard.contact.displayName);

    const stableToken = sourceAfterWinner.sync_token;
    await applyWithClient(firstClient, {
      ...plan(winnerCard),
      expectedRemoteRevision: '1',
    });
    const afterNoChange = await persistedLifecycleState(userId);
    expect(afterNoChange.allBooks.find(book => book.source === 'carddav')).toMatchObject({
      remote_sync_token: null,
      remote_sync_revision: '2',
      sync_token: stableToken,
    });
    expect(afterNoChange.contacts).toEqual(afterWinner.contacts);
    expect(afterNoChange.ledger).toEqual(afterWinner.ledger);
    await Promise.all([firstClient.end(), secondClient.end()]);
  }, 120_000);

  it('rolls back exact state before and after the final remote revision update', async () => {
    for (const boundary of ['before-remote-update', 'after-remote-update']) {
      const fixture = await seedAutomaticPair();
      const before = await persistedLifecycleState(fixture.userId);
      const source = before.allBooks.find(book => book.id === fixture.bookAId);
      const changed = {
        ...fixture.duplicate,
        remoteEtag: `"${boundary}"`,
        vcard: fixture.duplicate.vcard.replace(
          `FN:${fixture.duplicate.contact.displayName}`,
          `FN:${boundary}`,
        ),
        contact: { ...fixture.duplicate.contact, displayName: boundary },
      };
      const plan = completePlan({
        userId: fixture.userId,
        book: { url: source.external_url, displayName: 'Automatic Remote A' },
        connectionGeneration: fixture.generation,
        expectedRemoteRevision: source.remote_sync_revision,
        expectedRemoteToken: source.remote_sync_token,
        nextRemoteToken: `${boundary}-token`,
        capability: 'sync-collection',
        replaceAll: false,
        collectionIdentity: {
          observedUrl: source.external_url,
          canonicalUrl: source.external_url,
        },
        upserts: [changed],
      });

      await expect(beginApply(plan, async (client, sql, params) => {
        if (/external_url = COALESCE\(\$6, external_url\)/.test(sql)) {
          if (boundary === 'before-remote-update') throw new Error(boundary);
          await client.query(sql, params);
          throw new Error(boundary);
        }
        return client.query(sql, params);
      })).rejects.toThrow(boundary);
      expect(await persistedLifecycleState(fixture.userId), boundary).toEqual(before);
    }
  }, 120_000);

  it('updates automatic import photos while preserving a linked explicit contact through unlink', async () => {
    const userId = randomUUID();
    const generation = randomUUID();
    const separateUrl = `https://dav.example.test/addressbooks/${userId}/photo-separate/`;
    const mergeUrl = `https://dav.example.test/addressbooks/${userId}/photo-merge/`;
    const duplicateEmail = `photo-target-${userId}@example.test`;
    await databaseClient.query(
      'INSERT INTO users (id, username) VALUES ($1, $2)',
      [userId, `carddav-photo-parity-${userId}`],
    );
    await databaseClient.query(
      `INSERT INTO user_integrations (user_id, provider, config)
       VALUES ($1, 'carddav', jsonb_build_object(
         'connectionGeneration', $2::text
       ))`,
      [userId, generation],
    );
    const { rows: [targetBook] } = await databaseClient.query(
      "INSERT INTO address_books (user_id, name) VALUES ($1, 'Photo Target') RETURNING id, sync_token",
      [userId],
    );
    const target = {
      uid: `photo-target-${userId}`,
      displayName: 'Photo Original',
      primaryEmail: duplicateEmail,
      emails: [{ value: duplicateEmail, type: 'other', primary: true }],
      phones: [],
      organization: null,
      notes: 'photo local note',
      photoData: null,
    };
    const targetVcard = generateVCard(target);
    const targetEtag = createHash('md5').update(targetVcard).digest('hex');
    const { rows: [targetContact] } = await databaseClient.query(
      `INSERT INTO contacts (
         address_book_id, user_id, uid, vcard, etag, display_name,
         primary_email, emails, phones, notes, photo_data, is_auto
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8::jsonb, '[]'::jsonb, $9, NULL, false
       ) RETURNING id`,
      [
        targetBook.id, userId, target.uid, targetVcard, targetEtag,
        target.displayName, duplicateEmail, JSON.stringify(target.emails), target.notes,
      ],
    );
    const photoCard = (url, uid, name, email, photoData, remoteEtag) => {
      const contact = {
        uid,
        displayName: name,
        primaryEmail: email,
        emails: [{ value: email, type: 'other', primary: true }],
        phones: [],
        organization: null,
        notes: null,
        photoData,
      };
      return {
        href: `${url}${uid}.vcf`,
        remoteEtag,
        vcard: generateVCard(contact),
        contact,
      };
    };
    const jpeg = 'data:image/jpeg;base64,AQID';
    const png = 'data:image/png;base64,BAUG';
    const separateJpeg = photoCard(
      separateUrl, 'photo-separate', 'Photo Separate',
      `photo-separate-${userId}@example.test`, jpeg, '"photo-separate-1"',
    );
    const mergeJpeg = photoCard(
      mergeUrl, 'photo-merge', 'Photo Merge', duplicateEmail, jpeg, '"photo-merge-1"',
    );
    for (const [url, name, card, token] of [
      [separateUrl, 'Photo Separate', separateJpeg, 'photo-separate-token-1'],
      [mergeUrl, 'Photo Merge', mergeJpeg, 'photo-merge-token-1'],
    ]) {
      await beginApply(completePlan({
        userId,
        book: { url, displayName: name },
        connectionGeneration: generation,
        nextRemoteToken: token,
        capability: 'sync-collection',
        collectionIdentity: { observedUrl: url, canonicalUrl: url },
        upserts: [card],
      }));
    }
    const initial = await persistedLifecycleState(userId);
    const separateBook = initial.allBooks.find(book => book.external_url === separateUrl);
    const mergeBook = initial.allBooks.find(book => book.external_url === mergeUrl);
    const initialSeparate = initial.contacts.find(row => row.address_book_id === separateBook.id);
    const initialTarget = initial.contacts.find(row => row.address_book_id === targetBook.id);
    expect(initialSeparate.photo_data).toBe(jpeg);
    expect(initialSeparate.vcard).toContain('PHOTO;ENCODING=b;TYPE=JPEG:AQID\r\n');
    expect(initialSeparate.etag)
      .toBe(createHash('md5').update(initialSeparate.vcard).digest('hex'));
    expect(initialTarget).toMatchObject({
      display_name: target.displayName,
      photo_data: null,
      vcard: targetVcard,
      etag: targetEtag,
    });
    expect(initial.ledger.find(mapping => mapping.href === mergeJpeg.href)).toMatchObject({
      local_contact_id: targetContact.id,
      vcard: expect.stringContaining('PHOTO;ENCODING=b;TYPE=JPEG:AQID\r\n'),
    });

    const separatePng = photoCard(
      separateUrl, 'photo-separate', 'Photo Separate', separateJpeg.contact.primaryEmail,
      png, '"photo-separate-2"',
    );
    const mergePng = photoCard(
      mergeUrl, 'photo-merge', 'Photo Merge', duplicateEmail, png, '"photo-merge-2"',
    );
    for (const [url, card, expectedToken, nextToken] of [
      [separateUrl, separatePng, 'photo-separate-token-1', 'photo-separate-token-2'],
      [mergeUrl, mergePng, 'photo-merge-token-1', 'photo-merge-token-2'],
    ]) {
      await beginApply(completePlan({
        userId,
        book: { url, displayName: 'Photo' },
        connectionGeneration: generation,
        expectedRemoteRevision: '1',
        expectedRemoteToken: expectedToken,
        nextRemoteToken: nextToken,
        capability: 'sync-collection',
        replaceAll: false,
        collectionIdentity: { observedUrl: url, canonicalUrl: url },
        upserts: [card],
      }));
    }
    const updated = await persistedLifecycleState(userId);
    const updatedSeparateBook = updated.allBooks.find(book => book.id === separateBook.id);
    const updatedMergeBook = updated.allBooks.find(book => book.id === mergeBook.id);
    const updatedTargetBook = updated.allBooks.find(book => book.id === targetBook.id);
    const updatedSeparate = updated.contacts.find(row => row.address_book_id === separateBook.id);
    const updatedTarget = updated.contacts.find(row => row.address_book_id === targetBook.id);
    expect(updatedSeparate.photo_data).toBe(png);
    expect(updatedSeparate.vcard).toContain('PHOTO;ENCODING=b;TYPE=PNG:BAUG\r\n');
    expect(updatedSeparate.etag)
      .toBe(createHash('md5').update(updatedSeparate.vcard).digest('hex'));
    expect(updatedTarget).toEqual(initialTarget);
    expect(updated.ledger.find(mapping => mapping.href === mergePng.href)).toMatchObject({
      local_contact_id: targetContact.id,
      vcard: expect.stringContaining('PHOTO;ENCODING=b;TYPE=PNG:BAUG\r\n'),
    });
    expect(updatedSeparateBook.sync_token).not.toBe(separateBook.sync_token);
    expect(updatedMergeBook.sync_token).toBe(mergeBook.sync_token);
    expect(updatedTargetBook.sync_token)
      .toBe(initial.allBooks.find(book => book.id === targetBook.id).sync_token);

    await beginApply(completePlan({
      userId,
      book: { url: mergeUrl, displayName: 'Photo Merge' },
      connectionGeneration: generation,
      expectedRemoteRevision: '2',
      expectedRemoteToken: 'photo-merge-token-2',
      nextRemoteToken: 'photo-merge-token-3',
      capability: 'sync-collection',
      replaceAll: false,
      collectionIdentity: { observedUrl: mergeUrl, canonicalUrl: mergeUrl },
      upserts: [mergePng],
    }));
    const noOp = await persistedLifecycleState(userId);
    const noOpTarget = noOp.contacts.find(row => row.address_book_id === targetBook.id);
    expect(noOpTarget).toEqual(updatedTarget);
    expect(noOp.allBooks.find(book => book.id === targetBook.id).sync_token)
      .toBe(updatedTargetBook.sync_token);
    expect(noOp.allBooks.find(book => book.id === mergeBook.id)).toMatchObject({
      sync_token: updatedMergeBook.sync_token,
      remote_sync_revision: '3',
      remote_sync_token: 'photo-merge-token-3',
    });

    await beginApply(completePlan({
      userId,
      book: { url: mergeUrl, displayName: 'Photo Merge' },
      connectionGeneration: generation,
      expectedRemoteRevision: '3',
      expectedRemoteToken: 'photo-merge-token-3',
      nextRemoteToken: 'photo-merge-token-4',
      capability: 'sync-collection',
      replaceAll: false,
      collectionIdentity: { observedUrl: mergeUrl, canonicalUrl: mergeUrl },
      upserts: [],
      removedHrefs: [mergePng.href],
    }));
    const restored = await persistedLifecycleState(userId);
    const restoredTarget = restored.contacts.find(row => row.address_book_id === targetBook.id);
    expect(restoredTarget).toEqual(initialTarget);
    expect(restored.ledger.some(mapping => mapping.href === mergePng.href)).toBe(false);
    expect(restored.allBooks.find(book => book.id === targetBook.id).sync_token)
      .toBe(updatedTargetBook.sync_token);
    expect(restored.allBooks.find(book => book.id === mergeBook.id).sync_token)
      .toBe(updatedMergeBook.sync_token);
  }, 120_000);

  it('preserves local edits in both target-lock orderings', async () => {
    for (const ordering of ['local-first', 'sync-first']) {
      const fixture = await seedAutomaticPair();
      const before = await automaticState(fixture.userId);
      const source = before.books.find(book => book.id === fixture.bookAId);
      const changed = {
        ...fixture.duplicate,
        remoteEtag: `"local-edit-${ordering}"`,
        vcard: fixture.duplicate.vcard.replace(
          `FN:${fixture.duplicate.contact.displayName}`,
          `FN:Sync ${ordering}`,
        ),
        contact: { ...fixture.duplicate.contact, displayName: `Sync ${ordering}` },
      };
      const plan = completePlan({
        userId: fixture.userId,
        book: { url: source.external_url, displayName: 'Automatic Remote A' },
        connectionGeneration: fixture.generation,
        expectedRemoteRevision: source.remote_sync_revision,
        expectedRemoteToken: source.remote_sync_token,
        nextRemoteToken: `local-edit-${ordering}-token`,
        capability: 'sync-collection',
        replaceAll: false,
        collectionIdentity: {
          observedUrl: source.external_url,
          canonicalUrl: source.external_url,
        },
        upserts: [changed],
      });
      const syncClient = new Client({ connectionString: connectionStringFor(databaseName) });
      const localClient = new Client({ connectionString: connectionStringFor(databaseName) });
      await Promise.all([syncClient.connect(), localClient.connect()]);
      await Promise.all([
        syncClient.query("SET lock_timeout = '3s'; SET statement_timeout = '6s'"),
        localClient.query("SET lock_timeout = '3s'; SET statement_timeout = '6s'"),
      ]);

      if (ordering === 'local-first') {
        const sourceLocked = deferred();
        const releaseSync = deferred();
        const sync = applyWithClient(syncClient, plan, async (client, sql, params) => {
          const result = await client.query(sql, params);
          if (/external_url = ANY\(\$2::text\[\]\)[\s\S]+FOR UPDATE/.test(sql)) {
            sourceLocked.resolve();
            await releaseSync.promise;
          }
          return result;
        });
        await sourceLocked.promise;
        const localVcard = generateVCard({
          ...fixture.target,
          notes: 'local edit before target lock',
        });
        await localClient.query('BEGIN');
        await localClient.query(
          `UPDATE address_books SET sync_token = gen_random_uuid()::text
           WHERE id = $1`,
          [fixture.targetBook.id],
        );
        await localClient.query(
          `UPDATE contacts SET notes = 'local edit before target lock',
               vcard = $2, etag = $3
           WHERE id = $1`,
          [
            fixture.targetContact.id,
            localVcard,
            createHash('md5').update(localVcard).digest('hex'),
          ],
        );
        await localClient.query('COMMIT');
        releaseSync.resolve();
        await expect(sync).resolves.toMatchObject({ updated: 0, remote: 1 });
        const { rows: [contact] } = await databaseClient.query(
          `SELECT display_name, notes, vcard, etag FROM contacts WHERE id = $1`,
          [fixture.targetContact.id],
        );
        expect(contact).toMatchObject({
          display_name: fixture.target.displayName,
          notes: 'local edit before target lock',
          vcard: localVcard,
          etag: createHash('md5').update(localVcard).digest('hex'),
        });
      } else {
        const contactsLocked = deferred();
        const releaseSync = deferred();
        const sync = applyWithClient(syncClient, plan, async (client, sql, params) => {
          const result = await client.query(sql, params);
          if (/SELECT c\.id[\s\S]+c\.uid[\s\S]+FOR UPDATE OF c/.test(sql)) {
            contactsLocked.resolve();
            await releaseSync.promise;
          }
          return result;
        });
        await contactsLocked.promise;
        const localVcard = generateVCard({
          ...fixture.target,
          displayName: 'Local edit after sync lock',
        });
        const { rows: [{ pid: localPid }] } = await localClient.query(
          'SELECT pg_backend_pid() AS pid',
        );
        const local = (async () => {
          await localClient.query('BEGIN');
          try {
            await localClient.query(
              `UPDATE address_books SET sync_token = gen_random_uuid()::text
               WHERE id = $1`,
              [fixture.targetBook.id],
            );
            await localClient.query(
              `UPDATE contacts SET display_name = $2, vcard = $3, etag = $4
               WHERE id = $1`,
              [
                fixture.targetContact.id,
                'Local edit after sync lock',
                localVcard,
                createHash('md5').update(localVcard).digest('hex'),
              ],
            );
            await localClient.query('COMMIT');
          } catch (error) {
            await localClient.query('ROLLBACK');
            throw error;
          }
        })();
        await waitForPostgresState({
          description: 'local edit transaction to block on the target lock',
          probe: () => probeBackendLock(localPid),
        });
        releaseSync.resolve();
        await expect(sync).resolves.toMatchObject({ updated: 0, remote: 1 });
        await expect(local).resolves.toBeUndefined();
        const { rows: [contact] } = await databaseClient.query(
          `SELECT display_name, vcard, etag FROM contacts WHERE id = $1`,
          [fixture.targetContact.id],
        );
        expect(contact).toEqual({
          display_name: 'Local edit after sync lock',
          vcard: localVcard,
          etag: createHash('md5').update(localVcard).digest('hex'),
        });
      }
      await Promise.all([syncClient.end(), localClient.end()]);
    }
  }, 120_000);

  it('serializes two automatic source applies without deadlock in both source orders', async () => {
    for (const initiation of ['low-source-first', 'high-source-first']) {
      const userId = randomUUID();
      const generation = randomUUID();
      const [lowId, highId] = [randomUUID(), randomUUID()].sort();
      const urls = new Map([
        [lowId, `https://dav.example.test/addressbooks/${userId}/c17-low/`],
        [highId, `https://dav.example.test/addressbooks/${userId}/c17-high/`],
      ]);
      const duplicateEmail = `c17-${userId}@example.test`;
      await databaseClient.query(
        'INSERT INTO users (id, username) VALUES ($1, $2)',
        [userId, `carddav-c17-${initiation}-${userId}`],
      );
      await databaseClient.query(
        `INSERT INTO user_integrations (user_id, provider, config)
         VALUES ($1, 'carddav', jsonb_build_object(
           'connectionGeneration', $2::text
         ))`,
        [userId, generation],
      );
      const { rows: [targetBook] } = await databaseClient.query(
        "INSERT INTO address_books (user_id, name) VALUES ($1, 'C17 Target') RETURNING id, sync_token",
        [userId],
      );
      const target = {
        uid: `c17-target-${userId}`,
        displayName: 'C17 Original',
        primaryEmail: duplicateEmail,
        emails: [{ value: duplicateEmail, type: 'other', primary: true }],
        phones: [],
        organization: null,
        notes: null,
        photoData: null,
      };
      const targetVcard = generateVCard(target);
      await databaseClient.query(
        `INSERT INTO contacts (
           address_book_id, user_id, uid, vcard, etag, display_name,
           primary_email, emails, phones, is_auto
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8::jsonb, '[]'::jsonb, false
         )`,
        [
          targetBook.id, userId, target.uid, targetVcard,
          createHash('md5').update(targetVcard).digest('hex'), target.displayName,
          duplicateEmail, JSON.stringify(target.emails),
        ],
      );
      await databaseClient.query(
        `INSERT INTO address_books (id, user_id, name, source, external_url)
         VALUES ($1, $3, 'C17 Low', 'carddav', $4),
                ($2, $3, 'C17 High', 'carddav', $5)`,
        [lowId, highId, userId, urls.get(lowId), urls.get(highId)],
      );
      const cards = new Map();
      for (const [id, label] of [[lowId, 'low'], [highId, 'high']]) {
        const contact = {
          ...remoteCard('C17 Initial', duplicateEmail),
          href: `${urls.get(id)}${label}.vcf`,
        };
        cards.set(id, contact);
        await beginApply(completePlan({
          userId,
          book: { url: urls.get(id), displayName: `C17 ${label}` },
          connectionGeneration: generation,
          nextRemoteToken: `c17-${label}-token-1`,
          capability: 'sync-collection',
          collectionIdentity: { observedUrl: urls.get(id), canonicalUrl: urls.get(id) },
          upserts: [contact],
        }));
      }
      const before = await automaticState(userId);
      const beforeBooks = new Map(before.books.map(book => [book.id, book]));
      const applyClients = new Map();
      const applyPids = new Map();
      for (const id of [lowId, highId]) {
        const client = new Client({ connectionString: connectionStringFor(databaseName) });
        await client.connect();
        await client.query("SET lock_timeout = '3s'; SET statement_timeout = '8s'");
        applyClients.set(id, client);
        const { rows: [{ pid }] } = await client.query('SELECT pg_backend_pid() AS pid');
        applyPids.set(id, pid);
      }
      const reached = new Map([[lowId, deferred()], [highId, deferred()]]);
      const release = deferred();
      const startApply = id => {
        const label = id === lowId ? 'low' : 'high';
        const source = beforeBooks.get(id);
        return applyWithClient(
          applyClients.get(id),
          completePlan({
            userId,
            book: { url: urls.get(id), displayName: `C17 ${label}` },
            connectionGeneration: generation,
            expectedRemoteRevision: source.remote_sync_revision,
            expectedRemoteToken: source.remote_sync_token,
            nextRemoteToken: `c17-${label}-token-2`,
            capability: 'sync-collection',
            replaceAll: false,
            collectionIdentity: { observedUrl: urls.get(id), canonicalUrl: urls.get(id) },
          }),
          async (client, sql, params) => {
            const result = await client.query(sql, params);
            if (/external_url = ANY\(\$2::text\[\]\)[\s\S]+FOR UPDATE/.test(sql)) {
              reached.get(id).resolve();
              await release.promise;
            }
            return result;
          },
        );
      };
      const order = initiation === 'low-source-first'
        ? [lowId, highId]
        : [highId, lowId];
      const applies = [];
      applies.push(startApply(order[0]));
      await reached.get(order[0]).promise;
      applies.push(startApply(order[1]));
      await waitForPostgresState({
        description: 'second source apply to block on the source lock',
        probe: () => probeBackendLock(applyPids.get(order[1])),
      });

      release.resolve();
      const settled = await Promise.allSettled(applies);
      expect(settled.every(result => (
        result.status === 'fulfilled' || result.reason?.code !== '40P01'
      )), initiation).toBe(true);
      expect(settled, initiation).toEqual([
        expect.objectContaining({ status: 'fulfilled' }),
        expect.objectContaining({ status: 'fulfilled' }),
      ]);

      const after = await automaticState(userId);
      expect(after.integration).toEqual(before.integration);
      expect(after.contacts).toEqual(before.contacts);
      expect(after.ledger).toEqual(before.ledger);
      for (const id of [lowId, highId]) {
        const sourceBefore = beforeBooks.get(id);
        const sourceAfter = after.books.find(book => book.id === id);
        const label = id === lowId ? 'low' : 'high';
        expect(sourceAfter).toMatchObject({
          remote_sync_token: `c17-${label}-token-2`,
          remote_sync_revision: String(BigInt(sourceBefore.remote_sync_revision) + 1n),
          sync_token: sourceBefore.sync_token,
        });
      }
      await Promise.all([...applyClients.values()].map(client => client.end()));
    }
  }, 120_000);

  it('blocks a later automatic apply and rejects its stale revision after the winner commits', async () => {
    vi.clearAllMocks();
    const userId = randomUUID();
    const generation = randomUUID();
    await databaseClient.query(
      'INSERT INTO users (id, username) VALUES ($1, $2)',
      [userId, `carddav-automatic-lock-${userId}`],
    );
    await databaseClient.query(
      `INSERT INTO user_integrations (user_id, provider, config)
       VALUES ($1, 'carddav', jsonb_build_object(
         'connectionGeneration', $2::text
       ))`,
      [userId, generation],
    );
    await beginApply(completePlan({
      userId,
      connectionGeneration: generation,
      nextRemoteToken: 'automatic-token-before',
    }));
    const { rows: [sourceBook] } = await databaseClient.query(
      `SELECT remote_sync_revision::text
       FROM address_books
       WHERE user_id = $1 AND source = 'carddav' AND external_url = $2`,
      [userId, BOOK_URL],
    );

    const laterClient = new Client({ connectionString: connectionStringFor(databaseName) });
    await laterClient.connect();
    const { rows: [{ pid: laterPid }] } = await laterClient.query(
      'SELECT pg_backend_pid() AS pid',
    );

    const applyHoldingLocks = deferred();
    const releaseApply = deferred();
    const applyPromise = beginApply(completePlan({
      userId,
      connectionGeneration: generation,
      expectedRemoteRevision: sourceBook.remote_sync_revision,
      expectedRemoteToken: 'automatic-token-before',
      nextRemoteToken: 'automatic-token-after',
      replaceAll: false,
    }), async (client, sql, params) => {
      const result = await client.query(sql, params);
      if (/FROM user_integrations[\s\S]+FOR UPDATE/.test(sql)) {
        applyHoldingLocks.resolve();
        await releaseApply.promise;
      }
      return result;
    });

    await applyHoldingLocks.promise;
    const laterPromise = applyWithClient(laterClient, completePlan({
      userId,
      connectionGeneration: generation,
      expectedRemoteRevision: sourceBook.remote_sync_revision,
      expectedRemoteToken: 'automatic-token-before',
      nextRemoteToken: 'later-automatic-token',
      replaceAll: false,
    }));
    await waitForPostgresState({
      description: 'later automatic apply to block behind the integration lock',
      probe: () => probeBackendLock(laterPid),
    });
    releaseApply.resolve();

    await expect(applyPromise).resolves.toMatchObject({ remote: 0 });
    await expect(laterPromise).rejects.toMatchObject({
      name: 'StaleCarddavPlanError',
      expectedRemoteRevision: sourceBook.remote_sync_revision,
      actualRemoteRevision: String(BigInt(sourceBook.remote_sync_revision) + 1n),
    });
    const { rows: [book] } = await databaseClient.query(
      `SELECT remote_sync_token, remote_sync_revision::text
       FROM address_books
       WHERE user_id = $1 AND source = 'carddav' AND external_url = $2`,
      [userId, BOOK_URL],
    );
    expect(book).toEqual({
      remote_sync_token: 'automatic-token-after',
      remote_sync_revision: String(BigInt(sourceBook.remote_sync_revision) + 1n),
    });
    await laterClient.end();
  }, 120_000);

});
