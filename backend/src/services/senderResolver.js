import { query } from './db.js';
import { syncFastmailAliases } from './fastmailAliasSync.js';
import { normalizeEmailAddress, wildcardCovers } from './senderAddress.js';
import { sanitizeSignature } from './emailSanitizer.js';

function normalizeAddress(value) {
  const address = typeof value === 'string' ? value : value?.email;
  return normalizeEmailAddress(address);
}

function exact(left, right) {
  const normalizedLeft = normalizeAddress(left);
  const normalizedRight = normalizeAddress(right);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

function resultForAlias(account, alias, { fromEmail, displayEmail }) {
  const signature = alias.signature !== null ? alias.signature : account.signature;
  return {
    accountId: account.id,
    aliasId: alias.id,
    fromEmail,
    displayEmail,
    name: alias.provenance === 'fastmail'
      ? (typeof alias.name === 'string' ? alias.name : '')
      : (alias.name || account.sender_name || account.name || ''),
    provenance: alias.provenance,
    signature: signature === null || signature === undefined
      ? null
      : sanitizeSignature(signature),
  };
}

function resultForPrimary(account) {
  return {
    accountId: account.id,
    aliasId: null,
    fromEmail: null,
    displayEmail: account.email_address,
    name: account.sender_name || account.name || '',
    provenance: 'primary',
  };
}

export function matchAuthorizedSender({ account, aliases, candidates }) {
  for (const candidate of candidates) {
    const providerExact = aliases.find(alias => (
      alias.provenance === 'fastmail'
      && alias.fastmail_identity_id
      && exact(alias.email, candidate)
    ));
    const manualExact = aliases.find(alias => (
      alias.provenance === 'manual' && exact(alias.email, candidate)
    ));
    if (providerExact) {
      return resultForAlias(account, providerExact, {
        fromEmail: null,
        displayEmail: providerExact.email,
      });
    }
    if (manualExact) {
      return resultForAlias(account, manualExact, {
        fromEmail: null,
        displayEmail: manualExact.email,
      });
    }
    if (exact(account.email_address, candidate)) return resultForPrimary(account);

    const wildcard = aliases.find(alias => (
      alias.provenance === 'fastmail'
      && alias.fastmail_identity_id
      && wildcardCovers(alias.email, candidate)
    ));
    if (wildcard) {
      const exactAddress = normalizeAddress(candidate);
      return resultForAlias(account, wildcard, {
        fromEmail: exactAddress,
        displayEmail: exactAddress,
      });
    }
  }
  return null;
}

function addressList(value) {
  let parsed = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.map(entry => typeof entry === 'string' ? entry : entry?.email).filter(Boolean);
}

async function loadAliases(accountId) {
  const result = await query(
    `SELECT id, account_id, name, email, signature, provenance, fastmail_identity_id
     FROM account_aliases
     WHERE account_id = $1
     ORDER BY created_at ASC`,
    [accountId],
  );
  return result.rows;
}

export async function resolveMessageSender({ messageId, userId, purpose }) {
  const messageResult = await query(
    `SELECT a.id, m.account_id, m.from_email, m.delivery_addresses,
            m.to_addresses, m.cc_addresses,
            a.email_address, a.sender_name, a.name, a.signature, a.fastmail_api_token
     FROM messages m
     JOIN email_accounts a ON a.id = m.account_id
     WHERE m.id = $1 AND a.user_id = $2 AND m.is_deleted = false`,
    [messageId, userId],
  );
  if (!messageResult.rows.length) {
    throw Object.assign(new Error('Message not found'), { status: 404 });
  }

  const message = messageResult.rows[0];
  const candidates = purpose === 'draft'
    ? [message.from_email]
    : [
        ...addressList(message.delivery_addresses),
        ...addressList(message.to_addresses),
        ...addressList(message.cc_addresses),
      ];
  let aliases = await loadAliases(message.account_id);
  let sender = matchAuthorizedSender({ account: message, aliases, candidates });

  if (!sender && purpose === 'reply' && message.fastmail_api_token) {
    try {
      await syncFastmailAliases(message.account_id);
    } catch {
      return { sender: null, requiresSelection: true };
    }
    aliases = await loadAliases(message.account_id);
    sender = matchAuthorizedSender({ account: message, aliases, candidates });
  }

  return { sender, requiresSelection: sender === null };
}
