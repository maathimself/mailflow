// Keep client-side navigation state pointing only at accounts that still exist.
//
// selectedAccountId is restored from localStorage at startup and was never checked against
// the account list. Deleting the account you had selected therefore left the client pinned to
// an id the server no longer knows, and localStorage made it survive reloads. The symptoms
// looked unrelated to each other and none of them named the cause: the mailbox rendered empty,
// every folder poll for the dead account returned 404 on a 60s loop, and the favicon badge read
// `byAccount[selectedAccountId] ?? 0`, so it showed nothing while other accounts genuinely had
// unread mail.
//
// Both helpers return the input unchanged when they cannot improve on it, including the same
// object reference for folders, so a no-op cannot trigger a re-render.

/**
 * The account that should be selected, given the accounts that actually exist.
 * Returns null for the unified inbox, which is the right fallback: it is always valid.
 */
export function resolveSelectedAccount(accounts, selectedAccountId) {
  if (!selectedAccountId) return null;                    // already the unified inbox
  if (!Array.isArray(accounts)) return selectedAccountId; // list unknown, do not guess
  return accounts.some(a => a?.id === selectedAccountId) ? selectedAccountId : null;
}

/** Drop cached folder lists belonging to accounts that no longer exist. */
export function pruneFolders(folders, accounts) {
  if (!folders || !Array.isArray(accounts)) return folders;
  const live = new Set(accounts.map(a => a?.id).filter(Boolean));
  const ids = Object.keys(folders);
  const kept = ids.filter(id => live.has(id));
  if (kept.length === ids.length) return folders;         // unchanged: preserve identity
  return Object.fromEntries(kept.map(id => [id, folders[id]]));
}
