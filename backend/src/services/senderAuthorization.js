import { query } from './db.js';
import {
  hasHeaderControlCharacters,
  normalizeEmailAddress,
  normalizeWildcardAddress,
  wildcardCovers,
} from './senderAddress.js';

// A stale/forbidden sender is a client fault surfaced as 422; the code lets routes
// return the SENDER_UNAVAILABLE response shape without leaking why.
function unavailable() {
  throw Object.assign(
    new Error('The selected sending address is no longer available. Refresh addresses or choose another sender.'),
    { status: 422, code: 'SENDER_UNAVAILABLE' },
  );
}

function providerAddressList(value) {
  if (!Array.isArray(value)) unavailable();
  return value.map(address => {
    const email = normalizeEmailAddress(address?.email);
    const name = address?.name ?? '';
    if (!email || typeof name !== 'string' || hasHeaderControlCharacters(name)) unavailable();
    return name ? { name, address: email } : email;
  });
}

export async function authorizeSender({ userId, sender }, queryFn = query) {
  if (!sender || typeof sender !== 'object' || !sender.accountId) unavailable();

  const accountResult = await queryFn(
    'SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2',
    [sender.accountId, userId],
  );
  if (!accountResult.rows.length) unavailable();
  const account = accountResult.rows[0];

  if (sender.aliasId === null) {
    if (sender.fromEmail !== null) unavailable();
    return {
      account,
      fromName: account.sender_name || account.name,
      fromEmail: account.email_address,
      fromReplyTo: null,
      fromSignature: account.signature,
    };
  }

  if (typeof sender.aliasId !== 'string' || !sender.aliasId) unavailable();

  const aliasResult = await queryFn(
    'SELECT * FROM account_aliases WHERE id = $1 AND account_id = $2',
    [sender.aliasId, account.id],
  );
  if (!aliasResult.rows.length) unavailable();
  const alias = aliasResult.rows[0];
  if (alias.account_id !== account.id) unavailable();

  const wildcardPattern = normalizeWildcardAddress(alias.email);
  let fromEmail;
  if (wildcardPattern) {
    const isVerifiedWildcard = alias.provenance === 'fastmail'
      && Boolean(alias.fastmail_identity_id)
      && wildcardPattern === alias.email.trim().toLowerCase();
    const normalizedFrom = normalizeEmailAddress(sender.fromEmail);
    if (!isVerifiedWildcard || !normalizedFrom || !wildcardCovers(wildcardPattern, normalizedFrom)) unavailable();
    fromEmail = normalizedFrom;
  } else {
    if (sender.fromEmail !== null) unavailable();
    if (alias.provenance === 'fastmail' && !alias.fastmail_identity_id) unavailable();
    fromEmail = normalizeEmailAddress(alias.email);
    if (!fromEmail) unavailable();
  }

  const fromReplyTo = alias.provenance === 'fastmail'
    ? providerAddressList(alias.fastmail_reply_to)
    : (alias.reply_to || null);

  return {
    account,
    fromName: alias.provenance === 'fastmail'
      ? (typeof alias.name === 'string' ? alias.name : '')
      : (alias.name || account.sender_name || account.name),
    fromEmail,
    // A Fastmail identity with no Reply-To yields []; normalize to null so callers omit
    // the header (`fromReplyTo ? ... : {}`) instead of emitting an empty Reply-To.
    fromReplyTo: Array.isArray(fromReplyTo) && !fromReplyTo.length ? null : fromReplyTo,
    fromBcc: alias.provenance === 'fastmail'
      ? providerAddressList(alias.fastmail_bcc)
      : [],
    fromSignature: alias.signature !== null ? alias.signature : account.signature,
  };
}
