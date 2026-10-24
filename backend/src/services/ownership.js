// Ownership lookups for core routes. Each one is the single place its resource's "belongs to
// this user" condition is written as SQL, so a route cannot drift into a check that leaves out
// user_id or tests the wrong column. A miss is null (or a shorter list), never an error: routes
// answer a miss differently (404, 403, a skipped draft), so the response stays at the call site.
//
// `columns` goes into the SELECT list, so it is checked before use: a comma-separated list of
// plain columns (`id`, `m.subject`, `a.*`, `a.user_id AS owner_id`), plus the computed columns
// exported below by name. Anything else throws, so a request value that found its way in could
// not add a subquery or a clause. `client` is a withTransaction client when the lookup belongs
// inside a transaction; without one the lookup runs on the pool.
//
// The plugin API's getOwnedAccount and loadOwnedMessage (mailAccess.js) delegate here with fixed
// arguments, so plugins share this scoping without being able to pass columns.
import { query } from './db.js';

const pool = { query: (text, params) => query(text, params) };

// How many rows share the message's Message-ID in its account, for the read and star toggles'
// sibling fan-out.
// Computed columns are allowed only as these exact named constants. checkColumns splits a list
// on commas, so a constant must never contain one.
export const SIBLING_COUNT = `CASE WHEN m.message_id IS NULL THEN 1
                ELSE (SELECT COUNT(*) FROM messages s
                       WHERE s.account_id = m.account_id AND s.message_id = m.message_id)
           END AS sibling_count`;
// Whether a contact comes from a synced CardDAV book, which makes it read-only here.
export const CONTACT_READ_ONLY = "(ab.source = 'carddav') AS read_only";

const COMPUTED = new Set([SIBLING_COUNT, CONTACT_READ_ONLY]);
const KEYWORDS = new Set(['select', 'from', 'where', 'union', 'join', 'on', 'and', 'or', 'not', 'into',
  'insert', 'update', 'delete', 'drop', 'alter', 'create', 'grant', 'with', 'as', 'limit', 'offset',
  'order', 'group', 'having', 'returning', 'case', 'when', 'then', 'else', 'end', 'null', 'true', 'false',
  // Niladic functions read as bare names, so they would pass as columns and return server state.
  'user', 'session_user', 'current_user', 'current_role', 'system_user', 'current_schema', 'current_catalog',
  'current_date', 'current_time', 'current_timestamp', 'localtime', 'localtimestamp']);
const NAME = '[a-z_][a-z0-9_]*';
const PLAIN = new RegExp(`^(?:\\*|(${NAME})\\.\\*|(?:(${NAME})\\.)?(${NAME})(?:\\s+as\\s+(${NAME}))?)$`, 'i');

export function checkColumns(columns) {
  if (typeof columns !== 'string' || !columns.trim()) throw new TypeError('columns must be a non-empty string');
  for (const item of columns.split(',').map(c => c.trim())) {
    if (COMPUTED.has(item)) continue;
    const m = PLAIN.exec(item);
    if (!m || m.slice(1).some(name => name && KEYWORDS.has(name.toLowerCase()))) {
      throw new TypeError(`Not a column list: ${JSON.stringify(columns)}`);
    }
  }
  return columns;
}

// One of the user's accounts. `enabled` adds enabled = true; `protocol` limits it to one protocol.
export async function findOwnedAccount(userId, accountId, { columns = '*', enabled = false, protocol, client = pool } = {}) {
  const params = [accountId, userId];
  let sql = `SELECT ${checkColumns(columns)} FROM email_accounts WHERE id = $1 AND user_id = $2`;
  if (enabled) sql += ' AND enabled = true';
  if (protocol) {
    params.push(protocol);
    sql += ` AND protocol = $${params.length}`;
  }
  const { rows } = await client.query(sql, params);
  return rows[0] || null;
}

// A message in one of the user's accounts. Columns may name the message (m) or its account (a).
// `live` skips deleted rows; `enabledAccount` skips messages of a disabled account.
export async function findOwnedMessage(userId, messageId, { columns = 'm.*', live = false, enabledAccount = false, client = pool } = {}) {
  let sql = `SELECT ${checkColumns(columns)} FROM messages m JOIN email_accounts a ON m.account_id = a.id
     WHERE m.id = $1 AND a.user_id = $2`;
  if (enabledAccount) sql += ' AND a.enabled = true';
  if (live) sql += ' AND m.is_deleted = false';
  const { rows } = await client.query(sql, [messageId, userId]);
  return rows[0] || null;
}

// The subset of messageIds in the user's accounts, in no particular order. Ids that are not the
// user's are left out rather than refused; callers that need all of them compare the lengths.
export async function findOwnedMessages(userId, messageIds, { columns = 'm.*', live = false, client = pool } = {}) {
  let sql = `SELECT ${checkColumns(columns)} FROM messages m JOIN email_accounts a ON m.account_id = a.id
     WHERE m.id = ANY($2::uuid[]) AND a.user_id = $1`;
  if (live) sql += ' AND m.is_deleted = false';
  const { rows } = await client.query(sql, [userId, messageIds]);
  return rows;
}

// An alias of one of the user's accounts, only when it belongs to that account.
export async function findOwnedAlias(userId, accountId, aliasId, { client = pool } = {}) {
  const { rows } = await client.query(
    `SELECT a.id, a.account_id FROM account_aliases a
     JOIN email_accounts e ON a.account_id = e.id
     WHERE a.id = $1 AND e.user_id = $2 AND e.id = $3`,
    [aliasId, userId, accountId]
  );
  return rows[0] || null;
}

// One of the user's contacts. Columns may name the contact (c) or its address book (ab).
export async function findOwnedContact(userId, contactId, { columns = 'c.*', client = pool } = {}) {
  const { rows } = await client.query(
    `SELECT ${checkColumns(columns)} FROM contacts c
     JOIN address_books ab ON ab.id = c.address_book_id
     WHERE c.id = $1 AND c.user_id = $2`,
    [contactId, userId]
  );
  return rows[0] || null;
}

// One of the user's address books.
export async function findOwnedAddressBook(userId, bookId, { columns = '*', client = pool } = {}) {
  const { rows } = await client.query(
    `SELECT ${checkColumns(columns)} FROM address_books WHERE id = $1 AND user_id = $2`,
    [bookId, userId]
  );
  return rows[0] || null;
}
