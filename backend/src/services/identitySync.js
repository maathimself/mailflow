import { query, withTransaction } from './db.js';
import { decrypt } from './encryption.js';
import { loadJmapSession, fetchIdentities } from './jmapClient.js';
import { getConnectionPolicy } from './connectionPolicy.js';
import { hasHeaderControlCharacters, normalizeEmailAddress, normalizeSenderAddress } from './senderAddress.js';

// A Fastmail custom-domain identity can be a `*@domain` catch-all; normalizeSenderAddress
// accepts both that and a normal exact address, so wildcard identities sync the same way
// as any other.
function normalizeReplyToList(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const entry of value) {
    const email = normalizeEmailAddress(entry?.email);
    if (!email) continue;
    const name = typeof entry?.name === 'string' && !hasHeaderControlCharacters(entry.name) ? entry.name : undefined;
    out.push(name ? { name, email } : { email });
  }
  return out;
}

// Identities with an unusable address or a header-control-character name are skipped
// individually rather than failing the whole sync — one malformed identity on the
// provider side shouldn't block every other identity from syncing.
function normalizeIdentities(identities) {
  const normalized = [];
  for (const identity of identities || []) {
    if (!identity || typeof identity.id !== 'string' || !identity.id) continue;
    const address = normalizeSenderAddress(identity.email);
    if (!address) continue;
    const name = typeof identity.name === 'string' ? identity.name : '';
    if (hasHeaderControlCharacters(name)) continue;
    normalized.push({ providerId: identity.id, address, name, replyTo: normalizeReplyToList(identity.replyTo) });
  }
  return normalized;
}

// Upsert every synced identity by (account_id, kind, provider_id) and delete any existing
// identity row whose provider_id is no longer present — a single transaction so a manual
// refresh racing an account save can't leave a half-applied set. Scoped to kind='identity'
// so a future Masked Email sync (kind='masked') never touches these rows or vice versa.
async function reconcileIdentities(accountId, identities) {
  await withTransaction(async (client) => {
    for (const identity of identities) {
      await client.query(
        `INSERT INTO sendable_addresses (account_id, kind, provider_id, address, name, reply_to, synced_at)
         VALUES ($1, 'identity', $2, $3, $4, $5, NOW())
         ON CONFLICT (account_id, kind, provider_id) DO UPDATE
           SET address = EXCLUDED.address, name = EXCLUDED.name, reply_to = EXCLUDED.reply_to, synced_at = NOW()`,
        [accountId, identity.providerId, identity.address, identity.name, JSON.stringify(identity.replyTo)],
      );
    }
    await client.query(
      `DELETE FROM sendable_addresses
       WHERE account_id = $1 AND kind = 'identity' AND NOT (provider_id = ANY($2::varchar[]))`,
      [accountId, identities.map(identity => identity.providerId)],
    );
  });
}

function safeSyncErrorMessage(err) {
  return (err?.code === 'JMAP_CONFIG' || err?.code === 'JMAP_SYNC')
    ? err.message
    : 'JMAP synchronization failed';
}

// Load the account's identities over JMAP and reconcile them into sendable_addresses.
// No-op (not an error) when the account has no session URL or token configured. On
// failure, records the safe error message on the account row and rethrows so callers
// (accounts.js best-effort save-time sync, the manual refresh route, replySender's
// sync-on-miss) each decide how to surface it.
//
// Looks up the connection policy itself (rather than requiring every caller to fetch and
// pass it down) so the same allowPrivate the IMAP/SMTP fields honor also gates the user-
// configured JMAP session URL, however this function got invoked.
export async function syncAccountIdentities(accountId) {
  const result = await query(
    'SELECT jmap_session_url, jmap_api_token FROM email_accounts WHERE id = $1',
    [accountId],
  );
  const account = result.rows[0];
  if (!account) return { syncedAt: null };

  const token = decrypt(account.jmap_api_token);
  if (!account.jmap_session_url || !token) return { syncedAt: null };

  const { allowPrivateHosts: allowPrivate } = await getConnectionPolicy();
  try {
    const session = await loadJmapSession(account.jmap_session_url, token, { allowPrivate });
    const identities = await fetchIdentities(session, token, { allowPrivate });
    await reconcileIdentities(accountId, normalizeIdentities(identities));

    const syncedAt = new Date();
    await query(
      'UPDATE email_accounts SET jmap_identity_sync_at = $1, jmap_identity_sync_error = NULL WHERE id = $2',
      [syncedAt, accountId],
    );
    return { syncedAt };
  } catch (err) {
    await query(
      'UPDATE email_accounts SET jmap_identity_sync_error = $1 WHERE id = $2',
      [safeSyncErrorMessage(err), accountId],
    ).catch(() => {});
    throw err;
  }
}
