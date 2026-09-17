import { query } from '../services/db.js';

// Generic per-plugin storage — lets a plugin own data without raw DB access.
//
// A record is keyed by (pluginId, key) and holds a JSON `value`, an optional binary `blob`
// (+ mime), an optional `ownerId` (a user; the row is cascade-deleted when they're deleted),
// and a `visibility` flag the plugin can use for its own read gating. Modeled on the existing
// user_integrations table, extended to carry blobs. See migration 0041_plugin_data.sql.
//
// This is the first safe, generic capability of the plugin platform: the GTD inbox-zero pet
// is its first consumer, and it's the storage surface future (sandboxed) plugins will use.

export async function put(pluginId, key, { value = {}, blob = null, mime = null, ownerId = null, visibility = 'private' } = {}) {
  await query(
    `INSERT INTO plugin_data (plugin_id, key, owner_id, value, blob, blob_mime, visibility, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, NOW())
     ON CONFLICT (plugin_id, key) DO UPDATE SET
       owner_id   = EXCLUDED.owner_id,
       value      = EXCLUDED.value,
       blob       = EXCLUDED.blob,
       blob_mime  = EXCLUDED.blob_mime,
       visibility = EXCLUDED.visibility,
       updated_at = NOW()`,
    [pluginId, key, ownerId, JSON.stringify(value), blob, mime, visibility]
  );
}

// Metadata (no blob) — key, owner, JSON value, visibility. Null when absent.
export async function getValue(pluginId, key) {
  const { rows } = await query(
    `SELECT key, owner_id, value, visibility FROM plugin_data WHERE plugin_id = $1 AND key = $2`,
    [pluginId, key]
  );
  return rows[0] || null;
}

// The binary blob + mime (and owner/visibility for gating). Null when absent.
export async function getBlob(pluginId, key) {
  const { rows } = await query(
    `SELECT blob, blob_mime, owner_id, visibility FROM plugin_data WHERE plugin_id = $1 AND key = $2`,
    [pluginId, key]
  );
  return rows[0] || null;
}

export async function del(pluginId, key) {
  await query(`DELETE FROM plugin_data WHERE plugin_id = $1 AND key = $2`, [pluginId, key]);
}

// All records for a plugin scoped to one owner, ordered by key. Returns metadata only (no blob).
export async function listByOwner(pluginId, ownerId) {
  const { rows } = await query(
    `SELECT key, owner_id, value, visibility FROM plugin_data WHERE plugin_id = $1 AND owner_id = $2 ORDER BY key`,
    [pluginId, ownerId]
  );
  return { rows };
}
