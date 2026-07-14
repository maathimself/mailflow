// CardDAV sync orchestration + scheduler. Pulls contacts from a user's connected
// CardDAV server (provider='carddav' in user_integrations) into per-remote-book,
// read-only local address books. Remote objects are linked to explicit local
// contacts deterministically and unmatched contacts are imported or exported.

import crypto from 'crypto';
import {
  localContactHash,
  localVCardEtag,
  overlayContactOnVCard,
  parseVCardDocument,
  presentedVCard,
  pushSafeSnapshot,
  primaryEmail,
  semanticVCardHash,
  serializeVCardDocument,
} from '../utils/vcardProperties.js';
import { query, withTransaction } from './db.js';
import { generateVCard, parseVCard } from '../utils/vcard.js';
import { discoverAddressBooks, fetchAddressBookDelta } from './carddavClient.js';
import {
  CardDavError,
  activeRetryAfterAt,
  resolveCarddavCredentials,
} from './carddavTransport.js';
import {
  exportExistingContact,
  recoverPendingCarddavMutations,
} from './carddavContactService.js';
import { deleteResolvedConflictsBefore } from './carddavConflictService.js';
import {
  advanceDiscoveredBookState,
  applyConfirmedRemoteContact,
  applyRemoteTombstone,
  lockCarddavIntegration,
  normalizeCarddavCapabilities,
  persistDiscoveredBook,
  refreshUnresolvedConflict,
} from './carddavMappingState.js';
import { normalizeEmail, planAutomaticProjection } from './carddavProjection.js';

const DEFAULT_INTERVAL_MIN = 60;
const CONFLICT_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CONFLICT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const timers = new Map();   // userId -> interval id
let conflictCleanupTimer;
const syncing = new Set();  // userIds with a sync in flight (prevents overlap)
const activeSyncGenerations = new Map();
const pendingReplacementSyncs = new Set();
const RESULT_COUNTERS = [
  'remote', 'fetched', 'updated', 'removed', 'fallback',
];

const emptyResultCounters = () => Object.fromEntries(RESULT_COUNTERS.map(counter => [counter, 0]));
const PLAN_FENCES = ['connectionGeneration', 'expectedRemoteRevision', 'expectedRemoteToken'];
const STALE_PLAN_ACTIONS = Object.freeze({
  'invalid-plan-fence': 'abort',
  'not-connected': 'abort',
  'connection-generation-changed': 'abort',
  'projection-footprint-changed': 'retry-apply',
  'mapping-revision-changed': 'abort',
  'mapping-contact-missing': 'abort',
  'canonical-url-conflict': 'abort',
  'book-update-missed': 'abort',
  'canonical-reconciliation-required': 'abort',
  'observed-alias-missing': 'abort',
  'remote-revision-changed': 'refetch-once',
  'remote-token-changed': 'refetch-once',
});

function addResultCounters(total, counters) {
  for (const counter of RESULT_COUNTERS) total[counter] += counters[counter] || 0;
}

function carddavContactCount(config) {
  const count = Number(config?.contactCount);
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

function projectionFingerprint(books) {
  const inputs = books
    .map(book => [book.id, book.sync_token])
    .sort(([left], [right]) => left.localeCompare(right));
  return crypto.createHash('sha256').update(JSON.stringify(inputs)).digest('hex');
}

function requirePlanFences(plan) {
  if (PLAN_FENCES.every(field => Object.hasOwn(plan, field))) return;
  throw new StaleCarddavPlanError({ reason: 'invalid-plan-fence' });
}

export function stalePlanAction(reason) {
  if (Object.hasOwn(STALE_PLAN_ACTIONS, reason)) return STALE_PLAN_ACTIONS[reason];
  throw new TypeError(`Unknown stale CardDAV plan reason: ${reason}`);
}

function observedCapabilities(book) {
  return normalizeCarddavCapabilities(book.capabilities);
}

export class StaleCarddavPlanError extends Error {
  constructor(details) {
    stalePlanAction(details?.reason);
    super(details?.reason === 'not-connected' ? 'not connected' : 'CardDAV sync plan is stale');
    this.name = 'StaleCarddavPlanError';
    Object.assign(this, details);
  }
}

export function assertConnectionGeneration(actual, expected) {
  if (expected === undefined || actual === expected) return;
  throw new StaleCarddavPlanError({
    reason: 'connection-generation-changed',
    expectedConnectionGeneration: expected,
    actualConnectionGeneration: actual ?? null,
  });
}

export async function getCardavConfig(userId) {
  const r = await query(
    "SELECT config FROM user_integrations WHERE user_id = $1 AND provider = 'carddav'",
    [userId],
  );
  return r.rows[0]?.config || null;
}

async function invalidateCarddavBookIdentity(client, userId) {
  const { rows: books } = await client.query(
    `SELECT id
     FROM address_books
     WHERE user_id = $1 AND source = 'carddav'
     ORDER BY id
     FOR UPDATE`,
    [userId],
  );
  if (!books.length) return;
  await client.query(
    `UPDATE address_books
     SET remote_sync_token = NULL,
         remote_sync_capability = 'unknown',
         remote_sync_revision = remote_sync_revision + 1,
         remote_projection_fingerprint = NULL,
         updated_at = NOW()
     WHERE user_id = $1 AND id = ANY($2::uuid[])`,
    [userId, books.map(book => book.id)],
  );
}

export async function replaceCarddavConnection(userId, connection) {
  return withTransaction(async client => {
    const integration = await lockCarddavIntegration(client, userId);
    const contactCount = integration ? carddavContactCount(integration.config) : null;
    if (integration) {
      const identityChanged = integration.config?.serverUrl !== connection.serverUrl
        || integration.config?.username !== connection.username;
      if (identityChanged) await invalidateCarddavBookIdentity(client, userId);
    }
    const config = {
      serverUrl: connection.serverUrl,
      username: connection.username,
      password: connection.password,
      intervalMin: connection.intervalMin ?? DEFAULT_INTERVAL_MIN,
      connectionGeneration: crypto.randomUUID(),
      lastError: null,
    };
    if (contactCount !== null) config.contactCount = contactCount;
    if (integration) {
      const updated = await client.query(
        `UPDATE user_integrations
         SET config = $2::jsonb, updated_at = NOW()
         WHERE id = $1`,
        [integration.id, JSON.stringify(config)],
      );
      if (updated.rowCount !== 1) throw new StaleCarddavPlanError({ reason: 'not-connected' });
    } else {
      await client.query(
        `INSERT INTO user_integrations (user_id, provider, config)
         VALUES ($1, 'carddav', $2::jsonb)`,
        [userId, JSON.stringify(config)],
      );
    }
    return config;
  });
}

export async function patchCarddavConnection(userId, patch, expectedGeneration) {
  return withTransaction(async client => {
    const integration = await lockCarddavIntegration(client, userId);
    if (!integration) throw new StaleCarddavPlanError({ reason: 'not-connected' });
    const actualGeneration = integration.config?.connectionGeneration ?? null;
    assertConnectionGeneration(actualGeneration, expectedGeneration);
    const identityChanged = ['serverUrl', 'username'].some(field => (
      Object.hasOwn(patch, field) && patch[field] !== integration.config?.[field]
    ));
    if (identityChanged) await invalidateCarddavBookIdentity(client, userId);

    const nextPatch = {};
    for (const field of ['serverUrl', 'username', 'password', 'intervalMin']) {
      if (Object.hasOwn(patch, field)) nextPatch[field] = patch[field];
    }
    if (['serverUrl', 'username', 'password'].some(field => Object.hasOwn(patch, field))) {
      nextPatch.connectionGeneration = crypto.randomUUID();
      nextPatch.lastError = null;
    }
    const config = { ...integration.config, ...nextPatch };
    const updated = await client.query(
      `UPDATE user_integrations
       SET config = $2::jsonb, updated_at = NOW()
       WHERE id = $1`,
      [integration.id, JSON.stringify(config)],
    );
    if (updated.rowCount !== 1) throw new StaleCarddavPlanError({ reason: 'not-connected' });
    return config;
  });
}

async function lockCarddavBooks(client, userId, urls) {
  const result = await client.query(
    `SELECT id, external_url, remote_sync_token, remote_sync_revision::text, sync_token,
            remote_projection_fingerprint
     FROM address_books
     WHERE user_id = $1 AND source = 'carddav' AND external_url = ANY($2::text[])
     ORDER BY id
     FOR UPDATE`,
    [userId, urls],
  );
  return result.rows;
}

async function lockEligibleTargetBooks(client, userId) {
  const result = await client.query(
    `SELECT id, source, sync_token
     FROM address_books
     WHERE user_id = $1 AND source <> 'carddav'
     ORDER BY id
     FOR UPDATE`,
    [userId],
  );
  return result.rows;
}

async function validateTargetBookFootprint(client, userId, lockedBooks) {
  const { rows: currentBooks } = await client.query(
    `SELECT id, source, sync_token
     FROM address_books
     WHERE user_id = $1 AND source <> 'carddav'
     ORDER BY id`,
    [userId],
  );
  const unchanged = lockedBooks.length === currentBooks.length
    && lockedBooks.every((book, index) => (
      book.id === currentBooks[index].id
      && book.sync_token === currentBooks[index].sync_token
    ));
  if (!unchanged) {
    throw new StaleCarddavPlanError({ reason: 'projection-footprint-changed' });
  }
}

async function lockProjectionContacts(client, userId, sourceBookId) {
  const result = await client.query(`
    SELECT c.id, c.address_book_id, ab.source AS address_book_source,
           c.uid, c.vcard, c.etag, c.display_name, c.first_name, c.last_name,
           c.primary_email, c.emails, c.phones, c.organization, c.notes, c.photo_data,
           c.additional_fields, c.is_auto
    FROM contacts c
    JOIN address_books ab ON ab.id = c.address_book_id
    WHERE c.user_id = $1
      AND (c.address_book_id = $2 OR ab.source <> 'carddav')
    ORDER BY c.id
    FOR UPDATE OF c
  `, [userId, sourceBookId]);
  return result.rows;
}

async function validateProjectionFootprint(client, userId, targetBooks, contactRows, sourceBookId) {
  const currentBooks = await client.query(
    `SELECT id
     FROM address_books
     WHERE user_id = $1 AND source <> 'carddav'
     ORDER BY id`,
    [userId],
  );
  const currentContacts = await client.query(
    `SELECT c.id
     FROM contacts c
     JOIN address_books ab ON ab.id = c.address_book_id
     WHERE c.user_id = $1
       AND (c.address_book_id = $2 OR ab.source <> 'carddav')
     ORDER BY c.id`,
    [userId, sourceBookId],
  );
  const sameIds = (left, right) => left.length === right.length
    && left.every((row, index) => row.id === right[index].id);
  if (sameIds(targetBooks, currentBooks.rows) && sameIds(contactRows, currentContacts.rows)) return;
  throw new StaleCarddavPlanError({ reason: 'projection-footprint-changed' });
}

async function rotateChangedBookTokens(client, userId, changedBookIds) {
  const ids = [...new Set(changedBookIds)].sort();
  if (!ids.length) return [];
  const result = await client.query(
    `UPDATE address_books
     SET sync_token = gen_random_uuid()::text, updated_at = NOW()
     WHERE user_id = $1 AND id = ANY($2::uuid[])
     RETURNING id, source, sync_token`,
    [userId, ids],
  );
  if (result.rowCount !== ids.length) {
    throw new StaleCarddavPlanError({ reason: 'projection-footprint-changed' });
  }
  return result.rows;
}

function contactFromVCard(vcard, href) {
  const c = parseVCard(vcard);
  const uid = c.uid || crypto.createHash('md5').update(href).digest('hex');
  const preferredEmail = primaryEmail(c);
  return {
    uid,
    displayName: c.displayName || preferredEmail || null,
    firstName: c.firstName, lastName: c.lastName,
    primaryEmail: preferredEmail,
    emails: c.emails, phones: c.phones,
    organization: c.organization, notes: c.notes, photoData: c.photoData,
    additionalFields: c.additionalFields || [],
    vcard,
  };
}

function contactFromRow(row, bookId) {
  return {
    id: row.id,
    addressBookId: row.address_book_id,
    inRemoteBook: row.address_book_id === bookId,
    isCarddavProjected: row.address_book_source === 'carddav',
    uid: row.uid,
    vcard: row.vcard,
    etag: row.etag,
    displayName: row.display_name,
    firstName: row.first_name,
    lastName: row.last_name,
    primaryEmail: row.primary_email,
    emails: row.emails,
    phones: row.phones,
    organization: row.organization,
    notes: row.notes,
    photoData: row.photo_data,
    additionalFields: row.additional_fields || [],
    isAuto: row.is_auto,
  };
}

// A linked local contact tracks inbound remote changes (edits and deletes) when it
// lives in the CardDAV book (materialized from the remote) or shares the remote
// resource's UID (MailFlow pushed the remote from this contact). A contact merged to
// a remote only by matching email keeps a distinct UID and stays locally
// authoritative, so remote edits never overwrite it and a remote delete only unlinks.
function linkedContactFollowsRemote(contact, bookId, retainedVcard) {
  if (contact.addressBookId === bookId) return true;
  if (!retainedVcard) return false;
  const retainedUid = parseVCard(retainedVcard).uid;
  return Boolean(retainedUid) && retainedUid === contact.uid;
}

// The local snapshot stored on a sync-created conflict is pushed verbatim by a later
// keep-mailflow resolution, so it must be lossless AND carry the retained remote UID.
// Overlay the current local contact onto the retained remote vCard (the same overlay
// updateContact/replace use). If the overlay throws, re-key the stored vCard to the remote
// UID or fail closed (pushSafeSnapshot) — the fallback must never mint the local key
// onto the remote resource. The !mapping.vcard guard is defensive: a real
// mapped contact always has a retained vCard; when it is absent the contact is push-origin,
// whose local UID already equals the remote UID, so its stored vCard is safe.
function conflictLocalSnapshot(mapping, contact) {
  if (!contact) return null;
  if (!mapping.vcard) return contact.vcard;
  const retained = parseVCardDocument(mapping.vcard);
  try {
    return serializeVCardDocument(
      overlayContactOnVCard(retained, contact, { preserveDocumentUid: true }),
    );
  } catch (error) {
    return pushSafeSnapshot(contact.vcard, retained, error);
  }
}

function automaticMappingFromRow(row) {
  const document = row.vcard && (!row.vcard_version || !row.remote_semantic_hash)
    ? parseVCardDocument(row.vcard)
    : null;
  return {
    addressBookId: row.address_book_id,
    href: row.href,
    remoteEtag: row.remote_etag,
    vcard: row.vcard,
    primaryEmail: row.primary_email,
    localContactId: row.local_contact_id,
    mappingStatus: row.mapping_status ?? 'synced',
    vcardVersion: row.vcard_version ?? document?.version ?? null,
    remoteSemanticHash: row.remote_semantic_hash
      ?? (document ? semanticVCardHash(document) : null),
    localContactHash: row.local_contact_hash,
    mappingRevision: row.mapping_revision ?? '0',
    legacyProjection: row.legacy_projection,
  };
}

function desiredAutomaticContact(remote, primaryEmail, uid) {
  const contact = {
    ...remote.contact,
    // Imports key the local UID to the remote href; refreshes preserve the existing
    // UID so a push-origin contact keeps its identity across an inbound remote edit.
    uid: uid ?? crypto.createHash('sha256').update(remote.href).digest('hex'),
    primaryEmail,
    additionalFields: remote.contact?.additionalFields || [],
  };
  const vcard = generateVCard(contact);
  return { ...contact, vcard, etag: localVCardEtag(vcard), isAuto: false };
}

function confirmedAutomaticMapping(remote, contactId, contact) {
  const document = parseVCardDocument(remote.vcard);
  return {
    href: remote.href,
    remoteEtag: remote.remoteEtag ?? null,
    vcard: remote.vcard,
    primaryEmail: remote.contact?.primaryEmail ?? remote.primaryEmail ?? null,
    localContactId: contactId,
    vcardVersion: document.version,
    remoteSemanticHash: semanticVCardHash(document),
    localContactHash: localContactHash(contact),
  };
}

function assertMappingStateApplied(result, mapping) {
  if (result.ok) return result;
  throw new StaleCarddavPlanError({
    reason: 'mapping-revision-changed',
    addressBookId: mapping.addressBookId,
    href: mapping.href,
    expectedMappingRevision: mapping.mappingRevision,
  });
}

async function loadAutomaticProjectionState(client, userId, bookId, hasLegacyProjection) {
  const legacyProjection = hasLegacyProjection
    ? 'o.legacy_projection'
    : 'NULL::jsonb AS legacy_projection';
  const { rows: mappingRows } = await client.query(
    `SELECT o.address_book_id, o.href, o.remote_etag, o.vcard, o.primary_email,
            o.local_contact_id, o.mapping_status, o.vcard_version,
            o.remote_semantic_hash, o.local_contact_hash,
            o.mapping_revision::text, ${legacyProjection}
     FROM carddav_remote_objects o
     JOIN address_books b ON b.id = o.address_book_id
     WHERE b.user_id = $1
     ORDER BY b.id, o.href
     FOR UPDATE OF o`,
    [userId],
  );
  const contactRows = await lockProjectionContacts(client, userId, bookId);
  return {
    mappings: mappingRows.map(automaticMappingFromRow),
    contacts: contactRows.map(row => contactFromRow(row, bookId)),
  };
}

async function materializeAutomaticImport(client, userId, book, remote, primaryEmail) {
  const desired = desiredAutomaticContact(remote, primaryEmail);
  const result = await client.query(
    `INSERT INTO contacts (
       address_book_id, user_id, uid, vcard, etag, display_name, first_name,
       last_name, primary_email, emails, phones, organization, notes, photo_data,
       additional_fields, is_auto
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14,$15::jsonb,false
     )
     ON CONFLICT (address_book_id, uid) DO UPDATE SET
       vcard = EXCLUDED.vcard, etag = EXCLUDED.etag,
       display_name = EXCLUDED.display_name, first_name = EXCLUDED.first_name,
       last_name = EXCLUDED.last_name, primary_email = EXCLUDED.primary_email,
       emails = EXCLUDED.emails, phones = EXCLUDED.phones,
       organization = EXCLUDED.organization, notes = EXCLUDED.notes,
       photo_data = EXCLUDED.photo_data, additional_fields = EXCLUDED.additional_fields,
       is_auto = false, updated_at = NOW()
     RETURNING id`,
    [
      book.id, userId, desired.uid, desired.vcard, desired.etag,
      desired.displayName, desired.firstName, desired.lastName, desired.primaryEmail,
      JSON.stringify(desired.emails || []), JSON.stringify(desired.phones || []),
      desired.organization, desired.notes, desired.photoData,
      JSON.stringify(desired.additionalFields || []),
    ],
  );
  return {
    id: result.rows[0].id,
    addressBookId: book.id,
    inRemoteBook: true,
    isCarddavProjected: true,
    ...desired,
  };
}

async function refreshAutomaticImport(client, userId, book, remote, current, primaryEmail) {
  // Refresh the linked contact in place — a push-origin contact keeps its own local
  // book and UID, a pull-origin contact keeps the book/UID it was materialized with.
  const desired = desiredAutomaticContact(remote, primaryEmail, current.uid);
  if (localContactHash(desired) === localContactHash(current)) {
    return { contact: current, changed: false };
  }
  const result = await client.query(
    `UPDATE contacts SET
       uid = $3, vcard = $4, etag = $5, display_name = $6,
       first_name = $7, last_name = $8, primary_email = $9,
       emails = $10::jsonb, phones = $11::jsonb, organization = $12,
       notes = $13, photo_data = $14, additional_fields = $15::jsonb,
       is_auto = false, updated_at = NOW()
     WHERE user_id = $1 AND id = $2 AND address_book_id = $16`,
    [
      userId, current.id, desired.uid, desired.vcard, desired.etag,
      desired.displayName, desired.firstName, desired.lastName, desired.primaryEmail,
      JSON.stringify(desired.emails || []), JSON.stringify(desired.phones || []),
      desired.organization, desired.notes, desired.photoData,
      JSON.stringify(desired.additionalFields || []), current.addressBookId,
    ],
  );
  if (result.rowCount !== 1) {
    throw new StaleCarddavPlanError({ reason: 'mapping-contact-missing' });
  }
  return {
    contact: {
      ...current,
      ...desired,
      addressBookId: current.addressBookId,
      inRemoteBook: current.addressBookId === book.id,
      isCarddavProjected: current.isCarddavProjected,
    },
    changed: true,
  };
}

// The number of CardDAV contacts materialized for a user. This is the one authority for
// the integration's contactCount: the ledger row set, not an accumulated total.
async function countMaterializedCarddavContacts(client, userId) {
  const { rows: [row] } = await client.query(
    `SELECT count(*)::int AS count
     FROM carddav_remote_objects o
     JOIN address_books b ON b.id = o.address_book_id
     WHERE b.user_id = $1
       AND b.source = 'carddav'
       AND o.local_contact_id IS NOT NULL
       AND o.mapping_status <> 'pending_materialization'`,
    [userId],
  );
  return row?.count ?? 0;
}

// contactCount is derived, never accumulated. Adding a per-book delta to the stored total
// double-counts a book whenever the ledger does not already account for the contacts that
// total was computed from — which is exactly the full-snapshot path (the ledger starts
// empty while an earlier count survives in config). Recounting also self-heals a total
// that is already wrong.
async function persistCarddavContactCount(client, integration, userId) {
  const currentCount = carddavContactCount({ contactCount: integration.contact_count });
  const nextCount = await countMaterializedCarddavContacts(client, userId);
  if (nextCount === currentCount && integration.contact_count != null) return nextCount;
  const updated = await client.query(
    `UPDATE user_integrations
     SET config = config || jsonb_build_object('contactCount', $2::int), updated_at = NOW()
     WHERE id = $1`,
    [integration.id, nextCount],
  );
  if (updated.rowCount !== 1) throw new StaleCarddavPlanError({ reason: 'not-connected' });
}

async function applyAutomaticBookProjection(client, {
  plan,
  integrationRow,
  book,
  fingerprintBooks,
  replacingAlias,
  canonicalUrl,
  identity,
}) {
  const hasLegacyProjection = integrationRow.has_legacy_projection === true;
  const state = await loadAutomaticProjectionState(
    client, plan.userId, book.id, hasLegacyProjection,
  );
  await validateProjectionFootprint(
    client, plan.userId, fingerprintBooks, state.contacts, book.id,
  );
  const contactsById = new Map(state.contacts.map(contact => [contact.id, contact]));
  const currentMappings = state.mappings.filter(mapping => mapping.addressBookId === book.id);
  const currentByHref = new Map(currentMappings.map(mapping => [mapping.href, mapping]));
  const incomingByHref = new Map(plan.upserts.map(remote => [remote.href, remote]));
  const removedHrefs = new Set(plan.removedHrefs);
  const tombstoneHrefs = new Set(currentMappings
    .filter(mapping => (
      removedHrefs.has(mapping.href) || (plan.replaceAll && !incomingByHref.has(mapping.href))
    ))
    .map(mapping => mapping.href));
  const protectedHrefs = new Set();
  const pendingChanges = [];
  const conflictChanges = [];
  // Local (non-CardDAV) books whose contacts an inbound change touches, so their
  // sync tokens rotate for cache invalidation alongside the CardDAV book's.
  const changedLocalBookIds = new Set();
  // Books whose served (presented) document changed from a remote-only edit to
  // unmodeled properties, which leaves the modeled columns untouched: rotate so
  // getctag pollers re-fetch and the derived served ETag advances.
  const presentedChangedBookIds = new Set();
  for (const mapping of currentMappings) {
    if (hasLegacyProjection && mapping.legacyProjection) continue;
    let remote = incomingByHref.get(mapping.href);
    const remoteTombstone = tombstoneHrefs.has(mapping.href);
    const contact = contactsById.get(mapping.localContactId);
    const currentLocalHash = contact ? localContactHash(contact) : null;
    const confirmedLocalHash = mapping.localContactHash ?? currentLocalHash;
    const localChanged = mapping.mappingStatus === 'pending_push'
      || currentLocalHash !== confirmedLocalHash;
    if (!remote && !remoteTombstone) {
      if (mapping.mappingStatus !== 'synced' || !localChanged) continue;
      remote = {
        href: mapping.href,
        remoteEtag: mapping.remoteEtag,
        vcard: mapping.vcard,
        primaryEmail: mapping.primaryEmail,
        contact: contactFromVCard(mapping.vcard, mapping.href),
      };
    }
    const document = remote ? parseVCardDocument(remote.vcard) : null;
    const remoteSemanticHash = document ? semanticVCardHash(document) : null;
    const remoteChanged = remoteTombstone
      || remoteSemanticHash !== mapping.remoteSemanticHash;
    if (mapping.mappingStatus === 'conflict' || (localChanged && remoteChanged)) {
      protectedHrefs.add(mapping.href);
      conflictChanges.push({
        mapping,
        contact,
        remote,
        document,
        remoteSemanticHash,
        remoteTombstone,
        confirmedLocalHash,
      });
    } else if (localChanged) {
      protectedHrefs.add(mapping.href);
      pendingChanges.push({
        mapping, remote, document, remoteSemanticHash, confirmedLocalHash,
      });
    }
  }
  const removedMappings = currentMappings.filter(mapping => (
    tombstoneHrefs.has(mapping.href) && !protectedHrefs.has(mapping.href)
  ));
  const removedMappingHrefs = new Set(removedMappings.map(mapping => mapping.href));
  const removedContacts = removedMappings
    .map(mapping => ({ mapping, contact: contactsById.get(mapping.localContactId) }))
    .filter(entry => entry.contact
      && linkedContactFollowsRemote(entry.contact, book.id, entry.mapping.vcard));
  const projectedIds = removedContacts.map(entry => entry.contact.id);
  for (const { contact } of removedContacts) {
    if (contact.addressBookId !== book.id) changedLocalBookIds.add(contact.addressBookId);
  }
  let removed = 0;
  if (projectedIds.length) {
    const result = await client.query(
      'DELETE FROM contacts WHERE user_id = $1 AND id = ANY($2::uuid[])',
      [plan.userId, projectedIds],
    );
    removed = result.rowCount;
    for (const id of projectedIds) contactsById.delete(id);
  }
  if (removedMappings.length) {
    for (const mapping of removedMappings) {
      assertMappingStateApplied(await applyRemoteTombstone(client, {
        addressBookId: mapping.addressBookId,
        href: mapping.href,
        expectedMappingRevision: mapping.mappingRevision,
      }), mapping);
    }
  }

  const effectiveUpserts = plan.upserts.filter(remote => !protectedHrefs.has(remote.href));
  const upsertsByHref = new Map(effectiveUpserts.map(remote => [remote.href, remote]));

  const remoteObjects = [];
  for (const mapping of currentMappings) {
    if (removedMappingHrefs.has(mapping.href) || upsertsByHref.has(mapping.href)) continue;
    remoteObjects.push({
      href: mapping.href,
      remoteEtag: mapping.remoteEtag,
      vcard: mapping.vcard,
      primaryEmail: mapping.primaryEmail,
      contact: contactFromVCard(mapping.vcard, mapping.href),
      discoveryIndex: plan.book.discoveryIndex ?? 0,
    });
  }
  for (const remote of effectiveUpserts) {
    remoteObjects.push({ ...remote, discoveryIndex: plan.book.discoveryIndex ?? 0 });
  }

  const retainedMappings = state.mappings
    .filter(mapping => (
      mapping.addressBookId !== book.id || !removedMappingHrefs.has(mapping.href)
    ))
    .filter(mapping => mapping.localContactId && contactsById.has(mapping.localContactId))
    .filter(mapping => mapping.legacyProjection?.disposition !== 'skip')
    .map(mapping => ({ href: mapping.href, localContactId: mapping.localContactId }));
  const projection = planAutomaticProjection({
    remoteObjects,
    mappings: retainedMappings,
    localContacts: [...contactsById.values()],
  });
  const remotesByHref = new Map(remoteObjects.map(remote => [remote.href, remote]));
  const linkedIds = new Map(projection.links.map(link => [link.href, link.localContactId]));
  const usedEmails = new Set([...contactsById.values()]
    .filter(contact => contact.addressBookId === book.id)
    .map(contact => normalizeEmail(contact.primaryEmail))
    .filter(Boolean));
  let refreshed = 0;
  for (const link of projection.links) {
    const remote = remotesByHref.get(link.href);
    const contact = contactsById.get(link.localContactId);
    if (!upsertsByHref.has(link.href) || !contact) continue;
    // Only meaningful for an EXISTING mapping: compare the presented document before
    // and after this remote change (both via the overlay, so formatting is neutral). A
    // first-time link has no prior presented representation to have "changed".
    const retainedVcard = currentByHref.get(link.href)?.vcard;
    const presentedChanged = Boolean(retainedVcard)
      && presentedVCard({ ...contact, mapping_vcard: retainedVcard })
        !== presentedVCard({ ...contact, mapping_vcard: remote.vcard });
    if (!linkedContactFollowsRemote(contact, book.id, retainedVcard)) {
      // Email-merged: the local contact stays authoritative and is not refreshed, but a
      // remote change to unmodeled properties still changes the presented document.
      if (presentedChanged) presentedChangedBookIds.add(contact.addressBookId);
      continue;
    }
    const inRemoteBook = contact.addressBookId === book.id;
    const remoteEmail = normalizeEmail(remote.contact?.primaryEmail);
    let primaryEmail;
    if (inRemoteBook) {
      // Email uniqueness is per-address-book, so dedupe against the CardDAV book only.
      const currentEmail = normalizeEmail(contact.primaryEmail);
      if (currentEmail) usedEmails.delete(currentEmail);
      primaryEmail = remoteEmail && !usedEmails.has(remoteEmail) ? remoteEmail : null;
      if (primaryEmail) usedEmails.add(primaryEmail);
    } else {
      primaryEmail = remoteEmail;
    }
    const refresh = await refreshAutomaticImport(
      client, plan.userId, book, remote, contact, primaryEmail,
    );
    contactsById.set(contact.id, refresh.contact);
    if (refresh.changed && !inRemoteBook) changedLocalBookIds.add(contact.addressBookId);
    // A remote-only unmodeled change leaves the modeled columns (refresh.changed=false)
    // but still advances the presented document → rotate the contact's book.
    if (!refresh.changed && presentedChanged) presentedChangedBookIds.add(contact.addressBookId);
    refreshed += Number(refresh.changed);
  }
  let imported = 0;
  for (const importPlan of projection.imports) {
    const remote = remotesByHref.get(importPlan.href);
    const email = normalizeEmail(remote.contact?.primaryEmail);
    const primaryEmail = email && !usedEmails.has(email) ? email : null;
    if (primaryEmail) usedEmails.add(primaryEmail);
    const contact = await materializeAutomaticImport(
      client, plan.userId, book, remote, primaryEmail,
    );
    contactsById.set(contact.id, contact);
    linkedIds.set(remote.href, contact.id);
    imported++;
  }

  const confirmed = remoteObjects.map(remote => {
    const contactId = linkedIds.get(remote.href);
    const contact = contactsById.get(contactId);
    if (!contact) throw new StaleCarddavPlanError({ reason: 'mapping-contact-missing' });
    return confirmedAutomaticMapping(remote, contactId, contact);
  });
  const changedMappingHrefs = new Set(effectiveUpserts.map(remote => remote.href));
  for (const mapping of currentMappings) {
    if (mapping.legacyProjection) changedMappingHrefs.add(mapping.href);
  }
  const changedMappings = confirmed.filter(mapping => changedMappingHrefs.has(mapping.href));
  for (const mapping of changedMappings) {
    const current = currentByHref.get(mapping.href);
    assertMappingStateApplied(await applyConfirmedRemoteContact(client, {
      addressBookId: book.id,
      href: mapping.href,
      expectedMappingRevision: current?.mappingRevision ?? null,
      remoteEtag: mapping.remoteEtag,
      vcard: mapping.vcard,
      primaryEmail: mapping.primaryEmail,
      localContactId: mapping.localContactId,
      vcardVersion: mapping.vcardVersion,
      remoteSemanticHash: mapping.remoteSemanticHash,
      localContactHash: mapping.localContactHash,
      supportsPendingIntent: !hasLegacyProjection,
      clearLegacyProjection: hasLegacyProjection,
    }), current || {
      addressBookId: book.id,
      href: mapping.href,
      mappingRevision: null,
    });
  }
  for (const change of pendingChanges) {
    const {
      mapping, remote, document, remoteSemanticHash, confirmedLocalHash,
    } = change;
    assertMappingStateApplied(await applyConfirmedRemoteContact(client, {
      addressBookId: mapping.addressBookId,
      href: mapping.href,
      expectedMappingRevision: mapping.mappingRevision,
      remoteEtag: remote.remoteEtag,
      vcard: remote.vcard,
      primaryEmail: remote.contact?.primaryEmail ?? remote.primaryEmail ?? null,
      localContactId: mapping.localContactId,
      vcardVersion: document.version,
      remoteSemanticHash,
      localContactHash: confirmedLocalHash,
      mappingStatus: 'pending_push',
      supportsPendingIntent: !hasLegacyProjection,
      preservePendingIntent: true,
    }), mapping);
  }
  for (const change of conflictChanges) {
    const {
      mapping, contact, remote, document, remoteSemanticHash, remoteTombstone,
      confirmedLocalHash,
    } = change;
    assertMappingStateApplied(await refreshUnresolvedConflict(client, {
      addressBookId: mapping.addressBookId,
      href: mapping.href,
      expectedMappingRevision: mapping.mappingRevision,
      userId: plan.userId,
      baseLocalHash: confirmedLocalHash,
      remoteEtag: remote?.remoteEtag ?? null,
      primaryEmail: remote?.contact?.primaryEmail ?? remote?.primaryEmail ?? null,
      vcardVersion: document?.version ?? null,
      remoteSemanticHash,
      supportsPendingIntent: !hasLegacyProjection,
      preserveLocalSnapshot: mapping.mappingStatus === 'conflict',
      localVCard: mapping.mappingStatus === 'conflict'
        ? undefined
        : conflictLocalSnapshot(mapping, contact),
      remoteVCard: remote?.vcard ?? null,
      localTombstone: mapping.mappingStatus === 'conflict' ? undefined : !contact,
      remoteTombstone,
    }), mapping);
  }

  const updated = imported + refreshed;
  const changedBookIds = [
    ...(imported || refreshed || removed ? [book.id] : []),
    ...changedLocalBookIds,
    ...presentedChangedBookIds,
  ];
  const rotatedBooks = await rotateChangedBookTokens(client, plan.userId, changedBookIds);
  const rotatedById = new Map(rotatedBooks.map(row => [row.id, row]));
  const finalTargetBooks = fingerprintBooks.map(target => rotatedById.get(target.id) || target);
  const fingerprint = projectionFingerprint(finalTargetBooks);
  const capabilities = observedCapabilities(plan.book);
  const nextRemoteToken = Object.hasOwn(plan, 'nextRemoteToken')
    ? plan.nextRemoteToken
    : book.remote_sync_token;
  let updatedBook;
  if (replacingAlias) await client.query('SAVEPOINT carddav_alias_replace');
  try {
    updatedBook = await advanceDiscoveredBookState(client, {
      addressBookId: book.id,
      remoteSyncToken: nextRemoteToken,
      remoteSyncCapability: plan.capability,
      remoteProjectionFingerprint: fingerprint,
      expectedRemoteRevision: plan.expectedRemoteRevision,
      canonicalUrl,
      capabilities,
    });
  } catch (error) {
    if (error.code !== '23505' || !replacingAlias) throw error;
    await client.query('ROLLBACK TO SAVEPOINT carddav_alias_replace');
    const conflict = await client.query(
      `SELECT id FROM address_books
       WHERE user_id = $1 AND source = 'carddav' AND external_url = $2
       FOR UPDATE`,
      [plan.userId, canonicalUrl],
    );
    await client.query('RELEASE SAVEPOINT carddav_alias_replace');
    throw new StaleCarddavPlanError({
      reason: 'canonical-url-conflict',
      observedUrl: identity.observedUrl,
      canonicalUrl,
      conflictingBookId: conflict.rows[0]?.id,
    });
  }
  if (replacingAlias) await client.query('RELEASE SAVEPOINT carddav_alias_replace');
  if (updatedBook.rowCount !== 1) {
    throw new StaleCarddavPlanError({ reason: 'book-update-missed', bookId: book.id });
  }
  await persistCarddavContactCount(client, integrationRow, plan.userId);
  return {
    changedBookIds,
    ledgerChanged: removedMappings.length > 0 || changedMappings.length > 0
      || pendingChanges.length > 0 || conflictChanges.length > 0,
    updated,
    removed,
    remote: confirmed.length,
  };
}

export async function applyBookDelta(client, plan) {
  requirePlanFences(plan);
  const integration = await client.query(
    `SELECT id,
            -- Tolerate a half-migrated database applied out-of-band through 0035, not 0036.
            EXISTS (
              SELECT 1
              FROM information_schema.columns
              WHERE table_schema = current_schema()
                AND table_name = 'carddav_remote_objects'
                AND column_name = 'legacy_projection'
            ) AS has_legacy_projection,
            config->>'connectionGeneration' AS connection_generation,
            config->>'contactCount' AS contact_count
     FROM user_integrations
     WHERE user_id = $1 AND provider = 'carddav'
     FOR UPDATE`,
    [plan.userId],
  );
  const integrationRow = integration.rows[0];
  assertConnectionGeneration(
    integrationRow?.connection_generation ?? null,
    plan.connectionGeneration,
  );
  if (!integrationRow) {
    throw new StaleCarddavPlanError({
      reason: 'connection-generation-changed',
      expectedConnectionGeneration: plan.connectionGeneration,
      actualConnectionGeneration: null,
    });
  }
  const identity = plan.collectionIdentity;
  const replacingAlias = identity
    && identity.observedUrl !== identity.canonicalUrl;
  if (replacingAlias && !plan.replaceAll) {
    throw new StaleCarddavPlanError({ reason: 'canonical-reconciliation-required' });
  }
  const canonicalUrl = plan.replaceAll ? identity?.canonicalUrl : null;
  const bookUrls = replacingAlias
    ? [identity.observedUrl, identity.canonicalUrl]
    : [plan.book.url];
  const lockedBooks = await lockCarddavBooks(client, plan.userId, bookUrls);
  let book = lockedBooks.find(row => row.external_url === plan.book.url);
  if (!book && replacingAlias) {
    throw new StaleCarddavPlanError({
      reason: 'observed-alias-missing',
      observedUrl: identity.observedUrl,
    });
  }
  if (!book) book = await persistDiscoveredBook(client, { userId: plan.userId, ...plan.book });
  if (String(book.remote_sync_revision ?? '0') !== String(plan.expectedRemoteRevision)) {
    throw new StaleCarddavPlanError({
      reason: 'remote-revision-changed',
      expectedRemoteRevision: plan.expectedRemoteRevision,
      actualRemoteRevision: String(book.remote_sync_revision ?? '0'),
    });
  }
  const expectedRemoteToken = plan.expectedRemoteToken;
  if (book.remote_sync_token !== expectedRemoteToken) {
    throw new StaleCarddavPlanError({
      reason: 'remote-token-changed',
      expectedRemoteToken,
      actualRemoteToken: book.remote_sync_token,
    });
  }

  if (replacingAlias) {
    const conflictingBook = lockedBooks.find(row => (
      row.external_url === canonicalUrl && row.id !== book.id
    ));
    if (conflictingBook) {
      throw new StaleCarddavPlanError({
        reason: 'canonical-url-conflict',
        observedUrl: identity.observedUrl,
        canonicalUrl,
        conflictingBookId: conflictingBook.id,
      });
    }
  }

  const fingerprintBooks = await lockEligibleTargetBooks(client, plan.userId);
  await validateTargetBookFootprint(client, plan.userId, fingerprintBooks);

  return applyAutomaticBookProjection(client, {
    plan,
    integrationRow,
    book,
    fingerprintBooks,
    replacingAlias,
    canonicalUrl,
    identity,
  });
}

export async function prepareBookPlan(userId, book, creds) {
  const current = await query(
    `SELECT remote_sync_token, remote_sync_capability, remote_sync_revision,
            connection_generation, book_id
     FROM (
       SELECT b.id AS book_id, b.remote_sync_token, b.remote_sync_capability,
              b.remote_sync_revision::text,
              ui.config->>'connectionGeneration' AS connection_generation
       FROM user_integrations ui
       LEFT JOIN address_books b
         ON b.user_id = ui.user_id AND b.source = 'carddav' AND b.external_url = $2
       WHERE ui.user_id = $1 AND ui.provider = 'carddav'
     ) current_book`,
    [userId, book.url],
  );
  const currentBook = current.rows[0];
  if (!currentBook) throw new StaleCarddavPlanError({ reason: 'not-connected' });
  const expectedRemoteToken = currentBook.remote_sync_token ?? null;
  const supportsSyncCollection = Boolean(
    book.supportsSyncCollection
    && currentBook.remote_sync_capability !== 'snapshot',
  );
  const request = {
    ...book,
    ...creds,
    syncToken: expectedRemoteToken,
    supportsSyncCollection,
  };
  let delta;
  let fallback = 0;
  try {
    delta = await fetchAddressBookDelta(request);
  } catch (error) {
    const invalidStoredToken = error?.name === 'CardDavError'
      && error.status === 403
      && error.precondition === 'valid-sync-token'
      && expectedRemoteToken != null
      && expectedRemoteToken !== '';
    if (!invalidStoredToken) throw error;
    delta = await fetchAddressBookDelta({ ...request, syncToken: '' });
    delta = { ...delta, expectedRemoteToken };
    fallback = 1;
  }
  const identity = delta.collectionIdentity;
  if (identity && identity.observedUrl !== identity.canonicalUrl && !delta.replaceAll) {
    const canonicalDelta = await fetchAddressBookDelta({
      ...request,
      url: identity.canonicalUrl,
      syncToken: '',
    });
    if (!canonicalDelta.replaceAll
      || canonicalDelta.collectionIdentity?.canonicalUrl !== identity.canonicalUrl) {
      throw new StaleCarddavPlanError({ reason: 'canonical-reconciliation-required' });
    }
    delta = {
      ...canonicalDelta,
      expectedRemoteToken,
      collectionIdentity: identity,
    };
    fallback = 1;
  }
  const upserts = delta.upserts.map(card => ({
    href: card.href,
    remoteEtag: card.etag ?? null,
    vcard: card.vcard,
    contact: contactFromVCard(card.vcard, card.href),
  }));
  return {
    userId,
    book: { ...book, capabilities: observedCapabilities(book) },
    expectedRemoteToken: delta.expectedRemoteToken,
    connectionGeneration: currentBook.connection_generation ?? null,
    expectedRemoteRevision: currentBook.remote_sync_revision ?? '0',
    nextRemoteToken: delta.nextRemoteToken,
    capability: delta.capability,
    replaceAll: delta.replaceAll,
    collectionIdentity: delta.collectionIdentity,
    upserts,
    removedHrefs: delta.removedHrefs,
    fetched: upserts.length,
    fallback: fallback || Number(delta.capability === 'snapshot'),
  };
}

export async function reconcileStaleCarddavBooks(client, userId, { seenUrls }) {
  const { rows: books } = await client.query(
    `SELECT id, source, external_url, sync_token
     FROM address_books
     WHERE user_id = $1
     ORDER BY id
     FOR UPDATE`,
    [userId],
  );

  const seen = new Set(seenUrls);
  const staleBookIds = books
    .filter(book => book.source === 'carddav' && !seen.has(book.external_url))
    .map(book => book.id)
    .sort();
  if (!staleBookIds.length) return [];

  await client.query(
    `DELETE FROM address_books
     WHERE user_id = $1 AND id = ANY($2::uuid[])`,
    [userId, staleBookIds],
  );
  return staleBookIds;
}

export async function finalizeCarddavSyncTransaction(client, userId, {
  connectionGeneration,
  seenUrls,
  status,
}) {
  const integration = await lockCarddavIntegration(client, userId);
  if (!integration) throw new StaleCarddavPlanError({ reason: 'not-connected' });
  const actualGeneration = integration.config?.connectionGeneration ?? null;
  assertConnectionGeneration(actualGeneration, connectionGeneration);
  await reconcileStaleCarddavBooks(client, userId, { seenUrls });
  const contactCount = await countMaterializedCarddavContacts(client, userId);
  const updated = await client.query(
    `UPDATE user_integrations
     SET config = config || $2::jsonb, updated_at = NOW()
     WHERE id = $1 AND config->>'connectionGeneration' IS NOT DISTINCT FROM $3`,
    [
      integration.id,
      JSON.stringify({ ...status, contactCount }),
      connectionGeneration,
    ],
  );
  if (updated.rowCount !== 1) {
    throw new StaleCarddavPlanError({
      reason: 'connection-generation-changed',
      expectedConnectionGeneration: connectionGeneration,
      actualConnectionGeneration: actualGeneration,
    });
  }
  return contactCount;
}

export async function disconnectCarddavTransaction(client, userId) {
  const integration = await lockCarddavIntegration(client, userId);
  if (!integration) return false;
  const actualGeneration = integration.config?.connectionGeneration ?? null;
  await reconcileStaleCarddavBooks(client, userId, { seenUrls: [] });
  const deleted = await client.query(
    `DELETE FROM user_integrations
     WHERE id = $1 AND config->>'connectionGeneration' IS NOT DISTINCT FROM $2
     RETURNING id`,
    [integration.id, actualGeneration],
  );
  if (deleted.rowCount !== 1) {
    throw new StaleCarddavPlanError({
      reason: 'connection-generation-changed',
      expectedConnectionGeneration: actualGeneration,
      actualConnectionGeneration: null,
    });
  }
  return true;
}

export async function finalizeCarddavSync(userId, options) {
  return withTransaction(client => finalizeCarddavSyncTransaction(client, userId, options));
}

export async function disconnectCarddavAccount(userId) {
  const disconnected = await withTransaction(client => disconnectCarddavTransaction(client, userId));
  stopCardavUser(userId);
  pendingReplacementSyncs.delete(userId);
  return disconnected;
}

export async function recordCarddavSyncFailure(userId, expectedGeneration, error) {
  const patch = {
    lastError: error.message,
    lastSyncAt: new Date().toISOString(),
    ...(error.retryAfterAt ? { retryAfterAt: error.retryAfterAt } : {}),
  };
  const result = await query(
    `UPDATE user_integrations SET config = config || $2::jsonb, updated_at = NOW()
     WHERE user_id = $1 AND provider = 'carddav'
       AND config->>'connectionGeneration' IS NOT DISTINCT FROM $3`,
    [userId, JSON.stringify(patch), expectedGeneration],
  );
  return result.rowCount === 1;
}

async function unmappedExplicitContactIds(userId) {
  const { rows } = await query(
    `SELECT c.id
     FROM contacts c
     WHERE c.user_id = $1 AND c.is_auto = false
       AND NOT EXISTS (
         SELECT 1 FROM carddav_remote_objects mapping
         WHERE mapping.local_contact_id = c.id
       )
     ORDER BY c.id`,
    [userId],
  );
  return rows.map(row => row.id);
}

export function requestCarddavSync(userId, connectionGeneration) {
  if (syncing.has(userId)) {
    if (activeSyncGenerations.get(userId) !== connectionGeneration) {
      pendingReplacementSyncs.add(userId);
    }
    return false;
  }
  syncUser(userId, connectionGeneration).catch(() => {});
  return true;
}

export async function syncUser(userId, expectedGeneration) {
  const counters = emptyResultCounters();
  if (syncing.has(userId)) {
    if (expectedGeneration !== undefined
      && activeSyncGenerations.get(userId) !== expectedGeneration) {
      pendingReplacementSyncs.add(userId);
    }
    return { ok: false, error: 'A sync is already in progress', ...counters };
  }
  syncing.add(userId);
  activeSyncGenerations.set(userId, expectedGeneration);
  let config;

  try {
    config = await getCardavConfig(userId);
    if (!config?.serverUrl) return { ok: false, error: 'not connected', ...counters };
    assertConnectionGeneration(config.connectionGeneration, expectedGeneration);
    const retryAfterAt = activeRetryAfterAt(config);
    if (retryAfterAt) {
      throw new CardDavError('CardDAV requests are throttled until Retry-After eligibility', {
        status: 429,
        operation: 'sync',
        retryAfterAt,
      });
    }
    activeSyncGenerations.set(userId, config.connectionGeneration);
    const creds = await resolveCarddavCredentials(config);
    const books = await discoverAddressBooks({ serverUrl: config.serverUrl, ...creds });
    await recoverPendingCarddavMutations(userId, {
      integration: { config },
      creds,
    });
    const plans = [];
    for (const book of books) {
      plans.push(await prepareBookPlan(userId, book, creds));
    }

    for (let index = 0; index < plans.length; index++) {
      let plan = plans[index];
      let applied;
      try {
        applied = await withTransaction(client => applyBookDelta(client, plan));
      } catch (error) {
        if (!(error instanceof StaleCarddavPlanError)) throw error;
        switch (stalePlanAction(error.reason)) {
          case 'retry-apply':
            applied = await withTransaction(client => applyBookDelta(client, plan));
            break;
          case 'refetch-once': {
            const freshConfig = await getCardavConfig(userId);
            if (freshConfig?.connectionGeneration !== undefined
              && freshConfig.connectionGeneration !== plan.connectionGeneration) {
              throw error;
            }
            plan = await prepareBookPlan(userId, books[index], creds);
            applied = await withTransaction(client => applyBookDelta(client, plan));
            break;
          }
          case 'abort':
            throw error;
        }
      }
      plans[index] = plan;
      addResultCounters(counters, {
        fetched: plan.fetched,
        fallback: plan.fallback,
        remote: applied.remote,
        updated: applied.updated,
        removed: applied.removed,
      });
    }
    const exportFailures = [];
    for (const contactId of await unmappedExplicitContactIds(userId)) {
      try {
        await exportExistingContact(userId, contactId, {
          books,
          expectedGeneration: config.connectionGeneration,
        });
      } catch (error) {
        if (error instanceof CardDavError
          && error.status === 429
          && activeRetryAfterAt(error)) {
          throw error;
        }
        exportFailures.push({
          localContactId: contactId,
          code: error.code || 'ERR_CARDDAV_EXPORT',
          message: error.message,
        });
      }
    }
    const seenUrls = plans.map(plan => (
      plan.collectionIdentity?.canonicalUrl ?? plan.book.url
    ));
    const contactCount = await finalizeCarddavSync(userId, {
      seenUrls,
      connectionGeneration: config.connectionGeneration,
      status: {
        lastSyncAt: new Date().toISOString(),
        lastError: null,
        bookCount: books.length,
        exportFailures,
        ...(Object.hasOwn(config, 'retryAfterAt') ? { retryAfterAt: null } : {}),
      },
    });
    return {
      ok: true,
      bookCount: books.length,
      contactCount,
      exportFailures,
      ...counters,
    };
  } catch (err) {
    if (config && err.reason !== 'not-connected') {
      const statusGeneration = expectedGeneration !== undefined
        ? expectedGeneration
        : config.connectionGeneration;
      const gatedRetry = err instanceof CardDavError
        && err.status === 429
        && err.requestStatus == null
        && err.retryAfterAt;
      if (!gatedRetry) await recordCarddavSyncFailure(userId, statusGeneration, err);
    }
    return {
      ok: false,
      error: err.message,
      ...(err.retryAfterAt ? { retryAfterAt: err.retryAfterAt } : {}),
      ...counters,
    };
  } finally {
    syncing.delete(userId);
    activeSyncGenerations.delete(userId);
    if (pendingReplacementSyncs.delete(userId)) {
      queueMicrotask(() => requestCarddavSync(userId));
    }
  }
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

export function scheduleCardavUser(userId, intervalMin) {
  stopCardavUser(userId);
  const min = Math.max(15, Math.min(1440, parseInt(intervalMin) || DEFAULT_INTERVAL_MIN));
  const id = setInterval(() => {
    syncUser(userId).catch(e => console.warn(`CardDAV sync failed for ${userId}:`, e.message));
  }, min * 60 * 1000);
  timers.set(userId, id);
}

export function stopCardavUser(userId) {
  const id = timers.get(userId);
  if (id) { clearInterval(id); timers.delete(userId); }
}

export async function startCardavScheduler() {
  if (conflictCleanupTimer) clearInterval(conflictCleanupTimer);
  conflictCleanupTimer = setInterval(() => withTransaction(client => (
    deleteResolvedConflictsBefore(
      client,
      new Date(Date.now() - CONFLICT_RETENTION_MS),
    )
  )).catch(error => {
    console.warn('CardDAV conflict cleanup failed:', error.message);
  }), CONFLICT_CLEANUP_INTERVAL_MS);
  conflictCleanupTimer.unref?.();
  try {
    const rows = await query("SELECT user_id, config FROM user_integrations WHERE provider = 'carddav'");
    for (const row of rows.rows) {
      if (row.config?.serverUrl) scheduleCardavUser(row.user_id, row.config?.intervalMin);
    }
    if (rows.rows.length) console.log(`CardDAV: scheduled sync for ${rows.rows.length} account(s)`);
  } catch (err) {
    console.warn('CardDAV scheduler start failed:', err.message);
  }
}
