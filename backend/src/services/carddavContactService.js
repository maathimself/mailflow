import { randomUUID } from 'node:crypto';

import {
  ADDITIONAL_PROPERTIES,
  SERVER_OWNED_PROPERTIES,
  allocateItemGroup,
  contactFromVCardDocument,
  groupKey,
  localContactHash,
  localVCardEtag,
  overlayContactOnVCard,
  parseVCardDocument,
  presentedVCard,
  primaryEmail,
  semanticVCardHash,
  serializeVCardDocument,
  withDocumentUid,
} from '../utils/vcardProperties.js';

// Property names (case-normalized) MailFlow projects into modeled columns / Additional
// fields. Everything else is an unmodeled property for the two-tier replace merge.
const MODELED_PROPERTY_NAMES = new Set([
  'VERSION', 'UID', 'FN', 'N', 'EMAIL', 'TEL', 'ORG', 'NOTE', 'PHOTO', 'X-ABLABEL',
  ...ADDITIONAL_PROPERTIES,
]);
import {
  deleteCardResource,
  discoverAddressBooks,
  fetchCardResource,
  putCardResource,
} from './carddavClient.js';
import {
  CardDavError,
  activeRetryAfterAt,
  resolveCarddavCredentials,
} from './carddavTransport.js';
import {
  applyConfirmedRemoteContact,
  applyRemoteTombstone,
  lockCarddavIntegration,
  lockCarddavMapping,
  persistDiscoveredBook,
  persistDeniedBookCapability,
  persistPendingMutationIntent,
  refreshUnresolvedConflict,
  rotateBookToken,
  restorePendingMutationIntent,
  typedError,
} from './carddavMappingState.js';
import { query, withTransaction } from './db.js';

const API_CONTACT_COLUMNS = `
  id, uid, display_name, first_name, last_name, primary_email,
  emails, phones, organization, notes, photo_data, additional_fields,
  is_auto, send_count, last_sent, etag, created_at, updated_at`;
const DRAFT_FIELDS = [
  ['displayName', 'display_name'],
  ['firstName', 'first_name'],
  ['lastName', 'last_name'],
  ['emails', 'emails'],
  ['phones', 'phones'],
  ['organization', 'organization'],
  ['notes', 'notes'],
  ['photoData', 'photo_data'],
  ['additionalFields', 'additional_fields'],
];

export const CARDDAV_CONTACT_ERROR_STATUS = Object.freeze({
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

export class CardDavConflictError extends Error {
  constructor(conflictId, options = {}) {
    super('The CardDAV contact changed before this write completed', options);
    this.name = 'CardDavConflictError';
    this.code = 'ERR_CARDDAV_CONFLICT';
    this.conflictId = conflictId;
  }
}

export class CardDavAmbiguousWriteError extends Error {
  constructor(operation, details = {}, options = {}) {
    super('The CardDAV write succeeded, but MailFlow could not confirm its local state', options);
    this.name = 'CardDavAmbiguousWriteError';
    this.code = 'ERR_CARDDAV_AMBIGUOUS_WRITE';
    this.operation = operation;
    Object.assign(this, details);
  }
}

function normalizedDocumentContact(document) {
  const contact = contactFromVCardDocument(document);
  return { ...contact, primaryEmail: primaryEmail(contact) };
}

function contactPayload(contact, document, vcard) {
  return {
    ...contact,
    primaryEmail: primaryEmail(contact),
    document,
    vcard,
    etag: localVCardEtag(vcard),
    remoteSemanticHash: semanticVCardHash(document),
    localContactHash: localContactHash(contact),
  };
}

function draftWithCurrent(current, draft) {
  const merged = { uid: current.uid };
  for (const [camel, snake] of DRAFT_FIELDS) {
    merged[camel] = Object.hasOwn(draft || {}, camel) ? draft[camel] : current[snake];
  }
  merged.emails ??= [];
  merged.phones ??= [];
  merged.additionalFields ??= [];
  return merged;
}

function validateContact(contact) {
  if (!Array.isArray(contact.emails)) throw typedError('emails must be an array', 'ERR_CONTACT_VALIDATION');
  if (!Array.isArray(contact.phones)) throw typedError('phones must be an array', 'ERR_CONTACT_VALIDATION');
  if (!Array.isArray(contact.additionalFields)) {
    throw typedError('additionalFields must be an array', 'ERR_CONTACT_VALIDATION');
  }
  if (!contact.displayName && !primaryEmail(contact)) {
    throw typedError('A name or email address is required', 'ERR_CONTACT_VALIDATION');
  }
}

function normalizedCreateDraft(draft) {
  const normalized = {
    displayName: null,
    firstName: null,
    lastName: null,
    emails: [],
    phones: [],
    organization: null,
    notes: null,
    photoData: null,
    additionalFields: [],
    ...(draft || {}),
  };
  validateContact(normalized);
  return normalized;
}

function payloadForDraft(uid, draft, version = null, retainedDocument = null, options = {}) {
  const contact = { uid, ...draft };
  validateContact(contact);
  const document = retainedDocument
    ? { ...retainedDocument, version: version ?? retainedDocument.version }
    : { version: version ?? '3.0', properties: [] };
  const updatedDocument = overlayContactOnVCard(document, contact, options);
  const vcard = serializeVCardDocument(updatedDocument);
  return contactPayload(normalizedDocumentContact(updatedDocument), updatedDocument, vcard);
}

function parseClientVCard(rawVCard) {
  try {
    return parseVCardDocument(rawVCard);
  } catch (cause) {
    // A malformed client body is a request error, not a server fault: give it a
    // typed code so the route maps it to 400 instead of a generic 500.
    throw typedError(cause.message || 'The vCard body could not be parsed', 'ERR_CONTACT_VALIDATION', { cause });
  }
}

function payloadForRawVCard(uid, rawVCard) {
  if (typeof uid !== 'string' || !uid) throw typedError('Contact UID is required', 'ERR_CONTACT_VALIDATION');
  if (typeof rawVCard !== 'string') throw typedError('rawVCard must be a string', 'ERR_CONTACT_VALIDATION');
  const document = parseClientVCard(rawVCard);
  const contact = normalizedDocumentContact(document);
  if (contact.uid !== uid) {
    throw typedError('The vCard UID does not match the resource UID', 'ERR_CONTACT_UID_MISMATCH');
  }
  validateContact(contact);
  return contactPayload(contact, document, rawVCard);
}

// Confirmed-remote projection after a mapped write. The remote resource owns the vCard
// UID, so the caller stores the retained remote document verbatim in the mapping
// while the LOCAL contact keeps its stable local key: the projection is re-keyed onto
// localUid, its vCard is re-serialized with the local UID (still lossless), and
// localContactHash reflects the local key. document/remoteSemanticHash stay on the
// remote UID for the mapping. For a push-origin/create contact localUid equals the
// remote UID and this is a no-op re-key (unlike payloadForRawVCard, no UID-match check).
export function confirmedRemotePayload(localUid, remoteVcard) {
  const document = parseVCardDocument(remoteVcard);
  const remoteContact = normalizedDocumentContact(document);
  validateContact(remoteContact);
  const localContact = { ...remoteContact, uid: localUid };
  const localVcard = serializeVCardDocument(overlayContactOnVCard(document, localContact));
  return contactPayload(localContact, document, localVcard);
}

// A mapped CardDAV-server PUT is a two-tier merge (not a full replacement).
// - MODELED fields: the client body is authoritative full state — it received them all,
//   so an omitted modeled field is a deliberate removal.
// - UNMODELED properties: a property-NAME-level merge — names the client body includes
//   win (all of that name's instances, replacing the retained set), names it omits survive
//   from the retained document, so a client that strips properties it does not understand
//   cannot silently delete them. Survivorship is atomic PER GROUP: when a grouped
//   unmodeled property survives, its whole itemN group (including the group's X-ABLABEL and
//   grouped parameters) survives; if the client reuses that group prefix, the survivor is
//   re-prefixed to a fresh itemN.
// Server-owned metadata (REV/PRODID/…) is never replayed. UID is re-keyed to the retained
// remote UID.
// DOCUMENTED LIMITATIONS: deleting an unmodeled property through a DAV client is unsupported
// (name-absent survives — not silent loss, just not a delete); and the per-name merge is
// all-or-nothing (a client submitting one instance of a repeated name replaces the whole
// retained instance set for that name — last-writer-wins per property name).
function mergedReplacePayload(clientDocument, retainedDocument) {
  const clientNames = new Set(clientDocument.properties.map(property => property.name));
  const retainedUidProperty = retainedDocument.properties.find(property => property.name === 'UID');
  const withUid = withDocumentUid(clientDocument, retainedUidProperty);
  const usedGroupKeys = new Set(withUid.properties.map(property => groupKey(property.group)).filter(Boolean));

  // Bucket retained non-server-owned properties by group.
  const retainedGroups = new Map();
  for (const property of retainedDocument.properties) {
    if (SERVER_OWNED_PROPERTIES.has(property.name)) continue;
    const key = groupKey(property.group);
    if (!retainedGroups.has(key)) retainedGroups.set(key, []);
    retainedGroups.get(key).push(property);
  }

  const survivors = [];
  for (const [key, groupProperties] of retainedGroups) {
    if (key === '') {
      // Ungrouped: each surviving unmodeled property (name the client omitted) stands alone.
      for (const property of groupProperties) {
        if (!MODELED_PROPERTY_NAMES.has(property.name) && !clientNames.has(property.name)) {
          survivors.push(property);
        }
      }
      continue;
    }
    // A grouped property survives iff the group has an unmodeled member whose name the client
    // omitted. Then the group survives, but W7: emit ONLY its unmodeled members and its
    // X-ABLABEL — NEVER a modeled main (ADR/URL/TEL/…) the client already owns via its
    // full-state modeled fields, which would duplicate that property on the wire (the standard
    // Apple item1.ADR + item1.X-ABADR + item1.X-ABLABEL layout). ACCEPTED CONSEQUENCE: a
    // surviving unmodeled annotation may be stale relative to a client-edited modeled main —
    // consistent with the can't-delete-unmodeled stance (keep it, do not silently lose it).
    // Keep the group's unmodeled members the client omitted (present-name-wins) plus
    // its X-ABLABEL (group-scoped, so it labels the survivor even when the client also uses
    // one for a different group). Modeled mains are never re-emitted.
    const kept = groupProperties.filter(property => (
      property.name === 'X-ABLABEL'
      || (!MODELED_PROPERTY_NAMES.has(property.name) && !clientNames.has(property.name))
    ));
    const survives = kept.some(property => property.name !== 'X-ABLABEL');
    if (!survives) continue;
    let prefix;
    if (usedGroupKeys.has(key)) {
      prefix = allocateItemGroup(usedGroupKeys);   // collision with a client group → re-prefix
    } else {
      usedGroupKeys.add(key);
      prefix = groupProperties[0].group;
    }
    for (const property of kept) survivors.push({ ...property, group: prefix });
  }

  const properties = [...withUid.properties, ...survivors]
    .filter(property => !SERVER_OWNED_PROPERTIES.has(property.name));
  const outgoing = { ...withUid, properties };
  return contactPayload(normalizedDocumentContact(outgoing), outgoing, serializeVCardDocument(outgoing));
}

// Edits to a synced contact overlay onto the retained lossless remote vCard so
// unmodeled properties (CATEGORIES, KEY, TZ, X-*, …) survive the pull→edit→PUT
// round-trip. The local contacts.vcard is a lossy re-serialization from the pull
// (generateVCard keeps only modeled properties); it only backs edits made before
// a CardDAV mapping exists.
function retainedEditDocument(contact) {
  return parseVCardDocument(contact.mapping_vcard ?? contact.vcard);
}

function mappingBookId(contact) {
  return contact.mapping_address_book_id ?? (contact.href ? contact.address_book_id : null);
}

function localBookId(contact) {
  return contact.local_address_book_id ?? contact.address_book_id;
}

function remoteBookUrl(contact) {
  return contact.remote_book_url ?? contact.external_url;
}

function capability(contact, operation) {
  return contact[`remote_${operation}_capability`] ?? 'unknown';
}

function assertWritable(contact, operation) {
  if (capability(contact, operation) === 'denied') {
    throw typedError(`This CardDAV address book does not allow ${operation}`, 'ERR_CARDDAV_READ_ONLY');
  }
  if (contact.mapping_status === 'conflict' && contact.conflict_id) {
    throw new CardDavConflictError(contact.conflict_id);
  }
}

async function readIntegration(client, userId, lock = false) {
  if (lock) return lockCarddavIntegration(client, userId, { requireServerUrl: true });
  const { rows: [integration] } = await client.query(
    `SELECT id, config
     FROM user_integrations
     WHERE user_id = $1 AND provider = 'carddav'
     `,
    [userId],
  );
  return integration?.config?.serverUrl ? integration : null;
}

async function readContact(client, userId, { contactId, localAddressBookId, uid }) {
  const conditions = contactId
    ? 'c.id = $2'
    : 'c.address_book_id = $2 AND c.uid = $3';
  const params = contactId
    ? [userId, contactId]
    : [userId, localAddressBookId, uid];
  const { rows: [contact] } = await client.query(
    `SELECT c.*,
            c.address_book_id AS local_address_book_id,
            mapping.address_book_id AS mapping_address_book_id,
            mapping.href, mapping.remote_etag, mapping.mapping_status,
            mapping.vcard AS mapping_vcard,
            mapping.vcard_version, mapping.remote_semantic_hash,
            mapping.local_contact_hash, mapping.mapping_revision,
            mapping.pending_operation, mapping.pending_vcard,
            mapping.pending_local_hash, mapping.pending_remote_semantic_hash,
            mapping.pending_started_at, mapping.updated_at AS mapping_updated_at,
            remote_book.external_url AS remote_book_url,
            remote_book.remote_create_capability,
            remote_book.remote_update_capability,
            remote_book.remote_delete_capability,
            conflict.id AS conflict_id
     FROM contacts c
     JOIN address_books local_book ON local_book.id = c.address_book_id
     LEFT JOIN carddav_remote_objects mapping
       ON mapping.local_contact_id = c.id
      AND mapping.mapping_status <> 'pending_materialization'
     LEFT JOIN address_books remote_book ON remote_book.id = mapping.address_book_id
     LEFT JOIN carddav_conflicts conflict
       ON conflict.address_book_id = mapping.address_book_id
      AND conflict.href = mapping.href
      AND conflict.status = 'unresolved'
     WHERE c.user_id = $1 AND ${conditions}`,
    params,
  );
  return contact || null;
}

async function readOwnedBook(client, userId, addressBookId) {
  const { rows: [book] } = await client.query(
    `SELECT id, source
     FROM address_books
     WHERE id = $1 AND user_id = $2`,
    [addressBookId, userId],
  );
  return book || null;
}

async function credentials(integration) {
  const config = integration.config;
  const resolved = await resolveCarddavCredentials(config);
  const { password } = resolved;
  if (!password) throw typedError('Stored CardDAV credentials could not be read', 'ERR_CARDDAV_CREDENTIALS');
  return {
    serverUrl: config.serverUrl,
    ...resolved,
    connectionGeneration: config.connectionGeneration ?? null,
  };
}

async function discoverCreateContext(userId, integration) {
  assertRetryEligible(integration, 'create');
  const creds = await credentials(integration);
  try {
    const books = await discoverAddressBooks({
      serverUrl: creds.serverUrl,
      ...resourceCredentials(creds),
    });
    return { books, creds };
  } catch (error) {
    if (isThrottle(error)) {
      await recordThrottle(
        userId,
        integration.config.connectionGeneration ?? null,
        error,
      );
    }
    throw error;
  }
}

function selectedCreateBook(books) {
  if (!Array.isArray(books)) throw typedError('A fresh CardDAV book snapshot is required', 'ERR_CARDDAV_BOOKS');
  const selected = books.find(book => book.capabilities?.create === 'allowed')
    || books.find(book => (book.capabilities?.create ?? 'unknown') === 'unknown');
  if (!selected) throw typedError('No writable CardDAV address book was discovered', 'ERR_CARDDAV_READ_ONLY');
  return selected;
}

function selectedVCardVersion(book) {
  const advertised = (book.addressData || []).map(entry => entry.version);
  return advertised.length > 0 && advertised.every(version => version === '4.0') ? '4.0' : '3.0';
}

function resourceCredentials(creds) {
  return {
    username: creds.username,
    password: creds.password,
    allowPrivate: creds.allowPrivate,
  };
}

function safeLocation(url) {
  const parsed = URL.parse(url);
  return { origin: parsed?.origin ?? null, path: parsed?.pathname ?? null };
}

function logMutation({ operation, contactId, addressBookId, href, status, retryDecision, conflictTransition, startedAt }) {
  console.info('[carddav-contact-mutation]', {
    operation,
    contactId: contactId ?? null,
    addressBookId: addressBookId ?? null,
    ...safeLocation(href),
    status: status ?? null,
    retryDecision: retryDecision ?? null,
    conflictTransition: conflictTransition ?? null,
    durationMs: Date.now() - startedAt,
  });
}

async function ensureLocalBook(client, userId) {
  const { rows: [book] } = await client.query(
    `INSERT INTO address_books (user_id, name)
     VALUES ($1, 'Personal')
     ON CONFLICT (user_id, name) DO UPDATE SET updated_at = address_books.updated_at
     RETURNING id`,
    [userId],
  );
  return book.id;
}

export function contactValues(payload) {
  return [
    payload.uid,
    payload.vcard,
    payload.etag,
    payload.displayName,
    payload.firstName,
    payload.lastName,
    payload.primaryEmail,
    JSON.stringify(payload.emails || []),
    JSON.stringify(payload.phones || []),
    payload.organization,
    payload.notes,
    payload.photoData,
    JSON.stringify(payload.additionalFields || []),
  ];
}

export async function insertContact(client, userId, addressBookId, payload, {
  returning = API_CONTACT_COLUMNS,
} = {}) {
  const { rows: [row] } = await client.query(
    `INSERT INTO contacts (
       address_book_id, user_id, uid, vcard, etag,
       display_name, first_name, last_name, primary_email,
       emails, phones, organization, notes, photo_data, additional_fields, is_auto
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14,$15::jsonb,false)
     RETURNING ${returning}`,
    [addressBookId, userId, ...contactValues(payload)],
  );
  return row;
}

function isLocalContactUidConflict(error) {
  return error?.code === '23505'
    && error.constraint === 'contacts_address_book_id_uid_key';
}

export async function updateStoredContact(
  client,
  userId,
  contactId,
  payload,
  expectedEtag = null,
  { returning = API_CONTACT_COLUMNS, onMissing = null } = {},
) {
  const etagFence = expectedEtag == null ? '' : 'AND etag = $16';
  const params = [...contactValues(payload), contactId, userId];
  if (expectedEtag != null) params.push(expectedEtag);
  const { rows: [row] } = await client.query(
    `UPDATE contacts SET
       uid = $1, vcard = $2, etag = $3,
       display_name = $4, first_name = $5, last_name = $6,
       primary_email = $7, emails = $8::jsonb, phones = $9::jsonb,
       organization = $10, notes = $11, photo_data = $12,
       additional_fields = $13::jsonb, is_auto = false, updated_at = NOW()
     WHERE id = $14 AND user_id = $15 ${etagFence}
     RETURNING ${returning}`,
    params,
  );
  if (!row) {
    if (onMissing) throw onMissing();
    if (expectedEtag != null) {
      throw typedError('The local contact changed', 'ERR_LOCAL_ETAG_MISMATCH');
    }
    throw typedError('Contact not found', 'ERR_CONTACT_NOT_FOUND');
  }
  return row;
}

async function bumpLocalBook(client, userId, addressBookId) {
  await rotateBookToken(client, userId, addressBookId);
}

async function createLocal(client, userId, localAddressBookId, payload, expectedAbsent = false) {
  const addressBookId = localAddressBookId ?? await ensureLocalBook(client, userId);
  let row;
  try {
    row = await insertContact(client, userId, addressBookId, payload);
  } catch (error) {
    if (expectedAbsent === true && isLocalContactUidConflict(error)) {
      throw typedError('The contact already exists', 'ERR_LOCAL_PRECONDITION_FAILED');
    }
    throw error;
  }
  await bumpLocalBook(client, userId, addressBookId);
  return row;
}

async function updateLocal(client, userId, contact, payload, expectedEtag = null) {
  const row = await updateStoredContact(
    client,
    userId,
    contact.id,
    payload,
    expectedEtag,
  );
  await bumpLocalBook(client, userId, localBookId(contact));
  return row;
}

async function deleteLocal(client, userId, contact, expectedEtag = null) {
  const etagFence = expectedEtag == null ? '' : 'AND etag = $3';
  const params = [contact.id, userId];
  if (expectedEtag != null) params.push(expectedEtag);
  const deleted = await client.query(
    `DELETE FROM contacts
     WHERE id = $1 AND user_id = $2 ${etagFence}
     RETURNING address_book_id`,
    params,
  );
  if (deleted.rowCount !== 1) {
    if (expectedEtag != null) {
      throw typedError('The local contact changed', 'ERR_LOCAL_ETAG_MISMATCH');
    }
    throw typedError('Contact not found', 'ERR_CONTACT_NOT_FOUND');
  }
  await bumpLocalBook(client, userId, localBookId(contact));
  return { ok: true };
}

async function serializable(callback) {
  return withTransaction(async client => {
    await client.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
    return callback(client);
  });
}

async function confirmedCommit(operation, details, callback) {
  try {
    return await callback();
  } catch (cause) {
    throw new CardDavAmbiguousWriteError(operation, details, { cause });
  }
}

function sameGeneration(integration, generation) {
  return (integration?.config?.connectionGeneration ?? null) === generation;
}

function assertRetryEligible(integration, operation) {
  const retryAfterAt = activeRetryAfterAt(integration?.config);
  if (!retryAfterAt) return;
  throw new CardDavError('CardDAV requests are throttled until Retry-After eligibility', {
    status: 429,
    operation,
    retryAfterAt,
  });
}

function isThrottle(error) {
  return error instanceof CardDavError && error.status === 429;
}

async function persistRetryAfter(client, integration, retryAfterAt) {
  if (!retryAfterAt) return;
  const result = await client.query(
    `UPDATE user_integrations
     SET config = jsonb_set(config, '{retryAfterAt}', to_jsonb($2::text), true),
         updated_at = NOW()
     WHERE id = $1
       AND config->>'connectionGeneration' IS NOT DISTINCT FROM $3`,
    [
      integration.id,
      retryAfterAt,
      integration.config.connectionGeneration ?? null,
    ],
  );
  if (result.rowCount !== 1) {
    throw typedError('CardDAV connection changed after throttling', 'ERR_CARDDAV_FINAL_FENCE');
  }
}

async function recordThrottle(userId, generation, error) {
  if (!error.retryAfterAt) return;
  await withTransaction(async client => {
    const integration = await readIntegration(client, userId, true);
    if (!sameGeneration(integration, generation)) {
      throw typedError('CardDAV connection changed after throttling', 'ERR_CARDDAV_FINAL_FENCE');
    }
    await persistRetryAfter(client, integration, error.retryAfterAt);
  });
}

async function rollbackMappedThrottle(userId, preflight, error) {
  await withTransaction(async client => {
    const integration = await readIntegration(client, userId, true);
    if (!sameGeneration(integration, preflight.connectionGeneration)) {
      throw typedError('CardDAV connection changed after throttling', 'ERR_CARDDAV_FINAL_FENCE');
    }
    assertMappingApplied(await restorePendingMutationIntent(client, {
      addressBookId: preflight.addressBookId,
      href: preflight.href,
      expectedMappingRevision: preflight.mappingRevision,
      operation: preflight.pendingOperation,
      pendingVCard: preflight.pendingVCard,
      pendingLocalHash: preflight.pendingLocalHash,
      pendingRemoteSemanticHash: preflight.pendingRemoteSemanticHash,
      pendingStartedAt: preflight.pendingStartedAt,
      previousMappingStatus: preflight.previousMappingStatus,
      previousMappingRevision: preflight.previousMappingRevision,
      previousUpdatedAt: preflight.previousMappingUpdatedAt,
    }));
    await persistRetryAfter(client, integration, error.retryAfterAt);
  });
}

async function lockMutationState(client, userId, preflight) {
  const integration = await readIntegration(client, userId, true);
  const mapping = await lockCarddavMapping(client, {
    userId,
    addressBookId: preflight.addressBookId,
    href: preflight.href,
  });
  return { integration, mapping };
}

function finalFenceMatches(state, preflight) {
  return sameGeneration(state.integration, preflight.connectionGeneration)
    && state.mapping
    && String(state.mapping.mapping_revision) === String(preflight.mappingRevision);
}

function assertFinalFence(state, preflight) {
  if (!finalFenceMatches(state, preflight)) {
    throw typedError('CardDAV mapping changed after the remote write', 'ERR_CARDDAV_FINAL_FENCE');
  }
}

function assertMappingApplied(result) {
  if (result.ok) return result;
  throw typedError('CardDAV mapping changed after the remote write', 'ERR_CARDDAV_FINAL_FENCE');
}

function storedLocalContactHash(contact) {
  return localContactHash(draftWithCurrent(contact, {}));
}

async function commitRemoteCreate({ userId, preflight, localAddressBookId, book, remote }) {
  return confirmedCommit('create', {
    contactId: preflight.contactId ?? null,
    href: remote.href,
  }, async () => {
    const payload = payloadForRawVCard(preflight.uid, remote.vcard);
    return serializable(async client => {
      const integration = await readIntegration(client, userId, true);
      if (!sameGeneration(integration, preflight.connectionGeneration)) {
        throw typedError('CardDAV connection changed after the remote write', 'ERR_CARDDAV_FINAL_FENCE');
      }
      const localBook = localAddressBookId ?? await ensureLocalBook(client, userId);
      const remoteBook = await persistDiscoveredBook(client, { userId, ...book });
      const row = preflight.contactId
        ? await updateStoredContact(
          client,
          userId,
          preflight.contactId,
          payload,
          preflight.localEtag,
        )
        : await insertContact(client, userId, localBook, payload);
      assertMappingApplied(await applyConfirmedRemoteContact(client, {
        addressBookId: remoteBook.id,
        href: remote.href,
        expectedMappingRevision: null,
        remoteEtag: remote.etag,
        vcard: remote.vcard,
        primaryEmail: payload.primaryEmail,
        localContactId: row.id,
        vcardVersion: payload.document.version,
        remoteSemanticHash: payload.remoteSemanticHash,
        localContactHash: payload.localContactHash,
      }));
      await bumpLocalBook(client, userId, localBook);
      return row;
    });
  });
}

function isNotFound(error) {
  return error instanceof CardDavError && error.status === 404;
}

export async function fetchCreated({ book, href, uid, creds }) {
  try {
    const remote = await fetchCardResource({
      url: book.url,
      href,
      ...resourceCredentials(creds),
    });
    payloadForRawVCard(uid, remote.vcard);
    return { kind: 'found', remote };
  } catch (cause) {
    if (isNotFound(cause)) return { kind: 'missing' };
    return { kind: 'unknown', cause };
  }
}

function ambiguousCreate(book, href, outcome) {
  const cause = outcome.kind === 'unknown'
    ? outcome.cause
    : new CardDavError('Created CardDAV resource was not found', {
      status: 404,
      operation: 'fetch',
    });
  return new CardDavAmbiguousWriteError('create', {
    href: new URL(href, book.url).href,
  }, { cause });
}

async function canonicalCreate({ book, uid, payload, creds }) {
  const href = `${uid}.vcf`;
  const options = {
    url: book.url,
    href,
    vcard: payload.vcard,
    ...resourceCredentials(creds),
  };
  let firstPut = 'accepted';
  try {
    await putCardResource(options);
  } catch (error) {
    if (error instanceof CardDavError && error.status != null) throw error;
    firstPut = 'ambiguous';
  }

  switch (firstPut) {
    case 'accepted': {
      const final = await fetchCreated({ book, href, uid, creds });
      if (final.kind === 'found') {
        return { remote: final.remote, retryDecision: 'not-retried' };
      }
      throw ambiguousCreate(book, href, final);
    }
    case 'ambiguous': {
      const recovery = await fetchCreated({ book, href, uid, creds });
      switch (recovery.kind) {
        case 'found':
          return { remote: recovery.remote, retryDecision: 'recovered-after-ambiguous' };
        case 'unknown':
          throw ambiguousCreate(book, href, recovery);
        case 'missing':
          break;
      }

      let retryDecision = 'retried-after-confirmed-missing';
      try {
        await putCardResource(options);
      } catch (retryError) {
        if (
          retryError instanceof CardDavError
          && retryError.status != null
          && retryError.status !== 412
        ) {
          throw retryError;
        }
        retryDecision = 'recovered-after-bounded-retry';
      }
      const final = await fetchCreated({ book, href, uid, creds });
      switch (final.kind) {
        case 'found':
          return { remote: final.remote, retryDecision };
        case 'missing':
        case 'unknown':
          throw ambiguousCreate(book, href, final);
      }
      break;
    }
  }
  throw new Error('Unreachable create outcome');
}

async function remoteCreate({ userId, preflight, localAddressBookId, book, payload, creds }) {
  const activeCredentials = creds || await credentials(preflight.integration);
  const startedAt = Date.now();
  try {
    const { remote, retryDecision } = await canonicalCreate({
      book,
      uid: preflight.uid,
      payload,
      creds: activeCredentials,
    });
    const row = await commitRemoteCreate({ userId, preflight, localAddressBookId, book, remote });
    logMutation({
      operation: 'create', contactId: row.id, addressBookId: null,
      href: remote.href, status: 200, retryDecision, startedAt,
    });
    return row;
  } catch (error) {
    if (isThrottle(error)) {
      await recordThrottle(userId, preflight.connectionGeneration, error);
    }
    if (
      preflight.expectedAbsent === true
      && error instanceof CardDavError
      && error.status === 412
    ) {
      logMutation({
        operation: 'create', contactId: preflight.contactId, addressBookId: null,
        href: book.url, status: 412, retryDecision: 'not-retried', startedAt,
      });
      throw typedError('The contact already exists', 'ERR_LOCAL_PRECONDITION_FAILED');
    }
    if (error instanceof CardDavError && (error.status === 403 || error.status === 405)) {
      await recordDeniedCreate(userId, preflight.connectionGeneration, book);
    }
    logMutation({
      operation: 'create', contactId: preflight.contactId, addressBookId: null,
      href: book.url, status: error.status, retryDecision: 'not-retried', startedAt,
    });
    throw error;
  }
}

async function recordDeniedCreate(userId, generation, book) {
  await withTransaction(async client => {
    const integration = await readIntegration(client, userId, true);
    if (!sameGeneration(integration, generation)) return;
    const storedBook = await persistDiscoveredBook(client, {
      userId,
      ...book,
      preserveCapabilities: true,
    });
    await persistDeniedBookCapability(client, {
      userId,
      addressBookId: storedBook.id,
      capability: 'create',
    });
  });
}

async function recordDeniedMapped(userId, preflight, operation) {
  await withTransaction(async client => {
    const state = await lockMutationState(client, userId, preflight);
    if (!finalFenceMatches(state, preflight)) return;
    await persistDeniedBookCapability(client, {
      userId,
      addressBookId: preflight.addressBookId,
      capability: operation,
    });
  });
}

async function latestRemote(preflight, creds) {
  try {
    const remote = await fetchCardResource({
      url: preflight.url,
      href: preflight.href,
      ...resourceCredentials(creds),
    });
    return { ...remote, tombstone: false };
  } catch (error) {
    if (isNotFound(error)) {
      return { href: preflight.href, etag: null, vcard: null, tombstone: true };
    }
    throw error;
  }
}

async function commitPendingRecovery({ userId, preflight, remote }) {
  let conflict;
  const value = await serializable(async client => {
    const state = await lockMutationState(client, userId, preflight);
    assertFinalFence(state, preflight);
    const intent = state.mapping;
    if (!intent.pending_operation) {
      throw typedError('The pending CardDAV intent is missing', 'ERR_CARDDAV_FINAL_FENCE');
    }
    const contact = await readContact(client, userId, { contactId: preflight.contactId });
    const currentLocalHash = contact ? storedLocalContactHash(contact) : null;
    const localMatches = currentLocalHash === intent.pending_local_hash;
    const remotePayload = remote.payload ?? null;
    const remoteMatches = intent.pending_operation === 'delete'
      ? remote.tombstone
      : !remote.tombstone
        && remotePayload.remoteSemanticHash === intent.pending_remote_semantic_hash;

    if (remoteMatches && localMatches) {
      if (intent.pending_operation === 'delete') {
        assertMappingApplied(await applyRemoteTombstone(client, {
          addressBookId: preflight.addressBookId,
          href: preflight.href,
          expectedMappingRevision: preflight.mappingRevision,
        }));
        const deleted = await client.query(
          'DELETE FROM contacts WHERE id = $1 AND user_id = $2',
          [preflight.contactId, userId],
        );
        if (deleted.rowCount !== 1) {
          throw typedError('Contact not found', 'ERR_CONTACT_NOT_FOUND');
        }
        await bumpLocalBook(client, userId, preflight.localAddressBookId);
        return { ok: true };
      }
      const row = await updateStoredContact(
        client,
        userId,
        preflight.contactId,
        remotePayload,
      );
      assertMappingApplied(await applyConfirmedRemoteContact(client, {
        addressBookId: preflight.addressBookId,
        href: preflight.href,
        expectedMappingRevision: preflight.mappingRevision,
        remoteEtag: remote.etag,
        vcard: remote.vcard,
        primaryEmail: remotePayload.primaryEmail,
        localContactId: preflight.contactId,
        vcardVersion: remotePayload.document.version,
        remoteSemanticHash: remotePayload.remoteSemanticHash,
        localContactHash: remotePayload.localContactHash,
      }));
      await bumpLocalBook(client, userId, preflight.localAddressBookId);
      return row;
    }

    const preserveCurrentLocal = !localMatches && contact;
    // A later keep-mailflow resolution pushes this snapshot verbatim, so preserve the
    // current local contact losslessly onto the retained remote vCard — and keep the
    // retained REMOTE UID (preserveDocumentUid), never the local key, so
    // resolution can't rewrite the remote resource's UID. The pending-intent branch is
    // already the overlaid payload vCard (which already carries the remote UID).
    const localVCard = preserveCurrentLocal
      ? presentedVCard(contact, { preserveDocumentUid: true })
      : intent.pending_vcard;
    const result = await refreshUnresolvedConflict(client, {
      addressBookId: preflight.addressBookId,
      href: preflight.href,
      expectedMappingRevision: preflight.mappingRevision,
      userId,
      baseLocalHash: intent.local_contact_hash,
      remoteEtag: remote.etag,
      localVCard,
      remoteVCard: remote.vcard,
      localTombstone: preserveCurrentLocal ? false : intent.pending_operation === 'delete',
      remoteTombstone: remote.tombstone,
    });
    assertMappingApplied(result);
    conflict = result.conflict;
    return null;
  });
  if (conflict) throw new CardDavConflictError(conflict.id);
  return value;
}

async function recoverMappedIntent(userId, preflight, activeCredentials) {
  const creds = activeCredentials || await credentials(preflight.integration);
  let remote;
  try {
    remote = await latestRemote(preflight, creds);
  } catch (cause) {
    if (isThrottle(cause)) {
      await recordThrottle(userId, preflight.connectionGeneration, cause);
    }
    throw new CardDavAmbiguousWriteError(preflight.pendingOperation, {
      contactId: preflight.contactId,
      href: preflight.href,
    }, { cause });
  }
  if (!remote.tombstone) {
    remote = { ...remote, payload: confirmedRemotePayload(preflight.uid, remote.vcard) };
  }
  try {
    return await commitPendingRecovery({ userId, preflight, remote });
  } catch (error) {
    if (error instanceof CardDavConflictError) throw error;
    throw new CardDavAmbiguousWriteError(preflight.pendingOperation, {
      contactId: preflight.contactId,
      href: preflight.href,
    }, { cause: error });
  }
}

async function mappedUpdate(userId, preflight, payload) {
  const creds = await credentials(preflight.integration);
  const startedAt = Date.now();
  let writeError;
  if (!preflight.recoveryOnly) {
    try {
      await putCardResource({
        url: preflight.url,
        href: preflight.href,
        etag: preflight.remoteEtag,
        vcard: payload.vcard,
        ...resourceCredentials(creds),
      });
    } catch (error) {
      if (isThrottle(error)) {
        await rollbackMappedThrottle(userId, preflight, error);
        logMutation({
          operation: preflight.pendingOperation,
          contactId: preflight.contactId,
          addressBookId: preflight.addressBookId,
          href: preflight.href,
          status: error.status,
          retryDecision: 'scheduled-after-throttle',
          startedAt,
        });
        throw error;
      }
      writeError = error;
      if (error instanceof CardDavError && (error.status === 403 || error.status === 405)) {
        await recordDeniedMapped(userId, preflight, 'update');
      }
    }
  }
  try {
    const row = await recoverMappedIntent(userId, preflight, creds);
    logMutation({
      operation: preflight.pendingOperation,
      contactId: preflight.contactId,
      addressBookId: preflight.addressBookId,
      href: preflight.href,
      status: writeError?.status ?? 200,
      retryDecision: preflight.recoveryOnly ? 'read-only-recovery' : 'not-retried',
      startedAt,
    });
    return row;
  } catch (error) {
    logMutation({
      operation: preflight.pendingOperation,
      contactId: preflight.contactId,
      addressBookId: preflight.addressBookId,
      href: preflight.href,
      status: writeError?.status,
      retryDecision: 'not-retried',
      conflictTransition: error instanceof CardDavConflictError
        ? 'created-or-refreshed'
        : null,
      startedAt,
    });
    throw error;
  }
}

async function mappedDelete(userId, preflight) {
  const creds = await credentials(preflight.integration);
  const startedAt = Date.now();
  let writeError;
  if (!preflight.recoveryOnly) {
    try {
      await deleteCardResource({
        url: preflight.url,
        href: preflight.href,
        etag: preflight.remoteEtag,
        ...resourceCredentials(creds),
      });
    } catch (error) {
      if (isThrottle(error)) {
        await rollbackMappedThrottle(userId, preflight, error);
        logMutation({
          operation: preflight.pendingOperation,
          contactId: preflight.contactId,
          addressBookId: preflight.addressBookId,
          href: preflight.href,
          status: error.status,
          retryDecision: 'scheduled-after-throttle',
          startedAt,
        });
        throw error;
      }
      writeError = error;
      if (error instanceof CardDavError && (error.status === 403 || error.status === 405)) {
        await recordDeniedMapped(userId, preflight, 'delete');
      }
    }
  }
  try {
    const result = await recoverMappedIntent(userId, preflight, creds);
    logMutation({
      operation: preflight.pendingOperation,
      contactId: preflight.contactId,
      addressBookId: preflight.addressBookId,
      href: preflight.href,
      status: writeError?.status ?? 204,
      retryDecision: preflight.recoveryOnly ? 'read-only-recovery' : 'not-retried',
      startedAt,
    });
    return result;
  } catch (error) {
    logMutation({
      operation: preflight.pendingOperation,
      contactId: preflight.contactId,
      addressBookId: preflight.addressBookId,
      href: preflight.href,
      status: writeError?.status,
      retryDecision: 'not-retried',
      conflictTransition: error instanceof CardDavConflictError
        ? 'created-or-refreshed'
        : null,
      startedAt,
    });
    throw error;
  }
}

function mappedPreflight(integration, contact) {
  return {
    integration,
    connectionGeneration: integration.config.connectionGeneration ?? null,
    contactId: contact.id,
    uid: contact.uid,
    localAddressBookId: localBookId(contact),
    addressBookId: mappingBookId(contact),
    url: remoteBookUrl(contact),
    href: contact.href,
    remoteEtag: contact.remote_etag,
    mappingRevision: contact.mapping_revision,
    pendingOperation: contact.pending_operation ?? null,
    pendingVCard: contact.pending_vcard ?? null,
    pendingLocalHash: contact.pending_local_hash ?? null,
    pendingRemoteSemanticHash: contact.pending_remote_semantic_hash ?? null,
    pendingStartedAt: contact.pending_started_at ?? null,
    mappingStatus: contact.mapping_status,
    mappingUpdatedAt: contact.mapping_updated_at,
  };
}

async function prepareMappedMutation(client, userId, integration, contact, operation, payload = null) {
  const preflight = mappedPreflight(integration, contact);
  if (preflight.pendingOperation) {
    const sameIntent = preflight.pendingOperation === operation
      && (operation === 'delete'
        || payload?.remoteSemanticHash === preflight.pendingRemoteSemanticHash);
    if (!sameIntent) {
      throw typedError(
        'A CardDAV mutation is already awaiting confirmation',
        'ERR_CARDDAV_PENDING_INTENT',
        { operation: preflight.pendingOperation },
      );
    }
    return { ...preflight, recoveryOnly: true };
  }
  const pendingLocalHash = storedLocalContactHash(contact);
  const applied = await persistPendingMutationIntent(client, {
    userId,
    addressBookId: preflight.addressBookId,
    href: preflight.href,
    expectedMappingRevision: preflight.mappingRevision,
    operation,
    pendingVCard: payload?.vcard ?? null,
    pendingLocalHash,
    pendingRemoteSemanticHash: payload?.remoteSemanticHash ?? null,
  });
  assertMappingApplied(applied);
  return {
    ...preflight,
    previousMappingRevision: preflight.mappingRevision,
    previousMappingStatus: preflight.mappingStatus,
    previousMappingUpdatedAt: preflight.mappingUpdatedAt,
    mappingRevision: applied.mappingRevision,
    pendingOperation: operation,
    pendingVCard: payload?.vcard ?? null,
    pendingLocalHash,
    pendingRemoteSemanticHash: payload?.remoteSemanticHash ?? null,
    pendingStartedAt: applied.pendingStartedAt,
    payload,
  };
}

async function supportsPendingIntentSchema() {
  const { rows: [schema] } = await query(
    `SELECT EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'carddav_remote_objects'
         AND column_name = 'pending_operation'
     ) AS supports_pending_intent`,
  );
  return schema?.supports_pending_intent === true;
}

export async function recoverPendingCarddavMutations(userId, { integration, creds } = {}) {
  if (!integration?.config?.serverUrl) {
    throw typedError('CardDAV is not connected', 'ERR_CARDDAV_NOT_CONNECTED');
  }
  assertRetryEligible(integration, 'sync');
  if (!await supportsPendingIntentSchema()) return [];
  const { rows } = await query(
    `SELECT c.*,
            c.address_book_id AS local_address_book_id,
            mapping.address_book_id AS mapping_address_book_id,
            mapping.href, mapping.remote_etag, mapping.mapping_status,
            mapping.vcard_version, mapping.remote_semantic_hash,
            mapping.local_contact_hash, mapping.mapping_revision::text,
            mapping.pending_operation, mapping.pending_vcard,
            mapping.pending_local_hash, mapping.pending_remote_semantic_hash,
            mapping.pending_started_at, mapping.updated_at AS mapping_updated_at,
            remote_book.external_url AS remote_book_url
     FROM carddav_remote_objects mapping
     JOIN contacts c ON c.id = mapping.local_contact_id
     JOIN address_books remote_book ON remote_book.id = mapping.address_book_id
     WHERE c.user_id = $1 AND mapping.pending_operation IS NOT NULL
     ORDER BY mapping.address_book_id, mapping.href`,
    [userId],
  );
  const recovered = [];
  for (const contact of rows) {
    const preflight = { ...mappedPreflight(integration, contact), recoveryOnly: true };
    try {
      recovered.push(await recoverMappedIntent(userId, preflight, creds));
    } catch (error) {
      if (!(error instanceof CardDavConflictError)) throw error;
      recovered.push({ conflictId: error.conflictId });
    }
  }
  return recovered;
}

export async function createContact(userId, draft) {
  const validatedDraft = normalizedCreateDraft(draft);
  const uid = randomUUID();
  const preflight = await withTransaction(async client => ({
    integration: await readIntegration(client, userId),
    uid,
  }));
  if (!preflight.integration) {
    const payload = payloadForDraft(uid, validatedDraft);
    return withTransaction(client => createLocal(client, userId, null, payload));
  }
  const { books, creds } = await discoverCreateContext(userId, preflight.integration);
  const selected = selectedCreateBook(books);
  const payload = payloadForDraft(uid, validatedDraft, selectedVCardVersion(selected));
  return remoteCreate({
    userId,
    preflight: {
      ...preflight,
      connectionGeneration: preflight.integration.config.connectionGeneration ?? null,
    },
    localAddressBookId: null,
    book: selected,
    payload,
    creds,
  });
}

export async function updateContact(userId, contactId, draft) {
  let localResult;
  const prepared = await withTransaction(async client => {
    const integration = await readIntegration(client, userId);
    if (integration) assertRetryEligible(integration, 'update');
    const contact = await readContact(client, userId, { contactId });
    if (!contact) throw typedError('Contact not found', 'ERR_CONTACT_NOT_FOUND');
    if (!integration || !contact.href) {
      const payload = payloadForDraft(
        contact.uid,
        draftWithCurrent(contact, draft),
        undefined,
        parseVCardDocument(contact.vcard),
      );
      localResult = await updateLocal(client, userId, contact, payload);
      return null;
    }
    assertWritable(contact, 'update');
    // The outgoing document preserves the retained remote UID: UID is
    // remote-owned identity, so a Mailflow edit never rewrites it on the server.
    const payload = payloadForDraft(
      contact.uid,
      draftWithCurrent(contact, draft),
      undefined,
      retainedEditDocument(contact),
      { preserveDocumentUid: true },
    );
    return prepareMappedMutation(client, userId, integration, contact, 'update', payload);
  });
  return prepared ? mappedUpdate(userId, prepared, prepared.payload) : localResult;
}

export async function deleteContact(userId, contactId) {
  let localResult;
  const prepared = await withTransaction(async client => {
    const integration = await readIntegration(client, userId);
    if (integration) assertRetryEligible(integration, 'delete');
    const contact = await readContact(client, userId, { contactId });
    if (!contact) throw typedError('Contact not found', 'ERR_CONTACT_NOT_FOUND');
    if (!integration || !contact.href) {
      localResult = await deleteLocal(client, userId, contact);
      return null;
    }
    assertWritable(contact, 'delete');
    return prepareMappedMutation(client, userId, integration, contact, 'delete');
  });
  return prepared ? mappedDelete(userId, prepared) : localResult;
}

export async function exportExistingContact(userId, contactId, { books, expectedGeneration }) {
  const selected = selectedCreateBook(books);
  const prepared = await withTransaction(async client => {
    const integration = await readIntegration(client, userId);
    if (!integration) throw typedError('CardDAV is not connected', 'ERR_CARDDAV_NOT_CONNECTED');
    assertRetryEligible(integration, 'create');
    const actualGeneration = integration.config.connectionGeneration ?? null;
    if (expectedGeneration !== undefined && actualGeneration !== expectedGeneration) {
      throw typedError(
        'The CardDAV connection changed before export',
        'ERR_CARDDAV_STALE_GENERATION',
        {
          expectedConnectionGeneration: expectedGeneration,
          actualConnectionGeneration: actualGeneration,
        },
      );
    }
    const contact = await readContact(client, userId, { contactId });
    if (!contact) throw typedError('Contact not found', 'ERR_CONTACT_NOT_FOUND');
    if (contact.href) throw typedError('Contact already has a CardDAV mapping', 'ERR_CARDDAV_ALREADY_MAPPED');
    return {
      integration,
      connectionGeneration: integration.config.connectionGeneration ?? null,
      uid: contact.uid,
      contactId: contact.id,
      localAddressBookId: localBookId(contact),
      localEtag: contact.etag,
      payload: payloadForDraft(
        contact.uid,
        draftWithCurrent(contact, {}),
        selectedVCardVersion(selected),
        parseVCardDocument(contact.vcard),
      ),
    };
  });
  return remoteCreate({
    userId,
    preflight: prepared,
    localAddressBookId: prepared.localAddressBookId,
    book: selected,
    payload: prepared.payload,
  });
}

export async function createContactFromVCard(userId, {
  localAddressBookId,
  uid,
  rawVCard,
  expectedAbsent,
}) {
  const payload = payloadForRawVCard(uid, rawVCard);
  const requiresAbsent = expectedAbsent === true;
  const prepared = await withTransaction(async client => {
    const book = await readOwnedBook(client, userId, localAddressBookId);
    if (!book) throw typedError('Address book not found', 'ERR_ADDRESS_BOOK_NOT_FOUND');
    const existing = await readContact(client, userId, { localAddressBookId, uid });
    if (existing && requiresAbsent) {
      throw typedError('The contact already exists', 'ERR_LOCAL_PRECONDITION_FAILED');
    }
    if (existing) throw typedError('Contact already exists', 'ERR_CONTACT_EXISTS');
    const integration = await readIntegration(client, userId);
    if (!integration) {
      return {
        local: await createLocal(
          client,
          userId,
          localAddressBookId,
          payload,
          requiresAbsent,
        ),
      };
    }
    return {
      integration,
      connectionGeneration: integration.config.connectionGeneration ?? null,
      uid,
      expectedAbsent: requiresAbsent,
    };
  });
  if (prepared.local) return prepared.local;
  const { books, creds } = await discoverCreateContext(userId, prepared.integration);
  const selected = selectedCreateBook(books);
  return remoteCreate({
    userId,
    preflight: prepared,
    localAddressBookId,
    book: selected,
    payload,
    creds,
  });
}

export async function replaceContactFromVCard(userId, {
  localAddressBookId,
  uid,
  rawVCard,
  expectedLocalEtag,
}) {
  const clientPayload = payloadForRawVCard(uid, rawVCard);
  let localResult;
  const prepared = await withTransaction(async client => {
    const integration = await readIntegration(client, userId);
    if (integration) assertRetryEligible(integration, 'update');
    const contact = await readContact(client, userId, { localAddressBookId, uid });
    if (!contact) throw typedError('Contact not found', 'ERR_CONTACT_NOT_FOUND');
    if (contact.etag !== expectedLocalEtag) {
      throw typedError('The local contact changed', 'ERR_LOCAL_ETAG_MISMATCH');
    }
    if (!integration || !contact.href) {
      // Unmapped/local-only: the client's document is the complete resource.
      localResult = await updateLocal(client, userId, contact, clientPayload, expectedLocalEtag);
      return null;
    }
    assertWritable(contact, 'update');
    // Mapped: two-tier merge. Modeled fields are full-state from the client;
    // unmodeled properties merge by name (present-wins, absent survives); the remote UID
    // is preserved. The route requires a conditional (If-Match) request for this path.
    const payload = mergedReplacePayload(clientPayload.document, retainedEditDocument(contact));
    return prepareMappedMutation(client, userId, integration, contact, 'update', payload);
  });
  return prepared ? mappedUpdate(userId, prepared, prepared.payload) : localResult;
}

export async function deleteContactFromVCard(userId, {
  localAddressBookId,
  uid,
  expectedLocalEtag,
}) {
  let localResult;
  const prepared = await withTransaction(async client => {
    const integration = await readIntegration(client, userId);
    if (integration) assertRetryEligible(integration, 'delete');
    const contact = await readContact(client, userId, { localAddressBookId, uid });
    if (!contact) throw typedError('Contact not found', 'ERR_CONTACT_NOT_FOUND');
    if (contact.etag !== expectedLocalEtag) {
      throw typedError('The local contact changed', 'ERR_LOCAL_ETAG_MISMATCH');
    }
    if (!integration || !contact.href) {
      localResult = await deleteLocal(client, userId, contact, expectedLocalEtag);
      return null;
    }
    assertWritable(contact, 'delete');
    return prepareMappedMutation(client, userId, integration, contact, 'delete');
  });
  return prepared ? mappedDelete(userId, prepared) : localResult;
}
