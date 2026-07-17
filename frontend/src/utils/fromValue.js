// Encode/decode the ComposeModal From <select> value. Three forms:
//   account:<accountId>                  — the account's own primary address
//   alias:<aliasId>:<accountId>           — a saved alias
//   sendas:<accountId>:<fromEmail>        — a transient, non-persisted From (the reply-time
//                                           delivered-to match authorized by a synced JMAP
//                                           identity); selectable only while this draft is open,
//                                           never saved as an alias.
export function accountFromValue(accountId) {
  return `account:${accountId}`;
}

export function aliasFromValue(aliasId, accountId) {
  return `alias:${aliasId}:${accountId}`;
}

export function sendAsFromValue(accountId, fromEmail) {
  return `sendas:${accountId}:${fromEmail}`;
}

export function resolveFromValue(value) {
  if (!value) return { accountId: '', aliasId: null, fromEmail: null };
  if (value.startsWith('alias:')) {
    const [, aliasId, accountId] = value.split(':');
    return { accountId, aliasId, fromEmail: null };
  }
  if (value.startsWith('sendas:')) {
    // The address itself can't contain ':', but split defensively on the first two
    // separators only, so nothing downstream depends on that assumption.
    const parts = value.split(':');
    return { accountId: parts[1], aliasId: null, fromEmail: parts.slice(2).join(':') };
  }
  return { accountId: value.replace('account:', ''), aliasId: null, fromEmail: null };
}
