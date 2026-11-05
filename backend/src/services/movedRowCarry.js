// A message moved on a server that does not name its new uid (no UIDPLUS, or an empty COPYUID,
// the #407 case) loses its row: the source uid can belong to another message in the destination
// (#665), so the row is dropped and the destination's next sync files the message again. That
// sync used to take it for new mail. What MailFlow alone knows about it was lost (a "Not spam"
// decision, the category, an unsubscribe, plugin annotations), and it went through the inbox
// rules, the alerts and the spam check again, so a message the user had just called not spam
// could be moved straight back to Spam.
//
// The dropped row waits here, keyed by account, destination folder and Message-ID, until the
// destination's sync inserts that message: the sync puts its state back and does not treat it
// as new mail (see takeCarry in imapManager's sync). A row with no Message-ID has nothing to be
// found by and is not kept. Kept in memory: the destination is synced right after the move, and
// a restart in between only loses what was always lost before.

// Columns only MailFlow knows, put back on the re-filed row. Everything else (flags, headers,
// body) the sync reads from the server.
export const CARRIED_COLUMNS = [
  'spam_score_sa', 'spam_score_ml', 'spam_verdict', 'spam_analyzed_at', 'spam_details',
  'spam_user_override', 'category', 'unsubscribed_at', 'plugin_annotations', 'bcc_addresses',
];

export const CARRY_MS = 15 * 60 * 1000;
const MAX_CARRIES = 5000;
// The re-filed copy's Date header is the dropped row's; a second of slack covers rounding.
const DATE_SLACK_MS = 1000;

const carries = new Map();

const keyOf = (accountId, folder, messageId) => `${accountId}\n${folder}\n${messageId}`;
const timeOf = (date) => {
  const t = date == null ? NaN : new Date(date).getTime();
  return Number.isFinite(t) ? t : null;
};

function prune(now) {
  for (const [key, list] of carries) {
    const live = list.filter(carry => carry.until > now);
    if (live.length) carries.set(key, live);
    else carries.delete(key);
  }
  while (carries.size > MAX_CARRIES) carries.delete(carries.keys().next().value);
}

// Keep rows a move dropped into `folder`. `overrides` replaces columns the move itself decided,
// such as the verdict of a "Not spam" move.
export function rememberDroppedRows(folder, rows, overrides = {}, now = Date.now()) {
  prune(now);
  for (const row of rows ?? []) {
    if (!row?.account_id || !row.message_id) continue;
    const columns = {};
    for (const column of CARRIED_COLUMNS) {
      if (row[column] !== undefined) columns[column] = row[column];
    }
    Object.assign(columns, overrides);
    // Two copies of one message moved together (self-sent mail's Sent and INBOX copies) each
    // keep their own state, one per copy the sync files.
    const key = keyOf(row.account_id, folder, row.message_id);
    const kept = (carries.get(key) ?? []).filter(carry => carry.until > now);
    carries.delete(key);
    carries.set(key, [...kept, { date: timeOf(row.date), columns, until: now + CARRY_MS }]);
  }
}

export const hasCarries = () => carries.size > 0;

// The kept state of a message the sync just inserted, or null when no move dropped it. Taken
// once: a second copy of the same message is new mail.
export function takeCarry(accountId, folder, messageId, date, now = Date.now()) {
  if (!messageId || !carries.size) return null;
  const key = keyOf(accountId, folder, messageId);
  const list = (carries.get(key) ?? []).filter(carry => carry.until > now);
  const t = timeOf(date);
  const i = list.findIndex(carry => carry.date == null || t == null || Math.abs(carry.date - t) <= DATE_SLACK_MS);
  const carry = i === -1 ? null : list.splice(i, 1)[0];
  if (list.length) carries.set(key, list);
  else carries.delete(key);
  return carry ? carry.columns : null;
}

const JSON_COLUMNS = new Set(['spam_details', 'plugin_annotations', 'bcc_addresses']);

// The UPDATE that puts kept columns back on the re-filed row `id`, or null when there are none.
// plugin_annotations is NOT NULL, so a null there keeps the row's own value.
export function carryUpdate(id, columns) {
  const params = [id];
  const sets = [];
  for (const column of CARRIED_COLUMNS) {
    if (!columns || !(column in columns)) continue;
    const value = columns[column];
    params.push(JSON_COLUMNS.has(column) && value != null && typeof value !== 'string' ? JSON.stringify(value) : value);
    const param = `$${params.length}${JSON_COLUMNS.has(column) ? '::jsonb' : ''}`;
    sets.push(column === 'plugin_annotations' ? `${column} = COALESCE(${param}, ${column})` : `${column} = ${param}`);
  }
  if (!sets.length) return null;
  return { text: `UPDATE messages SET ${sets.join(', ')} WHERE id = $1`, params };
}

// For tests.
export function clearCarries() {
  carries.clear();
}
