import { createHash } from 'node:crypto';

import {
  contactFromVCardDocument,
  localContactHash,
  localVCardEtag,
  parseVCardDocument,
  primaryEmail,
  semanticVCardHash,
} from '../utils/vcardProperties.js';
import {
  deleteCardResource,
  fetchCardResource,
  putCardResource,
} from './carddavClient.js';
import { query, withTransaction } from './db.js';
import {
  confirmedRemotePayload,
  insertContact,
  updateStoredContact,
} from './carddavContactService.js';
import {
  refreshUnresolvedConflict,
  resolveCarddavConflict,
  rotateBookToken,
  typedError,
} from './carddavMappingState.js';
import { resolveCarddavCredentials } from './carddavTransport.js';

const RESOLUTIONS = new Set(['keep-mailflow', 'keep-carddav']);

function isoDate(value) {
  return value?.toISOString?.() ?? value ?? null;
}

function publicSnapshot(vcard, tombstone) {
  if (tombstone) return { tombstone: true, hasPhoto: false, contact: null };
  const document = parseVCardDocument(vcard);
  const contact = contactFromVCardDocument(document);
  delete contact.photoData;
  return {
    tombstone: false,
    hasPhoto: document.properties.some(property => property.name === 'PHOTO'),
    contact,
  };
}

function publicConflict(row) {
  return {
    id: row.id,
    href: row.href,
    status: row.status,
    resolution: row.resolution ?? null,
    createdAt: isoDate(row.created_at),
    updatedAt: isoDate(row.updated_at),
    resolvedAt: isoDate(row.resolved_at),
    local: publicSnapshot(row.local_vcard, row.local_tombstone),
    remote: publicSnapshot(row.remote_vcard, row.remote_tombstone),
  };
}

const PUBLIC_CONFLICT_COLUMNS = `
  conflict.id, conflict.href, conflict.status, conflict.resolution,
  conflict.local_vcard, conflict.remote_vcard,
  conflict.local_tombstone, conflict.remote_tombstone,
  conflict.created_at, conflict.updated_at, conflict.resolved_at`;

export async function listConflicts(userId) {
  const { rows } = await query(
    `SELECT ${PUBLIC_CONFLICT_COLUMNS}
     FROM carddav_conflicts conflict
     JOIN carddav_remote_objects mapping
       ON mapping.address_book_id = conflict.address_book_id
      AND mapping.href = conflict.href
     JOIN address_books remote_book ON remote_book.id = mapping.address_book_id
     JOIN user_integrations integration
       ON integration.user_id = remote_book.user_id
      AND integration.provider = 'carddav'
     WHERE integration.user_id = $1 AND conflict.user_id = $1
       AND conflict.status = 'unresolved'
     ORDER BY conflict.updated_at DESC, conflict.id`,
    [userId],
  );
  return rows.map(publicConflict);
}

export async function getConflict(userId, id) {
  const { rows: [row] } = await query(
    `SELECT ${PUBLIC_CONFLICT_COLUMNS}
     FROM carddav_conflicts conflict
     LEFT JOIN carddav_remote_objects mapping
       ON mapping.address_book_id = conflict.address_book_id
      AND mapping.href = conflict.href
     JOIN address_books remote_book ON remote_book.id = conflict.address_book_id
     JOIN user_integrations integration
       ON integration.user_id = remote_book.user_id
      AND integration.provider = 'carddav'
     WHERE integration.user_id = $1 AND conflict.user_id = $1
       AND conflict.id = $2
       AND (conflict.status = 'resolved' OR mapping.address_book_id IS NOT NULL)`,
    [userId, id],
  );
  return row ? publicConflict(row) : null;
}

function resolutionStateSql(lock = false) {
  const mappingJoin = lock ? 'JOIN' : 'LEFT JOIN';
  return `SELECT conflict.*, mapping.mapping_revision::text, mapping.mapping_status,
                 contact.id AS contact_id, contact.uid AS contact_uid,
                 contact.etag AS contact_etag,
                 contact.address_book_id AS local_address_book_id,
                 remote_book.external_url AS remote_book_url,
                 integration.config,
                 integration.config->>'connectionGeneration' AS connection_generation
          FROM carddav_conflicts conflict
          ${mappingJoin} carddav_remote_objects mapping
            ON mapping.address_book_id = conflict.address_book_id
           AND mapping.href = conflict.href
          JOIN address_books remote_book
            ON remote_book.id = conflict.address_book_id
          LEFT JOIN contacts contact
            ON contact.id = mapping.local_contact_id
           AND contact.user_id = remote_book.user_id
          JOIN user_integrations integration
            ON integration.user_id = remote_book.user_id
           AND integration.provider = 'carddav'
          WHERE integration.user_id = $1 AND conflict.user_id = $1
            AND conflict.id = $2
            AND (conflict.status = 'resolved' OR mapping.address_book_id IS NOT NULL)
          ${lock ? 'FOR UPDATE OF conflict, mapping, integration' : ''}`;
}

async function readResolutionState(executor, userId, id, lock = false) {
  const { rows: [state] } = await executor.query(
    resolutionStateSql(lock),
    [userId, id],
  );
  return state || null;
}

function staleConflict(id) {
  return typedError(
    'CardDAV conflict is stale or already resolved',
    'ERR_CARDDAV_CONFLICT_STALE',
    { conflictId: id },
  );
}

function assertUnresolved(state, id) {
  if (!state) {
    throw typedError('CardDAV conflict not found', 'ERR_CARDDAV_CONFLICT_NOT_FOUND');
  }
  if (state.status !== 'unresolved') throw staleConflict(id);
}

function sameResolutionFence(state, preflight) {
  return state
    && state.status === 'unresolved'
    && state.contact_id === preflight.contact_id
    && state.contact_etag === preflight.contact_etag
    && String(state.mapping_revision) === String(preflight.mapping_revision)
    && state.connection_generation === preflight.connection_generation;
}

async function credentials(state) {
  const resolved = await resolveCarddavCredentials(state.config);
  if (!state.remote_book_url || !resolved.username || !resolved.password) {
    throw typedError(
      'Stored CardDAV credentials could not be read',
      'ERR_CARDDAV_CREDENTIALS',
    );
  }
  return resolved;
}

async function fetchLatestRemote(state, creds) {
  try {
    const remote = await fetchCardResource({
      url: state.remote_book_url,
      href: state.href,
      ...creds,
    });
    return { ...remote, tombstone: false };
  } catch (error) {
    if (error?.status === 404) {
      return { href: state.href, etag: null, vcard: null, tombstone: true };
    }
    throw error;
  }
}

function canonicalPayload(state, remote) {
  const localUid = state.contact_uid
    ?? createHash('sha256').update(state.href).digest('hex');
  const payload = confirmedRemotePayload(localUid, remote.vcard);
  const remoteContact = contactFromVCardDocument(payload.document);
  const localVCard = remoteContact.uid === state.contact_uid ? remote.vcard : payload.vcard;
  const localEtag = localVCard === payload.vcard ? payload.etag : localVCardEtag(localVCard);
  return {
    ...payload,
    remoteContact,
    localContact: { ...payload, uid: localUid },
    localVCard,
    localEtag,
    vcard: localVCard,
    etag: localEtag,
  };
}

async function updateLocalContact(client, state, payload, userId) {
  const row = await updateStoredContact(
    client,
    userId,
    state.contact_id,
    payload,
    null,
    { returning: 'id', onMissing: () => staleConflict(state.id) },
  );
  return row.id;
}

async function insertLocalContact(client, state, payload, userId) {
  const row = await insertContact(
    client,
    userId,
    state.address_book_id,
    payload,
    { returning: 'id' },
  );
  if (!row) throw staleConflict(state.id);
  return row.id;
}

async function bumpLocalBook(client, state, userId, addressBookId = null) {
  const rowCount = await rotateBookToken(
    client,
    userId,
    addressBookId ?? state.local_address_book_id,
  );
  if (rowCount !== 1) throw staleConflict(state.id);
}

function assertMappingApplied(result, conflictId) {
  if (!result.ok) throw staleConflict(conflictId);
}

async function commitResolution(userId, preflight, resolution, remote) {
  const payload = remote.tombstone ? null : canonicalPayload(preflight, remote);
  return withTransaction(async client => {
    await client.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
    const state = await readResolutionState(client, userId, preflight.id, true);
    if (!sameResolutionFence(state, preflight)) throw staleConflict(preflight.id);

    if (remote.tombstone) {
      const result = await resolveCarddavConflict(client, {
        addressBookId: state.address_book_id,
        href: state.href,
        expectedMappingRevision: state.mapping_revision,
        conflictId: state.id,
        userId,
        resolution,
        remoteTombstone: true,
      });
      assertMappingApplied(result, state.id);
      if (state.contact_id) {
        const deleted = await client.query(
          'DELETE FROM contacts WHERE id = $1 AND user_id = $2',
          [state.contact_id, userId],
        );
        if (deleted.rowCount !== 1) throw staleConflict(state.id);
        await bumpLocalBook(client, state, userId);
      }
      return publicConflict({ ...state, ...result.conflict });
    }

    const localContactId = state.contact_id
      ? await updateLocalContact(client, state, payload, userId)
      : await insertLocalContact(client, state, payload, userId);
    const result = await resolveCarddavConflict(client, {
      addressBookId: state.address_book_id,
      href: state.href,
      expectedMappingRevision: state.mapping_revision,
      conflictId: state.id,
      userId,
      resolution,
      remoteTombstone: false,
      remoteEtag: remote.etag,
      vcard: remote.vcard,
      primaryEmail: primaryEmail(payload.remoteContact),
      localContactId,
      vcardVersion: payload.document.version,
      remoteSemanticHash: semanticVCardHash(payload.document),
      localContactHash: localContactHash(payload.localContact),
    });
    assertMappingApplied(result, state.id);
    await bumpLocalBook(
      client,
      state,
      userId,
      state.local_address_book_id ?? state.address_book_id,
    );
    return publicConflict({ ...state, ...result.conflict });
  });
}

async function refreshConflictAfter412(userId, preflight, remote) {
  const document = remote.tombstone ? null : parseVCardDocument(remote.vcard);
  await withTransaction(async client => {
    await client.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
    const state = await readResolutionState(client, userId, preflight.id, true);
    if (!sameResolutionFence(state, preflight)) throw staleConflict(preflight.id);
    const result = await refreshUnresolvedConflict(client, {
      addressBookId: state.address_book_id,
      href: state.href,
      expectedMappingRevision: state.mapping_revision,
      userId,
      baseLocalHash: state.base_local_hash,
      remoteEtag: remote.etag,
      primaryEmail: document ? primaryEmail(contactFromVCardDocument(document)) : null,
      vcardVersion: document?.version ?? null,
      remoteSemanticHash: document ? semanticVCardHash(document) : null,
      preserveLocalSnapshot: true,
      localVCard: undefined,
      remoteVCard: remote.vcard,
      localTombstone: undefined,
      remoteTombstone: remote.tombstone,
    });
    assertMappingApplied(result, state.id);
    if (result.conflict?.id !== state.id) throw staleConflict(state.id);
  });
}

export async function resolveConflict(userId, id, resolution) {
  if (!RESOLUTIONS.has(resolution)) {
    throw typedError(
      'Invalid CardDAV conflict resolution',
      'ERR_CARDDAV_CONFLICT_RESOLUTION',
    );
  }

  const preflight = await readResolutionState({ query }, userId, id);
  assertUnresolved(preflight, id);
  const creds = await credentials(preflight);

  if (resolution === 'keep-carddav') {
    const remote = await fetchLatestRemote(preflight, creds);
    return commitResolution(userId, preflight, resolution, remote);
  }

  const latest = await fetchLatestRemote(preflight, creds);
  try {
    if (preflight.local_tombstone) {
      if (!latest.tombstone) {
        await deleteCardResource({
          url: preflight.remote_book_url,
          href: preflight.href,
          etag: latest.etag,
          ...creds,
        });
      }
    } else {
      await putCardResource({
        url: preflight.remote_book_url,
        href: preflight.href,
        etag: latest.etag,
        vcard: preflight.local_vcard,
        ...creds,
      });
    }
  } catch (error) {
    if (error?.status !== 412) throw error;
    const refreshed = await fetchLatestRemote(preflight, creds);
    await refreshConflictAfter412(userId, preflight, refreshed);
    throw staleConflict(id);
  }
  const canonical = await fetchLatestRemote(preflight, creds);
  return commitResolution(userId, preflight, resolution, canonical);
}

export async function deleteResolvedConflictsBefore(client, cutoff) {
  const result = await client.query(
    `DELETE FROM carddav_conflicts
     WHERE status = 'resolved' AND resolved_at < $1`,
    [cutoff],
  );
  return result.rowCount;
}
