// The message list's order (#528) and starred on top (#196), chosen per folder. The server sorts
// (messageService.js listMessages); this names the choice, sends it, and orders a row put back by
// an Undo the same way the server would have.
import { SCHEDULED_VIEW } from './scheduledCompose.js';

// SNOOZED_FOLDER in snoozeActions.js, which imports the store; the store imports this file.
const SNOOZED_FOLDER = 'Snoozed';

export const LIST_SORTS = ['date', 'from', 'subject'];
export const DEFAULT_LIST_ORDER = Object.freeze({ sort: 'date', dir: 'desc', starredFirst: false });

// The preference key: the account, or "all" for All Inboxes, and the folder.
export function listSortKey(accountId, folder) {
  return `${accountId || 'all'}:${folder}`;
}

export function isDefaultListOrder(order) {
  return !order || (order.sort === 'date' && order.dir === 'desc' && !order.starredFirst);
}

// Whether the list showing can be sorted. Search keeps newest first, and the Snoozed view,
// Scheduled and the GTD tabs keep their own order.
export function isSortableList({ accountId, folder, searchQuery, gtdTab }) {
  if (String(searchQuery || '').trim() || gtdTab) return false;
  if (folder === SNOOZED_FOLDER || folder === SCHEDULED_VIEW) return false;
  return Boolean(accountId) || folder === 'INBOX';
}

export function listOrderFor(listSort, accountId, folder) {
  const entry = listSort?.[listSortKey(accountId, folder)];
  if (!entry || !LIST_SORTS.includes(entry.sort)) return DEFAULT_LIST_ORDER;
  return { sort: entry.sort, dir: entry.dir === 'asc' ? 'asc' : 'desc', starredFirst: entry.starredFirst === true };
}

// The order to switch to when a sort is picked: a new sort starts at its natural direction
// (newest first, or A to Z); picking the one already on keeps its direction.
export function pickListSort(order, sort) {
  if (order.sort === sort) return order;
  return { ...order, sort, dir: sort === 'date' ? 'desc' : 'asc' };
}

// Adds the order to GET /mail/messages params. The default order sends nothing, which is the
// order the list always had.
export function applyListOrder(params, order) {
  if (!order || isDefaultListOrder(order)) return params;
  if (order.sort !== 'date' || order.dir !== 'desc') {
    params.sort = order.sort;
    params.dir = order.dir;
  }
  if (order.starredFirst) params.starredFirst = 'true';
  return params;
}

// The server's subject key (normalized_subject): lowercase, up to three reply or forward prefixes
// stripped.
const SUBJECT_PREFIX = /^(re|fw|fwd|aw|sv|vs|tr|wg|ant|antw|ref|rif|ynt|odp|vb|atb)\s*:\s*/i;
function subjectKey(subject) {
  let s = String(subject || '');
  for (let i = 0; i < 3; i++) s = s.replace(SUBJECT_PREFIX, '');
  return s.trim().toLowerCase();
}
const senderKey = m => String(m.from_name || m.from_email || '').toLowerCase();
const time = m => new Date(m.date || 0).getTime();

// A conversation row counts as starred when any of its messages is: its own, or another one
// (others_starred, from the server), as listOrderSql orders threads.
const starredOf = m => Boolean(m.is_starred || m.others_starred);

// A comparator for rows in the given order, as listOrderSql in messageService.js sorts them.
// Rows with nothing to sort on go last; ties fall back to newest first.
export function compareListOrder(order = DEFAULT_LIST_ORDER) {
  const sign = order.dir === 'asc' ? 1 : -1;
  const keyOf = order.sort === 'from' ? senderKey : order.sort === 'subject' ? m => subjectKey(m.subject) : null;
  return (a, b) => {
    if (order.starredFirst && starredOf(a) !== starredOf(b)) return starredOf(a) ? -1 : 1;
    if (keyOf) {
      const ka = keyOf(a), kb = keyOf(b);
      if (ka !== kb) {
        if (!ka) return 1;
        if (!kb) return -1;
        return sign * (ka < kb ? -1 : 1);
      }
      return time(b) - time(a);
    }
    return sign * (time(a) - time(b));
  };
}
