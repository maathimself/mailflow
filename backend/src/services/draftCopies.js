import { query } from './db.js';
import { findOwnedAccount } from './ownership.js';
import { imapManager } from '../index.js';
import { resolveAllDraftsPaths } from '../utils/mailUtils.js';

// The server copies of drafts: where they live, which previous copy a save replaces, and the
// delete of the draft a message was sent from. routes/draft.js saves and deletes drafts through
// these; the send pipeline (services/outgoingMail.js) deletes the sent draft.

// Tells the user's tabs that a Drafts folder changed, so the Inbox re-checks its reply-draft
// markers. The composer refreshes its own tab; this reaches the user's other tabs and devices.
// Best-effort: the draft is already saved or deleted, and a failed notice only delays a marker.
export function noteDraftsChanged(userId, accountId) {
  try {
    imapManager.broadcast({ type: 'drafts_changed', accountId }, userId);
  } catch (err) {
    console.warn('Drafts change notice failed:', err.message);
  }
}

export async function resolveDraftsFolder(account) {
  const mapped = account.folder_mappings?.drafts;
  if (mapped) return mapped;
  const result = await query(
    "SELECT path FROM folders WHERE account_id = $1 AND special_use = '\\Drafts' LIMIT 1",
    [account.id]
  );
  return result.rows[0]?.path || null;
}

// These routes permanently expunge, so they may only touch a Drafts folder: the canonical set; the
// folder routes/draft.js appends drafts to (resolveDraftsFolder trusts the raw mapping, and a save must
// always be able to replace its own previous copy); and the server's own \Drafts folder, which the
// message list still opens as Drafts when the mapping points somewhere else.
export async function isDraftsPath(account, folder, draftsFolder) {
  if (typeof folder !== 'string' || !folder) return false;
  if (folder === (draftsFolder ?? await resolveDraftsFolder(account))) return true;
  if ((await resolveAllDraftsPaths(account.id, account.folder_mappings)).has(folder)) return true;
  const specialUse = await query(
    "SELECT 1 FROM folders WHERE account_id = $1 AND path = $2 AND special_use = '\\Drafts' LIMIT 1",
    [account.id, folder]
  );
  return specialUse.rows.length > 0;
}

// The previous copy a save replaces, or null (logged) when it cannot be pinned down. It lives in
// the account it was last saved to, which is not the saving account once From has been switched.
// The uid goes to IMAP as a UID set, so it must be a single uid ("1:*" would expunge the folder),
// in a Drafts folder, with a local row whose Message-ID the delete checks the server copy against.
export async function findReplacedDraft(userId, account, draftsFolder, { existingUid, existingFolder, existingAccountId }) {
  const refuse = (why) => {
    console.error(`Draft: refusing to delete old uid=${JSON.stringify(existingUid)} in folder ${JSON.stringify(existingFolder)}: ${why}`);
    return null;
  };
  const uid = (typeof existingUid === 'number' || typeof existingUid === 'string')
    && /^[1-9]\d*$/.test(String(existingUid)) ? Number(existingUid) : null;
  if (!uid) return refuse('not a single uid');

  // A composer from before existingAccountId was sent means the saving account.
  let holder = account;
  if (existingAccountId != null && existingAccountId !== account.id) {
    if (typeof existingAccountId !== 'string') return refuse('invalid account');
    holder = await findOwnedAccount(userId, existingAccountId);
    if (!holder) return refuse(`account ${JSON.stringify(existingAccountId)} not found`);
  }
  if (!(await isDraftsPath(holder, existingFolder, holder === account ? draftsFolder : undefined))) {
    return refuse('not a Drafts folder');
  }

  const { rows: [row] } = await query(
    'SELECT message_id FROM messages WHERE account_id = $1 AND uid = $2 AND folder = $3',
    [holder.id, uid, existingFolder]
  );
  if (!row?.message_id) return refuse('no local row with a Message-ID to check the server copy against');
  return { account: holder, uid, folder: existingFolder, messageId: row.message_id };
}

// Deletes the draft a message was sent from, once services/outgoingMail.js has delivered it. This runs on
// the server, after delivery, because with undo send the delivery happens after the composer has
// closed, possibly with the tab gone too: a draft deleted when Send was clicked would take with it
// the only other copy of a message whose delivery then failed. The checks are those of a save
// replacing its previous copy. Never throws: a draft left behind is logged, not a failed send.
export async function deleteSentDraft(userId, account, { uid, folder, accountId } = {}) {
  try {
    const target = await findReplacedDraft(userId, account, undefined, { existingUid: uid, existingFolder: folder, existingAccountId: accountId });
    if (!target) return false;
    const deleted = await imapManager.permanentDeleteMessage(target.account, target.uid, target.folder, { expectMessageId: target.messageId });
    if (!deleted) {
      console.error(`Draft: not deleting sent draft uid=${target.uid} in folder ${JSON.stringify(target.folder)}: the server copy's Message-ID does not match its local row`);
      return false;
    }
    await query('DELETE FROM messages WHERE account_id = $1 AND uid = $2 AND folder = $3', [target.account.id, target.uid, target.folder]);
    noteDraftsChanged(userId, target.account.id);
    return true;
  } catch (err) {
    console.error(`Draft: failed to delete sent draft uid=${JSON.stringify(uid)}: ${err.message}`);
    return false;
  }
}
