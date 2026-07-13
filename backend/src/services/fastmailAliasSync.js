import { pool, query } from './db.js';
import { decrypt } from './encryption.js';
import { sanitizeSignature } from './emailSanitizer.js';
import {
  hasHeaderControlCharacters,
  normalizeEmailAddress,
  normalizeSenderAddress,
  wildcardCovers,
} from './senderAddress.js';
import {
  createFastmailIdentities,
  fastmailSyncError,
  fetchFastmailSnapshot,
  loadFastmailSession,
} from './fastmailClient.js';

const FASTMAIL_SYNC_INTERVAL_MS = 15 * 60 * 1000;
const FASTMAIL_SYNC_CONCURRENCY = 3;
const FASTMAIL_LOCK_WAIT_MS = (3 * 60 * 1000) + 30 * 1000;
const FASTMAIL_LOCK_RETRY_MS = 100;
const FASTMAIL_MASK_STATES = new Set(['pending', 'enabled', 'disabled', 'deleted']);
const FASTMAIL_LOCK_NAMESPACE = 'mailflow:fastmail-alias-sync';
// A full session/get/set/get sequence times out within two minutes. Retain an
// ambiguous create claim beyond that window before allowing a safe retry.
const FASTMAIL_PROMOTION_CLAIM_TTL = '5 minutes';
const inFlight = new Map();
const syncWaiters = [];
let activeSyncs = 0;

// A distinct sync-class error: another worker holds the promotion claim, so this sync
// must back off. Its own code lets the caller skip recording it as a persistent sync
// error while still treating it as a synchronization failure.
function fastmailPromotionPendingError() {
  return Object.assign(
    new Error('Fastmail identity promotion is already in progress'),
    { code: 'FASTMAIL_PROMOTION_PENDING' },
  );
}

async function withSyncSlot(callback) {
  if (activeSyncs >= FASTMAIL_SYNC_CONCURRENCY) {
    await new Promise(resolve => syncWaiters.push(resolve));
  } else {
    activeSyncs += 1;
  }
  try {
    return await callback();
  } finally {
    const next = syncWaiters.shift();
    if (next) next();
    else activeSyncs -= 1;
  }
}

async function acquireFastmailLock(accountId) {
  // The database session owns this lock for the whole remote sync, so unlike a
  // leased Redis key it cannot expire while a worker is still reconciling.
  const client = await pool.connect();
  const lock = { accountId, client, connectionError: null, onError: null };
  lock.onError = error => {
    lock.connectionError ||= error;
  };
  client.on('error', lock.onError);
  const deadline = Date.now() + FASTMAIL_LOCK_WAIT_MS;
  try {
    do {
      assertFastmailLock(lock);
      const result = await client.query(
        'SELECT pg_try_advisory_lock(hashtext($1), hashtext($2)) AS acquired',
        [FASTMAIL_LOCK_NAMESPACE, String(accountId)],
      );
      assertFastmailLock(lock);
      if (result.rows[0]?.acquired) return lock;
      await new Promise(resolve => setTimeout(resolve, FASTMAIL_LOCK_RETRY_MS));
    } while (Date.now() < deadline);
  } catch (error) {
    client.off('error', lock.onError);
    client.release(lock.connectionError || error);
    throw error;
  }
  client.off('error', lock.onError);
  client.release();
  throw fastmailSyncError('Fastmail synchronization is already in progress');
}

function assertFastmailLock(lock) {
  if (lock.connectionError) {
    throw fastmailSyncError('Fastmail synchronization lock was lost');
  }
}

async function withFastmailLock(lock, operation) {
  assertFastmailLock(lock);
  const result = await operation();
  assertFastmailLock(lock);
  return result;
}

async function withFastmailTransaction(lock, operation) {
  assertFastmailLock(lock);
  await lock.client.query('BEGIN');
  try {
    assertFastmailLock(lock);
    const result = await operation(lock.client);
    assertFastmailLock(lock);
    await lock.client.query('COMMIT');
    return result;
  } catch (error) {
    await lock.client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

async function releaseFastmailLock(lock) {
  let releaseError = lock.connectionError;
  try {
    if (!releaseError) {
      await lock.client.query(
        'SELECT pg_advisory_unlock(hashtext($1), hashtext($2))',
        [FASTMAIL_LOCK_NAMESPACE, String(lock.accountId)],
      );
    }
  } catch (error) {
    releaseError = error;
    throw error;
  } finally {
    lock.client.off('error', lock.onError);
    if (releaseError) lock.client.release(releaseError);
    else lock.client.release();
  }
}

function identitySignature(identity) {
  if (identity.htmlSignature.trim()) {
    return sanitizeSignature(identity.htmlSignature);
  }
  if (!identity.textSignature) return '';
  const escaped = identity.textSignature
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replace(/\r\n|\r|\n/g, '<br>');
  return sanitizeSignature(escaped);
}

function identityAddressList(value) {
  if (value === null) return [];
  if (!Array.isArray(value)) throw fastmailSyncError('Fastmail returned an invalid alias snapshot');
  return value.map(address => {
    const email = normalizeEmailAddress(address?.email);
    const name = address?.name ?? '';
    if (!email || typeof name !== 'string' || hasHeaderControlCharacters(name)) {
      throw fastmailSyncError('Fastmail returned an invalid alias snapshot');
    }
    return { name, email };
  });
}

function aliasFromIdentity(identity, email) {
  const fastmailReplyTo = identityAddressList(identity.replyTo);
  const fastmailBcc = identityAddressList(identity.bcc);
  return {
    email,
    name: identity.name,
    replyTo: fastmailReplyTo[0]?.email || null,
    signature: identitySignature(identity),
    fastmailReplyTo,
    fastmailBcc,
    fastmailIdentityId: identity.id,
    fastmailMaskedEmailId: null,
    fastmailLabel: null,
  };
}

export function mergeFastmailSnapshot({ account, identities, maskedEmails }) {
  if (!Array.isArray(identities) || !Array.isArray(maskedEmails)) {
    throw fastmailSyncError('Fastmail returned an invalid alias snapshot');
  }
  const aliases = [];
  const identitiesByAddress = new Map();
  const wildcardIdentities = [];
  const identityIds = new Set();
  const maskedEmailIds = new Set();

  for (const identity of identities) {
    const email = normalizeSenderAddress(identity?.email);
    if (
      !identity || typeof identity.id !== 'string' || !identity.id
      || identityIds.has(identity.id)
      || !email
      || typeof identity.name !== 'string'
      || hasHeaderControlCharacters(identity.name)
      || typeof identity.textSignature !== 'string'
      || typeof identity.htmlSignature !== 'string'
      || (identity.replyTo !== null && !Array.isArray(identity.replyTo))
      || (identity.bcc !== null && !Array.isArray(identity.bcc))
    ) {
      throw fastmailSyncError('Fastmail returned an invalid alias snapshot');
    }
    identityIds.add(identity.id);
    const alias = aliasFromIdentity(identity, email);
    aliases.push(alias);
    if (email.startsWith('*@')) wildcardIdentities.push(email);
    const sameAddress = identitiesByAddress.get(email) || [];
    sameAddress.push(alias);
    identitiesByAddress.set(email, sameAddress);
  }

  const missingMasks = [];
  for (const mask of maskedEmails) {
    const email = normalizeEmailAddress(mask?.email);
    if (
      !mask || typeof mask.id !== 'string' || !mask.id
      || maskedEmailIds.has(mask.id)
      || !email
      || !FASTMAIL_MASK_STATES.has(mask.state)
      || typeof mask.description !== 'string'
    ) {
      throw fastmailSyncError('Fastmail returned an invalid alias snapshot');
    }
    maskedEmailIds.add(mask.id);
    if (mask.state !== 'enabled') continue;
    const exact = identitiesByAddress.get(email)?.[0];
    if (exact) {
      exact.fastmailMaskedEmailId = mask.id;
      exact.fastmailLabel = mask.description;
      continue;
    }
    const wildcard = wildcardIdentities.find(pattern => wildcardCovers(pattern, email));
    const maskAlias = {
      email,
      name: account.sender_name || account.name || '',
      replyTo: null,
      signature: '',
      fastmailReplyTo: [],
      fastmailBcc: [],
      fastmailIdentityId: null,
      fastmailMaskedEmailId: mask.id,
      fastmailLabel: mask.description,
    };
    aliases.push(maskAlias);
    if (!wildcard) missingMasks.push({ ...mask, email });
  }

  return { aliases, missingMasks };
}

function safeSyncMessage(error) {
  // Fastmail config/sync errors (including the promotion-pending sync sub-case) carry
  // fixed, user-safe messages; anything else is reduced to a generic status.
  if (error.code === 'FASTMAIL_CONFIG'
      || error.code === 'FASTMAIL_SYNC'
      || error.code === 'FASTMAIL_PROMOTION_PENDING') {
    return error.message;
  }
  return 'Fastmail synchronization failed';
}

async function clearResolvedPromotionClaims(accountId, missingMasks) {
  await query(
    `DELETE FROM fastmail_identity_promotions
     WHERE account_id = $1
       AND NOT (masked_email_id = ANY($2::varchar[]))`,
    [accountId, missingMasks.map(mask => mask.id)],
  );
}

async function claimFastmailPromotions(accountId, missingMasks) {
  if (!missingMasks.length) return [];
  const claims = missingMasks.map(mask => ({ id: mask.id, email: mask.email }));
  const result = await query(
    `INSERT INTO fastmail_identity_promotions (account_id, masked_email_id, email, claimed_at)
     SELECT $1, item.id, item.email, NOW()
     FROM jsonb_to_recordset($2::jsonb) AS item(id varchar(255), email varchar(255))
     ON CONFLICT (account_id, masked_email_id) DO UPDATE
       SET email = EXCLUDED.email, claimed_at = NOW()
       WHERE fastmail_identity_promotions.claimed_at < NOW() - $3::interval
     RETURNING masked_email_id`,
    [accountId, JSON.stringify(claims), FASTMAIL_PROMOTION_CLAIM_TTL],
  );
  const claimedIds = new Set(result.rows.map(row => row.masked_email_id));
  return missingMasks.filter(mask => claimedIds.has(mask.id));
}

async function recordSyncError(accountId, credentialVersion, error) {
  await query(
    `UPDATE email_accounts
     SET fastmail_sync_error = $2
     WHERE id = $1 AND fastmail_api_token = $3`,
    [accountId, safeSyncMessage(error), credentialVersion],
  );
}

async function loadLockedAccount(client, accountId) {
  const accountResult = await client.query(
    `SELECT *
     FROM email_accounts
     WHERE id = $1
     FOR UPDATE`,
    [accountId],
  );
  return accountResult.rows[0] || null;
}

async function reconcileFastmailAliases(client, accountId, credentialVersion, aliases) {
  const existingResult = await client.query(
    `SELECT id, email, fastmail_identity_id, fastmail_masked_email_id
     FROM account_aliases
     WHERE account_id = $1 AND provenance = 'fastmail'`,
    [accountId],
  );
  const providerKey = alias => {
    if (alias.fastmailIdentityId) return `identity:${alias.fastmailIdentityId}`;
    if (alias.fastmailMaskedEmailId) return `mask:${alias.fastmailMaskedEmailId}`;
    return null;
  };
  const existingByProviderKey = new Map(
    existingResult.rows
      .map(row => [providerKey({
        fastmailIdentityId: row.fastmail_identity_id,
        fastmailMaskedEmailId: row.fastmail_masked_email_id,
      }), row])
      .filter(([key]) => key),
  );
  const existingByMaskId = new Map(
    existingResult.rows
      .filter(row => row.fastmail_masked_email_id)
      .map(row => [row.fastmail_masked_email_id, row]),
  );
  const retainedIds = [];

  for (const alias of aliases) {
    if (!alias.fastmailMaskedEmailId) continue;
    const previousHolder = existingByMaskId.get(alias.fastmailMaskedEmailId);
    if (!previousHolder
        || previousHolder.fastmail_identity_id === alias.fastmailIdentityId) continue;
    await client.query(
      `UPDATE account_aliases
       SET fastmail_masked_email_id = NULL, fastmail_label = NULL
       WHERE account_id = $1 AND provenance = 'fastmail'
         AND fastmail_masked_email_id = $2
         AND fastmail_identity_id IS DISTINCT FROM $3`,
      [accountId, alias.fastmailMaskedEmailId, alias.fastmailIdentityId],
    );
  }

  for (const alias of aliases) {
    const existing = existingByProviderKey.get(providerKey(alias));
    if (existing) {
      await client.query(
        `UPDATE account_aliases
         SET name = $1, email = $2, reply_to = $3, signature = $4,
             fastmail_identity_id = $5, fastmail_masked_email_id = $6,
             fastmail_label = $7, fastmail_reply_to = $8, fastmail_bcc = $9
         WHERE id = $10 AND account_id = $11 AND provenance = 'fastmail'`,
        [
          alias.name, alias.email, alias.replyTo, alias.signature,
          alias.fastmailIdentityId, alias.fastmailMaskedEmailId, alias.fastmailLabel,
          JSON.stringify(alias.fastmailReplyTo), JSON.stringify(alias.fastmailBcc),
          existing.id, accountId,
        ],
      );
      retainedIds.push(existing.id);
    } else {
      const inserted = await client.query(
        `INSERT INTO account_aliases (
           account_id, name, email, reply_to, signature, provenance,
           fastmail_identity_id, fastmail_masked_email_id, fastmail_label,
           fastmail_reply_to, fastmail_bcc
         ) VALUES ($1, $2, $3, $4, $5, 'fastmail', $6, $7, $8, $9, $10)
         RETURNING id`,
        [
          accountId, alias.name, alias.email, alias.replyTo, alias.signature,
          alias.fastmailIdentityId, alias.fastmailMaskedEmailId, alias.fastmailLabel,
          JSON.stringify(alias.fastmailReplyTo), JSON.stringify(alias.fastmailBcc),
        ],
      );
      retainedIds.push(inserted.rows[0].id);
    }
  }

  if (retainedIds.length) {
    await client.query(
      `DELETE FROM account_aliases
       WHERE account_id = $1 AND provenance = 'fastmail' AND NOT (id = ANY($2))`,
      [accountId, retainedIds],
    );
  } else {
    await client.query(
      "DELETE FROM account_aliases WHERE account_id = $1 AND provenance = 'fastmail'",
      [accountId],
    );
  }
  await client.query(
    `UPDATE email_accounts
     SET fastmail_last_sync = NOW(), fastmail_sync_error = NULL
     WHERE id = $1 AND fastmail_api_token = $2`,
    [accountId, credentialVersion],
  );
}

async function performSync(accountId) {
  return withSyncSlot(async () => {
    const lock = await acquireFastmailLock(accountId);
    let credentialVersion;
    try {
      const accountResult = await query(
        'SELECT * FROM email_accounts WHERE id = $1',
        [accountId],
      );
      const account = accountResult.rows[0];
      if (!account?.fastmail_api_token) {
        throw fastmailSyncError('Fastmail is not configured for this account');
      }
      credentialVersion = account.fastmail_api_token;
      const token = decrypt(credentialVersion);
      if (!token) throw fastmailSyncError('Fastmail API token could not be decrypted');

      const session = await withFastmailLock(lock, () => loadFastmailSession(token));
      let remote = await withFastmailLock(lock, () => fetchFastmailSnapshot(session, token));
      let merged = mergeFastmailSnapshot({ account, ...remote });
      await withFastmailLock(lock, () => clearResolvedPromotionClaims(accountId, merged.missingMasks));

      if (merged.missingMasks.length) {
        const claimed = await withFastmailLock(
          lock,
          () => claimFastmailPromotions(accountId, merged.missingMasks),
        );
        const claimedIds = new Set(claimed.map(mask => mask.id));
        const pendingIds = new Set(
          merged.missingMasks.filter(mask => !claimedIds.has(mask.id)).map(mask => mask.id),
        );
        if (claimed.length) {
          await withFastmailLock(lock, () => createFastmailIdentities(session, token, claimed.map(mask => ({
            name: account.sender_name || account.name,
            email: normalizeEmailAddress(mask.email),
          }))));
          remote = await withFastmailLock(lock, () => fetchFastmailSnapshot(session, token));
          merged = mergeFastmailSnapshot({ account, ...remote });
          await withFastmailLock(lock, () => clearResolvedPromotionClaims(accountId, merged.missingMasks));
        }
        if (merged.missingMasks.some(mask => pendingIds.has(mask.id))) {
          throw fastmailPromotionPendingError();
        }
      }

      await withFastmailTransaction(lock, async client => {
        const lockedAccount = await loadLockedAccount(client, accountId);
        if (lockedAccount?.fastmail_api_token !== credentialVersion) {
          throw fastmailSyncError('Fastmail credentials changed during synchronization');
        }
        await reconcileFastmailAliases(client, accountId, credentialVersion, merged.aliases);
      });
      if (merged.missingMasks.length) {
        throw fastmailSyncError('Fastmail did not authorize every enabled Masked Email address');
      }
      return merged.aliases;
    } catch (error) {
      try {
        if (
          credentialVersion
          && !lock.connectionError
          && error.code !== 'FASTMAIL_PROMOTION_PENDING'
        ) {
          await recordSyncError(accountId, credentialVersion, error);
        }
      } catch {
        // Preserve the original failure. Error-status persistence is best effort and
        // intentionally has no sensitive context to log.
      }
      throw error;
    } finally {
      try {
        await releaseFastmailLock(lock);
      } catch {
        console.error('Fastmail synchronization lock release failed');
      }
    }
  });
}

export function syncFastmailAliases(accountId, options = {}) {
  const current = inFlight.get(accountId);
  if (current && !options.credentialChanged) return current;
  const work = current
    ? current.catch(() => {}).then(() => performSync(accountId))
    : performSync(accountId);
  const promise = work.finally(() => {
    if (inFlight.get(accountId) === promise) inFlight.delete(accountId);
  });
  inFlight.set(accountId, promise);
  return promise;
}

export async function syncAllFastmailAliases() {
  const result = await query(
    `SELECT id FROM email_accounts
     WHERE enabled = true AND fastmail_api_token IS NOT NULL`,
  );
  const queue = [...result.rows];
  let failed = false;
  async function worker() {
    while (queue.length) {
      const { id } = queue.shift();
      try {
        await syncFastmailAliases(id);
      } catch {
        failed = true;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(FASTMAIL_SYNC_CONCURRENCY, queue.length) }, worker));
  if (failed) throw fastmailSyncError('One or more Fastmail accounts failed to synchronize');
}

function logSafeSyncFailure() {
  console.error('Fastmail background synchronization failed');
}

export function startFastmailAliasScheduler() {
  syncAllFastmailAliases().catch(logSafeSyncFailure);
  const timer = setInterval(
    () => syncAllFastmailAliases().catch(logSafeSyncFailure),
    FASTMAIL_SYNC_INTERVAL_MS,
  );
  timer.unref();
  return timer;
}
