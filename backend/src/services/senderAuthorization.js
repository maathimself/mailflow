import { query } from './db.js';
import { hasHeaderControlCharacters, normalizeEmailAddress, wildcardCovers } from './senderAddress.js';

// A stale/forbidden sender is a client fault surfaced as 422; the code lets send.js return
// the SENDER_UNAVAILABLE response shape without leaking why (row missing vs. never synced
// vs. revoked upstream all look identical to the caller).
function unavailable() {
  throw Object.assign(
    new Error('The selected sending address is no longer available. Refresh addresses or choose another sender.'),
    { status: 422, code: 'SENDER_UNAVAILABLE' },
  );
}

// sendable_addresses.reply_to is JSONB `[{name?, email}]`; nodemailer's replyTo option
// wants `[{name, address}] | string[]`. Drop any entry that fails to re-normalize (defense
// in depth — identitySync already validates on write) and return null for an empty list
// so the caller omits the header entirely instead of sending an empty Reply-To.
function mapReplyTo(value) {
  if (!Array.isArray(value) || !value.length) return null;
  const mapped = value.map(entry => {
    const email = normalizeEmailAddress(entry?.email);
    if (!email) return null;
    return (typeof entry?.name === 'string' && entry.name && !hasHeaderControlCharacters(entry.name))
      ? { name: entry.name, address: email }
      : email;
  }).filter(Boolean);
  return mapped.length ? mapped : null;
}

// Authorize an explicit From address against the account's private sendable_addresses set
// (identities synced read-only over JMAP). Exact address match wins; otherwise a `*@domain`
// wildcard row covering the candidate. Throws SENDER_UNAVAILABLE (422) on any miss.
export async function authorizeSendableAddress({ accountId, fromEmail }) {
  const normalized = normalizeEmailAddress(fromEmail);
  if (!normalized) unavailable();

  // kind-agnostic on purpose: a synced identity and a synced Masked Email address
  // authorize a From exactly the same way — `kind` only disambiguates how a row was
  // sourced (and its provider_id namespace), never whether it's usable.
  const result = await query(
    'SELECT address, name, reply_to FROM sendable_addresses WHERE account_id = $1',
    [accountId],
  );
  const rows = result.rows;
  const matched = rows.find(row => row.address === normalized)
    || rows.find(row => wildcardCovers(row.address, normalized));
  if (!matched) unavailable();
  // identitySync already rejects control-character names at write time; this is defense
  // in depth against a row that reached the table some other way.
  if (typeof matched.name === 'string' && hasHeaderControlCharacters(matched.name)) unavailable();

  return {
    fromName: typeof matched.name === 'string' ? matched.name : '',
    fromEmail: normalized,
    replyTo: mapReplyTo(matched.reply_to),
  };
}
