export function isAccountInUnifiedInbox(account) {
  return !!account?.enabled && account.include_in_unified_inbox !== false;
}

export function accountAffectsUnifiedInbox(accounts, accountId) {
  const account = accounts.find(candidate => candidate.id === accountId);
  return isAccountInUnifiedInbox(account);
}

export function unifiedUnreadTotal(byAccount, accounts) {
  return accounts.reduce((total, account) => (
    isAccountInUnifiedInbox(account)
      ? total + (Number(byAccount[account.id]) || 0)
      : total
  ), 0);
}
