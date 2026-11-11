// A folder is "spam-like" when the user mapped it as spam or the IMAP server tagged it with
// \Junk special-use. Unconfigured accounts fall back to a multilingual name match. Mirrors
// resolveAllSpamPaths on the backend so server and client agree.
export const SPAM_NAME_RE = /(spam|junk|bulk|indesiderata|spamverdacht|courrier\s*ind|posta\s*indesiderata)/i;

export function spamFolderPaths(account, folders) {
  const mapped = account?.folder_mappings?.spam;
  if (mapped) return new Set([mapped]);
  return new Set((folders || []).filter(f =>
    f.special_use === '\\Junk' || SPAM_NAME_RE.test(f.name || '')
  ).map(f => f.path));
}

// Which spam action the selection bar offers for `messages`.
// `pathsFor(accountId)` returns that account's spam folder paths, or null while its folder list
// has not loaded.
//   action: 'ham' when every message sits in its account's spam folder, otherwise 'spam'.
//   enabled: 'ham' always; 'spam' only when no message is in a spam folder and every account has
//            a spam folder to move to.
//   pending: some account's folders are still unknown, so 'spam' cannot be confirmed yet.
export function selectionSpamAction(messages, pathsFor) {
  if (!messages.length) return { action: 'spam', enabled: false, pending: false };
  let inSpam = 0;
  let pending = false;
  let missingFolder = false;
  for (const m of messages) {
    const paths = pathsFor(m.account_id);
    if (!paths) { pending = true; continue; }
    if (paths.has(m.folder)) inSpam += 1;
    else if (paths.size === 0) missingFolder = true;
  }
  if (inSpam === messages.length) return { action: 'ham', enabled: true, pending: false };
  return { action: 'spam', enabled: inSpam === 0 && !pending && !missingFolder, pending };
}
