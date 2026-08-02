import { query } from './db.js';
import { imapManager } from '../index.js';
import { encrypt } from './encryption.js';
import { hasHeaderInjectionChars, sanitizeSignature } from './emailSanitizer.js';
import { validateHost } from './hostValidation.js';
import { getConnectionPolicy } from './connectionPolicy.js';
import { safeAccount } from './accountFields.js';
import { createKeyedSerializer } from '../utils/keyedSerializer.js';

// Serialize an account's reconnect triggers so a rapid settings change (e.g. a
// gtd_enabled double-toggle) can't fire two overlapping disconnect→connect chains —
// connectAccount's in-progress guard would drop the second and leave the GTD sync
// tick armed inconsistently with the final DB value. Queued per account id.
const reconnectQueue = createKeyedSerializer();

export const ALLOWED_IMAP_PORTS = new Set([143, 993]);
export const ALLOWED_SMTP_PORTS = new Set([465, 587]);

export function validatePort(port, allowed) {
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    return `Port ${port} is not a valid port number`;
  }
  // When private/local hosts are explicitly allowed (e.g. Proton Mail Bridge on 1143/1025),
  // skip the whitelist — the operator has already opted into unrestricted host access.
  if (process.env.ALLOW_PRIVATE_IMAP_HOSTS === 'true') return null;
  if (!allowed.has(n)) {
    return `Port ${port} is not allowed. Allowed: ${[...allowed].join(', ')}`;
  }
  return null;
}

async function validateAccountFields(fields) {
  const {
    name, sender_name = null, email_address,
    imap_host, imap_port = 993,
    smtp_host, smtp_port = 587,
  } = fields;

  if (!name || !email_address) return { error: 'Name and email required', status: 400 };
  if (hasHeaderInjectionChars(name) || hasHeaderInjectionChars(email_address)) {
    return { error: 'Name and email address cannot contain control characters', status: 400 };
  }
  if (sender_name && hasHeaderInjectionChars(sender_name)) {
    return { error: 'Sender name cannot contain control characters', status: 400 };
  }

  const policy = await getConnectionPolicy();

  if (imap_host) {
    const err = (await validateHost(imap_host, { allowPrivate: policy.allowPrivateHosts }))
      || (!policy.allowNonstandardPorts && validatePort(imap_port, ALLOWED_IMAP_PORTS));
    if (err) return { error: `IMAP: ${err}`, status: 400 };
  }
  if (smtp_host) {
    const err = (await validateHost(smtp_host, { allowPrivate: policy.allowPrivateHosts }))
      || (!policy.allowNonstandardPorts && validatePort(smtp_port, ALLOWED_SMTP_PORTS));
    if (err) return { error: `SMTP: ${err}`, status: 400 };
  }
  return null;
}

export async function createAccount({ userId, fields }) {
  const validation = await validateAccountFields(fields);
  if (validation) return validation;

  const {
    name, sender_name = null, email_address, color = '#6366f1', protocol = 'imap',
    imap_host, imap_port = 993, imap_skip_tls_verify = false,
    smtp_host, smtp_port = 587, smtp_tls = 'STARTTLS',
    auth_user, auth_pass,
    oauth_provider, oauth_access_token, oauth_refresh_token,
    signature = null
  } = fields;

  try {
    const result = await query(`
      INSERT INTO email_accounts (
        user_id, name, sender_name, email_address, color, protocol,
        imap_host, imap_port, imap_tls, imap_skip_tls_verify, smtp_host, smtp_port, smtp_tls,
        auth_user, auth_pass, oauth_provider, oauth_access_token, oauth_refresh_token,
        signature
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
      RETURNING *
    `, [
      userId, name, sender_name || null, email_address, color, protocol,
      imap_host, imap_port, Number(imap_port) % 1000 === 993, !!imap_skip_tls_verify, smtp_host, smtp_port, smtp_tls,
      auth_user, encrypt(auth_pass), oauth_provider, encrypt(oauth_access_token), encrypt(oauth_refresh_token),
      sanitizeSignature(signature) || null
    ]);

    const account = result.rows[0];

    // Immediately try to connect — needs full credentials from DB row
    if (protocol === 'imap') {
      imapManager.connectAccount(account).catch(console.error);
    }

    return { account: safeAccount(account) };
  } catch (err) {
    console.error(err);
    return { error: 'Failed to add account', status: 500 };
  }
}

export function reconcileConnectionState({ id, updates, before, updated }) {
  const gtdFoldersChanged = !!before?.gtdFoldersChanged;
  const isDisabling = 'enabled' in updates && !updates.enabled;
  const needsReconnect = !isDisabling && (
    'enabled' in updates ||
    'auth_user' in updates ||
    'auth_pass' in updates ||
    'imap_host' in updates ||
    'imap_port' in updates ||
    'imap_tls' in updates ||
    'imap_skip_tls_verify' in updates ||
    'gtd_enabled' in updates ||
    gtdFoldersChanged
  );

  // Both branches queue through the per-account serializer so overlapping settings
  // changes (e.g. a rapid gtd_enabled double-toggle) apply their connection-state
  // effects in order, never as two overlapping chains.
  if (isDisabling) {
    reconnectQueue(id, () => imapManager.disconnectAccount(id))
      .catch(err => console.error(`Failed to disconnect account ${id} after disable:`, err.message));
  } else if (needsReconnect && updated.protocol === 'imap' && updated.enabled) {
    reconnectQueue(id, () =>
      imapManager.disconnectAccount(id)
        .then(() => query('SELECT * FROM email_accounts WHERE id = $1', [id]))
        .then(r => { if (r.rows.length) return imapManager.connectAccount(r.rows[0]); })
    ).catch(err => console.error(`Failed to reconnect account ${id} after update:`, err.message));
  }
}

const STAGED_SECRET_FIELDS = [
  'auth_pass',
  'oauth_access_token',
  'oauth_refresh_token',
];

export async function stageAccount({ userId, payload }) {
  for (const key of STAGED_SECRET_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) {
      throw new Error(`Staged account payload cannot contain ${key}`);
    }
  }

  const validation = await validateAccountFields(payload);
  if (validation) return validation;

  const stagedPayload = {
    ...payload,
    signature: sanitizeSignature(payload.signature) || null,
  };
  const result = await query(
    `INSERT INTO mcp_account_stages (user_id, payload)
     VALUES ($1, $2)
     RETURNING *`,
    [userId, stagedPayload]
  );
  return result.rows[0];
}

export async function listStages(userId) {
  const result = await query(
    `SELECT id, status, payload, created_at, completed_account_id
     FROM mcp_account_stages
     WHERE user_id = $1 AND status = 'staged'
     ORDER BY created_at`,
    [userId]
  );
  return result.rows;
}

export async function completeAccountStage({ stageId, userId, credentials }) {
  const stageResult = await query(
    `SELECT id, payload
     FROM mcp_account_stages
     WHERE id = $1 AND user_id = $2 AND status = 'staged'`,
    [stageId, userId]
  );
  if (!stageResult.rows.length) return null;

  const freshCredentials = {};
  for (const key of STAGED_SECRET_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(credentials || {}, key)) {
      freshCredentials[key] = credentials[key];
    }
  }
  const fields = {
    ...stageResult.rows[0].payload,
    ...freshCredentials,
  };

  // createAccount performs the same host/port/header validation again before
  // writing, providing defense in depth if a staged payload was tampered with.
  const created = await createAccount({ userId, fields });
  if (created.error) {
    throw Object.assign(new Error(created.error), {
      status: created.status,
      expose: true,
    });
  }

  await query(
    `UPDATE mcp_account_stages
     SET status = 'completed', completed_account_id = $1
     WHERE id = $2 AND user_id = $3 AND status = 'staged'
     RETURNING id`,
    [created.account.id, stageId, userId]
  );
  return created.account;
}

export async function discardAccountStage({ stageId, userId }) {
  const result = await query(
    `UPDATE mcp_account_stages
     SET status = 'discarded'
     WHERE id = $1 AND user_id = $2 AND status = 'staged'
     RETURNING id`,
    [stageId, userId]
  );
  return result.rows.length > 0;
}
