export function resolveMessageListEmptyVisual({
  folderSyncing,
  searchQuery,
  unreadOnly,
  hasAccounts,
  selectedFolder,
}) {
  if (folderSyncing) return 'syncing';
  if (searchQuery) return 'search';
  if (unreadOnly) return 'unread';
  if (!hasAccounts) return 'no-accounts';
  return !selectedFolder || selectedFolder === 'INBOX' ? 'inbox-zero' : 'folder';
}
