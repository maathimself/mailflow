import { appLocale } from './formatDate.js';

// The times Send later offers (#543, design 5.1). Everything is worked out in the browser's own
// time zone and wall clock, then sent as an ISO instant: "tomorrow at 8:00" is 8:00 where the user
// is, also across a daylight saving change. The server checks the result against its own clock
// (routes/scheduled.js checkSendAt) and is the authority; these limits only keep the picker honest.

export const MIN_AHEAD_MS = 60_000;
export const MAX_AHEAD_MS = 366 * 86_400_000;
// The fixed preset hours (open question 5): morning and afternoon, as Gmail has them.
export const MORNING_HOUR = 8;
export const AFTERNOON_HOUR = 13;
// "Later today" goes at 18:00, and is offered only before 16:00, so it is always two hours away.
export const EVENING_HOUR = 18;
export const LATER_TODAY_UNTIL_HOUR = 16;

// Local midnight `days` after `now`'s day, at `hour`. The Date constructor takes a wall time that
// a spring-forward gap skips to the first time that exists (02:30 becomes 03:30).
function dayAt(now, days, hour, minute = 0) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, hour, minute, 0, 0);
}

// The presets, soonest first: later today (before 16:00 only), tomorrow morning and afternoon,
// and Monday morning, which is left out on Sundays because it is tomorrow morning then. On a
// Monday it is next week's.
export function presets(now = new Date()) {
  const list = [
    ...(now.getHours() < LATER_TODAY_UNTIL_HOUR ? [{ id: 'laterToday', at: dayAt(now, 0, EVENING_HOUR) }] : []),
    { id: 'tomorrowMorning', at: dayAt(now, 1, MORNING_HOUR) },
    { id: 'tomorrowAfternoon', at: dayAt(now, 1, AFTERNOON_HOUR) },
  ];
  const day = now.getDay();
  if (day !== 0) list.push({ id: 'mondayMorning', at: dayAt(now, ((8 - day) % 7) || 7, MORNING_HOUR) });
  return list;
}

const pad = n => String(n).padStart(2, '0');

// The values native date, time and datetime-local inputs take, in local time. Not
// toISOString().slice(0, 10), which is the UTC date and wrong in the evening west of UTC.
export const localDateValue = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const localTimeValue = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
export const localDateTimeValue = d => `${localDateValue(d)}T${localTimeValue(d)}`;

// A date ("2026-10-28") and a time ("08:00") from the picker, as a local Date; null when either is
// missing or not a real date (Feb 30 does not roll over into March).
export function resolveCustom(date, time) {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || '');
  const tm = /^(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(time || '');
  if (!dm || !tm) return null;
  const [y, mo, d] = [Number(dm[1]), Number(dm[2]) - 1, Number(dm[3])];
  const [h, mi] = [Number(tm[1]), Number(tm[2])];
  if (h > 23 || mi > 59) return null;
  const at = new Date(y, mo, d, h, mi, 0, 0);
  if (at.getFullYear() !== y || at.getMonth() !== mo || at.getDate() !== d) return null;
  return at;
}

// The phone picker's single datetime-local value ("2026-10-28T08:00").
export function resolveLocalDateTime(value) {
  const [date, time] = String(value || '').split('T');
  return resolveCustom(date, time);
}

// What is wrong with a chosen time, if anything: 'past', 'tooSoon' (under a minute ahead) or
// 'tooFar' (over 366 days).
export function checkSendAt(at, now = new Date()) {
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) return 'invalid';
  const ahead = at.getTime() - now.getTime();
  if (ahead <= 0) return 'past';
  if (ahead < MIN_AHEAD_MS) return 'tooSoon';
  if (ahead > MAX_AHEAD_MS) return 'tooFar';
  return null;
}

// The default the picker opens with: tomorrow morning.
export const defaultCustom = (now = new Date()) => dayAt(now, 1, MORNING_HOUR);
// The picker's date bounds: today, and the last day within 366 days.
export const dateBounds = (now = new Date()) => ({
  min: localDateValue(now),
  max: localDateValue(new Date(now.getTime() + MAX_AHEAD_MS)),
});

// "Tue, Oct 28, 8:00 AM" in MailFlow's language and the browser's time zone, with the year when it
// is not this year's.
export function formatSendAt(value, locale, now = new Date()) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(locale ?? appLocale(), {
    weekday: 'short', month: 'short', day: 'numeric',
    ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
    hour: 'numeric', minute: '2-digit',
  }).format(d);
}

// The browser's IANA time zone (open question 9), stored with the message for display only.
export function browserTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

// How far this device's clock is behind the server's, from the serverNow a too_soon or too_far
// answer carries; null when it is not known. Under a minute is not worth mentioning.
export function clockSkewMs(serverNow, now = Date.now()) {
  const server = new Date(serverNow).getTime();
  if (!serverNow || Number.isNaN(server)) return null;
  const skew = server - now;
  return Math.abs(skew) >= MIN_AHEAD_MS ? skew : null;
}
