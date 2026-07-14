export function typedError(message, code, details = {}) {
  return Object.assign(new Error(message), { code }, details);
}

export async function rotateBookToken(client, userId, addressBookId) {
  const result = await client.query(
    `UPDATE address_books
     SET sync_token = gen_random_uuid()::text, updated_at = NOW()
     WHERE id = $1 AND user_id = $2`,
    [addressBookId, userId],
  );
  return result.rowCount;
}

export const UNKNOWN_CARDDAV_CAPABILITIES = Object.freeze({
  create: 'unknown',
  update: 'unknown',
  delete: 'unknown',
});

export function normalizeCarddavCapabilities(capabilities) {
  return { ...UNKNOWN_CARDDAV_CAPABILITIES, ...(capabilities || {}) };
}

export async function lockCarddavIntegration(client, userId, { requireServerUrl = false } = {}) {
  const serverUrlFilter = requireServerUrl
    ? "AND NULLIF(config->>'serverUrl', '') IS NOT NULL"
    : '';
  const { rows: [integration] } = await client.query(
    `SELECT id, config
     FROM user_integrations
     WHERE user_id = $1 AND provider = 'carddav'
       ${serverUrlFilter}
     FOR UPDATE`,
    [userId],
  );
  return integration || null;
}

export function assertConflictSnapshotsWithinLimit({
  localVCard,
  remoteVCard,
  localTombstone = false,
  remoteTombstone = false,
}) {
  const bytes = (localTombstone ? 0 : Buffer.byteLength(localVCard, 'utf8'))
    + (remoteTombstone ? 0 : Buffer.byteLength(remoteVCard, 'utf8'));
  if (bytes > 2 * 1024 * 1024) {
    throw typedError(
      'CardDAV conflict snapshots exceed 2 MiB',
      'ERR_CARDDAV_CONFLICT_TOO_LARGE',
    );
  }
}

function requireExpectedRevision(change) {
  if (Object.hasOwn(change, 'expectedMappingRevision')
    && change.expectedMappingRevision !== undefined) return;
  throw typedError(
    'An expected CardDAV mapping revision is required',
    'ERR_CARDDAV_MAPPING_REVISION_REQUIRED',
  );
}

function staleResult(change) {
  return {
    ok: false,
    stale: true,
    code: 'ERR_CARDDAV_MAPPING_STALE',
    addressBookId: change.addressBookId,
    href: change.href,
    expectedMappingRevision: String(change.expectedMappingRevision),
  };
}

export async function lockCarddavMapping(client, { userId, addressBookId, href }) {
  const { rows: [mapping] } = await client.query(
    `SELECT mapping.*, contact.address_book_id AS local_address_book_id,
            contact.id AS contact_id
     FROM carddav_remote_objects mapping
     JOIN contacts contact ON contact.id = mapping.local_contact_id
     WHERE mapping.address_book_id = $1 AND mapping.href = $2
       AND contact.user_id = $3
     FOR UPDATE OF mapping, contact`,
    [addressBookId, href, userId],
  );
  return mapping || null;
}

export async function persistPendingMutationIntent(client, change) {
  requireExpectedRevision(change);
  if (change.operation !== 'update' && change.operation !== 'delete') {
    throw typedError('Invalid pending CardDAV operation', 'ERR_CARDDAV_PENDING_OPERATION');
  }
  if (!change.pendingLocalHash
    || (change.operation === 'update'
      && (!change.pendingVCard || !change.pendingRemoteSemanticHash))
    || (change.operation === 'delete'
      && (change.pendingVCard != null || change.pendingRemoteSemanticHash != null))) {
    throw typedError('Invalid pending CardDAV intent', 'ERR_CARDDAV_PENDING_INTENT');
  }
  if (change.pendingVCard
    && Buffer.byteLength(change.pendingVCard, 'utf8') > 1024 * 1024) {
    throw typedError(
      'Pending CardDAV vCard exceeds 1 MiB',
      'ERR_CARDDAV_PENDING_INTENT_TOO_LARGE',
    );
  }
  const mapping = await lockCarddavMapping(client, change);
  if (!mapping
    || String(mapping.mapping_revision) !== String(change.expectedMappingRevision)) {
    return staleResult(change);
  }
  if (mapping.pending_operation) {
    throw typedError(
      'A CardDAV mutation is already awaiting confirmation',
      'ERR_CARDDAV_PENDING_INTENT',
      { operation: mapping.pending_operation },
    );
  }
  const result = await client.query(
    `UPDATE carddav_remote_objects SET
       mapping_status = 'pending_push',
       pending_operation = $4, pending_vcard = $5,
       pending_local_hash = $6, pending_remote_semantic_hash = $7,
       pending_started_at = NOW(),
       mapping_revision = mapping_revision + 1,
       updated_at = NOW()
     WHERE address_book_id = $1 AND href = $2
       AND mapping_revision = $3::bigint
       AND pending_operation IS NULL
     RETURNING mapping_revision::text, pending_started_at::text`,
    [
      change.addressBookId,
      change.href,
      String(change.expectedMappingRevision),
      change.operation,
      change.pendingVCard ?? null,
      change.pendingLocalHash,
      change.pendingRemoteSemanticHash ?? null,
    ],
  );
  if (result.rowCount !== 1) return staleResult(change);
  return {
    ok: true,
    mappingRevision: String(
      result.rows[0]?.mapping_revision
      ?? (BigInt(change.expectedMappingRevision) + 1n),
    ),
    pendingStartedAt: result.rows[0]?.pending_started_at,
  };
}

export async function restorePendingMutationIntent(client, change) {
  requireExpectedRevision(change);
  const result = await client.query(
    `UPDATE carddav_remote_objects SET
       mapping_status = $8,
       pending_operation = NULL, pending_vcard = NULL,
       pending_local_hash = NULL, pending_remote_semantic_hash = NULL,
       pending_started_at = NULL,
       mapping_revision = $9::bigint,
       updated_at = $10
     WHERE address_book_id = $1 AND href = $2
       AND mapping_revision = $3::bigint
       AND mapping_status = 'pending_push'
       AND pending_operation = $4
       AND pending_vcard IS NOT DISTINCT FROM $5
       AND pending_local_hash IS NOT DISTINCT FROM $6
       AND pending_remote_semantic_hash IS NOT DISTINCT FROM $7
       AND pending_started_at = $11::timestamptz
     RETURNING mapping_revision::text`,
    [
      change.addressBookId,
      change.href,
      String(change.expectedMappingRevision),
      change.operation,
      change.pendingVCard ?? null,
      change.pendingLocalHash,
      change.pendingRemoteSemanticHash ?? null,
      change.previousMappingStatus,
      String(change.previousMappingRevision),
      change.previousUpdatedAt,
      change.pendingStartedAt,
    ],
  );
  if (result.rowCount !== 1) return staleResult(change);
  return {
    ok: true,
    mappingRevision: String(
      result.rows[0]?.mapping_revision ?? change.previousMappingRevision,
    ),
  };
}

async function applyConfirmedRemoteContactState(client, change, clearUnresolvedConflict) {
  requireExpectedRevision(change);
  const mappingStatus = change.mappingStatus ?? 'synced';
  if (mappingStatus !== 'synced' && mappingStatus !== 'pending_push') {
    throw typedError('Invalid confirmed CardDAV mapping status', 'ERR_CARDDAV_MAPPING_STATUS');
  }
  let result;
  if (change.expectedMappingRevision === null) {
    result = await client.query(
      `INSERT INTO carddav_remote_objects (
         address_book_id, href, remote_etag, vcard, primary_email,
         local_contact_id, mapping_status, vcard_version,
         remote_semantic_hash, local_contact_hash, last_synced_at
       ) VALUES ($1,$2,$3,$4,$5,$6,'synced',$7,$8,$9,NOW())
       ON CONFLICT (address_book_id, href) DO NOTHING
       RETURNING mapping_revision::text`,
      [
        change.addressBookId,
        change.href,
        change.remoteEtag ?? null,
        change.vcard,
        change.primaryEmail ?? null,
        change.localContactId,
        change.vcardVersion,
        change.remoteSemanticHash,
        change.localContactHash,
      ],
    );
  } else {
    const clearPendingIntent = change.supportsPendingIntent === false
      || change.preservePendingIntent === true
      ? ''
      : `, pending_operation = NULL,
         pending_vcard = NULL, pending_local_hash = NULL,
         pending_remote_semantic_hash = NULL, pending_started_at = NULL`;
    const clearLegacyProjection = change.clearLegacyProjection === true
      ? ', legacy_projection = NULL'
      : '';
    result = await client.query(
      `UPDATE carddav_remote_objects SET
         href = $1, remote_etag = $2, vcard = $3, primary_email = $4,
         local_contact_id = $5, mapping_status = '${mappingStatus}', vcard_version = $6,
         remote_semantic_hash = $7, local_contact_hash = $8,
         mapping_revision = mapping_revision + 1,
         last_synced_at = NOW(), last_push_error_code = NULL,
         last_push_error_at = NULL${clearPendingIntent}${clearLegacyProjection},
         updated_at = NOW()
       WHERE address_book_id = $9 AND href = $1
         AND mapping_revision = $10::bigint
       RETURNING mapping_revision::text`,
      [
        change.href,
        change.remoteEtag ?? null,
        change.vcard,
        change.primaryEmail ?? null,
        change.localContactId,
        change.vcardVersion,
        change.remoteSemanticHash,
        change.localContactHash,
        change.addressBookId,
        String(change.expectedMappingRevision),
      ],
    );
  }
  if (result.rowCount !== 1) return staleResult(change);
  const revision = result.rows[0]?.mapping_revision
    ?? (change.expectedMappingRevision === null
      ? '0'
      : String(BigInt(change.expectedMappingRevision) + 1n));
  if (clearUnresolvedConflict) {
    await client.query(
      `DELETE FROM carddav_conflicts
       WHERE address_book_id = $1 AND href = $2 AND status = 'unresolved'`,
      [change.addressBookId, change.href],
    );
  }
  return { ok: true, mappingRevision: String(revision) };
}

export async function applyConfirmedRemoteContact(client, change) {
  return applyConfirmedRemoteContactState(client, change, true);
}

async function applyRemoteTombstoneState(client, change, clearUnresolvedConflict) {
  requireExpectedRevision(change);
  const result = await client.query(
    `DELETE FROM carddav_remote_objects
     WHERE address_book_id = $1 AND href = $2
       AND mapping_revision = $3::bigint
     RETURNING mapping_revision::text`,
    [change.addressBookId, change.href, String(change.expectedMappingRevision)],
  );
  if (result.rowCount !== 1) return staleResult(change);
  if (clearUnresolvedConflict) {
    await client.query(
      `DELETE FROM carddav_conflicts
       WHERE address_book_id = $1 AND href = $2 AND status = 'unresolved'`,
      [change.addressBookId, change.href],
    );
  }
  return {
    ok: true,
    mappingRevision: String(result.rows[0]?.mapping_revision ?? change.expectedMappingRevision),
  };
}

export async function applyRemoteTombstone(client, change) {
  return applyRemoteTombstoneState(client, change, true);
}

// Multi-book lookup projection: retain a remote object for inbound-sender
// resolution without materializing a local contact. A lookup row keeps the
// parsed vCard, extracted primary_email, and a projected lookup_display_name
// but has local_contact_id = NULL and mapping_status = 'lookup', so it can
// never enter the contacts list, be edited/exported, conflict, or collide with
// the per-contact active-mapping index (that index excludes NULL contacts).
// Any pending push intent is cleared: a lookup book is read-only from MailFlow.

// Bind budget: each row contributes LOOKUP_UPSERT_COLUMNS_PER_ROW parameters,
// and PostgreSQL rejects a single statement carrying more than 65,535 binds. A
// lookup delta can carry up to DAV_MAX_SYNC_MEMBERS (50,000) members (see
// carddavClient.js), which at 8 binds/row would need 400,000 binds, so the
// upsert must be chunked. 4,000 rows is 32,000 binds — comfortably under the
// limit even if a column is ever added — and keeps each statement small.
const LOOKUP_UPSERT_COLUMNS_PER_ROW = 8;
const LOOKUP_UPSERT_CHUNK_ROWS = 4000;

async function upsertLookupObjectChunk(client, chunk) {
  const tuples = chunk.map((_, index) => {
    const base = index * LOOKUP_UPSERT_COLUMNS_PER_ROW;
    return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},`
      + `NULL,'lookup',$${base + 6},$${base + 7},NULL,$${base + 8},NOW())`;
  });
  const params = chunk.flatMap(change => [
    change.addressBookId,
    change.href,
    change.remoteEtag ?? null,
    change.vcard,
    change.primaryEmail ?? null,
    change.vcardVersion ?? null,
    change.remoteSemanticHash ?? null,
    change.lookupDisplayName ?? null,
  ]);
  const result = await client.query(
    `INSERT INTO carddav_remote_objects (
       address_book_id, href, remote_etag, vcard, primary_email,
       local_contact_id, mapping_status, vcard_version, remote_semantic_hash,
       local_contact_hash, lookup_display_name, last_synced_at
     ) VALUES ${tuples.join(',')}
     ON CONFLICT (address_book_id, href) DO UPDATE SET
       remote_etag = EXCLUDED.remote_etag,
       vcard = EXCLUDED.vcard,
       primary_email = EXCLUDED.primary_email,
       local_contact_id = NULL,
       mapping_status = 'lookup',
       vcard_version = EXCLUDED.vcard_version,
       remote_semantic_hash = EXCLUDED.remote_semantic_hash,
       local_contact_hash = NULL,
       lookup_display_name = EXCLUDED.lookup_display_name,
       pending_operation = NULL, pending_vcard = NULL, pending_local_hash = NULL,
       pending_remote_semantic_hash = NULL, pending_started_at = NULL,
       mapping_revision = carddav_remote_objects.mapping_revision + 1,
       last_synced_at = NOW(), last_push_error_code = NULL, last_push_error_at = NULL,
       updated_at = NOW()`,
    params,
  );
  return result.rowCount;
}

// Every changed row in a delta is written in multi-row upserts rather than one
// awaited round trip apiece, chunked to stay under PostgreSQL's per-statement
// bind limit (see LOOKUP_UPSERT_CHUNK_ROWS). The caller runs this inside its
// sync transaction, so every chunk shares that transaction and the ledger
// update stays atomic. Returns the total number of rows written.
export async function upsertLookupObjects(client, changes) {
  if (!changes.length) return 0;
  let written = 0;
  for (let start = 0; start < changes.length; start += LOOKUP_UPSERT_CHUNK_ROWS) {
    written += await upsertLookupObjectChunk(
      client,
      changes.slice(start, start + LOOKUP_UPSERT_CHUNK_ROWS),
    );
  }
  return written;
}

export async function removeLookupObjects(client, { addressBookId, hrefs }) {
  if (!hrefs.length) return { rowCount: 0 };
  return client.query(
    `DELETE FROM carddav_remote_objects
     WHERE address_book_id = $1 AND href = ANY($2::text[])`,
    [addressBookId, hrefs],
  );
}

export async function resolveCarddavConflict(client, change) {
  requireExpectedRevision(change);
  const mapping = change.remoteTombstone
    ? await applyRemoteTombstoneState(client, change, false)
    : await applyConfirmedRemoteContactState(client, change, false);
  if (!mapping.ok) return mapping;
  const result = await client.query(
    `UPDATE carddav_conflicts
     SET status = 'resolved', resolution = $2, resolved_by = $3,
         resolved_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND status = 'unresolved'
       AND address_book_id = $4 AND href = $5 AND user_id = $3
     RETURNING *`,
    [
      change.conflictId,
      change.resolution,
      change.userId,
      change.addressBookId,
      change.href,
    ],
  );
  if (result.rowCount !== 1) return staleResult(change);
  return { ...mapping, conflict: result.rows[0] };
}

export async function refreshUnresolvedConflict(client, change) {
  requireExpectedRevision(change);
  const preserveLocalSnapshot = change.preserveLocalSnapshot === true;
  let localVCard = change.localVCard ?? null;
  let localTombstone = change.localTombstone ?? false;
  if (preserveLocalSnapshot) {
    const { rows: [existingConflict] } = await client.query(
      `SELECT local_vcard, local_tombstone
       FROM carddav_conflicts
       WHERE address_book_id = $1 AND href = $2 AND status = 'unresolved'`,
      [change.addressBookId, change.href],
    );
    if (!existingConflict) {
      throw typedError(
        'The unresolved CardDAV conflict local snapshot is missing',
        'ERR_CARDDAV_CONFLICT_MISSING',
      );
    }
    localVCard = existingConflict.local_vcard;
    localTombstone = existingConflict.local_tombstone;
  }
  assertConflictSnapshotsWithinLimit({
    localVCard,
    remoteVCard: change.remoteVCard,
    localTombstone,
    remoteTombstone: change.remoteTombstone,
  });
  const localSnapshotUpdate = preserveLocalSnapshot
    ? ''
    : `
       local_vcard = EXCLUDED.local_vcard,
       local_tombstone = EXCLUDED.local_tombstone,`;
  const clearPendingIntent = change.supportsPendingIntent === false
    ? ''
    : `pending_operation = NULL, pending_vcard = NULL,
       pending_local_hash = NULL, pending_remote_semantic_hash = NULL,
       pending_started_at = NULL,
       `;
  const mapping = await client.query(
    `UPDATE carddav_remote_objects SET
       mapping_status = 'conflict',
       ${clearPendingIntent}mapping_revision = mapping_revision + 1,
       updated_at = NOW()
     WHERE address_book_id = $1 AND href = $2
       AND mapping_revision = $3::bigint
     RETURNING mapping_revision::text`,
    [
      change.addressBookId,
      change.href,
      String(change.expectedMappingRevision),
    ],
  );
  if (mapping.rowCount !== 1) return staleResult(change);
  const revision = mapping.rows[0]?.mapping_revision
    ?? String(BigInt(change.expectedMappingRevision) + 1n);
  const { rows: [conflict] } = await client.query(
    `INSERT INTO carddav_conflicts (
       address_book_id, href, user_id, base_local_hash, remote_etag,
       local_vcard, remote_vcard, local_tombstone, remote_tombstone
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (address_book_id, href) WHERE status = 'unresolved'
     DO UPDATE SET
       base_local_hash = EXCLUDED.base_local_hash,
       remote_etag = EXCLUDED.remote_etag,${localSnapshotUpdate}
       remote_vcard = EXCLUDED.remote_vcard,
       remote_tombstone = EXCLUDED.remote_tombstone,
       updated_at = NOW()
     RETURNING id, status`,
    [
      change.addressBookId,
      change.href,
      change.userId,
      change.baseLocalHash ?? null,
      change.remoteEtag ?? null,
      localVCard,
      change.remoteVCard ?? null,
      localTombstone,
      change.remoteTombstone ?? false,
    ],
  );
  return { ok: true, mappingRevision: String(revision), conflict };
}

function isUndefinedColumn(error) {
  return error?.code === '42703';
}

function isNameCollisionViolation(error) {
  return error.code === '23505' && error.constraint === 'address_books_user_id_name_key';
}

// Does this schema have the multi-book role columns yet (added by the
// multi-book migration)? Probed with a SAVEPOINT because this runs inside the
// caller's sync transaction: an undefined_column error would otherwise abort
// that whole transaction, not just this one query, on a not-yet-migrated
// (transitional, mid-deploy) database.
async function supportsMultiBookRoles(client, userId) {
  await client.query('SAVEPOINT carddav_multi_book_probe');
  try {
    await client.query(
      `SELECT 1 FROM address_books
       WHERE user_id = $1 AND source = 'carddav' AND is_write_target = true
       LIMIT 1`,
      [userId],
    );
    await client.query('RELEASE SAVEPOINT carddav_multi_book_probe');
    return true;
  } catch (error) {
    if (!isUndefinedColumn(error)) throw error;
    await client.query('ROLLBACK TO SAVEPOINT carddav_multi_book_probe');
    await client.query('RELEASE SAVEPOINT carddav_multi_book_probe');
    return false;
  }
}

// Atomically claims the write-target (+ subscribed) flags for whichever
// create-capable carddav book of this user currently ranks best — 'allowed'
// capability before 'unknown', then earliest created_at/id — mirroring the
// ranking the 0033 migration backfill applied once for already-connected
// users.
//
// An ignored book (neither subscribed nor a lookup source) is not a candidate at
// any rank. The claim sets is_subscribed alongside is_write_target, so promoting
// one would silently re-enable a book the user explicitly turned off and
// materialize it into the contacts list on the next pull — the very thing the
// per-book roles exist to prevent. When every create-capable book is ignored the
// claim takes none and the user is left with no write-target: creates then fail
// with the typed ERR_CARDDAV_NO_WRITE_TARGET the routes already surface (and the
// export sweep already skips on), which is the honest outcome once the user has
// excluded every book that could receive a contact — re-including one through the
// role controls makes it a candidate again. Deciding *for* them by resurrecting an
// excluded book would be the one outcome they cannot undo by hand.
//
// The `NOT EXISTS` guard makes this a no-op whenever the user already
// has a write-target, so it is safe to call unconditionally, from two seams:
//  - persistDiscoveredBook below, immediately after inserting a brand-new
//    book — correct for every single-book caller (interactive create/export,
//    which only ever discovers or persists one book per call);
//  - carddavSync.js's syncUser, once after every book in a discovery
//    snapshot has been persisted (see the `deferWriteTargetClaim` book flag
//    below), so a multi-book connect ranks the *whole* snapshot in one shot
//    instead of claiming per book in discovery order — a later 'allowed'
//    book must be able to win over an earlier 'unknown' one that would
//    otherwise keep the flag forever purely by having been discovered first
//    (the bug this replaces) — and once more after a sync's stale-book
//    cleanup (see reconcileStaleCarddavBooks) — a connection replacement
//    (new server or user) can delete the old book that held the flag, which
//    would otherwise leave the replacement connection with none.
export async function claimBestWriteTargetCandidate(client, userId) {
  await client.query('SAVEPOINT carddav_write_target_claim');
  try {
    await client.query(
      `UPDATE address_books SET
         is_write_target = true, is_subscribed = true, updated_at = NOW()
       WHERE id = (
         SELECT id FROM address_books
         WHERE user_id = $1 AND source = 'carddav' AND remote_create_capability <> 'denied'
           AND (is_subscribed OR is_lookup_source)
         ORDER BY (remote_create_capability = 'allowed') DESC, created_at, id
         LIMIT 1
       )
       AND NOT EXISTS (
         SELECT 1 FROM address_books
         WHERE user_id = $1 AND source = 'carddav' AND is_write_target = true
       )`,
      [userId],
    );
    await client.query('RELEASE SAVEPOINT carddav_write_target_claim');
  } catch (error) {
    if (!isUndefinedColumn(error) && error.code !== '23505') throw error;
    await client.query('ROLLBACK TO SAVEPOINT carddav_write_target_claim');
    await client.query('RELEASE SAVEPOINT carddav_write_target_claim');
  }
}

// Resolve a fresh discovery snapshot's book to an already-persisted row, by
// its canonical external_url or its recorded discovery alias. Some CardDAV
// servers keep advertising a stable "alias" href in PROPFIND discovery for a
// collection whose canonical external_url advanceDiscoveredBookState already
// rewrote after a REPORT/PUT/DELETE redirect reconciliation; selectedCreateBook
// (carddavContactService.js) deliberately matches such a book by either URL so
// write routing keeps working, but an INSERT can only ON CONFLICT on one
// column. Without this lookup, persisting a book resolved via its alias would
// insert a second, non-write-target row for the same remote collection
// instead of updating the existing one — silently orphaning every future
// mutation mapped through it as read-only.
async function findDiscoveredBookByUrl(client, userId, url) {
  const { rows: [existing] } = await client.query(
    `SELECT id FROM address_books
     WHERE user_id = $1 AND source = 'carddav'
       AND (external_url = $2 OR discovery_alias_url = $2)
     FOR UPDATE`,
    [userId, url],
  );
  return existing || null;
}

export async function persistDiscoveredBook(client, book) {
  const capabilities = normalizeCarddavCapabilities(book.capabilities);
  const displayName = book.displayName || 'CardDAV';
  const multiBook = await supportsMultiBookRoles(client, book.userId);

  // Already-persisted book (matched by canonical URL or discovery alias) —
  // update its capabilities in place. Role flags (is_write_target,
  // is_subscribed) are never touched here: those are only ever decided once,
  // at first creation below, or by deliberate role-management elsewhere.
  const existingBook = multiBook
    ? await findDiscoveredBookByUrl(client, book.userId, book.url)
    : null;
  if (existingBook) {
    const { rows: [stored] } = await client.query(
      book.preserveCapabilities === true
        ? `UPDATE address_books SET updated_at = NOW()
           WHERE id = $1
           RETURNING id, external_url, remote_sync_token,
                     remote_sync_revision::text, sync_token,
                     remote_projection_fingerprint`
        : `UPDATE address_books SET
             remote_create_capability = $2,
             remote_update_capability = $3,
             remote_delete_capability = $4,
             updated_at = NOW()
           WHERE id = $1
           RETURNING id, external_url, remote_sync_token,
                     remote_sync_revision::text, sync_token,
                     remote_projection_fingerprint`,
      book.preserveCapabilities === true
        ? [existingBook.id]
        : [existingBook.id, capabilities.create, capabilities.update, capabilities.delete],
    );
    return stored;
  }

  const capabilityUpdate = book.preserveCapabilities === true
    ? ''
    : `,
           remote_create_capability = EXCLUDED.remote_create_capability,
           remote_update_capability = EXCLUDED.remote_update_capability,
           remote_delete_capability = EXCLUDED.remote_delete_capability`;
  // A brand-new carddav book is normally inserted lookup-only (is_write_target,
  // is_subscribed both false, matching the column defaults exactly): a book
  // never claims the write-target directly, in per-book discovery order, here —
  // claimBestWriteTargetCandidate re-ranks the *whole* snapshot of the user's
  // carddav books by capability priority once the row exists, and assigns the
  // single is_write_target flag. The one exception is subscribeOnCreate: the
  // sync loop resolves the book that will become the write-target from the
  // discovery snapshot (see carddavSync.js) and asks for it to be inserted
  // *subscribed* so it materializes in that very first sync, and durably —
  // even if a later sibling book in the same batch fails before the batch-wide
  // claim runs, or a stale write-target from a replaced connection still holds
  // the flag this pass. is_write_target stays false here (only the claim sets
  // it, avoiding the one-write-target unique index while a stale one lingers);
  // subscribing without the write-target flag is a valid subscribed-secondary
  // state and satisfies the address_books_write_target_subscribed check.
  const subscribeOnCreate = multiBook && book.subscribeOnCreate === true;
  const roleColumns = multiBook ? ', is_write_target, is_subscribed' : '';
  const roleValues = multiBook ? `,false,${subscribeOnCreate}` : '';
  let stored;
  let nameAttempt = 0;
  let unexpectedRetries = 0;
  for (;;) {
    const name = nameAttempt === 0 ? displayName : `${displayName} (${nameAttempt + 1})`;
    await client.query('SAVEPOINT carddav_book_name');
    try {
      ({ rows: [stored] } = await client.query(
        `INSERT INTO address_books (
           user_id, name, source, external_url,
           remote_create_capability, remote_update_capability, remote_delete_capability${roleColumns}
         ) VALUES ($1,$2,'carddav',$3,$4,$5,$6${roleValues})
         ON CONFLICT (user_id, external_url)
           WHERE source = 'carddav' AND external_url IS NOT NULL
         DO UPDATE SET
           external_url = EXCLUDED.external_url${capabilityUpdate},
           updated_at = NOW()
         RETURNING id, external_url, remote_sync_token,
                   remote_sync_revision::text, sync_token,
                   remote_projection_fingerprint`,
        [
          book.userId,
          name,
          book.url,
          capabilities.create,
          capabilities.update,
          capabilities.delete,
        ],
      ));
      await client.query('RELEASE SAVEPOINT carddav_book_name');
      break;
    } catch (error) {
      if (error.code !== '23505') throw error;
      await client.query('ROLLBACK TO SAVEPOINT carddav_book_name');
      await client.query('RELEASE SAVEPOINT carddav_book_name');
      // Only a display-name collision (this user already has a same-named
      // book) should provoke a rename. Anything else — e.g. a concurrent
      // insert for this same external_url racing this one — retries the
      // *identical* name a bounded number of times instead of spuriously
      // renaming this book for an unrelated conflict.
      if (isNameCollisionViolation(error)) {
        nameAttempt += 1;
        if (nameAttempt >= 20) {
          throw new Error(`Could not create a local address book for "${displayName}"`, { cause: error });
        }
      } else {
        unexpectedRetries += 1;
        if (unexpectedRetries >= 5) throw error;
      }
    }
  }
  // The sync loop (createCarddavBook in carddavSync.js) persists every book
  // of a discovery snapshot individually but defers claiming until the whole
  // snapshot exists, so it can rank all of them at once (see
  // claimBestWriteTargetCandidate above); every other caller persists a
  // single book and wants the claim attempted right away.
  if (multiBook && book.deferWriteTargetClaim !== true) {
    await claimBestWriteTargetCandidate(client, book.userId);
  }
  return stored;
}

const CAPABILITY_COLUMNS = {
  create: 'remote_create_capability',
  update: 'remote_update_capability',
  delete: 'remote_delete_capability',
};

export async function persistDeniedBookCapability(client, {
  userId,
  addressBookId,
  capability,
}) {
  const column = CAPABILITY_COLUMNS[capability];
  if (!column) {
    throw typedError('Invalid CardDAV book capability', 'ERR_CARDDAV_BOOK_CAPABILITY');
  }
  return client.query(
    `UPDATE address_books
     SET ${column} = 'denied', updated_at = NOW()
     WHERE id = $1 AND user_id = $2`,
    [addressBookId, userId],
  );
}

const ADVANCE_BOOK_STATE_SQL = `
    UPDATE address_books SET
      external_url = COALESCE($6, external_url),
      remote_sync_token = $2,
      remote_sync_capability = $3,
      remote_sync_revision = remote_sync_revision + 1,
      remote_projection_fingerprint = $4,
      remote_create_capability = $7,
      remote_update_capability = $8,
      remote_delete_capability = $9,
      updated_at = NOW()
    WHERE id = $1 AND remote_sync_revision = $5::bigint
  `;

// Same statement, but also records the discovery URL a book's canonical
// external_url gets rewritten from. A CardDAV discovery PROPFIND can keep
// advertising a stable "alias" href for a collection that 3xx-redirects
// (REPORT/PUT/DELETE) to a different canonical URL; when that happens
// canonicalUrl differs from the row's current external_url (the alias),
// and the alias is worth keeping so write-target resolution can still match
// a book by whichever URL a fresh discovery snapshot returns (see
// writeTargetBookUrls / selectedCreateBook in carddavContactService.js).
const ADVANCE_BOOK_STATE_WITH_ALIAS_SQL = `
    UPDATE address_books SET
      external_url = COALESCE($6, external_url),
      discovery_alias_url = CASE
        WHEN $6 IS NOT NULL AND $6 <> external_url THEN external_url
        ELSE discovery_alias_url
      END,
      remote_sync_token = $2,
      remote_sync_capability = $3,
      remote_sync_revision = remote_sync_revision + 1,
      remote_projection_fingerprint = $4,
      remote_create_capability = $7,
      remote_update_capability = $8,
      remote_delete_capability = $9,
      updated_at = NOW()
    WHERE id = $1 AND remote_sync_revision = $5::bigint
  `;

export async function advanceDiscoveredBookState(client, state) {
  const capabilities = normalizeCarddavCapabilities(state.capabilities);
  const params = [
    state.addressBookId,
    state.remoteSyncToken,
    state.remoteSyncCapability,
    state.remoteProjectionFingerprint,
    state.expectedRemoteRevision,
    state.canonicalUrl,
    capabilities.create,
    capabilities.update,
    capabilities.delete,
  ];
  // Guarded with a SAVEPOINT + undefined_column fallback (rather than an
  // information_schema pre-check) because this runs inside the caller's sync
  // transaction, once per book on every sync — an undefined_column error on
  // a not-yet-migrated (transitional) schema would otherwise abort that whole
  // transaction, not just this query.
  await client.query('SAVEPOINT carddav_book_alias_column');
  try {
    const result = await client.query(ADVANCE_BOOK_STATE_WITH_ALIAS_SQL, params);
    await client.query('RELEASE SAVEPOINT carddav_book_alias_column');
    return result;
  } catch (error) {
    if (!isUndefinedColumn(error)) throw error;
    await client.query('ROLLBACK TO SAVEPOINT carddav_book_alias_column');
    await client.query('RELEASE SAVEPOINT carddav_book_alias_column');
    return client.query(ADVANCE_BOOK_STATE_SQL, params);
  }
}
