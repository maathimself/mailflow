export function mailboxQueryScope(accountId, folder) {
  if (accountId) return { accountId, folder };
  return folder === 'ALL_MAIL' ? { folder } : {};
}

export function mailboxTitle(accountId, folder, complete, unifiedInboxTitle, t = (_key, { defaultValue }) => defaultValue) {
  if (!accountId && folder === 'ALL_MAIL') {
    return complete
      ? t('sidebar.allMail', { defaultValue: 'All Mail' })
      : t('sidebar.allMailSyncing', { defaultValue: 'All Mail (syncing)' });
  }
  return accountId ? folder : unifiedInboxTitle;
}
