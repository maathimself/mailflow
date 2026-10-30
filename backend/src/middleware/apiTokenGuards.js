import { query } from '../services/db.js';
import { draftMessageSql, folderRoles, resolveArchiveFolder } from '../utils/mailUtils.js';
import { providerProfile } from '../services/imapManager.js';
import { isValidFolderName, areValidUUIDs, gatherSnoozeConversation } from '../routes/mail.js';
import { isUuid } from '../utils/uuid.js';
import { isProtectedDestination, PROTECTED_DESTINATION_ERROR } from '../services/apiTokenDestinations.js';

// Checks on an API token request that need its body, so they run once it has been parsed, after
// the screen-lock gate and before the routers (#617). The allowlist entry names its guard. A
// guard answers null to let the request through, or { status, error } to refuse it.
export async function apiTokenGuards(req, res, next) {
  const name = req.apiToken?.route?.guard;
  if (!name) return next();
  try {
    const guard = GUARDS.get(name);
    // An entry naming a guard that does not exist must not pass unchecked.
    if (!guard) throw new Error(`No API token guard named ${name}`);
    const refusal = await guard(req);
    if (refusal) return res.status(refusal.status).json({ error: refusal.error });
    next();
  } catch (err) {
    next(err);
  }
}

const DRAFT_SOURCE_ERROR = 'API tokens cannot move or archive drafts';
export const ALL_MAIL_ARCHIVE_ERROR = "API tokens cannot archive into Gmail's All Mail, where the mail drops out of MailFlow. "
  + "Create a Gmail label named Archive, or choose an archive folder in the account's settings.";
export const PROTECTED_ARCHIVE_ERROR = 'API tokens cannot archive into Trash, Junk, Drafts, Snoozed or folders MailFlow does not sync: '
  + "check the account's archive folder setting.";
const PLAIN_TEXT_ERROR = 'API token drafts must be plain text';

// What the bulk routes accept: 1 to 500 UUID strings. Anything else is left to the route's own
// 400, so it never reaches the uuid[] cast below.
const acceptedIds = ids => Array.isArray(ids) && ids.length >= 1 && ids.length <= 500 && areValidUUIDs(ids);

// The accounts the user's messages among `ids` are in, and whether any of those messages is a
// draft, by the definition the conversation view uses to keep drafts out of conversation actions.
// Sweeping a conversation would otherwise carry the user's unsent reply out of Drafts, and on
// Gmail an archive into All Mail deletes MailFlow's rows.
async function sourceAccounts(userId, ids) {
  const { rows } = await query(
    `SELECT a.id, a.imap_host, a.oauth_provider, a.folder_mappings, bool_or(${draftMessageSql('m')}) AS has_draft
       FROM messages m JOIN email_accounts a ON a.id = m.account_id
      WHERE m.id = ANY($2::uuid[]) AND a.user_id = $1
      GROUP BY a.id`,
    [userId, ids]
  );
  return rows;
}

// An archive goes to the folder resolveArchiveFolder picks for each account, as in the route, and
// that folder is held to the same rules as a move's destination: an archive mapping can point
// anywhere, Trash or Junk included. On Gmail without an archive label or mapping, it is All Mail:
// Gmail only drops the Inbox label, but MailFlow does not sync All Mail, so the mail leaves every
// view and only Gmail can bring it back. The archive button still does that; a token may not.
async function bulkArchive(req) {
  const { ids } = req.body ?? {};
  if (!acceptedIds(ids)) return null;
  const accounts = await sourceAccounts(req.session.userId, ids);
  if (accounts.some(a => a.has_draft)) return { status: 403, error: DRAFT_SOURCE_ERROR };
  for (const account of accounts) {
    const destination = await resolveArchiveFolder(account.id, account.folder_mappings);
    if (!destination) continue; // the route reports an account with no archive folder
    const roles = await folderRoles(account.id, destination);
    if (!roles) continue;
    if (String(roles.specialUse ?? '').toLowerCase() === '\\all') return { status: 403, error: ALL_MAIL_ARCHIVE_ERROR };
    if (isProtectedDestination(destination, roles, providerProfile(account))) return { status: 403, error: PROTECTED_ARCHIVE_ERROR };
  }
  return null;
}

// bulk-move takes any folder path the account has. Each message moves within its own account, so
// the destination is checked in every account the messages are in; an account without that
// folder is skipped by the route.
async function bulkMove(req) {
  const { ids, folder } = req.body ?? {};
  if (!acceptedIds(ids) || !isValidFolderName(folder)) return null;
  const accounts = await sourceAccounts(req.session.userId, ids);
  if (accounts.some(a => a.has_draft)) return { status: 403, error: DRAFT_SOURCE_ERROR };
  for (const account of accounts) {
    const roles = await folderRoles(account.id, folder);
    if (roles && isProtectedDestination(folder, roles, providerProfile(account))) {
      return { status: 403, error: PROTECTED_DESTINATION_ERROR };
    }
  }
  return null;
}

const SNOOZE_PATH = /^\/api\/mail\/messages\/([^/]+)\/snooze$/;

// Snoozing moves the message into Snoozed with the rest of its reply chain in the same folder, so
// every message the route would move is checked, found as the route finds them. A message the user
// does not have, or one without a Message-ID, is left to the route, which moves nothing for it.
async function snooze(req) {
  const [, id] = SNOOZE_PATH.exec(req.originalUrl.split('?')[0]) ?? [];
  if (!isUuid(id)) return null;
  const { rows: [msg] } = await query(
    `SELECT m.* FROM messages m JOIN email_accounts a ON a.id = m.account_id
      WHERE m.id = $1 AND a.user_id = $2`,
    [id, req.session.userId]
  );
  if (!msg?.message_id) return null;
  const moving = await gatherSnoozeConversation(msg);
  const accounts = await sourceAccounts(req.session.userId, moving.map(m => m.id));
  if (accounts.some(a => a.has_draft)) return { status: 403, error: DRAFT_SOURCE_ERROR };
  return null;
}

const absent = value => value === undefined || value === null;
const HEADER_BREAK = /[\r\n\0]/;

// A token saves new plain-text drafts only, and only with fields draft.js would otherwise take
// unchecked.
function draft(req) {
  const body = req.body ?? {};
  // Replacing a draft permanently expunges the copy it replaces.
  if (!absent(body.existingUid) || !absent(body.existingFolder) || !absent(body.existingAccountId)) {
    return { status: 403, error: 'API tokens can only create new drafts' };
  }
  // draft.js deletes the scheduled message a draft was made from (fromScheduled). A token may
  // draft, never take back a message due to go out.
  if (!absent(body.fromScheduled)) return { status: 403, error: 'API tokens cannot remove a scheduled message' };
  // draft.js takes any truthy bodyIsHtml for HTML, and stores quotedBodyHtml as it is.
  if (!(absent(body.bodyIsHtml) || body.bodyIsHtml === false) || !absent(body.quotedBodyHtml)) {
    return { status: 400, error: PLAIN_TEXT_ERROR };
  }
  // Unchecked, a malformed id reaches a uuid comparison and answers 500.
  if (!isUuid(body.accountId)) return { status: 400, error: 'Invalid accountId' };
  if (!absent(body.aliasId) && !isUuid(body.aliasId)) return { status: 400, error: 'Invalid aliasId' };
  // send.js refuses these characters in recipients; draft.js does not check.
  for (const field of ['to', 'cc', 'bcc']) {
    const list = body[field];
    if (absent(list)) continue;
    if (!Array.isArray(list) || list.some(addr => typeof addr !== 'string' || HEADER_BREAK.test(addr))) {
      return { status: 400, error: `Invalid ${field}` };
    }
  }
  // A string would be stored as the signature, which is HTML.
  if (body.editedSignature !== undefined && body.editedSignature !== '') {
    return { status: 400, error: "API token drafts can only use the account's signature or none" };
  }
  for (const field of ['subject', 'body', 'quotedBody', 'inReplyTo', 'references']) {
    if (!absent(body[field]) && typeof body[field] !== 'string') return { status: 400, error: `Invalid ${field}` };
  }
  body.bodyIsHtml = false;
  return null;
}

const GUARDS = new Map(Object.entries({ bulkArchive, bulkMove, snooze, draft }));
export const GUARD_NAMES = [...GUARDS.keys()];
