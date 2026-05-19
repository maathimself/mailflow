import { query } from './db.js';

function adjustFolderCounts(accountId, path, totalDelta, unreadDelta) {
  if (totalDelta === 0 && unreadDelta === 0) return;
  query(
    `UPDATE folders
        SET total_count  = GREATEST(0, total_count  + $1),
            unread_count = GREATEST(0, unread_count + $2)
      WHERE account_id = $3 AND path = $4`,
    [totalDelta, unreadDelta, accountId, path]
  ).catch(err => console.error('Folder count adjust failed:', err.message));
}

export async function resolveTrashFolder(accountId) {
  const { rows } = await query(
    `SELECT path FROM folders WHERE account_id = $1
     AND (special_use = '\\Trash' OR lower(name) LIKE '%trash%') LIMIT 1`,
    [accountId]
  );
  return rows[0]?.path ?? null;
}

export async function resolveArchiveFolder(accountId, folderMappings) {
  if (folderMappings?.archive) return folderMappings.archive;
  const { rows } = await query(
    `SELECT path FROM folders WHERE account_id = $1
     AND (special_use = '\\Archive' OR lower(name) LIKE '%archive%') LIMIT 1`,
    [accountId]
  );
  return rows[0]?.path ?? null;
}

export async function setMessageRead(id, userId, read, imapManager) {
  const { rows } = await query(
    `SELECT m.*, a.user_id FROM messages m
     JOIN email_accounts a ON m.account_id = a.id
     WHERE m.id = $1 AND a.user_id = $2`,
    [id, userId]
  );
  if (!rows.length) throw Object.assign(new Error('Message not found'), { status: 404 });
  const message = rows[0];

  const [, accountResult] = await Promise.all([
    query('UPDATE messages SET is_read = $1, read_changed_at = NOW() WHERE id = $2', [read, id]),
    query('SELECT * FROM email_accounts WHERE id = $1', [message.account_id]),
  ]);

  if (!!message.is_read !== !!read) {
    adjustFolderCounts(message.account_id, message.folder, 0, read ? -1 : 1);
  }
  if (imapManager) {
    imapManager.setFlag(accountResult.rows[0], message.uid, message.folder, '\\Seen', read)
      .catch(err => console.error('IMAP flag update failed:', err.message));
  }
  return { ok: true, is_read: read };
}

export async function setMessageStarred(id, userId, starred, imapManager) {
  const { rows } = await query(
    `SELECT m.*, a.user_id FROM messages m
     JOIN email_accounts a ON m.account_id = a.id
     WHERE m.id = $1 AND a.user_id = $2`,
    [id, userId]
  );
  if (!rows.length) throw Object.assign(new Error('Message not found'), { status: 404 });
  const message = rows[0];

  const [, accountResult] = await Promise.all([
    query('UPDATE messages SET is_starred = $1, star_changed_at = NOW() WHERE id = $2', [starred, id]),
    query('SELECT * FROM email_accounts WHERE id = $1', [message.account_id]),
  ]);

  if (imapManager) {
    imapManager.setFlag(accountResult.rows[0], message.uid, message.folder, '\\Flagged', starred)
      .catch(err => console.error('IMAP star update failed:', err.message));
  }
  return { ok: true, is_starred: starred };
}

export async function moveSingleMessage(id, userId, toFolder, imapManager) {
  const { rows } = await query(
    `SELECT m.*, a.user_id FROM messages m
     JOIN email_accounts a ON m.account_id = a.id
     WHERE m.id = $1 AND a.user_id = $2`,
    [id, userId]
  );
  if (!rows.length) throw Object.assign(new Error('Message not found'), { status: 404 });
  const message = rows[0];

  const { rows: accountRows } = await query('SELECT * FROM email_accounts WHERE id = $1', [message.account_id]);
  const newUid = await imapManager.moveMessage(accountRows[0], message.uid, message.folder, toFolder);
  if (newUid != null) {
    await query('UPDATE messages SET folder = $1, uid = $2 WHERE id = $3', [toFolder, newUid, id]);
  } else {
    await query('UPDATE messages SET folder = $1 WHERE id = $2', [toFolder, id]);
  }
  return { ok: true };
}

export async function deleteSingleMessage(id, userId, imapManager) {
  const { rows } = await query(
    `SELECT m.*, a.user_id FROM messages m
     JOIN email_accounts a ON m.account_id = a.id
     WHERE m.id = $1 AND a.user_id = $2`,
    [id, userId]
  );
  if (!rows.length) {
    const err = new Error('Message not found');
    err.status = 404;
    throw err;
  }
  const message = rows[0];

  const [trashResult, accountResult] = await Promise.all([
    query(
      `SELECT path FROM folders WHERE account_id = $1
       AND (special_use = '\\Trash' OR lower(name) LIKE '%trash%') LIMIT 1`,
      [message.account_id]
    ),
    query('SELECT * FROM email_accounts WHERE id = $1', [message.account_id]),
  ]);

  const wasUnread = !message.is_read ? 1 : 0;
  if (trashResult.rows.length) {
    const trashPath = trashResult.rows[0].path;
    const newUid = await imapManager.moveMessage(accountResult.rows[0], message.uid, message.folder, trashPath);
    if (newUid != null) {
      await query('UPDATE messages SET folder = $1, uid = $2 WHERE id = $3', [trashPath, newUid, id]);
    } else {
      await query('UPDATE messages SET folder = $1 WHERE id = $2', [trashPath, id]);
    }
    adjustFolderCounts(message.account_id, message.folder, -1, -wasUnread);
    adjustFolderCounts(message.account_id, trashPath, 1, wasUnread);
    return { ok: true, trashPath };
  } else {
    await query('UPDATE messages SET is_deleted = true WHERE id = $1', [id]);
    adjustFolderCounts(message.account_id, message.folder, -1, -wasUnread);
    return { ok: true };
  }
}

export async function archiveSingleMessage(id, userId, imapManager) {
  const { rows } = await query(
    `SELECT m.*, a.user_id, a.folder_mappings FROM messages m
     JOIN email_accounts a ON m.account_id = a.id
     WHERE m.id = $1 AND a.user_id = $2`,
    [id, userId]
  );
  if (!rows.length) {
    const err = new Error('Message not found');
    err.status = 404;
    throw err;
  }
  const message = rows[0];

  const archiveFolder = await resolveArchiveFolder(message.account_id, message.folder_mappings);
  if (!archiveFolder) {
    const err = new Error('Archive folder not found for this account');
    err.status = 422;
    throw err;
  }

  const { rows: accountRows } = await query('SELECT * FROM email_accounts WHERE id = $1', [message.account_id]);
  const newUid = await imapManager.moveMessage(accountRows[0], message.uid, message.folder, archiveFolder);

  if (newUid != null) {
    await query('UPDATE messages SET folder = $1, uid = $2 WHERE id = $3', [archiveFolder, newUid, id]);
  } else {
    await query('UPDATE messages SET folder = $1 WHERE id = $2', [archiveFolder, id]);
  }

  const wasUnread = !message.is_read ? 1 : 0;
  adjustFolderCounts(message.account_id, message.folder, -1, -wasUnread);
  adjustFolderCounts(message.account_id, archiveFolder, 1, wasUnread);

  return { ok: true, archiveFolder };
}
