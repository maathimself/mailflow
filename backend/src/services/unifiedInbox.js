export function resolveAccountScope(accounts, requestedAccountId) {
  const ownedIds = accounts.map(account => account.id);
  const isSpecificAccount = requestedAccountId && ownedIds.includes(requestedAccountId);

  return {
    accountIds: isSpecificAccount
      ? [requestedAccountId]
      : accounts
        .filter(account => account.include_in_unified_inbox !== false)
        .map(account => account.id),
    resolvedAccountId: isSpecificAccount ? requestedAccountId : null,
  };
}
