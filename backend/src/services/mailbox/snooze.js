import { query } from '../db.js';
import { emitGtdIfRelevant } from '../gtdSections.js';
import { adjustFolderCounts } from '../../utils/mailUtils.js';

function emitGtdSectionsRefresh(imapManager, rows, userId) {
  const byAccount = new Map();
  for (const m of rows) {
    if (!m.message_id) continue;
    if (!byAccount.has(m.account_id)) byAccount.set(m.account_id, { mids: new Set(), folders: new Set() });
    const entry = byAccount.get(m.account_id);
    entry.mids.add(m.message_id);
    if (m.folder) entry.folders.add(m.folder);
  }
  for (const [accountId, { mids, folders }] of byAccount) {
    emitGtdIfRelevant(imapManager, accountId, userId, [...mids], [...folders])
      .catch(err => console.warn('GTD sections refresh emit failed:', err.message));
  }
}

async function connectedConversation(msg) {
  if (!msg.thread_id) {
    return { pool: [msg], seen: new Set([msg.message_id]) };
  }
  const pool = (await query(
    `SELECT id, uid, account_id, folder, message_id, in_reply_to, thread_references, is_read
     FROM messages
     WHERE account_id = $1 AND thread_id = $2 AND message_id IS NOT NULL`,
    [msg.account_id, msg.thread_id]
  )).rows;

  if (!pool.some(r => r.message_id === msg.message_id)) pool.push(msg);

  const refsOf = (r) => {
    const ids = (r.thread_references || '').match(/<[^>]+>/g) || [];
    if (r.in_reply_to) ids.push(r.in_reply_to);
    return ids;
  };

  const adj = new Map();
  const node = (m) => { let s = adj.get(m); if (!s) { s = new Set(); adj.set(m, s); } return s; };
  for (const r of pool) node(r.message_id);
  for (const r of pool) {
    for (const ref of refsOf(r)) {
      if (adj.has(ref)) { node(r.message_id).add(ref); node(ref).add(r.message_id); }
    }
  }
  const seen = new Set([msg.message_id]);
  const queue = [msg.message_id];
  while (queue.length) {
    const cur = queue.shift();
    for (const nb of (adj.get(cur) || [])) if (!seen.has(nb)) { seen.add(nb); queue.push(nb); }
  }
  return { pool, seen };
}

// Gather the reply-chain conversation that should be snoozed alongside `msg`.
export async function gatherSnoozeConversation(msg) {
  if (!msg.thread_id) return [msg];

  const { pool, seen } = await connectedConversation(msg);
  const already = new Set(
    (await query(
      'SELECT message_id_header FROM snoozed_messages WHERE account_id = $1 AND message_id_header = ANY($2)',
      [msg.account_id, [...seen]]
    )).rows.map(r => r.message_id_header)
  );
  const picked = new Map();
  for (const r of pool) {
    if (seen.has(r.message_id) && r.folder === msg.folder && !already.has(r.message_id) && !picked.has(r.message_id)) {
      picked.set(r.message_id, r);
    }
  }
  const rest = [...picked.values()].filter(r => r.message_id !== msg.message_id);
  const self = picked.get(msg.message_id) || msg;
  return [self, ...rest];
}

export async function restoreSnoozedRow(imapManager, row, { markUnread }) {
  const accountResult = await query('SELECT * FROM email_accounts WHERE id = $1', [row.account_id]);
  if (!accountResult.rows.length) return { restored: false };
  const account = accountResult.rows[0];

  // Guard source UID before the IMAP move so reconcileDeletes cannot delete
  // the DB row if an EXPUNGE arrives from the Snoozed folder while the move
  // is in flight.
  imapManager._guardMoveUid(row.account_id, row.snoozed_folder, row.uid);
  let newUid;
  try {
    newUid = await imapManager.moveMessageGetNewUid(
      account, row.uid, row.snoozed_folder, row.original_folder
    );

    if (markUnread && newUid) {
      await imapManager.setFlag(account, newUid, row.original_folder, '\\Seen', false);
    } else if (markUnread && row.message_id_header) {
      // No UIDPLUS — server moved the message but returned no UID map.
      // Search the destination folder by Message-ID to locate and unflag \Seen.
      try {
        await imapManager._withFreshClient(account, async (client) => {
          const lock = await client.getMailboxLock(row.original_folder);
          try {
            const uids = await client.search({ header: ['Message-ID', row.message_id_header] }, { uid: true });
            if (uids.length > 0) {
              const r = await client.messageFlagsRemove(String(uids[0]), ['\\Seen'], { uid: true });
              if (r === false) console.warn(`Snooze wakeup: messageFlagsRemove returned false for ${row.original_folder}`);
            } else {
              console.warn(`Snooze wakeup: could not find message in ${row.original_folder} to mark unread (Message-ID: ${row.message_id_header})`);
            }
          } finally {
            lock.release();
          }
        });
      } catch (err) {
        console.warn(`Snooze wakeup: could not mark message unread on server (no UIDPLUS): ${err.message}`);
      }
    }

    if (newUid != null) {
      if (markUnread) {
        await query(
          'UPDATE messages SET folder = $1, is_read = false, read_changed_at = NOW(), uid = $4 WHERE account_id = $2 AND message_id = $3 AND folder = $5',
          [row.original_folder, row.account_id, row.message_id_header, newUid, row.snoozed_folder]
        );
      } else {
        await query(
          'UPDATE messages SET folder = $1, uid = $4 WHERE account_id = $2 AND message_id = $3 AND folder = $5',
          [row.original_folder, row.account_id, row.message_id_header, newUid, row.snoozed_folder]
        );
      }
    } else {
      // Non-UIDPLUS: DB holds the stale source UID at the destination. Guard it so
      // reconcileDeletes does not treat it as an orphan before the next sync corrects it.
      imapManager._guardMoveUid(row.account_id, row.original_folder, row.uid);
      if (markUnread) {
        await query(
          'UPDATE messages SET folder = $1, is_read = false, read_changed_at = NOW() WHERE account_id = $2 AND message_id = $3 AND folder = $4',
          [row.original_folder, row.account_id, row.message_id_header, row.snoozed_folder]
        );
      } else {
        await query(
          'UPDATE messages SET folder = $1 WHERE account_id = $2 AND message_id = $3 AND folder = $4',
          [row.original_folder, row.account_id, row.message_id_header, row.snoozed_folder]
        );
      }
      setTimeout(() => imapManager._unguardMoveUid(row.account_id, row.original_folder, row.uid), 10_000);
    }
  } finally {
    imapManager._unguardMoveUid(row.account_id, row.snoozed_folder, row.uid);
  }

  return { restored: true, folder: row.original_folder, newUid: newUid ?? null };
}

export async function snoozeConversation(imapManager, { userId, accountIds, id, until }) {
  const accountClause = accountIds == null ? '' : ' AND m.account_id = ANY($3::uuid[])';
  const params = accountIds == null ? [id, userId] : [id, userId, accountIds];
  const msgResult = await query(
    `SELECT m.*, a.user_id FROM messages m
     JOIN email_accounts a ON a.id = m.account_id
     WHERE m.id = $1 AND a.user_id = $2${accountClause}`,
    params
  );
  if (!msgResult.rows.length) return { ok: false, status: 404, error: 'Message not found' };
  const msg = msgResult.rows[0];

  if (!msg.message_id) {
    return { ok: false, status: 400, error: 'Message has no Message-ID header — cannot snooze' };
  }

  const snoozedFolder = 'Snoozed';

  if (msg.folder === snoozedFolder) {
    return { ok: false, status: 400, error: 'Message is already in Snoozed folder' };
  }

  const existing = await query(
    'SELECT id FROM snoozed_messages WHERE account_id = $1 AND message_id_header = $2',
    [msg.account_id, msg.message_id]
  );
  if (existing.rows.length) return { ok: false, status: 400, error: 'Message is already snoozed' };

  const accountResult = await query('SELECT * FROM email_accounts WHERE id = $1', [msg.account_id]);
  const account = accountResult.rows[0];

  const convo = await gatherSnoozeConversation(msg);

  try {
    await imapManager.ensureFolder(account, snoozedFolder);
  } catch (err) {
    console.error(`Snooze ensureFolder failed for message ${id}:`, err.message);
    return { ok: false, status: 500, error: 'Failed to move message to Snoozed folder' };
  }

  const untilDate = until instanceof Date ? until : new Date(until);
  const movedIds = [];
  for (const tm of convo) {
    imapManager._guardMoveUid(tm.account_id, tm.folder, tm.uid);
    try {
      let snoozedUid;
      try {
        snoozedUid = await imapManager.moveMessage(account, tm.uid, tm.folder, snoozedFolder);
      } catch (err) {
        console.error(`Snooze IMAP move failed for message ${tm.id}:`, err.message);
        if (tm.id === msg.id) {
          return { ok: false, status: 500, error: 'Failed to move message to Snoozed folder' };
        }
        continue;
      }
      if (snoozedUid != null) {
        await query('UPDATE messages SET folder = $1, uid = $2 WHERE id = $3', [snoozedFolder, snoozedUid, tm.id]);
      } else {
        imapManager._guardMoveUid(tm.account_id, snoozedFolder, tm.uid);
        await query('UPDATE messages SET folder = $1 WHERE id = $2', [snoozedFolder, tm.id]);
        setTimeout(() => imapManager._unguardMoveUid(tm.account_id, snoozedFolder, tm.uid), 10_000);
      }

      await query(
        `INSERT INTO snoozed_messages (user_id, account_id, message_id_header, original_folder, snooze_until, snoozed_folder)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [userId, tm.account_id, tm.message_id, tm.folder, untilDate.toISOString(), snoozedFolder]
      );

      adjustFolderCounts(tm.account_id, tm.folder, -1, tm.is_read ? 0 : -1);
      adjustFolderCounts(tm.account_id, snoozedFolder, 1, tm.is_read ? 0 : 1);
      movedIds.push(tm.id);
    } finally {
      imapManager._unguardMoveUid(tm.account_id, tm.folder, tm.uid);
    }
  }

  emitGtdSectionsRefresh(imapManager, convo, userId);

  return {
    ok: true,
    movedCount: movedIds.length,
    movedIds,
    folder: snoozedFolder,
  };
}

export async function unsnoozeConversation(
  imapManager,
  { userId, accountIds, id, markUnread = false },
) {
  const accountClause = accountIds == null ? '' : ' AND m.account_id = ANY($3::uuid[])';
  const params = accountIds == null ? [id, userId] : [id, userId, accountIds];
  const msgResult = await query(
    `SELECT m.*, a.user_id FROM messages m
     JOIN email_accounts a ON a.id = m.account_id
     WHERE m.id = $1 AND a.user_id = $2${accountClause}`,
    params,
  );
  if (!msgResult.rows.length) return { ok: false, status: 404, error: 'Message not found' };
  const msg = msgResult.rows[0];

  const { seen } = await connectedConversation(msg);
  const snoozed = await query(
    `SELECT sm.id AS snooze_id, sm.user_id, sm.account_id,
            sm.message_id_header, sm.original_folder, sm.snoozed_folder,
            m.uid, m.is_read
     FROM snoozed_messages sm
     JOIN messages m ON m.account_id = sm.account_id
                    AND m.message_id = sm.message_id_header
                    AND m.folder = sm.snoozed_folder
                    AND m.is_deleted = false
     WHERE sm.user_id = $1
       AND sm.account_id = $2
       AND sm.message_id_header = ANY($3)`,
    [userId, msg.account_id, [...seen]],
  );
  const acted = snoozed.rows.find(row => row.message_id_header === msg.message_id);
  if (!acted) {
    return { ok: false, status: 400, error: 'Message is not currently snoozed' };
  }

  const rows = [acted, ...snoozed.rows.filter(row => row !== acted)];
  let restored = 0;
  for (const row of rows) {
    const outcome = await restoreSnoozedRow(imapManager, row, { markUnread });
    if (!outcome.restored) continue;
    await query('DELETE FROM snoozed_messages WHERE id = $1', [row.snooze_id]);
    adjustFolderCounts(row.account_id, row.snoozed_folder, -1, row.is_read ? 0 : -1);
    adjustFolderCounts(
      row.account_id,
      row.original_folder,
      1,
      markUnread || !row.is_read ? 1 : 0,
    );
    restored++;
  }

  if (restored > 0) {
    imapManager.broadcast?.({ type: 'snooze_wakeup', accountId: msg.account_id }, userId);
    emitGtdSectionsRefresh(imapManager, [msg], userId);
  }

  return { ok: true, restored, folder: acted.original_folder };
}
