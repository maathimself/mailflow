import { SNOOZED_FOLDER } from './messageService.js';

// Where an API token may not move mail (#617). Organize has to stay reversible: a token can never
// move mail back out of these, and some of them destroy it. Deleting from Trash or Drafts is a
// permanent expunge and providers purge Trash and Junk on their own; a message moved by hand into
// Snoozed (INBOX.Snoozed under an INBOX. namespace prefix) has no snooze record, so it never wakes;
// mail moved into a folder MailFlow does not sync (Gmail's All Mail, Starred and Important) drops
// out of every view. The roles come from folderRoles in utils/mailUtils.js, built from the SQL the
// rest of the server decides them by.
export const PROTECTED_DESTINATION_ERROR =
  'API tokens cannot move mail into Trash, Junk, Drafts, Snoozed or folders MailFlow does not sync';

const PROTECTED_SPECIAL_USE = new Set(['\\trash', '\\junk', '\\drafts', '\\all', '\\flagged']);

// As imapManager.js decides which of a provider's folders backfill and count observation skip.
export function providerSkipsFolder(profile, path) {
  const lower = path.toLowerCase();
  return profile.skipFolderPatterns.some(pattern => lower.includes(pattern)) || profile.skipFolderNames.includes(lower);
}

// roles: folderRoles(accountId, path); profile: providerProfile(account) from imapManager.js.
export function isProtectedDestination(path, roles, profile) {
  return roles.noSelect
    || PROTECTED_SPECIAL_USE.has(String(roles.specialUse ?? '').toLowerCase())
    || path === SNOOZED_FOLDER || roles.snoozed
    || roles.trash || roles.drafts || roles.spam
    || providerSkipsFolder(profile, path);
}
