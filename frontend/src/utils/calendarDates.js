// Date logic for the calendar page, kept free of React and of i18next so node:test can run it.
//
// A day is a 'YYYY-MM-DD' string in the browser's time zone. All-day events arrive as such
// strings (end exclusive) and must never go through Date/UTC: a Date at local midnight
// serialized with toISOString() lands on the previous day east of Greenwich. Day arithmetic here
// uses Date.UTC only as a calendar calculator on the string's own numbers, never on an instant.
// Timed events are instants; they are placed from their local Date parts, so a 23 or 25 hour
// day still shows a 09:00 event at 09:00.

const DAY_MS = 86_400_000;
const pad = (n) => String(n).padStart(2, '0');

export const AGENDA_DAYS = 30;
export const SNAP_MINUTES = 15;
export const VIEWS = ['month', 'week', 'day', 'agenda'];

export function parseDay(day) {
  const [y, m, d] = String(day).split('-').map(Number);
  return { y, m, d };
}

export function toDay(y, m, d) {
  const u = new Date(Date.UTC(y, m - 1, d));
  return `${String(u.getUTCFullYear()).padStart(4, '0')}-${pad(u.getUTCMonth() + 1)}-${pad(u.getUTCDate())}`;
}

export function isDay(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

const dayNumber = (day) => {
  const { y, m, d } = parseDay(day);
  return Date.UTC(y, m - 1, d) / DAY_MS;
};

export const addDays = (day, n) => {
  const { y, m, d } = parseDay(day);
  return toDay(y, m, d + n);
};

export const dayDiff = (a, b) => Math.round(dayNumber(b) - dayNumber(a));

// Moves by whole months, keeping the day of the month where the target month has it.
export function addMonths(day, n) {
  const { y, m, d } = parseDay(day);
  const first = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return toDay(first.getUTCFullYear(), first.getUTCMonth() + 1, Math.min(d, last));
}

// 0 is Sunday, as in Date.getDay().
export function dayOfWeek(day) {
  const { y, m, d } = parseDay(day);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export const dayKey = (date) => `${String(date.getFullYear()).padStart(4, '0')}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
export const todayDay = (now = new Date()) => dayKey(now);

// The first day of the week as Date.getDay() numbers it (0 Sunday ... 6 Saturday), from the
// locale's week data; Monday where the runtime has none.
export function firstDayOfWeek(locale) {
  try {
    const tag = locale || (typeof navigator !== 'undefined' ? navigator.language : undefined);
    if (!tag) return 1;
    const loc = new Intl.Locale(tag).maximize();
    const info = typeof loc.getWeekInfo === 'function' ? loc.getWeekInfo() : loc.weekInfo;
    if (info && Number.isInteger(info.firstDay)) return info.firstDay % 7;
  } catch { /* fall through */ }
  return 1;
}

export function startOfWeek(day, firstDay) {
  return addDays(day, -((dayOfWeek(day) - firstDay + 7) % 7));
}

export function weekDays(day, firstDay) {
  const start = startOfWeek(day, firstDay);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

export const monthStart = (day) => { const { y, m } = parseDay(day); return toDay(y, m, 1); };

// The weeks that show the month of `day`, each as 7 day strings, as many as the month needs.
export function monthGrid(day, firstDay) {
  const first = monthStart(day);
  const { y, m } = parseDay(first);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const lead = (dayOfWeek(first) - firstDay + 7) % 7;
  const weeks = Math.ceil((lead + daysInMonth) / 7);
  const start = addDays(first, -lead);
  return Array.from({ length: weeks }, (_, w) => Array.from({ length: 7 }, (_, i) => addDays(start, w * 7 + i)));
}

export function localMidnight(day) {
  const { y, m, d } = parseDay(day);
  return new Date(y, m - 1, d);
}

// A local time on a day, by wall clock: minutes may run to 1440 and past, DST days included.
export function slotToDate(day, minutes) {
  const { y, m, d } = parseDay(day);
  return new Date(y, m - 1, d, Math.floor(minutes / 60), minutes % 60);
}

// What the view shows: the days from `first` up to `endDay` (exclusive), and the ISO instants the
// events request is made with.
export function visibleRange(view, anchor, firstDay) {
  let first;
  let endDay;
  if (view === 'month') {
    const grid = monthGrid(anchor, firstDay);
    first = grid[0][0];
    endDay = addDays(grid[grid.length - 1][6], 1);
  } else if (view === 'week') {
    first = startOfWeek(anchor, firstDay);
    endDay = addDays(first, 7);
  } else if (view === 'day') {
    first = anchor;
    endDay = addDays(anchor, 1);
  } else {
    first = anchor;
    endDay = addDays(anchor, AGENDA_DAYS);
  }
  return { first, endDay, from: localMidnight(first).toISOString(), to: localMidnight(endDay).toISOString() };
}

export function shiftAnchor(view, anchor, direction) {
  if (view === 'month') return addMonths(anchor, direction);
  if (view === 'week') return addDays(anchor, 7 * direction);
  if (view === 'day') return addDays(anchor, direction);
  return addDays(anchor, AGENDA_DAYS * direction);
}

// [startDay, endDay) of an occurrence in local days. A timed event ending exactly at midnight
// does not reach the next day; an empty or inverted one still takes its start day.
export function occurrenceDays(occ) {
  if (occ.allDay) {
    const startDay = String(occ.start).slice(0, 10);
    const end = String(occ.end).slice(0, 10);
    return { startDay, endDay: end > startDay ? end : addDays(startDay, 1) };
  }
  const s = new Date(occ.start);
  const e = new Date(occ.end);
  const last = e.getTime() > s.getTime() ? new Date(e.getTime() - 1) : s;
  return { startDay: dayKey(s), endDay: addDays(dayKey(last), 1) };
}

export function occursOnDay(occ, day) {
  const { startDay, endDay } = occurrenceDays(occ);
  return startDay <= day && day < endDay;
}

export function compareOccurrences(a, b) {
  if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
  const sa = a.allDay ? a.start : new Date(a.start).getTime();
  const sb = b.allDay ? b.start : new Date(b.start).getTime();
  if (sa < sb) return -1;
  if (sa > sb) return 1;
  return String(a.summary).localeCompare(String(b.summary));
}

// The part of a timed occurrence on `day`, in minutes from that day's local midnight.
export function minutesOnDay(occ, day) {
  const s = new Date(occ.start);
  const e = new Date(occ.end);
  const startMin = dayKey(s) === day ? s.getHours() * 60 + s.getMinutes() : 0;
  const endMin = dayKey(e) === day ? e.getHours() * 60 + e.getMinutes() : 1440;
  return { startMin, endMin: Math.max(endMin, startMin) };
}

// Side-by-side columns for the timed events of one day: events that overlap, directly or through
// a chain, share a cluster and split its width. items: [{id, startMin, endMin}].
export function layoutColumns(items, minLength = SNAP_MINUTES) {
  const sorted = items
    .map(i => ({ ...i, endMin: Math.max(i.endMin, i.startMin + minLength) }))
    .sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);
  const out = new Map();
  let cluster = [];
  let clusterEnd = -1;
  const flush = () => {
    const cols = Math.max(1, ...cluster.map(c => c.col + 1));
    for (const c of cluster) out.set(c.id, { col: c.col, cols });
    cluster = [];
  };
  for (const item of sorted) {
    if (cluster.length && item.startMin >= clusterEnd) { flush(); clusterEnd = -1; }
    const taken = new Set(cluster.filter(c => c.endMin > item.startMin).map(c => c.col));
    let col = 0;
    while (taken.has(col)) col += 1;
    cluster.push({ id: item.id, col, endMin: item.endMin });
    clusterEnd = Math.max(clusterEnd, item.endMin);
  }
  if (cluster.length) flush();
  return out;
}

// Bars for a row of days (a month week, or the all-day row): each occurrence that touches the
// days becomes one segment on the columns it covers, stacked in the first free lane.
export function layoutWeek(occs, days) {
  const first = days[0];
  const last = days[days.length - 1];
  const segments = [];
  for (const occ of occs) {
    const { startDay, endDay } = occurrenceDays(occ);
    if (endDay <= first || startDay > last) continue;
    segments.push({
      occ,
      startCol: Math.max(0, dayDiff(first, startDay)),
      endCol: Math.min(days.length, dayDiff(first, endDay)),
      before: startDay < first,
      after: endDay > addDays(last, 1),
      lane: 0,
    });
  }
  segments.sort((a, b) => a.startCol - b.startCol
    || (b.endCol - b.startCol) - (a.endCol - a.startCol)
    || compareOccurrences(a.occ, b.occ));
  const laneEnds = [];
  for (const seg of segments) {
    let lane = laneEnds.findIndex(end => end <= seg.startCol);
    if (lane === -1) { lane = laneEnds.length; laneEnds.push(0); }
    laneEnds[lane] = seg.endCol;
    seg.lane = lane;
  }
  return { segments, laneCount: laneEnds.length };
}

// How many segments each column loses when only the first `maxLanes` lanes are drawn.
export function hiddenCounts(segments, columns, maxLanes) {
  const counts = Array(columns).fill(0);
  for (const seg of segments) {
    if (seg.lane < maxLanes) continue;
    for (let c = seg.startCol; c < seg.endCol; c += 1) counts[c] += 1;
  }
  return counts;
}

export const snapMinutes = (minutes, step = SNAP_MINUTES) => Math.round(minutes / step) * step;

function shiftLocal(iso, days, minutes) {
  const d = new Date(iso);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days, d.getHours(), d.getMinutes() + minutes).toISOString();
}

// The start and end an occurrence has after being dragged by whole days and minutes. A move keeps
// the wall-clock length; a resize moves the end only and keeps at least one snap step.
export function shiftOccurrence(occ, { days = 0, minutes = 0, resize = false } = {}) {
  if (occ.allDay) {
    const { startDay, endDay } = occurrenceDays(occ);
    return { start: addDays(startDay, days), end: addDays(endDay, days) };
  }
  if (resize) {
    const start = new Date(occ.start);
    let end = shiftLocal(occ.end, days, minutes);
    if (new Date(end).getTime() < start.getTime() + SNAP_MINUTES * 60_000) {
      end = shiftLocal(occ.start, 0, SNAP_MINUTES);
    }
    return { start: new Date(occ.start).toISOString(), end };
  }
  return { start: shiftLocal(occ.start, days, minutes), end: shiftLocal(occ.end, days, minutes) };
}

// Values for <input type="datetime-local"> and back; the browser's own zone both ways.
export function toLocalInput(iso) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  return `${dayKey(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value || '')) return null;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

// ── Writing, with the locale passed in so the module stays pure ───────────────────────────────

// A day string as a Date at local noon, safe to format in the local zone.
export const dateFromDay = (day) => {
  const { y, m, d } = parseDay(day);
  return new Date(y, m - 1, d, 12);
};

const fmt = (locale, options) => new Intl.DateTimeFormat(locale, options);

export function formatDayText(day, options, locale) {
  return fmt(locale, options).format(dateFromDay(day));
}

export function formatTitle(view, anchor, firstDay, locale) {
  if (view === 'month') return formatDayText(anchor, { month: 'long', year: 'numeric' }, locale);
  if (view === 'day') return formatDayText(anchor, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }, locale);
  const { first, endDay } = visibleRange(view, anchor, firstDay);
  const options = { day: 'numeric', month: 'short', year: 'numeric' };
  return fmt(locale, options).formatRange(dateFromDay(first), dateFromDay(addDays(endDay, -1)));
}

export function formatHour(hour, locale) {
  return fmt(locale, { hour: 'numeric' }).format(new Date(2000, 0, 1, hour));
}

export function formatClock(value, locale) {
  return fmt(locale, { hour: 'numeric', minute: '2-digit' }).format(new Date(value));
}

// "9:00 AM – 10:30 AM", or with the days when it crosses midnight; all-day events give their days.
export function formatWhen(occ, locale) {
  if (occ.allDay) {
    const { startDay, endDay } = occurrenceDays(occ);
    const last = addDays(endDay, -1);
    const options = { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' };
    if (last === startDay) return formatDayText(startDay, options, locale);
    return fmt(locale, options).formatRange(dateFromDay(startDay), dateFromDay(last));
  }
  const s = new Date(occ.start);
  const e = new Date(occ.end);
  const dayOptions = { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' };
  if (dayKey(s) === dayKey(e) || e.getTime() <= s.getTime()) {
    return `${fmt(locale, dayOptions).format(s)}, ${formatClock(s, locale)} – ${formatClock(e, locale)}`;
  }
  const full = { ...dayOptions, hour: 'numeric', minute: '2-digit' };
  return fmt(locale, full).formatRange(s, e);
}
