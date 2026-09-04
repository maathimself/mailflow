// Which address a new message is sent from.
//
// The From selector encodes its value as either `account:<accountId>` or
// `alias:<aliasId>:<accountId>`, and that same encoding is what gets stored as the user's
// preferred default, so an alias can be the default and not just an account.
//
// Before #417 there was no rung on this ladder the user could set. In the unified inbox
// there is no selected account, so the sender fell through to whichever account was last
// sent from, recorded in localStorage. That drifts: send once from a secondary address and
// every later compose defaults to it, silently, until you send from something else. Being
// in localStorage it also never followed the user to another device, unlike the rest of
// their settings.

const ACCOUNT_PREFIX = 'account:';
const ALIAS_PREFIX = 'alias:';

/**
 * Does this From value still name an account (and alias) the user actually has?
 *
 * Preferences outlive the things they point at: an account can be removed or an alias
 * deleted long after being chosen as the default. An unvalidated value would leave the
 * composer with a From that cannot send, so every candidate is checked and a stale one is
 * skipped in favour of the next fallback.
 */
export function isValidFromValue(value, accounts) {
  if (typeof value !== 'string' || !value) return false;
  const list = Array.isArray(accounts) ? accounts : [];

  if (value.startsWith(ALIAS_PREFIX)) {
    const parts = value.split(':');
    if (parts.length !== 3) return false;
    const [, aliasId, accountId] = parts;
    if (!aliasId || !accountId) return false;
    const account = list.find(a => a && a.id === accountId);
    return Boolean(account && Array.isArray(account.aliases)
      && account.aliases.some(al => al && al.id === aliasId));
  }

  if (value.startsWith(ACCOUNT_PREFIX)) {
    const accountId = value.slice(ACCOUNT_PREFIX.length);
    return Boolean(accountId && list.some(a => a && a.id === accountId));
  }

  return false;
}

/**
 * The From value a newly opened composer should start on.
 *
 * In precedence order:
 *   1. an alias carried by the compose request  (a reply answering on the alias it arrived at)
 *   2. an account carried by the compose request (a reply or forward)
 *   3. the account whose folder is currently open (composing "from" that account)
 *   4. the user's configured default sender      (#417, the new rung)
 *   5. the account last sent from
 *   6. the first account, by the user's own sidebar ordering
 *
 * The configured default deliberately outranks last-used. Below it, the drift described
 * above would simply continue and setting a default would look like it did nothing. It sits
 * below the selected account because opening the composer while reading one account's mail
 * should still answer from that account; #417 is about the unified inbox, where there is no
 * such context.
 *
 * Replies and forwards are untouched: they carry their own account, and which identity a
 * reply answers on is decided earlier by pickReplyAlias.
 */
export function resolveInitialFrom({
  composeData = null,
  selectedAccountId = null,
  defaultSender = null,
  lastUsedAccountId = null,
  accounts = [],
} = {}) {
  const list = Array.isArray(accounts) ? accounts : [];

  if (composeData?.aliasId && composeData?.accountId) {
    return `${ALIAS_PREFIX}${composeData.aliasId}:${composeData.accountId}`;
  }

  const candidates = [
    composeData?.accountId ? `${ACCOUNT_PREFIX}${composeData.accountId}` : null,
    selectedAccountId ? `${ACCOUNT_PREFIX}${selectedAccountId}` : null,
    defaultSender,
    lastUsedAccountId ? `${ACCOUNT_PREFIX}${lastUsedAccountId}` : null,
    list[0]?.id ? `${ACCOUNT_PREFIX}${list[0].id}` : null,
  ];

  for (const candidate of candidates) {
    if (isValidFromValue(candidate, list)) return candidate;
  }
  return '';
}
