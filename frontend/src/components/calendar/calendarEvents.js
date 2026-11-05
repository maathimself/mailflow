import { addDays, fromLocalInput, occurrenceDays, slotToDate, toLocalInput } from '../../utils/calendarDates.js';

export const FREQS = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'];
export const REMINDER_PRESETS = [0, 10, 30, 60, 1440];

export const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

// What to tell the person about a failed request, and whether the events must be fetched again
// because the server's copy moved on (409) or is not what the page shows.
export function describeError(err) {
  if (err?.status === 409 && err.code === 'conflict') return { key: 'calendar.errors.conflict', refetch: true };
  if (err?.status === 409) return { key: 'calendar.errors.busy', refetch: false };
  if (err?.status === 403 && err.code === 'read_only') return { key: 'calendar.errors.readOnly', refetch: true };
  if (err?.status === 502) return { key: 'calendar.errors.server', message: err.message, refetch: true };
  return { key: 'calendar.errors.generic', message: err?.message || '', refetch: false };
}

export function emptyForm({ calendarId, allDay = false, start, end }) {
  const base = {
    summary: '', calendarId, allDay, location: '', description: '',
    freq: '', interval: 1, ends: 'never', until: '', count: 10, reminder: '',
  };
  if (allDay) {
    const startDay = String(start).slice(0, 10);
    const endExclusive = String(end || addDays(startDay, 1)).slice(0, 10);
    return { ...base, startDay, endDay: addDays(endExclusive, -1) >= startDay ? addDays(endExclusive, -1) : startDay, startLocal: `${startDay}T09:00`, endLocal: `${startDay}T10:00` };
  }
  const s = toLocalInput(start);
  const e = toLocalInput(end);
  return { ...base, startLocal: s, endLocal: e, startDay: s.slice(0, 10), endDay: e.slice(0, 10) };
}

export function formFromOccurrence(occ) {
  const days = occurrenceDays(occ);
  const form = emptyForm({ calendarId: occ.calendarId, allDay: occ.allDay, start: occ.start, end: occ.end });
  const r = occ.recurrence;
  return {
    ...form,
    summary: occ.summary || '',
    location: occ.location || '',
    description: occ.description || '',
    ...(occ.allDay ? { startDay: days.startDay, endDay: addDays(days.endDay, -1) } : {}),
    freq: r?.freq || '',
    interval: r?.interval || 1,
    ends: r?.count ? 'count' : r?.until ? 'until' : 'never',
    until: r?.until ? String(r.until).slice(0, 10) : '',
    count: r?.count || 10,
    reminder: occ.reminderMinutes == null ? '' : String(occ.reminderMinutes),
  };
}

export function defaultSlot(day, now = new Date()) {
  const startMin = Math.min(22 * 60, (now.getHours() + 1) * 60);
  return { allDay: false, start: slotToDate(day, startMin).toISOString(), end: slotToDate(day, startMin + 60).toISOString() };
}

// Switching the all-day toggle keeps the days and picks sensible clock times.
export function toggleAllDay(form) {
  if (!form.allDay) {
    const startDay = form.startLocal.slice(0, 10);
    const endDay = form.endLocal.slice(0, 10);
    return { ...form, allDay: true, startDay, endDay: endDay >= startDay ? endDay : startDay };
  }
  return { ...form, allDay: false, startLocal: `${form.startDay}T09:00`, endLocal: `${form.endDay}T10:00` };
}

// Moving the start moves the end with it, so the length stays.
export function changeStart(form, value) {
  if (form.allDay) {
    const shift = form.startDay && value ? Math.round((Date.parse(`${form.endDay}T00:00Z`) - Date.parse(`${form.startDay}T00:00Z`)) / 86_400_000) : 0;
    return { ...form, startDay: value, endDay: value ? addDays(value, Math.max(0, shift)) : form.endDay };
  }
  const oldS = fromLocalInput(form.startLocal);
  const oldE = fromLocalInput(form.endLocal);
  const newS = fromLocalInput(value);
  if (!oldS || !oldE || !newS) return { ...form, startLocal: value };
  const length = new Date(oldE) - new Date(oldS);
  return { ...form, startLocal: value, endLocal: toLocalInput(new Date(new Date(newS).getTime() + Math.max(0, length)).toISOString()) };
}

// Returns {payload} to send, or {error} naming the locale key of what is wrong.
export function buildPayload(form, { scope = 'all', recurrenceCustom = false } = {}) {
  const summary = form.summary.trim();
  if (!summary) return { error: 'calendar.form.titleRequired' };
  if (!form.calendarId) return { error: 'calendar.form.calendarRequired' };
  const payload = {
    calendarId: form.calendarId,
    summary,
    location: form.location.trim(),
    description: form.description,
    allDay: form.allDay,
    reminderMinutes: form.reminder === '' ? null : Number(form.reminder),
  };
  if (form.allDay) {
    if (!form.startDay || !form.endDay || form.endDay < form.startDay) return { error: 'calendar.form.endBeforeStart' };
    payload.start = form.startDay;
    payload.end = addDays(form.endDay, 1);
  } else {
    const start = fromLocalInput(form.startLocal);
    const end = fromLocalInput(form.endLocal);
    if (!start || !end) return { error: 'calendar.form.timeRequired' };
    if (new Date(end) < new Date(start)) return { error: 'calendar.form.endBeforeStart' };
    payload.start = start;
    payload.end = end;
    payload.timezone = browserZone();
  }
  if (scope !== 'this' && !recurrenceCustom) {
    if (!form.freq) {
      payload.recurrence = null;
    } else {
      const rec = { freq: form.freq, interval: Math.max(1, Math.floor(Number(form.interval)) || 1) };
      if (form.ends === 'until') {
        if (!form.until || form.until < payload.start.slice(0, 10)) return { error: 'calendar.form.untilBeforeStart' };
        rec.until = form.until;
      } else if (form.ends === 'count') {
        const count = Math.floor(Number(form.count));
        if (!(count >= 1)) return { error: 'calendar.form.countInvalid' };
        rec.count = count;
      }
      payload.recurrence = rec;
    }
  }
  return { payload };
}

// The PATCH body for an edit: scope 'this' names the occurrence and cannot move calendars; scope
// 'all' on one occurrence of a series still names it, so the server shifts the series by the same amount.
export function withScope(payload, occ, scope) {
  const out = { ...payload, scope };
  if (occ.recurrenceId) out.recurrenceId = occ.recurrenceId;
  if (scope === 'this') delete out.calendarId;
  return out;
}

// A drag changes the times only: recurrence and reminder are left out, which keeps them.
export function movePayload(occ, times, scope) {
  const payload = {
    calendarId: occ.calendarId,
    summary: occ.summary,
    location: occ.location || '',
    description: occ.description || '',
    allDay: occ.allDay,
    start: times.start,
    end: times.end,
  };
  if (!occ.allDay) payload.timezone = browserZone();
  return withScope(payload, occ, scope);
}

export function reminderOptions(current) {
  const values = [...REMINDER_PRESETS];
  const n = current === '' || current == null ? null : Number(current);
  if (n != null && Number.isFinite(n) && !values.includes(n)) values.push(n);
  return { values, extra: n != null && !REMINDER_PRESETS.includes(n) ? n : null };
}

// Writable calendars an event can go to: on create any; on edit only its own account's.
export function offeredCalendars(calendars, { editing, accountId }) {
  return calendars.filter(c => !c.readOnly && (!editing || c.accountId === accountId));
}

const URL_RE = /\bhttps?:\/\/[^\s<>"']+/gi;

// Splits plain text into text and http(s) links, so the page can render both without HTML.
export function linkify(text) {
  const parts = [];
  let last = 0;
  for (const m of String(text).matchAll(URL_RE)) {
    let url = m[0];
    const trail = url.match(/[.,;:!?)\]]+$/);
    if (trail) url = url.slice(0, -trail[0].length);
    if (m.index > last) parts.push({ text: text.slice(last, m.index) });
    parts.push({ text: url, href: url });
    last = m.index + url.length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

export const FREQ_KEYS = {
  DAILY: 'calendar.recurrence.daily',
  WEEKLY: 'calendar.recurrence.weekly',
  MONTHLY: 'calendar.recurrence.monthly',
  YEARLY: 'calendar.recurrence.yearly',
};

export const REMINDER_KEYS = {
  0: 'calendar.reminder.atStart',
  10: 'calendar.reminder.min10',
  30: 'calendar.reminder.min30',
  60: 'calendar.reminder.hour1',
  1440: 'calendar.reminder.day1',
};

export const ATTENDEE_KEYS = {
  ACCEPTED: 'calendar.attendee.accepted',
  DECLINED: 'calendar.attendee.declined',
  TENTATIVE: 'calendar.attendee.tentative',
  'NEEDS-ACTION': 'calendar.attendee.pending',
};

export function reminderText(minutes, t) {
  if (minutes == null) return t('calendar.reminder.none');
  return REMINDER_KEYS[minutes] ? t(REMINDER_KEYS[minutes]) : t('calendar.reminder.custom', { n: minutes });
}

export function recurrenceText(occ, t, locale) {
  if (occ.recurrenceCustom) return t('calendar.recurrence.custom');
  const r = occ.recurrence;
  if (!r || !FREQ_KEYS[r.freq]) return '';
  const parts = [t(FREQ_KEYS[r.freq])];
  if (r.interval > 1) parts.push(t('calendar.recurrence.interval', { n: r.interval }));
  if (r.count) parts.push(t('calendar.recurrence.afterCount', { n: r.count }));
  else if (r.until) parts.push(t('calendar.recurrence.untilDate', { date: new Date(`${String(r.until).slice(0, 10)}T12:00`).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' }) }));
  return parts.join(', ');
}
