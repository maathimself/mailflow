// Pure iCalendar handling for the CalDAV client: reading a calendar resource into occurrences, and
// editing one without losing what MailFlow does not model. A resource is edited in place, never
// regenerated, so properties another client wrote (X-*, attachments, attendees) survive the round trip.

import crypto from 'node:crypto';
import ICAL from 'ical.js';

const MAX_ITERATIONS = 20000;
const DAY_MS = 86400000;
const PRODID = '-//MailFlow//CalDAV//EN';
const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

// Building a formatter is by far the slowest step of expanding a long series.
const formatters = new Map();
function formatterFor(tz) {
  if (formatters.has(tz)) return formatters.get(tz);
  let formatter = null;
  // Some clients prefix the IANA name, as in /freeassociation.sourceforge.net/Europe/Zurich.
  const segments = tz.split('/').filter(Boolean);
  const names = [tz, ...segments.slice(1).map((_, i) => segments.slice(i + 1).join('/'))];
  for (const timeZone of names) {
    try {
      formatter = new Intl.DateTimeFormat('en-US', {
        timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
        hour: 'numeric', minute: 'numeric', second: 'numeric',
      });
      break;
    } catch { /* not a zone Intl knows */ }
  }
  if (formatters.size > 500) formatters.clear();
  formatters.set(tz, formatter);
  return formatter;
}

const isIana = tzid => Boolean(tzid && formatterFor(tzid));

function wallParts(ms, tz) {
  const parts = formatterFor(tz).formatToParts(new Date(ms));
  const get = type => Number(parts.find(p => p.type === type).value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') };
}

function offsetMs(ms, tz) {
  const w = wallParts(ms, tz);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(ms / 1000) * 1000;
}

// The second pass settles a wall clock next to a DST change.
function wallToUtc(t, tz) {
  const wall = Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second);
  const first = wall - offsetMs(wall, tz);
  return wall - offsetMs(first, tz);
}

// Date-times are resolved through Intl for real IANA zones and through the resource's own
// VTIMEZONE otherwise (Outlook's "Romance Standard Time"). A floating time, or an unknown zone with
// no definition, is read in the viewer's zone when known, else as UTC.
function toUtcMs(time, tzid, zones) {
  if (time.zone === ICAL.Timezone.utcTimezone) return time.toUnixTime() * 1000;
  if (isIana(tzid)) return wallToUtc(time, tzid);
  const zone = zones?.get(tzid);
  if (zone) {
    const copy = time.clone();
    copy.zone = zone;
    return copy.toUnixTime() * 1000;
  }
  if (zones?.floatingTz) return wallToUtc(time, zones.floatingTz);
  return Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute, time.second);
}

function zonesOf(root, floatingTz) {
  const zones = new Map();
  zones.floatingTz = isIana(floatingTz) ? floatingTz : null;
  for (const vtz of root.getAllSubcomponents('vtimezone')) {
    const tzid = vtz.getFirstPropertyValue('tzid');
    if (tzid) zones.set(tzid, new ICAL.Timezone({ component: vtz, tzid }));
  }
  return zones;
}

function parseRoot(ics) {
  const root = new ICAL.Component(ICAL.parse(ics));
  if (root.name !== 'vcalendar') throw new Error('Not an iCalendar object');
  return root;
}

const tzidOf = prop => prop?.getParameter('tzid') || null;
const isoDate = t => `${String(t.year).padStart(4, '0')}-${String(t.month).padStart(2, '0')}-${String(t.day).padStart(2, '0')}`;
const dateToMs = d => Date.parse(`${d}T00:00:00Z`);
const msToDate = ms => new Date(ms).toISOString().slice(0, 10);

function bounds(vevent, zones) {
  const startProp = vevent.getFirstProperty('dtstart');
  if (!startProp) return null;
  const start = startProp.getFirstValue();
  const tzid = tzidOf(startProp);
  const allDay = start.isDate;
  const startMs = allDay ? dateToMs(isoDate(start)) : toUtcMs(start, tzid, zones);
  const endProp = vevent.getFirstProperty('dtend');
  let endMs;
  if (endProp) {
    const end = endProp.getFirstValue();
    endMs = allDay ? dateToMs(isoDate(end)) : toUtcMs(end, tzidOf(endProp) || tzid, zones);
  } else {
    const duration = vevent.getFirstPropertyValue('duration');
    endMs = startMs + (duration ? duration.toSeconds() * 1000 : (allDay ? DAY_MS : 0));
  }
  if (endMs < startMs) endMs = startMs;
  return { start, startMs, endMs, tzid, allDay };
}

function masterAndOverrides(root) {
  const events = root.getAllSubcomponents('vevent');
  return {
    master: events.find(e => !e.hasProperty('recurrence-id')) || null,
    overrides: events.filter(e => e.hasProperty('recurrence-id')),
  };
}

function occurrenceKey(time, tzid, zones) {
  return time.isDate ? isoDate(time) : toUtcMs(time, tzid, zones);
}

function isSeries(master) {
  return master.hasProperty('rrule') || master.hasProperty('rdate');
}

// What sync stores to find a resource by date without parsing it. rangeEnd null: the series never ends.
export function resourceInfo(ics) {
  const root = parseRoot(ics);
  const zones = zonesOf(root);
  const events = root.getAllSubcomponents('vevent');
  if (!events.length) return null;
  const { master } = masterAndOverrides(root);
  let rangeStart = Infinity;
  let rangeEnd = -Infinity;
  for (const event of events) {
    const b = bounds(event, zones);
    if (!b) continue;
    rangeStart = Math.min(rangeStart, b.startMs);
    rangeEnd = Math.max(rangeEnd, b.endMs);
  }
  if (rangeStart === Infinity) return null;
  if (master && isSeries(master)) {
    const b = bounds(master, zones);
    if (b) {
      const duration = b.endMs - b.startMs;
      const rules = master.getAllProperties('rrule').map(p => p.getFirstValue());
      if (rules.some(r => !r.until && !r.count)) {
        rangeEnd = null;
      } else {
        const it = new ICAL.Event(master).iterator();
        let next;
        let n = 0;
        while ((next = it.next())) {
          if (++n > MAX_ITERATIONS) { rangeEnd = null; break; }
          const ms = next.isDate ? dateToMs(isoDate(next)) : toUtcMs(next, b.tzid, zones);
          rangeEnd = Math.max(rangeEnd, ms + duration);
        }
      }
    }
  }
  return {
    uid: events[0].getFirstPropertyValue('uid') || null,
    rangeStart: new Date(rangeStart - DAY_MS),
    rangeEnd: rangeEnd === null ? null : new Date(rangeEnd + DAY_MS),
  };
}

function text(vevent, name) {
  const value = vevent.getFirstPropertyValue(name);
  return value == null || value === '' ? null : String(value);
}

function person(prop) {
  const value = String(prop.getFirstValue() || '');
  return {
    name: prop.getParameter('cn') || null,
    email: value.replace(/^mailto:/i, '') || null,
    status: prop.getParameter('partstat') || null,
  };
}

function reminderOf(vevent) {
  for (const alarm of vevent.getAllSubcomponents('valarm')) {
    const trigger = alarm.getFirstPropertyValue('trigger');
    if (trigger instanceof ICAL.Duration) return Math.max(0, Math.round(-trigger.toSeconds() / 60));
  }
  return null;
}

function recurrenceOf(master, b) {
  const props = master.getAllProperties('rrule');
  if (!props.length) return { recurrence: null, custom: master.hasProperty('rdate') };
  const rule = props[0].getFirstValue();
  const parts = Object.keys(rule.parts || {});
  const weekday = WEEKDAYS[new Date(b.allDay ? b.startMs : b.startMs + offsetMs(b.startMs, isIana(b.tzid) ? b.tzid : 'UTC')).getUTCDay()];
  const plainWeekly = rule.freq === 'WEEKLY' && parts.length === 1 && parts[0] === 'BYDAY'
    && rule.parts.BYDAY.length === 1 && rule.parts.BYDAY[0] === weekday;
  const custom = props.length > 1 || master.hasProperty('rdate')
    || !['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(rule.freq)
    || (parts.length > 0 && !plainWeekly);
  let until = null;
  if (rule.until) {
    if (rule.until.isDate) until = isoDate(rule.until);
    else if (rule.until.zone === ICAL.Timezone.utcTimezone && isIana(b.tzid)) {
      const w = wallParts(rule.until.toUnixTime() * 1000, b.tzid);
      until = isoDate(w);
    } else until = isoDate(rule.until);
  }
  return {
    recurrence: { freq: rule.freq, interval: rule.interval || 1, until, count: rule.count || null },
    custom,
  };
}

function describe(vevent, b, startMs, extra) {
  const duration = b.endMs - b.startMs;
  return {
    summary: text(vevent, 'summary') || '',
    location: text(vevent, 'location'),
    description: text(vevent, 'description'),
    url: text(vevent, 'url'),
    allDay: b.allDay,
    start: b.allDay ? msToDate(startMs) : new Date(startMs).toISOString(),
    end: b.allDay ? msToDate(startMs + duration) : new Date(startMs + duration).toISOString(),
    timezone: b.allDay ? null : b.tzid,
    status: text(vevent, 'status'),
    organizer: vevent.hasProperty('organizer') ? (({ name, email }) => ({ name, email }))(person(vevent.getFirstProperty('organizer'))) : null,
    attendees: vevent.getAllProperties('attendee').map(person),
    reminderMinutes: reminderOf(vevent),
    ...extra,
  };
}

// The occurrences of one resource that overlap [fromMs, toMs). Times come back as UTC ISO instants,
// all-day dates as plain dates with an exclusive end.
export function expandResource(ics, fromMs, toMs, { floatingTz } = {}) {
  const root = parseRoot(ics);
  const zones = zonesOf(root, floatingTz);
  const { master, overrides } = masterAndOverrides(root);
  const out = [];
  const overlaps = (startMs, endMs, allDay) => {
    const slack = allDay ? DAY_MS : 0;
    return startMs < toMs + slack && (endMs > fromMs - slack || (endMs === startMs && startMs >= fromMs - slack));
  };

  const overridden = new Set();
  const masterBounds = master ? bounds(master, zones) : null;
  for (const override of overrides) {
    const ridProp = override.getFirstProperty('recurrence-id');
    const rid = ridProp.getFirstValue();
    const ridTz = tzidOf(ridProp);
    overridden.add(occurrenceKey(rid, ridTz, zones));
    const b = bounds(override, zones);
    if (!b) continue;
    if (text(override, 'status') === 'CANCELLED') continue;
    if (!overlaps(b.startMs, b.endMs, b.allDay)) continue;
    const sameZone = rid.isDate || !masterBounds || ridTz === masterBounds.tzid;
    const recurrenceId = sameZone ? rid.toString() : `${new Date(toUtcMs(rid, ridTz, zones)).toISOString().slice(0, 19)}Z`;
    out.push(describe(override, b, b.startMs, { recurrenceId, isRecurring: true, recurrence: null, recurrenceCustom: false }));
  }

  if (!master || !masterBounds) return out;
  const b = masterBounds;
  const duration = b.endMs - b.startMs;
  if (!isSeries(master)) {
    if (overlaps(b.startMs, b.endMs, b.allDay)) {
      out.push(describe(master, b, b.startMs, { recurrenceId: null, isRecurring: false, recurrence: null, recurrenceCustom: false }));
    }
    return out;
  }

  const excluded = new Set();
  for (const prop of master.getAllProperties('exdate')) {
    for (const value of prop.getValues()) excluded.add(occurrenceKey(value, tzidOf(prop) || b.tzid, zones));
  }
  const { recurrence, custom } = recurrenceOf(master, b);
  const it = new ICAL.Event(master).iterator();
  let next;
  let n = 0;
  while ((next = it.next())) {
    if (++n > MAX_ITERATIONS) {
      console.warn(`Calendar: series ${text(master, 'uid')} stopped expanding after ${MAX_ITERATIONS} occurrences`);
      break;
    }
    const startMs = next.isDate ? dateToMs(isoDate(next)) : toUtcMs(next, b.tzid, zones);
    if (startMs >= toMs + DAY_MS) break;
    const key = next.isDate ? isoDate(next) : startMs;
    if (excluded.has(key) || overridden.has(key)) continue;
    if (!overlaps(startMs, startMs + duration, b.allDay)) continue;
    out.push(describe(master, b, startMs, { recurrenceId: next.toString(), isRecurring: true, recurrence, recurrenceCustom: custom }));
  }
  return out;
}

// ── Writing ───────────────────────────────────────────────────────────────────

function offsetString(ms) {
  const sign = ms < 0 ? '-' : '+';
  const min = Math.abs(ms) / 60000;
  return `${sign}${String(Math.floor(min / 60)).padStart(2, '0')}${String(min % 60).padStart(2, '0')}`;
}

function pad2(n) { return String(n).padStart(2, '0'); }

// RFC 5545 asks for a VTIMEZONE next to any TZID, and Intl is the only zone data at hand, so this
// derives one from the current year's transitions as a yearly rule.
export function vtimezoneBlock(tzid, nowMs = Date.now()) {
  const year = new Date(nowMs).getUTCFullYear();
  const transitions = [];
  let prevMs = Date.UTC(year, 0, 1);
  let prevOffset = offsetMs(prevMs, tzid);
  for (let ms = prevMs + DAY_MS; ms <= Date.UTC(year + 1, 0, 1); ms += DAY_MS) {
    const off = offsetMs(ms, tzid);
    if (off !== prevOffset) {
      let lo = prevMs;
      let hi = ms;
      while (hi - lo > 60000) {
        const mid = Math.floor((lo + hi) / 2 / 60000) * 60000;
        if (offsetMs(mid, tzid) === prevOffset) lo = mid; else hi = mid;
      }
      transitions.push({ at: hi, from: prevOffset, to: off });
      prevOffset = off;
    }
    prevMs = ms;
  }
  const lines = ['BEGIN:VTIMEZONE', `TZID:${tzid}`];
  if (transitions.length !== 2) {
    lines.push('BEGIN:STANDARD', 'DTSTART:19700101T000000', `TZOFFSETFROM:${offsetString(prevOffset)}`,
      `TZOFFSETTO:${offsetString(prevOffset)}`, 'END:STANDARD');
  } else {
    for (const t of transitions) {
      const wall = new Date(t.at + t.from);
      const month = wall.getUTCMonth();
      const day = wall.getUTCDate();
      const dow = wall.getUTCDay();
      const monthDays = new Date(Date.UTC(wall.getUTCFullYear(), month + 1, 0)).getUTCDate();
      const nth = day + 7 > monthDays ? -1 : Math.ceil(day / 7);
      const candidates = [];
      const days1970 = new Date(Date.UTC(1970, month + 1, 0)).getUTCDate();
      for (let d = 1; d <= days1970; d++) if (new Date(Date.UTC(1970, month, d)).getUTCDay() === dow) candidates.push(d);
      const d1970 = nth === -1 ? candidates[candidates.length - 1] : candidates[nth - 1];
      const kind = t.to > t.from ? 'DAYLIGHT' : 'STANDARD';
      lines.push(`BEGIN:${kind}`,
        `DTSTART:1970${pad2(month + 1)}${pad2(d1970)}T${pad2(wall.getUTCHours())}${pad2(wall.getUTCMinutes())}00`,
        `TZOFFSETFROM:${offsetString(t.from)}`, `TZOFFSETTO:${offsetString(t.to)}`,
        `RRULE:FREQ=YEARLY;BYMONTH=${month + 1};BYDAY=${nth}${WEEKDAYS[dow]}`, `END:${kind}`);
    }
  }
  lines.push('END:VTIMEZONE');
  return lines.join('\r\n');
}

function ensureTimezone(root, tzid) {
  if (!tzid || !isIana(tzid) || tzid === 'UTC') return;
  if (root.getAllSubcomponents('vtimezone').some(v => v.getFirstPropertyValue('tzid') === tzid)) return;
  const vtz = new ICAL.Component(ICAL.parse(`BEGIN:VCALENDAR\r\n${vtimezoneBlock(tzid)}\r\nEND:VCALENDAR`)).getFirstSubcomponent('vtimezone');
  // VTIMEZONE conventionally comes ahead of the events.
  const events = root.getAllSubcomponents('vevent');
  events.forEach(e => root.removeSubcomponent(e));
  root.addSubcomponent(vtz);
  events.forEach(e => root.addSubcomponent(e));
}

function setText(vevent, name, value) {
  vevent.removeAllProperties(name);
  if (value) vevent.addPropertyWithValue(name, String(value));
}

function dateProp(name, dateStr) {
  const prop = new ICAL.Property(name);
  prop.resetType('date');
  prop.setValue(ICAL.Time.fromDateString(dateStr));
  return prop;
}

function wallTime(ms, tzid) {
  const time = new ICAL.Time({ ...wallParts(ms, tzid), isDate: false });
  return time;
}

function instantProp(name, ms, tzid) {
  const prop = new ICAL.Property(name);
  if (tzid && tzid !== 'UTC' && isIana(tzid)) {
    prop.setParameter('tzid', tzid);
    prop.setValue(wallTime(ms, tzid));
  } else {
    prop.setValue(ICAL.Time.fromJSDate(new Date(ms), true));
  }
  return prop;
}

function setBounds(vevent, input, tzid) {
  vevent.removeAllProperties('dtstart');
  vevent.removeAllProperties('dtend');
  vevent.removeAllProperties('duration');
  if (input.allDay) {
    vevent.addProperty(dateProp('dtstart', input.start));
    vevent.addProperty(dateProp('dtend', input.end));
  } else {
    vevent.addProperty(instantProp('dtstart', Date.parse(input.start), tzid));
    vevent.addProperty(instantProp('dtend', Date.parse(input.end), tzid));
  }
}

function setRecurrence(vevent, recurrence, input, tzid) {
  vevent.removeAllProperties('rrule');
  if (!recurrence) return;
  const data = { freq: recurrence.freq, interval: recurrence.interval > 1 ? recurrence.interval : 1 };
  if (recurrence.count) data.count = recurrence.count;
  else if (recurrence.until) {
    if (input.allDay) {
      data.until = ICAL.Time.fromDateString(recurrence.until);
    } else {
      const [y, m, d] = recurrence.until.split('-').map(Number);
      const end = { year: y, month: m, day: d, hour: 23, minute: 59, second: 59 };
      const ms = tzid && isIana(tzid) ? wallToUtc(end, tzid) : Date.UTC(y, m - 1, d, 23, 59, 59);
      data.until = ICAL.Time.fromJSDate(new Date(ms), true);
    }
  }
  vevent.addPropertyWithValue('rrule', new ICAL.Recur(data));
}

function setReminder(vevent, minutes) {
  if (reminderOf(vevent) === minutes) return;
  for (const alarm of vevent.getAllSubcomponents('valarm')) vevent.removeSubcomponent(alarm);
  if (minutes == null) return;
  const alarm = new ICAL.Component('valarm');
  alarm.addPropertyWithValue('action', 'DISPLAY');
  alarm.addPropertyWithValue('description', vevent.getFirstPropertyValue('summary') || 'Reminder');
  alarm.addPropertyWithValue('trigger', ICAL.Duration.fromSeconds(-minutes * 60));
  vevent.addSubcomponent(alarm);
}

function touch(vevent) {
  const now = ICAL.Time.fromJSDate(new Date(), true);
  vevent.updatePropertyWithValue('dtstamp', now);
  vevent.updatePropertyWithValue('last-modified', now);
  vevent.updatePropertyWithValue('sequence', (Number(vevent.getFirstPropertyValue('sequence')) || 0) + 1);
}

function applyText(vevent, input) {
  if (input.summary !== undefined) setText(vevent, 'summary', input.summary);
  if (input.location !== undefined) setText(vevent, 'location', input.location);
  if (input.description !== undefined) setText(vevent, 'description', input.description);
}

export function buildEvent(input, uid = crypto.randomUUID()) {
  const root = new ICAL.Component('vcalendar');
  root.addPropertyWithValue('version', '2.0');
  root.addPropertyWithValue('prodid', PRODID);
  root.addPropertyWithValue('calscale', 'GREGORIAN');
  const vevent = new ICAL.Component('vevent');
  vevent.addPropertyWithValue('uid', uid);
  const now = ICAL.Time.fromJSDate(new Date(), true);
  vevent.addPropertyWithValue('dtstamp', now);
  vevent.addPropertyWithValue('created', now);
  vevent.addPropertyWithValue('last-modified', now);
  vevent.addPropertyWithValue('sequence', 0);
  applyText(vevent, input);
  const tzid = input.allDay ? null : input.timezone;
  setBounds(vevent, input, tzid);
  if (input.recurrence) setRecurrence(vevent, input.recurrence, input, tzid);
  if (input.reminderMinutes != null) setReminder(vevent, input.reminderMinutes);
  root.addSubcomponent(vevent);
  if (tzid) ensureTimezone(root, tzid);
  return { uid, ical: root.toString() };
}

// Reads a recurrenceId from the API: a plain date, a wall clock in the series' zone, or a UTC time
// ending in Z (see expandResource).
function ridKey(recurrenceId, masterBounds, zones) {
  const time = ICAL.Time.fromString(recurrenceId);
  return occurrenceKey(time, masterBounds?.tzid, zones);
}

function findOverride(overrides, key, zones) {
  return overrides.find(o => {
    const prop = o.getFirstProperty('recurrence-id');
    return occurrenceKey(prop.getFirstValue(), tzidOf(prop), zones) === key;
  });
}

function assertOccurs(master, b, key, zones) {
  if (!master || !b) throw Object.assign(new Error('Occurrence not found'), { notFound: true });
  const it = new ICAL.Event(master).iterator();
  let next;
  let n = 0;
  while ((next = it.next()) && ++n <= MAX_ITERATIONS) {
    const k = next.isDate ? isoDate(next) : toUtcMs(next, b.tzid, zones);
    if (k === key) return;
    if (typeof k === 'number' && typeof key === 'number' && k > key) break;
    if (typeof k === 'string' && typeof key === 'string' && k > key) break;
  }
  throw Object.assign(new Error('Occurrence not found'), { notFound: true });
}

function ridValue(recurrenceId, b, name) {
  const time = ICAL.Time.fromString(recurrenceId);
  const prop = new ICAL.Property(name);
  if (time.isDate) prop.resetType('date');
  else if (b.tzid && time.zone !== ICAL.Timezone.utcTimezone) prop.setParameter('tzid', b.tzid);
  prop.setValue(time);
  return prop;
}

function editOccurrence(root, input, recurrenceId, zones) {
  const { master, overrides } = masterAndOverrides(root);
  const b = master ? bounds(master, zones) : null;
  const key = ridKey(recurrenceId, b, zones);
  let target = findOverride(overrides, key, zones);
  if (!target) {
    assertOccurs(master, b, key, zones);
    target = new ICAL.Component(JSON.parse(JSON.stringify(master.toJSON())));
    for (const name of ['rrule', 'rdate', 'exdate', 'recurrence-id']) target.removeAllProperties(name);
    target.addProperty(ridValue(recurrenceId, b, 'recurrence-id'));
    root.addSubcomponent(target);
  }
  const current = bounds(target, zones);
  const tzid = input.allDay ? null : (current?.tzid || input.timezone);
  applyText(target, input);
  setBounds(target, input, tzid);
  if (input.reminderMinutes !== undefined) setReminder(target, input.reminderMinutes);
  touch(target);
  if (tzid) ensureTimezone(root, tzid);
}

function shiftTime(prop, value, deltaMs, tzid, zones) {
  if (value.isDate) {
    return ICAL.Time.fromDateString(msToDate(dateToMs(isoDate(value)) + deltaMs));
  }
  const ms = toUtcMs(value, tzid, zones) + deltaMs;
  if (value.zone === ICAL.Timezone.utcTimezone || !isIana(tzid)) return ICAL.Time.fromJSDate(new Date(ms), true);
  return wallTime(ms, tzid);
}

// A series whose start moved: its EXDATEs and its overrides' RECURRENCE-IDs name occurrences by
// their old start, so they move with it, or they would stop matching and the skipped or edited
// occurrences would come back.
function shiftSeriesMarkers(master, overrides, deltaMs, tzid, zones) {
  for (const prop of master.getAllProperties('exdate')) {
    const ptz = tzidOf(prop) || tzid;
    prop.setValues(prop.getValues().map(v => shiftTime(prop, v, deltaMs, ptz, zones)));
  }
  for (const o of overrides) {
    const prop = o.getFirstProperty('recurrence-id');
    prop.setValue(shiftTime(prop, prop.getFirstValue(), deltaMs, tzidOf(prop) || tzid, zones));
  }
}

// A rule pinned to weekdays or a month day has to follow a series dragged to another day.
function shiftRuleDays(master, b, newStartMs) {
  const dayOf = (ms) => {
    if (b.allDay) return new Date(ms);
    const w = wallParts(ms, isIana(b.tzid) ? b.tzid : 'UTC');
    return new Date(Date.UTC(w.year, w.month - 1, w.day));
  };
  const before = dayOf(b.startMs);
  const after = dayOf(newStartMs);
  const dayDelta = Math.round((after - before) / DAY_MS);
  if (!dayDelta) return;
  for (const prop of master.getAllProperties('rrule')) {
    const rule = prop.getFirstValue();
    if (rule.parts?.BYDAY) {
      rule.parts.BYDAY = rule.parts.BYDAY.map((d) => {
        const m = /^([+-]?\d+)?([A-Z]{2})$/.exec(d);
        if (!m) return d;
        const i = WEEKDAYS.indexOf(m[2]);
        return `${m[1] || ''}${WEEKDAYS[(((i + dayDelta) % 7) + 7) % 7]}`;
      });
    }
    if (rule.parts?.BYMONTHDAY?.length === 1) rule.parts.BYMONTHDAY = [after.getUTCDate()];
    if (rule.parts?.BYMONTH?.length === 1) rule.parts.BYMONTH = [after.getUTCMonth() + 1];
    prop.setValue(rule);
  }
}

function editSeries(root, input, recurrenceId, zones) {
  const { master, overrides } = masterAndOverrides(root);
  if (!master) throw Object.assign(new Error('Event not found'), { notFound: true });
  const b = bounds(master, zones);
  applyText(master, input);
  if (input.start !== undefined) {
    // The form holds one occurrence's dates. The series moves by the same amount, from its own start.
    let anchorMs = b.startMs;
    if (recurrenceId && isSeries(master)) {
      const time = ICAL.Time.fromString(recurrenceId);
      anchorMs = time.isDate ? dateToMs(isoDate(time)) : toUtcMs(time, b.tzid, zones);
    }
    const inStart = input.allDay ? dateToMs(input.start) : Date.parse(input.start);
    const inEnd = input.allDay ? dateToMs(input.end) : Date.parse(input.end);
    const newStartMs = b.startMs + (inStart - anchorMs);
    const newEndMs = newStartMs + (inEnd - inStart);
    const kindChanged = input.allDay !== b.allDay;
    const moved = input.allDay
      ? { ...input, start: msToDate(kindChanged ? inStart : newStartMs), end: msToDate(kindChanged ? inEnd : newEndMs) }
      : { ...input, start: new Date(kindChanged ? inStart : newStartMs).toISOString(), end: new Date(kindChanged ? inEnd : newEndMs).toISOString() };
    const tzid = input.allDay ? null : (b.tzid || input.timezone);
    if (isSeries(master) && !kindChanged) {
      const deltaMs = newStartMs - b.startMs;
      if (deltaMs) {
        shiftSeriesMarkers(master, overrides, deltaMs, b.tzid, zones);
        shiftRuleDays(master, b, newStartMs);
      }
    }
    if (kindChanged) {
      // A marker in the old value type no longer names any occurrence.
      master.removeAllProperties('exdate');
      overrides.forEach(o => root.removeSubcomponent(o));
    }
    setBounds(master, moved, tzid);
    if (tzid) ensureTimezone(root, tzid);
    if (input.recurrence !== undefined) setRecurrence(master, input.recurrence, input, tzid);
  } else if (input.recurrence !== undefined) {
    setRecurrence(master, input.recurrence, { allDay: b.allDay }, b.tzid);
  }
  if (input.reminderMinutes !== undefined) setReminder(master, input.reminderMinutes);
  touch(master);
}

export function applyEdit(ics, input, { scope = 'all', recurrenceId } = {}) {
  const root = parseRoot(ics);
  const zones = zonesOf(root, input.timezone);
  if (scope === 'this') editOccurrence(root, input, recurrenceId, zones);
  else editSeries(root, input, recurrenceId, zones);
  return root.toString();
}

// One occurrence off a series. Returns null when nothing is left of the resource.
export function removeOccurrence(ics, recurrenceId) {
  const root = parseRoot(ics);
  const zones = zonesOf(root);
  const { master, overrides } = masterAndOverrides(root);
  const b = master ? bounds(master, zones) : null;
  const key = ridKey(recurrenceId, b, zones);
  const override = findOverride(overrides, key, zones);
  if (!override && !master) throw Object.assign(new Error('Occurrence not found'), { notFound: true });
  if (override) root.removeSubcomponent(override);
  if (master) {
    const ridProp = override?.getFirstProperty('recurrence-id');
    const prop = override
      ? (() => {
        const p = new ICAL.Property('exdate');
        const tz = tzidOf(ridProp);
        if (ridProp.getFirstValue().isDate) p.resetType('date');
        else if (tz) p.setParameter('tzid', tz);
        p.setValue(ridProp.getFirstValue());
        return p;
      })()
      : (assertOccurs(master, b, key, zones), ridValue(recurrenceId, b, 'exdate'));
    master.addProperty(prop);
    touch(master);
  } else if (!root.getAllSubcomponents('vevent').length) {
    return null;
  }
  return root.toString();
}
