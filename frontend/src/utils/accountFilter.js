// Sidebar mailbox filter. Pure functions: no DOM, no store, so they can be
// unit-tested with `node --test`. The filter only narrows what the sidebar
// renders; it never touches the account array, the selection or unread counts.

export function normalizeAccountFilter(query) {
  return typeof query === 'string' ? query.trim().toLowerCase() : '';
}

// Case-insensitive substring match on the account name and email address.
// A blank query returns the input array itself so callers can skip re-rendering.
export function filterAccounts(accounts, query) {
  const list = Array.isArray(accounts) ? accounts : [];
  const needle = normalizeAccountFilter(query);
  if (!needle) return list;
  return list.filter(account => [account?.name, account?.email_address]
    .some(value => typeof value === 'string' && value.toLowerCase().includes(needle)));
}
