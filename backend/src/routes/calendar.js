// CalDAV calendars: the accounts, their calendars, and events expanded for display. Edits go to the
// remote server first, guarded by the stored etag, and reach the local row only once it accepted them.

import crypto from 'node:crypto';
import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { decrypt, encrypt } from '../services/encryption.js';
import { findOwnedAccount } from '../services/ownership.js';
import { validateHost } from '../services/hostValidation.js';
import { getConnectionPolicy } from '../services/connectionPolicy.js';
import { discoverCalendars, findCalDavServer, getEvent, putEvent, deleteEvent } from '../services/caldavClient.js';
import { syncAccount, credentialsFor, isSyncing } from '../services/caldavSync.js';
import { applyEdit, buildEvent, expandResource, removeOccurrence, resourceInfo, seriesMarkers } from '../services/icalEvents.js';

const router = Router();
router.use(requireAuth);

const MAX_WINDOW_MS = 400 * 86400000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const RID_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}Z?)?$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const FREQS = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'];
const clampInterval = v => Math.max(5, Math.min(1440, parseInt(v) || 15));
const badRequest = (res, error) => res.status(400).json({ error });

for (const param of ['id', 'eventId']) {
  router.param(param, (req, res, next, value) => (UUID_RE.test(value) ? next() : res.status(404).json({ error: 'Not found' })));
}

const ACCOUNT_SELECT = `
  SELECT a.*,
    (SELECT COUNT(*)::int FROM calendars c WHERE c.account_id = a.id) AS calendar_count,
    (SELECT COUNT(*)::int FROM calendar_events e JOIN calendars c ON c.id = e.calendar_id WHERE c.account_id = a.id) AS event_count
  FROM caldav_accounts a`;

function publicAccount(a) {
  return {
    id: a.id, name: a.name, serverUrl: a.server_url, username: a.username, intervalMin: a.interval_min,
    lastSyncAt: a.last_sync_at, lastError: a.last_error,
    calendarCount: a.calendar_count ?? 0, eventCount: a.event_count ?? 0,
  };
}

async function loadAccount(userId, id) {
  const r = await query(`${ACCOUNT_SELECT} WHERE a.id = $1 AND a.user_id = $2`, [id, userId]);
  return r.rows[0] || null;
}

const FALLBACK_COLOR = '#6366f1';
function publicCalendar(c) {
  return {
    id: c.id, accountId: c.account_id, accountName: c.account_name, name: c.name,
    color: c.color || c.server_color || FALLBACK_COLOR, visible: c.visible, readOnly: c.read_only,
  };
}

// Plaintext HTTP only for a genuinely private address the admin has allowed, as for CardDAV.
async function serverUrlError(serverUrl, policy) {
  let parsed;
  try { parsed = new URL(serverUrl); } catch { return 'Invalid server URL'; }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return 'Server URL must be http(s).';
  if (parsed.protocol === 'http:') {
    if (!policy.allowPrivateHosts) return 'Server URL must use HTTPS.';
    if (!(await validateHost(parsed.hostname, { allowPrivate: false }))) {
      return 'HTTPS is required for a public host; plaintext HTTP is only allowed for a private/local address.';
    }
  }
  return validateHost(parsed.hostname, { allowPrivate: policy.allowPrivateHosts });
}

async function saveAccount(userId, { name, serverUrl, username, password, intervalMin }) {
  const r = await query(
    `INSERT INTO caldav_accounts (user_id, name, server_url, username, password, interval_min)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (user_id, server_url, username) DO UPDATE SET password = EXCLUDED.password, name = EXCLUDED.name, last_error = NULL
     RETURNING *`,
    [userId, name, serverUrl, username, encrypt(password), clampInterval(intervalMin)],
  );
  syncAccount(r.rows[0].id).catch(err => console.warn(`Calendar: first sync failed: ${err.message}`));
  return publicAccount(r.rows[0]);
}

router.get('/accounts', async (req, res) => {
  const r = await query(`${ACCOUNT_SELECT} WHERE a.user_id = $1 ORDER BY a.created_at`, [req.session.userId]);
  res.json(r.rows.map(publicAccount));
});

router.post('/accounts', async (req, res) => {
  const { name, serverUrl, username, password, intervalMin } = req.body || {};
  if (![serverUrl, username, password].every(v => typeof v === 'string' && v)) {
    return badRequest(res, 'Server URL, username, and password are required');
  }
  if (name != null && typeof name !== 'string') return badRequest(res, 'Invalid name');
  const policy = await getConnectionPolicy();
  const urlErr = await serverUrlError(serverUrl, policy);
  if (urlErr) return badRequest(res, urlErr);
  try {
    await discoverCalendars({ serverUrl, username, password, allowPrivate: policy.allowPrivateHosts });
  } catch (err) {
    return badRequest(res, err.message);
  }
  const label = name?.trim().slice(0, 100) || new URL(serverUrl).hostname;
  res.json(await saveAccount(req.session.userId, { name: label, serverUrl, username, password, intervalMin }));
});

// Mail accounts whose password may also open a calendar on the same server.
router.get('/mail-accounts', async (req, res) => {
  const r = await query(
    `SELECT m.id, m.email_address, m.imap_host,
       EXISTS (SELECT 1 FROM caldav_accounts c
               WHERE c.user_id = m.user_id AND c.username = m.auth_user AND c.server_url IN ('https://' || m.imap_host || '/', 'https://' || m.smtp_host || '/')) AS connected
     FROM email_accounts m
     WHERE m.user_id = $1 AND m.enabled AND m.protocol = 'imap' AND m.auth_pass IS NOT NULL AND m.oauth_provider IS NULL
     ORDER BY m.sort_order, m.email_address`,
    [req.session.userId],
  );
  res.json(r.rows.map(m => ({ id: m.id, email: m.email_address, host: m.imap_host, connected: m.connected })));
});

router.post('/accounts/from-mail', async (req, res) => {
  const { accountId } = req.body || {};
  if (!UUID_RE.test(accountId || '')) return res.status(404).json({ error: 'Not found' });
  const mail = await findOwnedAccount(req.session.userId, accountId, {
    columns: 'email_address, imap_host, smtp_host, auth_user, auth_pass, oauth_provider',
  });
  if (!mail) return res.status(404).json({ error: 'Not found' });
  if (mail.oauth_provider || !mail.auth_pass) return badRequest(res, 'This mail account has no password to connect with');
  const username = mail.auth_user;
  const password = decrypt(mail.auth_pass);
  const policy = await getConnectionPolicy();
  let found;
  try {
    found = await findCalDavServer([mail.imap_host, mail.smtp_host], { username, password, allowPrivate: policy.allowPrivateHosts });
  } catch (err) {
    return res.status(400).json({ error: err.message, code: 'no_caldav' });
  }
  res.json(await saveAccount(req.session.userId, { name: mail.email_address, serverUrl: found.serverUrl, username, password }));
});

router.patch('/accounts/:id', async (req, res) => {
  const { name, intervalMin, password } = req.body || {};
  const r = await query(
    `UPDATE caldav_accounts SET
       name = COALESCE($3, name), interval_min = COALESCE($4, interval_min), password = COALESCE($5, password)
     WHERE id = $1 AND user_id = $2 RETURNING id`,
    [req.params.id, req.session.userId,
      typeof name === 'string' && name.trim() ? name.trim().slice(0, 100) : null,
      intervalMin != null ? clampInterval(intervalMin) : null,
      typeof password === 'string' && password ? encrypt(password) : null],
  );
  if (!r.rowCount) return res.status(404).json({ error: 'Not found' });
  res.json(publicAccount(await loadAccount(req.session.userId, req.params.id)));
});

router.post('/accounts/:id/sync', async (req, res) => {
  const account = await loadAccount(req.session.userId, req.params.id);
  if (!account) return res.status(404).json({ error: 'Not found' });
  if (isSyncing(account.id)) return res.status(409).json({ error: 'A sync is already in progress' });
  const result = await syncAccount(account.id);
  res.json({ ok: result.ok, error: result.error, account: publicAccount(await loadAccount(req.session.userId, account.id)) });
});

router.delete('/accounts/:id', async (req, res) => {
  const r = await query('DELETE FROM caldav_accounts WHERE id = $1 AND user_id = $2', [req.params.id, req.session.userId]);
  if (!r.rowCount) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

const CALENDAR_SELECT = `
  SELECT c.*, a.name AS account_name FROM calendars c JOIN caldav_accounts a ON a.id = c.account_id`;

router.get('/calendars', async (req, res) => {
  const r = await query(`${CALENDAR_SELECT} WHERE c.user_id = $1 ORDER BY a.created_at, c.name`, [req.session.userId]);
  res.json(r.rows.map(publicCalendar));
});

router.patch('/calendars/:id', async (req, res) => {
  const { visible, color } = req.body || {};
  if (color !== undefined && !COLOR_RE.test(color)) return badRequest(res, 'Invalid color');
  const r = await query(
    `UPDATE calendars SET visible = COALESCE($3, visible), color = COALESCE($4, color)
     WHERE id = $1 AND user_id = $2 RETURNING id`,
    [req.params.id, req.session.userId, typeof visible === 'boolean' ? visible : null, color ?? null],
  );
  if (!r.rowCount) return res.status(404).json({ error: 'Not found' });
  const c = await query(`${CALENDAR_SELECT} WHERE c.id = $1`, [req.params.id]);
  res.json(publicCalendar(c.rows[0]));
});

router.get('/events', async (req, res) => {
  const fromMs = Date.parse(req.query.from);
  const toMs = Date.parse(req.query.to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return badRequest(res, 'Invalid date range');
  if (toMs - fromMs > MAX_WINDOW_MS) return badRequest(res, 'Date range too large');
  const floatingTz = typeof req.query.tz === 'string' && req.query.tz.length < 100 ? req.query.tz : null;
  const r = await query(
    `SELECT e.id, e.calendar_id, e.ical, c.read_only
     FROM calendar_events e JOIN calendars c ON c.id = e.calendar_id
     WHERE e.user_id = $1 AND c.visible AND e.range_start < $3 AND (e.range_end IS NULL OR e.range_end > $2)`,
    [req.session.userId, new Date(fromMs), new Date(toMs)],
  );
  const events = [];
  for (const [i, row] of r.rows.entries()) {
    // This process also runs the mail engine: a large calendar must not hold it up.
    if (i % 25 === 24) await new Promise(setImmediate);
    try {
      for (const occ of expandResource(row.ical, fromMs, toMs, { floatingTz })) {
        events.push({
          ...occ, id: `${row.id}:${occ.recurrenceId || ''}`, eventId: row.id,
          calendarId: row.calendar_id, readOnly: row.read_only,
        });
      }
    } catch (err) {
      console.warn(`Calendar: could not expand event ${row.id}: ${err.message}`);
    }
  }
  res.json({ events });
});

function dateValueError(input) {
  const { allDay, start, end } = input;
  if (allDay) {
    if (!DATE_RE.test(start) || !DATE_RE.test(end) || !Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end))) return 'Invalid dates';
    if (end <= start) return 'The end must be after the start';
  } else {
    const s = Date.parse(start);
    const e = Date.parse(end);
    if (!Number.isFinite(s) || !Number.isFinite(e)) return 'Invalid dates';
    if (e < s) return 'The end must be after the start';
  }
  return null;
}

function eventInput(body, { requireDates }) {
  const b = body || {};
  const input = {};
  if (b.summary !== undefined) {
    if (typeof b.summary !== 'string' || b.summary.length > 1000) return { error: 'Invalid title' };
    input.summary = b.summary.trim();
  }
  for (const key of ['location', 'description']) {
    if (b[key] === undefined) continue;
    if (b[key] !== null && (typeof b[key] !== 'string' || b[key].length > 100000)) return { error: `Invalid ${key}` };
    input[key] = b[key];
  }
  if (b.start !== undefined || b.end !== undefined || requireDates) {
    input.allDay = b.allDay === true;
    input.start = b.start;
    input.end = b.end;
    if (typeof b.start !== 'string' || typeof b.end !== 'string') return { error: 'Invalid dates' };
    const err = dateValueError(input);
    if (err) return { error: err };
  }
  if (typeof b.timezone === 'string' && b.timezone.length < 100) input.timezone = b.timezone;
  if (b.recurrence !== undefined) {
    if (b.recurrence === null) input.recurrence = null;
    else {
      const { freq, interval, until, count } = b.recurrence;
      if (!FREQS.includes(freq)) return { error: 'Invalid recurrence' };
      if (until != null && !DATE_RE.test(until)) return { error: 'Invalid recurrence' };
      if (count != null && (!Number.isInteger(count) || count < 1 || count > 10000)) return { error: 'Invalid recurrence' };
      if (interval != null && (!Number.isInteger(interval) || interval < 1 || interval > 1000)) return { error: 'Invalid recurrence' };
      input.recurrence = { freq, interval: interval || 1, until: until || null, count: count || null };
    }
  }
  if (b.reminderMinutes !== undefined) {
    if (b.reminderMinutes !== null && (!Number.isInteger(b.reminderMinutes) || b.reminderMinutes < 0 || b.reminderMinutes > 100000)) {
      return { error: 'Invalid reminder' };
    }
    input.reminderMinutes = b.reminderMinutes;
  }
  return { input };
}

async function loadCalendar(userId, calendarId) {
  if (!UUID_RE.test(calendarId || '')) return null;
  const r = await query(
    `SELECT c.*, a.server_url, a.username, a.password
     FROM calendars c JOIN caldav_accounts a ON a.id = c.account_id
     WHERE c.id = $1 AND c.user_id = $2`,
    [calendarId, userId],
  );
  return r.rows[0] || null;
}

async function loadEvent(userId, eventId) {
  const r = await query(
    `SELECT e.*, c.read_only, c.account_id, c.url AS calendar_url, a.username, a.password
     FROM calendar_events e
     JOIN calendars c ON c.id = e.calendar_id
     JOIN caldav_accounts a ON a.id = c.account_id
     WHERE e.id = $1 AND e.user_id = $2`,
    [eventId, userId],
  );
  return r.rows[0] || null;
}

// Stores what the server now holds, not what was sent: servers may rewrite the object.
async function storeFromServer(calendarId, userId, href, ical, creds) {
  let etag = null;
  let stored = ical;
  try {
    const read = await getEvent(href, creds);
    if (read) { etag = read.etag; stored = read.ical; }
  } catch (err) {
    console.warn(`Calendar: could not re-read ${href}: ${err.message}`);
  }
  const info = resourceInfo(stored);
  const r = await query(
    `INSERT INTO calendar_events (calendar_id, user_id, href, etag, uid, ical, range_start, range_end)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (calendar_id, href) DO UPDATE SET
       etag = EXCLUDED.etag, uid = EXCLUDED.uid, ical = EXCLUDED.ical,
       range_start = EXCLUDED.range_start, range_end = EXCLUDED.range_end, updated_at = NOW()
     RETURNING id`,
    [calendarId, userId, href, etag, info.uid, stored, info.rangeStart, info.rangeEnd],
  );
  return r.rows[0].id;
}

const readOnlyError = res => res.status(403).json({ error: 'This calendar is read-only', code: 'read_only' });

// MDaemon, like Outlook, drops a series' exceptions and exclusions when its start changes, which
// brings deleted occurrences back. The series now has its new start, so sending it again keeps them.
export async function putKeepingMarkers(href, ical, creds, etag) {
  await putEvent(href, ical, creds, { etag });
  const sent = seriesMarkers(ical);
  if (!sent) return;
  const stored = await getEvent(href, creds);
  if (!stored || seriesMarkers(stored.ical) >= sent) return;
  await putEvent(href, ical, creds, { etag: stored.etag });
  const again = await getEvent(href, creds);
  if (again && seriesMarkers(again.ical) < sent) {
    console.warn(`Calendar: the server dropped exceptions of ${href} and would not take them back`);
  }
}

// A conflict waits for the server's newer version to sync, so the client's refetch shows it.
async function sendWriteError(res, err, accountId) {
  if (err.conflict) {
    await syncAccount(accountId).catch(e => console.warn(`Calendar: sync after a conflict failed: ${e.message}`));
    return res.status(409).json({ error: 'This event changed on the server', code: 'conflict' });
  }
  if (err.notFound) return res.status(404).json({ error: err.message });
  if (err.forbidden) return readOnlyError(res);
  console.warn(`Calendar: write failed: ${err.message}`);
  return res.status(502).json({ error: err.message });
}

router.post('/events', async (req, res) => {
  const calendar = await loadCalendar(req.session.userId, req.body?.calendarId);
  if (!calendar) return res.status(404).json({ error: 'Calendar not found' });
  if (calendar.read_only) return readOnlyError(res);
  const { input, error } = eventInput(req.body, { requireDates: true });
  if (error) return badRequest(res, error);
  const { uid, ical } = buildEvent(input);
  const href = new URL(`${encodeURIComponent(uid)}.ics`, calendar.url.endsWith('/') ? calendar.url : `${calendar.url}/`).href;
  try {
    const creds = await credentialsFor(calendar);
    const { url } = await putEvent(href, ical, creds, { create: true });
    const eventId = await storeFromServer(calendar.id, calendar.user_id, url, ical, creds);
    res.json({ ok: true, eventId });
  } catch (err) {
    await sendWriteError(res, err, calendar.account_id);
  }
});

router.patch('/events/:eventId', async (req, res) => {
  const event = await loadEvent(req.session.userId, req.params.eventId);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  if (event.read_only) return readOnlyError(res);
  const { input, error } = eventInput(req.body, { requireDates: false });
  if (error) return badRequest(res, error);
  const scope = req.body.scope === 'this' ? 'this' : 'all';
  const { recurrenceId } = req.body;
  if (recurrenceId != null && !RID_RE.test(recurrenceId)) return badRequest(res, 'Invalid occurrence');
  if (scope === 'this' && (!recurrenceId || input.start === undefined)) return badRequest(res, 'Editing one occurrence needs its id and dates');

  const moveTo = req.body.calendarId && req.body.calendarId !== event.calendar_id ? req.body.calendarId : null;
  let target = null;
  if (moveTo) {
    if (scope === 'this') return badRequest(res, 'One occurrence cannot move to another calendar');
    target = await loadCalendar(req.session.userId, moveTo);
    if (!target) return res.status(404).json({ error: 'Calendar not found' });
    if (target.read_only) return readOnlyError(res);
    if (target.account_id !== event.account_id) {
      return badRequest(res, 'An event cannot move to a calendar on another account');
    }
  }

  try {
    const ical = applyEdit(event.ical, input, { scope, recurrenceId });
    const creds = await credentialsFor(event);
    if (target) {
      const base = target.url.endsWith('/') ? target.url : `${target.url}/`;
      const href = new URL(`${crypto.randomUUID()}.ics`, base).href;
      const { url } = await putEvent(href, ical, creds, { create: true });
      await storeFromServer(target.id, target.user_id, url, ical, creds);
      await deleteEvent(event.href, creds, { etag: event.etag });
      await query('DELETE FROM calendar_events WHERE id = $1', [event.id]);
    } else {
      await putKeepingMarkers(event.href, ical, creds, event.etag);
      await storeFromServer(event.calendar_id, event.user_id, event.href, ical, creds);
    }
    res.json({ ok: true });
  } catch (err) {
    await sendWriteError(res, err, event.account_id);
  }
});

router.delete('/events/:eventId', async (req, res) => {
  const event = await loadEvent(req.session.userId, req.params.eventId);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  if (event.read_only) return readOnlyError(res);
  const { scope, recurrenceId } = req.query;
  if (scope === 'this' && (typeof recurrenceId !== 'string' || !RID_RE.test(recurrenceId))) return badRequest(res, 'Invalid occurrence');
  try {
    const creds = await credentialsFor(event);
    const remaining = scope === 'this' ? removeOccurrence(event.ical, recurrenceId) : null;
    if (remaining) {
      await putEvent(event.href, remaining, creds, { etag: event.etag });
      await storeFromServer(event.calendar_id, event.user_id, event.href, remaining, creds);
    } else {
      await deleteEvent(event.href, creds, { etag: event.etag });
      await query('DELETE FROM calendar_events WHERE id = $1', [event.id]);
    }
    res.json({ ok: true });
  } catch (err) {
    await sendWriteError(res, err, event.account_id);
  }
});

export default router;
