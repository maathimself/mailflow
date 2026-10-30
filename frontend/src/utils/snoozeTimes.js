import { localDateValue, resolveCustom } from './scheduleTimes.js';

// The custom snooze picker's values, in the browser's own time zone and wall clock, as Send
// later's are: its earliest date is today here, not the UTC date, which in the evening west of
// UTC is already tomorrow (and in the morning east of it still yesterday).
export const SNOOZE_DEFAULT_TIME = '09:00';
export const snoozeMinDate = (now = new Date()) => localDateValue(now);
// The date the picker opens with: tomorrow.
export const snoozeDefaultDate = (now = new Date()) =>
  localDateValue(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
// The picked date and time as the instant to snooze until, read as local time; null when either
// is missing or not a real date.
export const snoozeCustomUntil = (date, time) => resolveCustom(date, time);
