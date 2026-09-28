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
 *   2. an account carried by the compose request (a reply, forward or reopened draft)
 *   3. the user's configured default sender      (#417)
 *   4. the account whose folder is currently open
 *   5. the account last sent from
 *   6. the first account, by the user's own sidebar ordering
 *
 * The configured default outranks the open account as well as last-used. It is opt-in, and
 * someone who picked an address wants every new message to start from it, wherever they
 * happen to be reading; with only one account there is no unified inbox at all, so a
 * default that yielded to the open account would never apply. With no default configured
 * the open account still decides, as it always has.
 *
 * This only holds if a plain Compose does not carry the open account in its request, since
 * rung 2 would then outrank the default. New-message entry points pass no accountId and let
 * rung 4 supply it.
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
    defaultSender,
    selectedAccountId ? `${ACCOUNT_PREFIX}${selectedAccountId}` : null,
    lastUsedAccountId ? `${ACCOUNT_PREFIX}${lastUsedAccountId}` : null,
    list[0]?.id ? `${ACCOUNT_PREFIX}${list[0].id}` : null,
  ];

  for (const candidate of candidates) {
    if (isValidFromValue(candidate, list)) return candidate;
  }
  return '';
}
