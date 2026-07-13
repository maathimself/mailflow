import { query } from './db.js';
import { getRightSidebarConfig } from './rightSidebarConfig.js';

// Group the rows a mutation touched by account, so one route call fans out to at most
// one emit per account. Message-IDs find same-message copies of the acted mail, thread
// keys find its thread siblings — section counts roll up per thread, so a sibling in a
// configured folder is just as relevant. `extraActedFolders` carries a destination that
// the rows can't name themselves — after a move, mail without a Message-ID can no longer
// be found by id.
export function groupSectionUpdateInputs(rows, extraActedFolders = []) {
  const byAccount = new Map();
  for (const message of rows || []) {
    if (!message?.account_id) continue;
    if (!message.message_id && !message.thread_key && !message.folder) continue;
    if (!byAccount.has(message.account_id)) {
      byAccount.set(message.account_id, { messageIds: new Set(), threadKeys: new Set(), actedFolders: new Set() });
    }
    const entry = byAccount.get(message.account_id);
    if (message.message_id) entry.messageIds.add(message.message_id);
    if (message.thread_key) entry.threadKeys.add(message.thread_key);
    if (message.folder) entry.actedFolders.add(message.folder);
  }
  return [...byAccount].map(([accountId, entry]) => ({
    accountId,
    messageIds: [...entry.messageIds],
    threadKeys: [...entry.threadKeys],
    actedFolders: [...entry.actedFolders, ...extraActedFolders.filter(folder => !entry.actedFolders.has(folder))],
  }));
}

// Broadcast only when the acted mail actually lives in a folder this account has
// configured as a sidebar section. Most mutations touch nothing configured, so the
// common case costs one cached config read and no broadcast at all.
export async function emitSectionUpdatesIfRelevant(imapManager, accountId, userId, messageIds, actedFolders, threadKeys) {
  if (!accountId || !userId) return;
  const ids = [...new Set((messageIds || []).filter(Boolean))];
  const threads = [...new Set((threadKeys || []).filter(Boolean))];
  const acted = new Set((actedFolders || []).filter(Boolean));
  if (!ids.length && !threads.length && !acted.size) return;

  const sidebarFolders = [...new Set((await getRightSidebarConfig(accountId).catch(() => []) || []).filter(Boolean))];
  if (!sidebarFolders.length) return;

  // A move/delete can drop the row before we look, so an acted folder counts on its own.
  const rows = ids.length || threads.length
    ? (await query(
      `SELECT DISTINCT folder FROM messages
        WHERE account_id = $1
          AND (message_id = ANY($2::text[]) OR thread_key = ANY($3::text[]))
          AND folder = ANY($4::text[])
          AND is_deleted = false`,
      [accountId, ids, threads, sidebarFolders]
    )).rows
    : [];

  const matched = new Set(rows.map(row => row.folder));
  if (sidebarFolders.some(folder => acted.has(folder) || matched.has(folder))) {
    imapManager.broadcast({ type: 'right_sidebar_updated', accountId }, userId);
  }
}
