// Pulls each connected CalDAV account into calendars and calendar_events. A calendar whose ctag has
// not moved is skipped; otherwise etags are compared and only changed events are fetched. Local rows
// are written by this sync and by routes/calendar.js at once, so a row touched after the sync began
// is left alone: the listing the sync works from may predate that write.

import { query } from './db.js';
import { decrypt } from './encryption.js';
import { getConnectionPolicy } from './connectionPolicy.js';
import { discoverCalendars, listEvents, fetchEvents, hrefKey } from './caldavClient.js';
import { resourceInfo } from './icalEvents.js';

const TICK_MS = 60 * 1000;
const syncing = new Set();
let ticking = false;
let timer = null;

export const isSyncing = accountId => syncing.has(accountId);

export async function credentialsFor(account) {
  const policy = await getConnectionPolicy();
  return { username: account.username, password: decrypt(account.password), allowPrivate: policy.allowPrivateHosts };
}

async function upsertEvent(calendar, ev, startedAt) {
  const info = resourceInfo(ev.ical);
  if (!info) return false;
  await query(
    `INSERT INTO calendar_events (calendar_id, user_id, href, etag, uid, ical, range_start, range_end)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (calendar_id, href) DO UPDATE SET
       etag = EXCLUDED.etag, uid = EXCLUDED.uid, ical = EXCLUDED.ical,
       range_start = EXCLUDED.range_start, range_end = EXCLUDED.range_end, updated_at = NOW()
     WHERE calendar_events.updated_at < $9`,
    [calendar.id, calendar.user_id, ev.url, ev.etag, info.uid, ev.ical, info.rangeStart, info.rangeEnd, startedAt],
  );
  return true;
}

async function syncCalendar(calendar, remote, creds, startedAt) {
  const local = await query('SELECT href, etag FROM calendar_events WHERE calendar_id = $1', [calendar.id]);
  const known = new Map(local.rows.map(r => [hrefKey(r.href), r.etag]));
  const listing = await listEvents(calendar.url, creds);
  const seen = new Set(listing.map(e => hrefKey(e.url)));
  const stale = local.rows.map(r => r.href).filter(href => !seen.has(hrefKey(href)));
  if (stale.length) {
    await query(
      'DELETE FROM calendar_events WHERE calendar_id = $1 AND href = ANY($2::text[]) AND updated_at < $3',
      [calendar.id, stale, startedAt],
    );
  }
  const changed = listing.filter(e => !e.etag || known.get(hrefKey(e.url)) !== e.etag).map(e => e.rawHref);
  let unreadable = 0;
  for (const ev of await fetchEvents(calendar.url, changed, creds)) {
    if (!ev.ical) continue;
    try {
      await upsertEvent(calendar, ev, startedAt);
    } catch (err) {
      if (err.code) throw err; // database error, not a bad event
      unreadable++;
      console.warn(`Calendar: skipped an unreadable event at ${ev.url}: ${err.message}`);
    }
  }
  if (unreadable) throw new Error(`${unreadable} event(s) in "${remote.name}" could not be read`);
  await query('UPDATE calendars SET ctag = $2 WHERE id = $1', [calendar.id, remote.ctag]);
}

export async function syncAccount(accountId) {
  if (syncing.has(accountId)) return { ok: false, error: 'A sync is already in progress', busy: true };
  syncing.add(accountId);
  try {
    const r = await query('SELECT * FROM caldav_accounts WHERE id = $1', [accountId]);
    const account = r.rows[0];
    if (!account) return { ok: false, error: 'Account not found' };
    const startedAt = (await query('SELECT NOW() AS now')).rows[0].now;
    const errors = [];
    try {
      const creds = await credentialsFor(account);
      const remotes = await discoverCalendars({ serverUrl: account.server_url, ...creds });
      for (const remote of remotes) {
        const saved = await query(
          `INSERT INTO calendars (account_id, user_id, url, name, server_color, read_only)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (account_id, url) DO UPDATE SET
             name = EXCLUDED.name, server_color = EXCLUDED.server_color, read_only = EXCLUDED.read_only
           RETURNING *`,
          [account.id, account.user_id, remote.url, remote.name, remote.color, remote.readOnly],
        );
        const calendar = saved.rows[0];
        if (remote.ctag && calendar.ctag === remote.ctag) continue;
        try {
          await syncCalendar(calendar, remote, creds, startedAt);
        } catch (err) {
          if (err.status === 401) throw err;
          errors.push(`${remote.name}: ${err.message}`);
        }
      }
      await query(
        'DELETE FROM calendars WHERE account_id = $1 AND url <> ALL($2::text[])',
        [account.id, remotes.map(c => c.url)],
      );
    } catch (err) {
      errors.push(err.message);
    }
    const error = errors.join('; ') || null;
    await query('UPDATE caldav_accounts SET last_sync_at = NOW(), last_error = $2 WHERE id = $1', [account.id, error]);
    if (error) console.warn(`Calendar: sync of account ${account.id} failed: ${error}`);
    return error ? { ok: false, error } : { ok: true };
  } finally {
    syncing.delete(accountId);
  }
}

// Accounts sync one at a time, so a slow calendar server costs this loop time and never the mail engine's.
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const due = await query(
      `SELECT id FROM caldav_accounts
       WHERE last_sync_at IS NULL OR last_sync_at < NOW() - make_interval(mins => interval_min)
       ORDER BY last_sync_at NULLS FIRST`,
    );
    for (const { id } of due.rows) {
      await syncAccount(id).catch(err => console.warn(`Calendar: sync of account ${id} failed: ${err.message}`));
    }
  } catch (err) {
    console.warn('Calendar: scheduler tick failed:', err.message);
  } finally {
    ticking = false;
  }
}

export function startCaldavScheduler() {
  if (timer) return;
  timer = setInterval(tick, TICK_MS);
  timer.unref?.();
}
