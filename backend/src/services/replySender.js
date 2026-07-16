import { query } from './db.js';
import { syncAccountIdentities } from './identitySync.js';
import { normalizeEmailAddress, wildcardCovers } from './senderAddress.js';

// A synced identity set older than this is worth one re-sync attempt before giving up on a
// reply-time match — long enough that every reply doesn't trigger a JMAP round trip, short
// enough that a newly-added Fastmail identity shows up without the user opening Settings.
const STALE_SYNC_MS = 15 * 60 * 1000;

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
  return parsed.map(entry => (typeof entry === 'string' ? entry : entry?.email)).filter(Boolean);
}

function normalizeCandidates(list) {
  return list.map(email => normalizeEmailAddress(email)).filter(Boolean);
}

async function loadMessageAndAccount(messageId, userId) {
  const result = await query(
    `SELECT m.account_id, m.delivery_addresses, m.to_addresses, m.cc_addresses,
            a.email_address AS account_email, a.jmap_api_token, a.jmap_identity_sync_at
     FROM messages m
     JOIN email_accounts a ON a.id = m.account_id
     WHERE m.id = $1 AND a.user_id = $2 AND m.is_deleted = false`,
    [messageId, userId],
  );
  if (!result.rows.length) {
    throw Object.assign(new Error('Message not found'), { status: 404 });
  }
  return result.rows[0];
}

async function loadAliasEmails(accountId) {
  const result = await query('SELECT email FROM account_aliases WHERE account_id = $1', [accountId]);
  return result.rows.map(row => normalizeEmailAddress(row.email)).filter(Boolean);
}

async function loadSendableRows(accountId) {
  const result = await query(
    `SELECT address, name FROM sendable_addresses WHERE account_id = $1 AND kind = 'identity'`,
    [accountId],
  );
  return result.rows;
}

// Candidates are checked in order (delivery-to, then To, then Cc — envelope truth first);
// for each candidate an exact address match wins over a wildcard match, matching the old
// matchAuthorizedSender precedence.
function matchSendable(rows, candidates) {
  for (const candidate of candidates) {
    const exact = rows.find(row => row.address === candidate);
    if (exact) return { fromEmail: candidate, name: typeof exact.name === 'string' ? exact.name : '' };
    const wildcard = rows.find(row => wildcardCovers(row.address, candidate));
    if (wildcard) return { fromEmail: candidate, name: typeof wildcard.name === 'string' ? wildcard.name : '' };
  }
  return null;
}

// Resolve the transient reply From: an address the message was delivered/addressed to that
// the account is authorized (via synced JMAP identities) to send as, but that isn't already
// one of the addresses MailFlow trusts today (account primary / a saved alias — those are
// already auto-selected before this resolver runs). Never returns the full sendable set,
// only the single best match.
export async function resolveReplySender({ messageId, userId }) {
  const message = await loadMessageAndAccount(messageId, userId);

  const excluded = new Set([
    normalizeEmailAddress(message.account_email),
    ...(await loadAliasEmails(message.account_id)),
  ].filter(Boolean));

  const candidates = normalizeCandidates([
    ...addressList(message.delivery_addresses),
    ...addressList(message.to_addresses),
    ...addressList(message.cc_addresses),
  ]).filter(candidate => !excluded.has(candidate));

  if (!candidates.length) return { sender: null };

  const rows = await loadSendableRows(message.account_id);
  let sender = matchSendable(rows, candidates);
  if (sender) return { sender };

  const isStale = !message.jmap_identity_sync_at
    || (Date.now() - new Date(message.jmap_identity_sync_at).getTime()) > STALE_SYNC_MS;
  if (message.jmap_api_token && isStale) {
    try {
      await syncAccountIdentities(message.account_id);
    } catch {
      return { sender: null };
    }
    sender = matchSendable(await loadSendableRows(message.account_id), candidates);
  }

  return { sender };
}
