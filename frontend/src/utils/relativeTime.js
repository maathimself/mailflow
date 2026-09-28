// "3 days ago" in the UI language, e.g. for when a user was last seen.
const UNITS = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
];

// new Date(null) is the 1970 epoch, not an invalid date, so a missing value is caught first.
const timeOf = date => (date == null || date === '' ? NaN : new Date(date).getTime());

export function formatRelativeTime(date, locale, now = Date.now()) {
  const time = timeOf(date);
  if (!Number.isFinite(time)) return '';
  const seconds = Math.round((time - now) / 1000);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return format.format(Math.trunc(seconds / size), unit);
  }
  return format.format(0, 'second');
}

export function daysSince(date, now = Date.now()) {
  const time = timeOf(date);
  return Number.isFinite(time) ? (now - time) / 86_400_000 : Infinity;
}
