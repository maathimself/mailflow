import i18next from 'i18next';
import { isToday, isTomorrow, isYesterday, isThisYear } from 'date-fns';
import { htmlLang } from './browserLanguage.js';

// Dates are written in MailFlow's language, not the browser's (#593): with Russian chosen in
// MailFlow and an English browser, month names, AM/PM and "Yesterday" used to stay English. The
// time zone and the calendar day stay the browser's own. The language is read from the shared
// i18next instance (src/i18n.js), so these work wherever they are called from.
export function appLocale() {
  const tag = htmlLang(i18next.language || 'en');
  try {
    return Intl.DateTimeFormat.supportedLocalesOf([tag]).length ? tag : undefined;
  } catch {
    return undefined;
  }
}

const parse = (value) => {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
};

const written = (d, options, locale) => new Intl.DateTimeFormat(locale ?? appLocale(), options).format(d);

// "Yesterday" in the app's language, capitalized as a label.
function yesterday(locale) {
  const word = new Intl.RelativeTimeFormat(locale ?? appLocale(), { numeric: 'auto' }).format(-1, 'day');
  return word.charAt(0).toLocaleUpperCase(locale ?? appLocale()) + word.slice(1);
}

// Compact relative date label shared by MessageList and the GTD display surfaces.
// Guards an invalid date to '' so a malformed value can never throw.
export function formatDate(dateStr, locale) {
  const d = parse(dateStr);
  if (!d) return '';
  if (isToday(d)) return written(d, { hour: 'numeric', minute: '2-digit' }, locale);
  if (isYesterday(d)) return yesterday(locale);
  if (isThisYear(d)) return written(d, { month: 'short', day: 'numeric' }, locale);
  return written(d, { month: 'short', day: 'numeric', year: 'numeric' }, locale);
}

// A message's date and time in the reading pane; without the year where space is short.
export function formatMessageDateTime(dateStr, { withYear = true } = {}, locale) {
  const d = parse(dateStr);
  if (!d) return '';
  return written(d, {
    month: 'short', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}), hour: 'numeric', minute: '2-digit',
  }, locale);
}

// toLocaleString / toLocaleDateString / toLocaleTimeString, in the app's language.
export const formatDateTime = (value, locale) => parse(value)?.toLocaleString(locale ?? appLocale()) ?? '';
export const formatDay = (value, locale) => parse(value)?.toLocaleDateString(locale ?? appLocale()) ?? '';
export const formatTime = (value, locale) => parse(value)?.toLocaleTimeString(locale ?? appLocale()) ?? '';

// When snoozed mail comes back (#269), compact for a list row: the time today, "Tomorrow" and the
// time, the weekday within the week, the date beyond that.
export function formatSnoozeUntil(value, locale, now = new Date()) {
  const d = parse(value);
  if (!d) return '';
  const time = written(d, { hour: 'numeric', minute: '2-digit' }, locale);
  if (isToday(d)) return time;
  if (isTomorrow(d)) {
    const word = new Intl.RelativeTimeFormat(locale ?? appLocale(), { numeric: 'auto' }).format(1, 'day');
    return `${word.charAt(0).toLocaleUpperCase(locale ?? appLocale())}${word.slice(1)} ${time}`;
  }
  if (d - now < 6 * 86_400_000) return written(d, { weekday: 'short', hour: 'numeric', minute: '2-digit' }, locale);
  return written(d, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }, locale);
}
