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
  claimBestWriteTargetCandidate,
  persistDiscoveredBook,
  refreshUnresolvedConflict,
  removeLookupObjects,
  upsertLookupObjects,
} from './carddavMappingState.js';
import { normalizeEmail, planAutomaticProjection } from './carddavProjection.js';

const DEFAULT_INTERVAL_MIN = 60;
const CONFLICT_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CONFLICT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const timers = new Map();   // userId -> interval id
let conflictCleanupTimer;
const syncing = new Set();  // userIds with a sync in flight (prevents overlap)
const activeSyncGenerations = new Map();
// userIds whose in-flight sync cannot be trusted to reflect a change that landed
// while it ran, so it must be re-run once it settles (see requestCarddavSync).
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

// Per-book summary for the integrations UI: role flags, observed write
// capabilities, and how many rows each book contributes (materialized
// contacts vs. ledger-only lookup rows). Read-only — role changes go through
// patchCarddavBookRoles (PATCH /api/carddav/books/:id).
//
// lookup_count answers "how many senders does this book resolve", so it is
// scoped exactly like the inbound probes (carddavLookupService's
// LOOKUP_LEDGER_SOURCE / messageService): ledger rows of an is_lookup_source
// book. An ignored book's ledger rows resolve nothing — they are dropped on its
// next sync (see dropIgnoredBookLedger) — so counting them would render the
// book as "N for lookup" while it looks up nobody.
export async function getCarddavBookSummaries(userId) {
  const { rows } = await query(
    `SELECT
       b.id, b.name, b.external_url,
       b.is_write_target, b.is_subscribed, b.is_lookup_source,
       b.remote_create_capability, b.remote_update_capability, b.remote_delete_capability,
       b.updated_at,
       (SELECT count(*)::int FROM contacts c
          WHERE c.address_book_id = b.id) AS materialized_count,
       CASE WHEN b.is_lookup_source
         THEN (SELECT count(*)::int FROM carddav_remote_objects o
                 WHERE o.address_book_id = b.id AND o.mapping_status = 'lookup')
         ELSE 0
       END AS lookup_count
     FROM address_books b
     WHERE b.user_id = $1 AND b.source = 'carddav'
     ORDER BY b.created_at, b.id`,
    [userId],
  );

  return rows.map(row => ({
    id: row.id,
    name: row.name,
    externalUrl: row.external_url,
    isWriteTarget: row.is_write_target,
    isSubscribed: row.is_subscribed,
    isLookupSource: row.is_lookup_source,
    capabilities: {
      create: row.remote_create_capability,
      update: row.remote_update_capability,
      delete: row.remote_delete_capability,
    },
    materializedCount: row.materialized_count,
    lookupCount: row.lookup_count,
    lastSyncAt: row.updated_at ? row.updated_at.toISOString() : null,
  }));
}

function bookRoleError(message, code) {
  return Object.assign(new Error(message), { code });
}

// When a subscribed book is unsubscribed, its materialized contacts leave the
// list and its ledger rows are retained for lookup only. Capture each row's
// display name from the linked contact first (so the ledger keeps a name for
// inbound resolution), then drop the local link and any pending push intent —
// a lookup book is read-only from MailFlow — before deleting the now-orphaned
// contacts and any conflicts (a lookup book produces none). Mirrors the sync's
// applyLookupBookProjection end state without waiting for the next pull.
async function demoteSubscribedBookToLookup(client, userId, bookId) {
  await client.query(
    `UPDATE carddav_remote_objects o
     SET lookup_display_name = COALESCE(o.lookup_display_name, c.display_name)
     FROM contacts c
     WHERE o.address_book_id = $1 AND o.local_contact_id = c.id`,
    [bookId],
  );
  await client.query(
    `UPDATE carddav_remote_objects SET
       mapping_status = 'lookup',
       local_contact_id = NULL,
       local_contact_hash = NULL,
       pending_operation = NULL, pending_vcard = NULL, pending_local_hash = NULL,
       pending_remote_semantic_hash = NULL, pending_started_at = NULL,
       mapping_revision = mapping_revision + 1,
       updated_at = NOW()
     WHERE address_book_id = $1 AND mapping_status <> 'lookup'`,
    [bookId],
  );
  await client.query(
    'DELETE FROM contacts WHERE user_id = $1 AND address_book_id = $2',
    [userId, bookId],
  );
  await client.query(
    'DELETE FROM carddav_conflicts WHERE address_book_id = $1',
    [bookId],
  );
}

// Force the next sync to re-pull a book in full, by clearing its incremental
// sync token (the same reset invalidateCarddavBookIdentity uses on a re-connect).
// The pull's projection is not this function's business — the sync reads the
// book's live roles for that — only that an incremental delta cannot get the
// book's rows to where its new roles need them, so the whole collection must be
// re-fetched. Both role transitions that owe a book a full pull use it:
//  - into subscribed: a lookup book's retained ledger rows carry local_contact_id
//    = NULL, so an incremental delta would skip them; a full pull re-imports every
//    remote object and converts the lookup rows into materialized contacts.
//  - out of ignored: the book's ledger was dropped (dropIgnoredBookLedger) while
//    the token that would resume from it survived, so an incremental delta would
//    report no changes and leave the book lookup-on with an empty ledger forever.
// Clearing the token alone would not do: remote_sync_capability is reset with it
// (the dropped ledger makes the stored capability's incremental path meaningless)
// and the revision bump fences any pull still in flight against the new roles.
async function scheduleFullReconcile(client, bookId) {
  await client.query(
    `UPDATE address_books SET
       remote_sync_token = NULL,
       remote_sync_capability = 'unknown',
       remote_sync_revision = remote_sync_revision + 1,
       remote_projection_fingerprint = NULL,
       updated_at = NOW()
     WHERE id = $1`,
    [bookId],
  );
}

// Apply a role change to one of a user's carddav books, fenced against the
// connection generation the caller observed (a concurrent disconnect/reconnect
// between the caller's config read and this transaction is rejected). The three
// independent decisions, resolved in one transaction:
//  - makeWriteTarget: validates the book is create-capable, then atomically
//    clears any existing write-target for the user and sets this one, forcing
//    isSubscribed = true (write-target implies subscribed — the row CHECK);
//  - isSubscribed=false: rejected for the write-target; otherwise removes the
//    book's materialized contacts and demotes its ledger rows to lookup;
//  - isSubscribed=true (from a non-subscribed state): schedules a full reconcile
//    on the next sync, which materializes the book;
//  - isLookupSource toggles the lookup axis (both flags false = ignored: the
//    book is skipped at the network layer and its retained ledger rows are
//    dropped on the next sync — see dropIgnoredBookLedger). Re-enabling either
//    role on an ignored book schedules that full reconcile too, to rebuild the
//    ledger the drop took.
// Returns the affected book's id; the caller re-reads the per-book summaries.
export async function patchCarddavBookRoles(userId, bookId, patch, expectedGeneration) {
  const { isSubscribed, isLookupSource, makeWriteTarget } = patch || {};
  if (makeWriteTarget === undefined && isSubscribed === undefined && isLookupSource === undefined) {
    throw bookRoleError('No CardDAV book role change was provided', 'ERR_CARDDAV_BOOK_PATCH_EMPTY');
  }
  return withTransaction(async client => {
    const integration = await lockCarddavIntegration(client, userId);
    if (!integration?.config?.serverUrl) {
      throw new StaleCarddavPlanError({ reason: 'not-connected' });
    }
    const actualGeneration = integration.config?.connectionGeneration ?? null;
    if (expectedGeneration !== undefined && actualGeneration !== expectedGeneration) {
      throw new StaleCarddavPlanError({
        reason: 'connection-generation-changed',
        expectedConnectionGeneration: expectedGeneration,
        actualConnectionGeneration: actualGeneration,
      });
    }
    const { rows: [book] } = await client.query(
      `SELECT id, is_write_target, is_subscribed, is_lookup_source, remote_create_capability
       FROM address_books
       WHERE id = $1 AND user_id = $2 AND source = 'carddav'
       FOR UPDATE`,
      [bookId, userId],
    );
    if (!book) throw bookRoleError('CardDAV address book not found', 'ERR_ADDRESS_BOOK_NOT_FOUND');

    let nextWriteTarget = book.is_write_target;
    let nextSubscribed = book.is_subscribed;
    let nextLookup = book.is_lookup_source;

    if (makeWriteTarget === true) {
      if (book.remote_create_capability === 'denied') {
        throw bookRoleError(
          'This CardDAV address book cannot be a write-target because it does not allow create',
          'ERR_CARDDAV_READ_ONLY',
        );
      }
      nextWriteTarget = true;
      nextSubscribed = true;
    }
    if (isSubscribed === true) nextSubscribed = true;
    if (isSubscribed === false) {
      if (nextWriteTarget) {
        throw bookRoleError(
          'The CardDAV write-target book must stay subscribed',
          'ERR_CARDDAV_WRITE_TARGET_SUBSCRIBED',
        );
      }
      nextSubscribed = false;
    }
    if (isLookupSource === true) nextLookup = true;
    if (isLookupSource === false) nextLookup = false;

    // Atomic write-target swap: clear the current holder before setting this
    // one, so the one-write-target partial unique index never sees two rows
    // (mirrors JMAP's onSuccessSetIsDefault — no window with two/zero targets).
    //
    // The outgoing holder keeps any open pending push intent, deliberately. An
    // intent is a record that one PUT/DELETE was *already issued* and its
    // acknowledgement lost, so it must be observed, never replayed and never
    // dropped: the next sync's recovery pass reads the resource back (see
    // recoverPendingCarddavMutations — read-only, recoveryOnly) and either
    // confirms the write or raises a conflict. Clearing intents here would
    // discard an un-acknowledged local edit with neither a push nor a conflict.
    // The book becoming a subscribed secondary does not weaken that: every
    // write site re-reads is_write_target live (assertWritable, selectedCreateBook,
    // resolveConflict's keep-mailflow guard), so nothing writes to it again.
    if (makeWriteTarget === true && !book.is_write_target) {
      await client.query(
        `UPDATE address_books SET is_write_target = false, updated_at = NOW()
         WHERE user_id = $1 AND source = 'carddav' AND is_write_target = true AND id <> $2`,
        [userId, bookId],
      );
    }
    if (book.is_subscribed && !nextSubscribed) {
      await demoteSubscribedBookToLookup(client, userId, bookId);
    }
    // Both transitions that leave the book's rows short of what its new roles
    // need: gaining subscribed (its ledger rows are unmaterialized) and leaving
    // ignored (its ledger was dropped). Either way an incremental delta cannot
    // fill the gap — see scheduleFullReconcile.
    const wasIgnored = !book.is_subscribed && !book.is_lookup_source;
    const nowIgnored = !nextSubscribed && !nextLookup;
    if ((!book.is_subscribed && nextSubscribed) || (wasIgnored && !nowIgnored)) {
      await scheduleFullReconcile(client, bookId);
    }
    await client.query(
      `UPDATE address_books SET
         is_write_target = $2, is_subscribed = $3, is_lookup_source = $4, updated_at = NOW()
       WHERE id = $1`,
      [bookId, nextWriteTarget, nextSubscribed, nextLookup],
    );
    return bookId;
  });
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
    for (const field of ['serverUrl', 'username', 'password', 'intervalMin', 'publishEmailedContacts']) {
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

// Match a persisted/locked book row to a URL a fresh discovery returned, by
// either its canonical external_url or the discovery_alias_url a
// redirect-reconciling server may still advertise for a collection whose
// external_url was already rewritten to its canonical form (see
// advanceDiscoveredBookState in carddavMappingState.js). This is the same
// external_url-OR-discovery_alias_url resolution the sync-planning join
// (prepareBookPlan), role loading (loadCarddavBookRoles), and write-target
// routing (selectedCreateBook) use, so an already-canonicalized book resolves
// consistently no matter which URL discovery reports. discovery_alias_url is
// absent on a not-yet-migrated (transitional) schema; a row that lacks it
// simply falls back to external_url matching.
function matchBookByDiscoveryUrl(rows, url) {
  if (url == null) return null;
  return rows.find(row => (
    row.external_url === url || row.discovery_alias_url === url
  )) ?? null;
}

// discovery_alias_url is added by migration 0034. A sync running on a
// not-yet-migrated (transitional) schema must still resolve books by
// external_url alone, so the alias-aware SELECT runs under a SAVEPOINT: an
// undefined_column (42703) rolls back only this statement, not the caller's
// whole sync transaction, then the external_url-only variant is retried.
// Mirrors advanceDiscoveredBookState's guard.
async function selectWithAliasColumnFallback(client, aliasSql, plainSql, params) {
  await client.query('SAVEPOINT carddav_alias_column_read');
  try {
    const result = await client.query(aliasSql, params);
    await client.query('RELEASE SAVEPOINT carddav_alias_column_read');
    return result;
  } catch (error) {
    if (error?.code !== '42703') throw error;
    await client.query('ROLLBACK TO SAVEPOINT carddav_alias_column_read');
    await client.query('RELEASE SAVEPOINT carddav_alias_column_read');
    return client.query(plainSql, params);
  }
}

// Lock the persisted rows for the URLs a fresh discovery reported. When the
// schema carries discovery_alias_url (migration 0034 — the caller probes once
// via the integration query's EXISTS check rather than paying a per-book
// SAVEPOINT on this hot path), also match a row a redirect-reconciling server
// still surfaces under its alias, whose external_url was already rewritten to
// canonical. On a not-yet-migrated (transitional) schema, hasDiscoveryAlias is
// false and the lock resolves by external_url alone, exactly as before.
async function lockCarddavBooks(client, userId, urls, hasDiscoveryAlias) {
  const result = await client.query(
    hasDiscoveryAlias
      ? `SELECT id, external_url, discovery_alias_url, remote_sync_token,
                remote_sync_revision::text, sync_token, remote_projection_fingerprint
         FROM address_books
         WHERE user_id = $1 AND source = 'carddav'
           AND (external_url = ANY($2::text[]) OR discovery_alias_url = ANY($2::text[]))
         ORDER BY id
         FOR UPDATE`
      : `SELECT id, external_url, remote_sync_token, remote_sync_revision::text, sync_token,
                remote_projection_fingerprint
         FROM address_books
         WHERE user_id = $1 AND source = 'carddav' AND external_url = ANY($2::text[])
         ORDER BY id
         FOR UPDATE`,
    [userId, urls],
  );
  return result.rows;
}

async function createCarddavBook(client, userId, book) {
  // Defer the write-target claim: syncUser persists every book of a single
  // discovery snapshot individually, each in its own transaction, so ranking
  // per book here (in discovery order) could let an earlier, worse-ranked
  // book keep the flag ahead of a later, better one from the very same
  // batch. syncUser claims once, after every book has been persisted (see
  // claimBestWriteTargetCandidate in carddavMappingState.js).
  return persistDiscoveredBook(client, { userId, ...book, deferWriteTargetClaim: true });
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

// Advance a pulled book's discovery state (sync token, capability, projection
// fingerprint, canonical URL) after its projection — materializing or
// lookup-only — has been applied. Shared by both branches so the alias-replace
// SAVEPOINT dance and the canonical-url-conflict / book-update-missed fences
// stay identical for a lookup book and a subscribed one.
async function advanceProjectedBookState(client, {
  plan, book, fingerprint, replacingAlias, canonicalUrl, identity,
}) {
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
  await advanceProjectedBookState(client, {
    plan, book, fingerprint, replacingAlias, canonicalUrl, identity,
  });
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

// Post-delta ledger size of a lookup book, so an incremental sync can report
// the book's remote count without reading and locking every row (see
// applyLookupBookProjection). A single lock-free count(); no per-row data.
async function countLookupObjects(client, addressBookId) {
  const { rows: [row] } = await client.query(
    'SELECT count(*)::int AS count FROM carddav_remote_objects WHERE address_book_id = $1',
    [addressBookId],
  );
  return row?.count ?? 0;
}

// Lookup-only projection for an is_lookup_source && !is_subscribed book: pull
// the same incremental delta but retain each remote object as a ledger row
// (mapping_status='lookup', local_contact_id=NULL) for inbound-sender
// resolution instead of materializing a local contact. This is the core split
// of pull-from-materialize — no materializeAutomaticImport, no local
// export-candidate claiming, no conflict creation, and the materialized
// footprint (lockEligibleTargetBooks / validateProjectionFootprint) is never
// touched, so a lookup book contributes zero rows to the contacts list.
async function applyLookupBookProjection(client, {
  plan, integrationRow, book, replacingAlias, canonicalUrl, identity,
}) {
  const incomingByHref = new Map(plan.upserts.map(remote => [remote.href, remote]));
  const removedHrefs = new Set(plan.removedHrefs);

  // A full-snapshot (replaceAll) sync must reconcile against every existing
  // ledger row to tombstone the ones the server dropped, so it reads and locks
  // them all. An incremental delta only ever names the hrefs it touches, so it
  // locks just those — never the whole (potentially very large) lookup book —
  // and derives the post-sync total with a single lock-free count() below.
  const deltaHrefs = [...incomingByHref.keys(), ...removedHrefs];
  const { rows: lockedRows } = plan.replaceAll
    ? await client.query(
      `SELECT href, remote_etag, remote_semantic_hash, mapping_status
       FROM carddav_remote_objects
       WHERE address_book_id = $1
       ORDER BY href
       FOR UPDATE`,
      [book.id],
    )
    : await client.query(
      `SELECT href, remote_etag, remote_semantic_hash, mapping_status
       FROM carddav_remote_objects
       WHERE address_book_id = $1 AND href = ANY($2::text[])
       ORDER BY href
       FOR UPDATE`,
      [book.id, deltaHrefs],
    );
  const existingByHref = new Map(lockedRows.map(row => [row.href, row]));

  const tombstoneHrefs = lockedRows
    .filter(row => (
      removedHrefs.has(row.href) || (plan.replaceAll && !incomingByHref.has(row.href))
    ))
    .map(row => row.href);
  const removedResult = await removeLookupObjects(client, {
    addressBookId: book.id,
    hrefs: tombstoneHrefs,
  });
  const removed = removedResult.rowCount || 0;

  const changes = [];
  let added = 0;
  for (const remote of plan.upserts) {
    const document = parseVCardDocument(remote.vcard);
    const remoteSemanticHash = semanticVCardHash(document);
    const vcardVersion = document.version === '3.0' || document.version === '4.0'
      ? document.version
      : null;
    const existing = existingByHref.get(remote.href);
    if (!existing) added++;
    const unchanged = existing
      && existing.mapping_status === 'lookup'
      && existing.remote_semantic_hash === remoteSemanticHash
      && existing.remote_etag === (remote.remoteEtag ?? null);
    if (unchanged) continue;
    changes.push({
      addressBookId: book.id,
      href: remote.href,
      remoteEtag: remote.remoteEtag ?? null,
      vcard: remote.vcard,
      primaryEmail: remote.contact?.primaryEmail ?? null,
      vcardVersion,
      remoteSemanticHash,
      lookupDisplayName: remote.contact?.displayName ?? null,
    });
  }
  const updated = await upsertLookupObjects(client, changes);

  // An upsert href is always in the incoming set, so it is never tombstoned:
  // the count moves by (rows added) − (rows tombstoned) regardless of how many
  // untouched rows the book holds. replaceAll locked every row, so it totals
  // them in memory; an incremental delta counts once, without a full lock.
  const contactCountDelta = added - tombstoneHrefs.length;
  const remote = plan.replaceAll
    ? lockedRows.length - tombstoneHrefs.length + added
    : await countLookupObjects(client, book.id);

  await advanceProjectedBookState(client, {
    plan, book, fingerprint: projectionFingerprint([]), replacingAlias, canonicalUrl, identity,
  });
  const totalContactCount = await persistCarddavContactCount(client, integrationRow, plan.userId);
  return {
    bookId: book.id,
    count: remote,
    changedBookIds: [],
    ledgerChanged: updated > 0 || removed > 0,
    updated,
    removed,
    contactCount: remote,
    contactCountDelta,
    totalContactCount,
    completeReclassification: true,
    remote,
    exports: [],
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
            EXISTS (
              SELECT 1
              FROM information_schema.columns
              WHERE table_schema = current_schema()
                AND table_name = 'address_books'
                AND column_name = 'discovery_alias_url'
            ) AS has_discovery_alias,
            EXISTS (
              SELECT 1
              FROM information_schema.columns
              WHERE table_schema = current_schema()
                AND table_name = 'address_books'
                AND column_name = 'is_subscribed'
            ) AS has_book_roles,
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
  const lockedBooks = await lockCarddavBooks(
    client, plan.userId, bookUrls, integrationRow.has_discovery_alias === true,
  );
  // Resolve the row by the observed URL first (its external_url on a first
  // canonicalization, or its discovery_alias_url once already canonicalized),
  // then by the canonical URL — which is a book's external_url after an earlier
  // rewrite, so an already-canonicalized book seen again via its alias resolves
  // even on a transitional schema whose locked rows carry no discovery_alias_url.
  let book = matchBookByDiscoveryUrl(lockedBooks, plan.book.url);
  if (!book && replacingAlias) {
    book = matchBookByDiscoveryUrl(lockedBooks, canonicalUrl);
  }
  if (!book && replacingAlias) {
    throw new StaleCarddavPlanError({
      reason: 'observed-alias-missing',
      observedUrl: identity.observedUrl,
    });
  }
  if (!book) book = await createCarddavBook(client, plan.userId, plan.book);
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

  // A lookup-only book never touches the materialized footprint, so it neither
  // locks the eligible target books nor validates against them. syncUser sets
  // plan.materialize from the book's stored roles; an unset flag (direct
  // applyBookDelta callers, and pre-multi-book schemas where roles cannot be
  // read) defaults to the materializing projection, preserving legacy behavior.
  //
  // That role snapshot was taken before the (possibly slow) network pull, so
  // re-read the book's live is_subscribed under the row lock this transaction
  // now holds: patchCarddavBookRoles serializes on the same user_integrations
  // FOR UPDATE lock, so this reflects any role change that committed while the
  // pull was in flight. Honoring it keeps an unsubscribe that raced this pull
  // from re-materializing the very contacts it just removed (its demote does
  // not rotate the token/revision fences), and lets a raced subscribe
  // materialize. Only when syncUser set plan.materialize on a schema that has
  // the role columns; direct callers and pre-multi-book schemas keep the plan's
  // own decision.
  let materialize = plan.materialize !== false;
  if (plan.materialize !== undefined && integrationRow.has_book_roles) {
    const { rows: [role] } = await client.query(
      'SELECT is_subscribed FROM address_books WHERE id = $1',
      [book.id],
    );
    if (role) materialize = role.is_subscribed;
  }
  if (!materialize) {
    return applyLookupBookProjection(client, {
      plan,
      integrationRow,
      book,
      replacingAlias,
      canonicalUrl,
      identity,
    });
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

// The sync-planning join. Resolve the discovered book's stored sync state by
// its canonical external_url OR the discovery_alias_url a redirect-reconciling
// server may still advertise (same resolution as matchBookByDiscoveryUrl /
// selectedCreateBook), so an already-canonicalized book keeps its incremental
// sync token instead of re-pulling in full and then failing the apply step's
// alias check. Runs on the pool (autocommit), so a plain try/catch — no
// SAVEPOINT — recovers a not-yet-migrated (transitional) schema that lacks
// discovery_alias_url by retrying the external_url-only join.
async function loadCurrentBookState(userId, bookUrl) {
  const selectClause =
    `SELECT remote_sync_token, remote_sync_capability, remote_sync_revision,
            connection_generation, book_id
     FROM (
       SELECT b.id AS book_id, b.remote_sync_token, b.remote_sync_capability,
              b.remote_sync_revision::text,
              ui.config->>'connectionGeneration' AS connection_generation
       FROM user_integrations ui
       LEFT JOIN address_books b
         ON b.user_id = ui.user_id AND b.source = 'carddav'`;
  const tail =
    `
       WHERE ui.user_id = $1 AND ui.provider = 'carddav'
     ) current_book`;
  try {
    return await query(
      `${selectClause} AND (b.external_url = $2 OR b.discovery_alias_url = $2)${tail}`,
      [userId, bookUrl],
    );
  } catch (error) {
    if (error?.code !== '42703') throw error;
    return query(`${selectClause} AND b.external_url = $2${tail}`, [userId, bookUrl]);
  }
}

export async function prepareBookPlan(userId, book, creds) {
  const current = await loadCurrentBookState(userId, book.url);
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
  const { rows: books } = await selectWithAliasColumnFallback(
    client,
    `SELECT id, source, external_url, discovery_alias_url, sync_token
     FROM address_books
     WHERE user_id = $1
     ORDER BY id
     FOR UPDATE`,
    `SELECT id, source, external_url, sync_token
     FROM address_books
     WHERE user_id = $1
     ORDER BY id
     FOR UPDATE`,
    [userId],
  );

  // A carddav book is stale only when neither URL discovery might report for it
  // — its canonical external_url nor the discovery_alias_url a redirect server
  // keeps advertising — was seen this sync. Matching external_url alone would
  // reconcile away an ignored/subscribed book whose row was already rewritten
  // to canonical but that discovery still surfaces under its alias. A row with
  // no discovery_alias_url (never canonicalized, or transitional schema) falls
  // back to external_url matching. seenUrls never contains null/undefined.
  const seen = new Set(seenUrls);
  const staleBookIds = books
    .filter(book => book.source === 'carddav'
      && !seen.has(book.external_url)
      && !seen.has(book.discovery_alias_url))
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
  const staleBookIds = await reconcileStaleCarddavBooks(client, userId, { seenUrls });
  if (staleBookIds.length) await claimBestWriteTargetCandidate(client, userId);
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

// Load each of a user's carddav books' stored roles, keyed by both its
// canonical external_url and (if present) the discovery alias a fresh
// PROPFIND may still advertise, so a snapshot book resolves by whichever URL
// discovery returns. Returns null on a pre-multi-book schema (undefined_column
// SQLSTATE), signalling syncUser to fall back to the legacy "materialize every
// discovered book" behavior.
async function loadCarddavBookRoles(userId) {
  let rows;
  try {
    ({ rows } = await query(
      `SELECT id, external_url, discovery_alias_url,
              is_write_target, is_subscribed, is_lookup_source
       FROM address_books
       WHERE user_id = $1 AND source = 'carddav'`,
      [userId],
    ));
  } catch (error) {
    if (error?.code === '42703') return null;
    throw error;
  }
  const roles = new Map();
  for (const row of rows) {
    const role = {
      id: row.id,
      externalUrl: row.external_url,
      isWriteTarget: row.is_write_target,
      isSubscribed: row.is_subscribed,
      isLookupSource: row.is_lookup_source,
    };
    if (row.external_url) roles.set(row.external_url, role);
    if (row.discovery_alias_url) roles.set(row.discovery_alias_url, role);
  }
  return roles;
}

// How a discovered book should be pulled this sync, from its stored roles:
//  - 'ignored'     (both flags false) — skipped at the network layer entirely;
//  - 'materialize' (subscribed)       — pulled into the contacts list as today;
//  - 'lookup'      (lookup-only, or a freshly discovered book that defaults to
//                   lookup-only, or a first-connect book that is not the
//                   resolved write-target) — pulled into the ledger only.
// A null roles map (pre-multi-book schema) always materializes, preserving
// legacy behavior. A book unknown to the map is being discovered for the first
// time: it materializes only if it is the resolved write-target-to-be (see
// resolveWriteTargetUrl), otherwise it defaults to lookup-only.
function bookProjectionKind(roles, url, writeTargetUrl) {
  if (roles === null) return 'materialize';
  const role = roles.get(url);
  if (role) {
    if (!role.isSubscribed && !role.isLookupSource) return 'ignored';
    return role.isSubscribed ? 'materialize' : 'lookup';
  }
  return url === writeTargetUrl ? 'materialize' : 'lookup';
}

// An ignored book is never pulled again, so whatever its last pull left in the
// ledger is frozen there: rows that resolve no inbound sender (every lookup
// probe joins on is_lookup_source) yet still count toward the cached
// contactCount. Drop them on the first sync after the book was ignored — the
// design's "its ledger rows are dropped on the next sync and it is skipped
// thereafter" — and hand the cached count back the rows it no longer holds.
// Idempotent: every later sync of that book deletes nothing.
//
// The ledger only. The book's materialized contacts and conflicts are already
// gone (patchCarddavBookRoles demotes a subscribed book on the way to ignored),
// and the book row itself survives so its ignored roles are not reconciled away
// and re-discovered as lookup-only.
//
// The caller's 'ignored' classification comes from the role snapshot syncUser
// took before its (possibly slow) network pulls, so re-read the book's live
// roles under the user_integrations lock this transaction now holds — exactly as
// the materializing branch of applyBookDelta does. patchCarddavBookRoles
// serializes on that same lock, so a Look-up-senders (or Subscribe) toggle that
// committed while the pull was in flight is visible here, and dropping on the
// stale decision would wipe the ledger the user just re-enabled. Skipping the
// drop is all this owes such a book: the patch that re-enabled it scheduled its
// full re-pull (scheduleFullReconcile) and its route queued the uncoalesced
// follow-up sync that runs it.
async function dropIgnoredBookLedger(client, userId, bookId) {
  const { rows: [integration] } = await client.query(
    `SELECT id, config->>'contactCount' AS contact_count
     FROM user_integrations
     WHERE user_id = $1 AND provider = 'carddav'
     FOR UPDATE`,
    [userId],
  );
  if (!integration) throw new StaleCarddavPlanError({ reason: 'not-connected' });
  const { rows: [role] } = await client.query(
    'SELECT is_subscribed, is_lookup_source FROM address_books WHERE id = $1',
    [bookId],
  );
  if (!role || role.is_subscribed || role.is_lookup_source) return 0;
  const dropped = await client.query(
    'DELETE FROM carddav_remote_objects WHERE address_book_id = $1',
    [bookId],
  );
  if (!dropped.rowCount) return 0;
  await persistCarddavContactCount(client, integration, userId);
  return dropped.rowCount;
}

// When none of the currently discovered books is already the write-target,
// resolve the one that will become it, so it materializes (and is inserted
// subscribed) in this very sync rather than one sync late. Covers a fresh first
// connect (no books yet) and a connection replacement (a new server's books
// replace an old write-target that this same sync will reconcile away). Ranks
// the discovery snapshot exactly as the batch-wide claimBestWriteTargetCandidate
// will once the rows exist — create 'allowed' before 'unknown', then discovery
// order, and never a book the user ignored — so the book we materialize and the
// book the claim flags as the write-target are always the same one. Returns null
// when a discovered book already holds the write-target (its stored role drives
// materialization) or when no discovered book is an eligible candidate.
function resolveWriteTargetUrl(roles, books) {
  if (roles === null) return null;
  if (books.some(book => roles.get(book.url)?.isWriteTarget)) return null;
  const ranked = books
    .filter(book => {
      const role = roles.get(book.url);
      if (role && !role.isSubscribed && !role.isLookupSource) return false;
      return (book.capabilities?.create ?? 'unknown') !== 'denied';
    })
    .sort((left, right) => (
      (right.capabilities?.create === 'allowed' ? 1 : 0)
        - (left.capabilities?.create === 'allowed' ? 1 : 0)
      || Number(left.discoveryIndex ?? 0) - Number(right.discoveryIndex ?? 0)
    ));
  return ranked[0]?.url ?? null;
}

// The export sweep only ever has somewhere to send a contact when the user has
// designated a write-target book; skip the whole sweep (not just each write)
// when none is configured, rather than recomputing and recording the same
// ERR_CARDDAV_NO_WRITE_TARGET failure for every unmapped explicit contact. On a
// not-yet-migrated (transitional) schema — detected via PostgreSQL's
// undefined_column SQLSTATE, see carddavContactService.js's isUndefinedColumn —
// run the sweep unconditionally exactly as it did before this gate existed.
async function hasWriteTargetBook(userId) {
  let rows;
  try {
    ({ rows } = await query(
      `SELECT 1 FROM address_books
       WHERE user_id = $1 AND source = 'carddav' AND is_write_target = true
       LIMIT 1`,
      [userId],
    ));
  } catch (error) {
    if (error?.code === '42703') return true;
    throw error;
  }
  return rows.length > 0;
}

// The contacts the sweep publishes to the write-target book.
//
// is_auto = false is necessary but not sufficient. send.js flips it for anyone
// the user emails (and search.js ranks autocomplete on it, so it stays), which
// would make a reply to a harvested sender enough to publish them to a shared
// address book. Publication additionally requires carddav_publish_intent — set
// only by a deliberate act: creating the contact, or promoting it.
//
// `publishEmailedContacts` is the user's opt-in to the other reading, where
// emailing someone *is* the act of adding them (the "Email contacts book"
// workflow): it re-admits the explicit-but-unintended contacts, and nothing else
// — a merely harvested contact (is_auto = true) is still never published.
async function unmappedExplicitContactIds(userId, publishEmailedContacts) {
  let rows;
  try {
    ({ rows } = await query(
      `SELECT c.id
       FROM contacts c
       WHERE c.user_id = $1 AND c.is_auto = false
         AND (c.carddav_publish_intent = true OR $2 = true)
         AND NOT EXISTS (
           SELECT 1 FROM carddav_remote_objects mapping
           WHERE mapping.local_contact_id = c.id
         )
       ORDER BY c.id`,
      [userId, publishEmailedContacts === true],
    ));
  } catch (error) {
    if (error?.code !== '42703') throw error;
    ({ rows } = await query(
      `SELECT c.id
       FROM contacts c
       WHERE c.user_id = $1 AND c.is_auto = false
         AND NOT EXISTS (
           SELECT 1 FROM carddav_remote_objects mapping
           WHERE mapping.local_contact_id = c.id
         )
       ORDER BY c.id`,
      [userId],
    ));
  }
  return rows.map(row => row.id);
}

// Start a sync, or — when one is already in flight — decide whether it stands in
// for the requested one. It does when the caller's change *is* the new connection
// generation (connect, credential patch): the in-flight sync already reads it, or
// it is running against the superseded generation and gets queued for replacement.
// Callers whose change leaves the generation untouched (a book role patch) cannot
// know whether the in-flight sync read it before or after its own book loop passed
// that book, so they pass `coalesce: false` to always queue a follow-up rather than
// risk dropping the pull-side effect until the next scheduled tick.
export function requestCarddavSync(userId, connectionGeneration, { coalesce = true } = {}) {
  if (syncing.has(userId)) {
    if (!coalesce || activeSyncGenerations.get(userId) !== connectionGeneration) {
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

    // Resolve each discovered book's role before pulling. Ignored books (both
    // flags false) are skipped at the network layer entirely; subscribed books
    // materialize and lookup-only books populate the ledger only. A freshly
    // discovered book defaults to lookup-only unless it is the resolved
    // first-connect write-target, which materializes in this same sync.
    const roles = await loadCarddavBookRoles(userId);
    const writeTargetUrl = resolveWriteTargetUrl(roles, books);
    const plans = [];
    const plannedBooks = [];
    const ignoredUrls = [];
    for (const book of books) {
      const kind = bookProjectionKind(roles, book.url, writeTargetUrl);
      if (kind === 'ignored') {
        // A book only resolves to 'ignored' when it has a stored role, so its
        // row (id, externalUrl) is always known here.
        const role = roles.get(book.url);
        // Record the ignored book as seen by its persisted external_url, not the
        // discovery URL: a canonicalized book is stored under its canonical URL
        // while discovery keeps advertising the alias, and reconciliation
        // matches seen URLs against external_url. Using book.url here would let
        // reconcileStaleCarddavBooks delete the ignored canonical row and the
        // next sync rediscover it fresh as lookup-only.
        ignoredUrls.push(role.externalUrl ?? book.url);
        await withTransaction(client => dropIgnoredBookLedger(client, userId, role.id));
        continue;
      }
      const plan = await prepareBookPlan(userId, book, creds);
      plan.materialize = kind === 'materialize';
      plan.book.subscribeOnCreate = book.url === writeTargetUrl;
      plans.push(plan);
      plannedBooks.push(book);
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
            plan = await prepareBookPlan(userId, plannedBooks[index], creds);
            plan.materialize = bookProjectionKind(
              roles, plannedBooks[index].url, writeTargetUrl,
            ) === 'materialize';
            plan.book.subscribeOnCreate = plannedBooks[index].url === writeTargetUrl;
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
    if (books.length) {
      // Rank the *whole* discovery snapshot at once, now that every book in
      // it has been persisted — not per book, in discovery order — so a
      // later 'allowed' book can still win the write-target over an earlier
      // 'unknown' one from the very same connect/sync batch (see
      // createCarddavBook's deferred claim above). Runs before the export
      // sweep below so a fresh multi-book connect's write-target is already
      // available to it in this same sync.
      await withTransaction(client => claimBestWriteTargetCandidate(client, userId));
    }
    const exportFailures = [];
    if (await hasWriteTargetBook(userId)) {
      const publishable = await unmappedExplicitContactIds(userId, config.publishEmailedContacts);
      for (const contactId of publishable) {
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
    }
    // Ignored books are not pulled but must still count as "seen" so the stale
    // reconciliation keeps their row (and its role flags) rather than deleting
    // it and re-discovering it fresh as lookup-only on the next sync.
    const seenUrls = [
      ...plans.map(plan => plan.collectionIdentity?.canonicalUrl ?? plan.book.url),
      ...ignoredUrls,
    ];
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
