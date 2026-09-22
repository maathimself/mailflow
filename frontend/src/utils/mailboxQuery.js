export function mailboxQueryScope(accountId, folder) {
  if (accountId) return { accountId, folder };
  return folder === 'ALL_MAIL' ? { folder } : {};
}

export function mailboxTitle(accountId, folder, complete, unifiedInboxTitle) {
  if (!accountId && folder === 'ALL_MAIL') return complete ? 'All Mail' : 'All Mail (syncing)';
  return accountId ? folder : unifiedInboxTitle;
}
