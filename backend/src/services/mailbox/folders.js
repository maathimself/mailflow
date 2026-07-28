import { query } from '../db.js';

function accountScope(accountId, userId, accountIds, columns = '*') {
  const accountClause = accountIds == null ? '' : ' AND id = ANY($3::uuid[])';
  const params = accountIds == null
    ? [accountId, userId]
    : [accountId, userId, accountIds];
  return query(
    `SELECT ${columns} FROM email_accounts WHERE id = $1 AND user_id = $2${accountClause}`,
    params,
  );
}

export async function listFolders(imapManager, { userId, accountIds, accountId }) {
  void imapManager;
  const check = await accountScope(accountId, userId, accountIds, 'id');
  if (!check.rows.length) return { ok: false, status: 404, error: 'Account not found' };

  const result = await query(
    'SELECT * FROM folders WHERE account_id = $1 ORDER BY path',
    [accountId]
  );
  return { ok: true, folders: result.rows };
}

export async function createFolder(
  imapManager,
  { userId, accountIds, accountId, name, parentPath },
) {
  const check = await accountScope(accountId, userId, accountIds);
  if (!check.rows.length) return { ok: false, status: 404, error: 'Account not found' };

  let path = name.trim();
  if (parentPath) {
    const delimResult = await query('SELECT delimiter FROM folders WHERE account_id = $1 LIMIT 1', [accountId]);
    const delim = delimResult.rows[0]?.delimiter || '/';
    path = `${parentPath}${delim}${name.trim()}`;
  }

  try {
    await imapManager.createFolder(check.rows[0], path);
    await query(
      `INSERT INTO folders (account_id, path, name) VALUES ($1, $2, $3)
       ON CONFLICT (account_id, path) DO NOTHING`,
      [accountId, path, name.trim()]
    );
    return { ok: true, path };
  } catch (err) {
    console.error('Create folder error:', err);
    return { ok: false, status: 500, error: 'Failed to create folder' };
  }
}

export async function deleteFolder(imapManager, { userId, accountIds, accountId, path }) {
  const check = await accountScope(accountId, userId, accountIds);
  if (!check.rows.length) return { ok: false, status: 404, error: 'Account not found' };

  try {
    await imapManager.deleteFolder(check.rows[0], path);
  } catch (err) {
    console.error(`IMAP deleteFolder failed for ${path}:`, err.message);
    return { ok: false, status: 500, error: 'Failed to delete folder on server' };
  }
  await query('DELETE FROM folders WHERE account_id = $1 AND path = $2', [accountId, path]);
  await query('DELETE FROM messages WHERE account_id = $1 AND folder = $2', [accountId, path]);
  return { ok: true };
}

export async function renameFolder(
  imapManager,
  { userId, accountIds, accountId, oldPath, newName },
) {
  const check = await accountScope(accountId, userId, accountIds);
  if (!check.rows.length) return { ok: false, status: 404, error: 'Account not found' };

  const delimResult = await query('SELECT delimiter FROM folders WHERE account_id = $1 AND path = $2', [accountId, oldPath]);
  const delim = delimResult.rows[0]?.delimiter || '/';
  const parts = oldPath.split(delim);
  parts[parts.length - 1] = newName.trim();
  const newPath = parts.join(delim);

  try {
    await imapManager.renameFolder(check.rows[0], oldPath, newPath);
    await query(
      'UPDATE folders SET path = $1, name = $2, updated_at = NOW() WHERE account_id = $3 AND path = $4',
      [newPath, newName.trim(), accountId, oldPath]
    );
    await query('UPDATE messages SET folder = $1 WHERE account_id = $2 AND folder = $3', [newPath, accountId, oldPath]);
    return { ok: true, newPath };
  } catch (err) {
    console.error('Rename folder error:', err);
    return { ok: false, status: 500, error: 'Failed to rename folder' };
  }
}

export async function countMessagesIn(accountId, path) {
  const result = await query(
    'SELECT COUNT(*) AS count FROM messages WHERE account_id = $1 AND folder = $2',
    [accountId, path],
  );
  return Number(result.rows[0]?.count || 0);
}
