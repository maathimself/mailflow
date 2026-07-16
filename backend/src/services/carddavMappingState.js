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

export async function persistDiscoveredBook(client, book) {
  const capabilities = normalizeCarddavCapabilities(book.capabilities);
  const displayName = book.displayName || 'CardDAV';
  const capabilityUpdate = book.preserveCapabilities === true
    ? ''
    : `,
           remote_create_capability = EXCLUDED.remote_create_capability,
           remote_update_capability = EXCLUDED.remote_update_capability,
           remote_delete_capability = EXCLUDED.remote_delete_capability`;
  for (let attempt = 0; attempt < 20; attempt++) {
    const name = attempt === 0 ? displayName : `${displayName} (${attempt + 1})`;
    await client.query('SAVEPOINT carddav_book_name');
    try {
      const { rows: [stored] } = await client.query(
        `INSERT INTO address_books (
           user_id, name, source, external_url,
           remote_create_capability, remote_update_capability, remote_delete_capability
         ) VALUES ($1,$2,'carddav',$3,$4,$5,$6)
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
      );
      await client.query('RELEASE SAVEPOINT carddav_book_name');
      return stored;
    } catch (error) {
      if (error.code !== '23505') throw error;
      await client.query('ROLLBACK TO SAVEPOINT carddav_book_name');
      await client.query('RELEASE SAVEPOINT carddav_book_name');
    }
  }
  throw new Error(`Could not create a local address book for "${displayName}"`);
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

export async function advanceDiscoveredBookState(client, state) {
  const capabilities = normalizeCarddavCapabilities(state.capabilities);
  return client.query(`
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
  `, [
    state.addressBookId,
    state.remoteSyncToken,
    state.remoteSyncCapability,
    state.remoteProjectionFingerprint,
    state.expectedRemoteRevision,
    state.canonicalUrl,
    capabilities.create,
    capabilities.update,
    capabilities.delete,
  ]);
}
