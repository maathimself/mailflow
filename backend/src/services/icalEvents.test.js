import { describe, expect, it } from 'vitest';
import ICAL from 'ical.js';
import { applyEdit, buildEvent, expandResource, removeOccurrence, resourceInfo, vtimezoneBlock } from './icalEvents.js';

const range = (from, to) => [Date.parse(from), Date.parse(to)];
const cal = (...lines) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//t//EN', ...lines, 'END:VCALENDAR'].join('\r\n');
const WEEKLY = cal(
  'BEGIN:VEVENT', 'UID:w1', 'DTSTAMP:20260101T000000Z', 'SUMMARY:Standup', 'X-KEEP-ME:yes',
  'DTSTART;TZID=Europe/Zurich:20261019T090000', 'DTEND;TZID=Europe/Zurich:20261019T093000',
  'RRULE:FREQ=WEEKLY;BYDAY=MO', 'ATTENDEE;CN=Ana;PARTSTAT=ACCEPTED:mailto:ana@example.com', 'END:VEVENT',
);

describe('expandResource', () => {
  it('keeps the wall clock of a series across a DST change', () => {
    const occ = expandResource(WEEKLY, ...range('2026-10-19T00:00:00Z', '2026-11-03T00:00:00Z'));
    expect(occ.map(o => o.start)).toEqual([
      '2026-10-19T07:00:00.000Z', // CEST
      '2026-10-26T08:00:00.000Z', // CET, DST ended on the 25th
      '2026-11-02T08:00:00.000Z',
    ]);
    expect(occ[1].end).toBe('2026-10-26T08:30:00.000Z');
    expect(occ[0].isRecurring).toBe(true);
    expect(occ[0].recurrence).toEqual({ freq: 'WEEKLY', interval: 1, until: null, count: null });
    expect(occ[0].recurrenceCustom).toBe(false);
    expect(occ[0].attendees[0]).toEqual({ name: 'Ana', email: 'ana@example.com', status: 'ACCEPTED' });
  });

  it('leaves all-day dates as dates, with an exclusive end', () => {
    const ics = cal('BEGIN:VEVENT', 'UID:a', 'DTSTAMP:20260101T000000Z', 'SUMMARY:Off',
      'DTSTART;VALUE=DATE:20261105', 'DTEND;VALUE=DATE:20261107', 'END:VEVENT');
    const [occ] = expandResource(ics, ...range('2026-11-01T00:00:00Z', '2026-11-30T00:00:00Z'));
    expect(occ).toMatchObject({ allDay: true, start: '2026-11-05', end: '2026-11-07', timezone: null });
  });

  it('defaults a missing DTEND to one day for a date and to no length for a time', () => {
    const date = cal('BEGIN:VEVENT', 'UID:a', 'DTSTAMP:20260101T000000Z', 'DTSTART;VALUE=DATE:20261105', 'END:VEVENT');
    expect(expandResource(date, ...range('2026-11-01T00:00:00Z', '2026-11-30T00:00:00Z'))[0].end).toBe('2026-11-06');
    const time = cal('BEGIN:VEVENT', 'UID:b', 'DTSTAMP:20260101T000000Z', 'DTSTART:20261105T100000Z', 'END:VEVENT');
    const [o] = expandResource(time, ...range('2026-11-01T00:00:00Z', '2026-11-30T00:00:00Z'));
    expect(o.end).toBe(o.start);
  });

  it('reads DURATION', () => {
    const ics = cal('BEGIN:VEVENT', 'UID:a', 'DTSTAMP:20260101T000000Z', 'DTSTART:20261105T100000Z', 'DURATION:PT90M', 'END:VEVENT');
    expect(expandResource(ics, ...range('2026-11-01T00:00:00Z', '2026-11-30T00:00:00Z'))[0].end).toBe('2026-11-05T11:30:00.000Z');
  });

  it('resolves a non-IANA zone through the resource\'s VTIMEZONE', () => {
    const ics = cal('BEGIN:VTIMEZONE', 'TZID:Romance Standard Time',
      'BEGIN:STANDARD', 'DTSTART:16010101T030000', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=10', 'END:STANDARD',
      'BEGIN:DAYLIGHT', 'DTSTART:16010101T020000', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=3', 'END:DAYLIGHT',
      'END:VTIMEZONE',
      'BEGIN:VEVENT', 'UID:o', 'DTSTAMP:20260101T000000Z', 'DTSTART;TZID=Romance Standard Time:20260701T100000',
      'DTEND;TZID=Romance Standard Time:20260701T110000', 'END:VEVENT');
    expect(expandResource(ics, ...range('2026-07-01T00:00:00Z', '2026-07-02T00:00:00Z'))[0].start).toBe('2026-07-01T08:00:00.000Z');
  });

  it('keeps two different definitions of one zone name apart', () => {
    const define = offset => cal('BEGIN:VTIMEZONE', 'TZID:Paris, Madrid',
      'BEGIN:STANDARD', 'DTSTART:16010101T000000', `TZOFFSETFROM:${offset}`, `TZOFFSETTO:${offset}`, 'END:STANDARD', 'END:VTIMEZONE',
      'BEGIN:VEVENT', 'UID:o', 'DTSTAMP:20260101T000000Z', 'DTSTART;TZID="Paris, Madrid":20260701T100000',
      'DTEND;TZID="Paris, Madrid":20260701T110000', 'END:VEVENT');
    const start = ics => expandResource(ics, ...range('2026-07-01T00:00:00Z', '2026-07-02T00:00:00Z'))[0].start;
    expect(start(define('+0100'))).toBe('2026-07-01T09:00:00.000Z');
    expect(start(define('+0300'))).toBe('2026-07-01T07:00:00.000Z');
    expect(start(define('+0100'))).toBe('2026-07-01T09:00:00.000Z');
  });

  it('drops EXDATEs, including one written in another zone, and shows a moved override once', () => {
    const ics = cal(
      'BEGIN:VEVENT', 'UID:s', 'DTSTAMP:20260101T000000Z', 'SUMMARY:Daily',
      'DTSTART;TZID=Europe/Zurich:20261102T090000', 'DTEND;TZID=Europe/Zurich:20261102T100000',
      'RRULE:FREQ=DAILY;COUNT=5', 'EXDATE:20261103T080000Z', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:s', 'DTSTAMP:20260101T000000Z', 'SUMMARY:Moved',
      'RECURRENCE-ID;TZID=Europe/Zurich:20261104T090000',
      'DTSTART;TZID=Europe/Zurich:20261120T140000', 'DTEND;TZID=Europe/Zurich:20261120T150000', 'END:VEVENT',
    );
    const occ = expandResource(ics, ...range('2026-11-01T00:00:00Z', '2026-12-01T00:00:00Z'));
    const days = occ.map(o => o.start.slice(0, 10)).sort();
    expect(days).toEqual(['2026-11-02', '2026-11-05', '2026-11-06', '2026-11-20']);
    expect(occ.find(o => o.summary === 'Moved').recurrenceId).toBe('2026-11-04T09:00:00');
  });

  it('reads a floating time in the viewer\'s zone', () => {
    const ics = cal('BEGIN:VEVENT', 'UID:f', 'DTSTAMP:20260101T000000Z', 'DTSTART:20261105T100000', 'DTEND:20261105T110000', 'END:VEVENT');
    const [occ] = expandResource(ics, ...range('2026-11-01T00:00:00Z', '2026-11-30T00:00:00Z'), { floatingTz: 'Europe/Zurich' });
    expect(occ.start).toBe('2026-11-05T09:00:00.000Z');
  });

  it('understands an IANA zone behind a vendor prefix', () => {
    const ics = cal('BEGIN:VEVENT', 'UID:p', 'DTSTAMP:20260101T000000Z',
      'DTSTART;TZID=/freeassociation.sourceforge.net/Europe/Zurich:20261105T100000',
      'DTEND;TZID=/freeassociation.sourceforge.net/Europe/Zurich:20261105T110000', 'END:VEVENT');
    expect(expandResource(ics, ...range('2026-11-01T00:00:00Z', '2026-11-30T00:00:00Z'))[0].start).toBe('2026-11-05T09:00:00.000Z');
  });

  it('expands a series that began long before the window', () => {
    const ics = cal('BEGIN:VEVENT', 'UID:o', 'DTSTAMP:20100101T000000Z', 'DTSTART:20100101T080000Z', 'DTEND:20100101T090000Z', 'RRULE:FREQ=DAILY', 'END:VEVENT');
    expect(expandResource(ics, ...range('2026-11-01T00:00:00Z', '2026-11-08T00:00:00Z'))).toHaveLength(7);
  });

  it('skips a CANCELLED override', () => {
    const ics = cal(
      'BEGIN:VEVENT', 'UID:s', 'DTSTAMP:20260101T000000Z', 'DTSTART:20261102T090000Z', 'DTEND:20261102T100000Z', 'RRULE:FREQ=DAILY;COUNT=2', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:s', 'DTSTAMP:20260101T000000Z', 'RECURRENCE-ID:20261103T090000Z', 'STATUS:CANCELLED', 'DTSTART:20261103T090000Z', 'DTEND:20261103T100000Z', 'END:VEVENT',
    );
    expect(expandResource(ics, ...range('2026-11-01T00:00:00Z', '2026-12-01T00:00:00Z'))).toHaveLength(1);
  });

  it('flags a rule the simple form cannot show as custom', () => {
    const ics = cal('BEGIN:VEVENT', 'UID:s', 'DTSTAMP:20260101T000000Z', 'DTSTART:20261102T090000Z', 'DTEND:20261102T100000Z', 'RRULE:FREQ=MONTHLY;BYDAY=1MO', 'END:VEVENT');
    expect(expandResource(ics, ...range('2026-11-01T00:00:00Z', '2026-11-30T00:00:00Z'))[0].recurrenceCustom).toBe(true);
  });
});

describe('resourceInfo', () => {
  it('leaves an endless series open, and closes one with a COUNT', () => {
    expect(resourceInfo(WEEKLY).rangeEnd).toBeNull();
    const ics = cal('BEGIN:VEVENT', 'UID:s', 'DTSTAMP:20260101T000000Z', 'DTSTART:20261102T090000Z', 'DTEND:20261102T100000Z', 'RRULE:FREQ=DAILY;COUNT=3', 'END:VEVENT');
    expect(resourceInfo(ics).rangeEnd.toISOString().slice(0, 10)).toBe('2026-11-05');
  });
  it('returns null for a resource with no event', () => {
    expect(resourceInfo(cal('BEGIN:VTODO', 'UID:t', 'DTSTAMP:20260101T000000Z', 'END:VTODO'))).toBeNull();
  });
});

describe('buildEvent', () => {
  it('round-trips a timed event through its own VTIMEZONE and rule', () => {
    const { ical, uid } = buildEvent({
      summary: 'Lunch; with, commas', location: 'Bern', description: 'line one\nline two', allDay: false,
      start: '2026-11-10T11:00:00.000Z', end: '2026-11-10T12:00:00.000Z', timezone: 'Europe/Zurich',
      recurrence: { freq: 'WEEKLY', interval: 2, until: '2026-12-31' }, reminderMinutes: 10,
    });
    expect(ical).toContain('DTSTART;TZID=Europe/Zurich:20261110T120000');
    expect(ical).toContain('BEGIN:VTIMEZONE');
    const occ = expandResource(ical, ...range('2026-11-01T00:00:00Z', '2027-02-01T00:00:00Z'));
    expect(occ[0]).toMatchObject({ summary: 'Lunch; with, commas', description: 'line one\nline two', reminderMinutes: 10, start: '2026-11-10T11:00:00.000Z' });
    expect(occ[0].recurrence).toEqual({ freq: 'WEEKLY', interval: 2, until: '2026-12-31', count: null });
    expect(occ[occ.length - 1].start.slice(0, 10)).toBe('2026-12-22');
    expect(resourceInfo(ical).uid).toBe(uid);
  });

  it('writes an all-day event as dates', () => {
    const { ical } = buildEvent({ summary: 'Off', allDay: true, start: '2026-11-05', end: '2026-11-06' });
    expect(ical).toContain('DTSTART;VALUE=DATE:20261105');
    expect(ical).not.toContain('VTIMEZONE');
  });

  it('writes UTC when given no zone', () => {
    const { ical } = buildEvent({ summary: 'x', allDay: false, start: '2026-11-05T10:00:00Z', end: '2026-11-05T11:00:00Z' });
    expect(ical).toContain('DTSTART:20261105T100000Z');
  });
});

describe('vtimezoneBlock', () => {
  for (const tz of ['Europe/Zurich', 'America/New_York', 'Australia/Sydney', 'Asia/Tokyo', 'Asia/Kolkata']) {
    it(`agrees with Intl for ${tz}`, () => {
      const root = new ICAL.Component(ICAL.parse(`BEGIN:VCALENDAR\r\n${vtimezoneBlock(tz, Date.UTC(2026, 5, 1))}\r\nEND:VCALENDAR`));
      const zone = new ICAL.Timezone({ component: root.getFirstSubcomponent('vtimezone'), tzid: tz });
      for (const month of [1, 4, 7, 10]) {
        const local = new ICAL.Time({ year: 2027, month, day: 15, hour: 12, minute: 0, second: 0 }, zone);
        const ms = local.toUnixTime() * 1000;
        const wall = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', hour: 'numeric', minute: 'numeric' }).format(new Date(ms));
        expect(wall).toBe('12:00');
      }
    });
  }
});

describe('applyEdit', () => {
  it('keeps properties MailFlow does not model', () => {
    const out = applyEdit(WEEKLY, { summary: 'Renamed' }, { scope: 'all' });
    expect(out).toContain('X-KEEP-ME:yes');
    expect(out).toContain('ATTENDEE');
    expect(out).toContain('SUMMARY:Renamed');
    expect(out).toContain('RRULE:FREQ=WEEKLY;BYDAY=MO');
  });

  it('edits one occurrence as an override and leaves the others', () => {
    const out = applyEdit(WEEKLY, {
      summary: 'Late', allDay: false, start: '2026-10-26T09:00:00Z', end: '2026-10-26T09:30:00Z',
    }, { scope: 'this', recurrenceId: '2026-10-26T09:00:00' });
    expect(out).toContain('RECURRENCE-ID;TZID=Europe/Zurich:20261026T090000');
    const occ = expandResource(out, ...range('2026-10-19T00:00:00Z', '2026-11-03T00:00:00Z'));
    expect(occ.map(o => o.summary).sort()).toEqual(['Late', 'Standup', 'Standup']);
    expect(occ.find(o => o.summary === 'Late')).toMatchObject({ start: '2026-10-26T09:00:00.000Z', recurrenceId: '2026-10-26T09:00:00' });
    // A second edit finds that override rather than adding another.
    const again = applyEdit(out, { summary: 'Later', allDay: false, start: '2026-10-26T10:00:00Z', end: '2026-10-26T10:30:00Z' }, { scope: 'this', recurrenceId: '2026-10-26T09:00:00' });
    expect(again.match(/RECURRENCE-ID/g)).toHaveLength(1);
  });

  it('refuses an occurrence the series does not have', () => {
    expect(() => applyEdit(WEEKLY, { allDay: false, start: '2026-10-27T09:00:00Z', end: '2026-10-27T09:30:00Z' }, { scope: 'this', recurrenceId: '2026-10-27T09:00:00' })).toThrow(/not found/);
  });

  it('moves a series by the shift made on one of its occurrences', () => {
    // Dragging the 2 November occurrence an hour later, for the whole series.
    const out = applyEdit(WEEKLY, {
      allDay: false, start: '2026-11-02T09:00:00Z', end: '2026-11-02T09:30:00Z',
    }, { scope: 'all', recurrenceId: '2026-11-02T09:00:00' });
    expect(out).toContain('DTSTART;TZID=Europe/Zurich:20261019T100000');
    const occ = expandResource(out, ...range('2026-10-19T00:00:00Z', '2026-11-03T00:00:00Z'));
    expect(occ.map(o => o.start)).toEqual(['2026-10-19T08:00:00.000Z', '2026-10-26T09:00:00.000Z', '2026-11-02T09:00:00.000Z']);
  });

  it('carries a weekday rule, exceptions and overrides along when a series moves a day', () => {
    const excluded = removeOccurrence(WEEKLY, '2026-10-26T09:00:00');
    const edited = applyEdit(excluded, { summary: 'Solo', allDay: false, start: '2026-11-02T10:00:00Z', end: '2026-11-02T10:30:00Z' }, { scope: 'this', recurrenceId: '2026-11-02T09:00:00' });
    const out = applyEdit(edited, {
      allDay: false, start: '2026-11-10T08:00:00Z', end: '2026-11-10T08:30:00Z',
    }, { scope: 'all', recurrenceId: '2026-11-09T09:00:00' });
    expect(out).toContain('BYDAY=TU');
    const occ = expandResource(out, ...range('2026-10-19T00:00:00Z', '2026-11-18T00:00:00Z'));
    const days = occ.map(o => `${o.summary}:${o.start.slice(0, 10)}`).sort();
    expect(days).toEqual(['Solo:2026-11-02', 'Standup:2026-10-20', 'Standup:2026-11-10', 'Standup:2026-11-17']);
  });

  it('sets and clears a recurrence and a reminder', () => {
    const { ical } = buildEvent({ summary: 'x', allDay: false, start: '2026-11-05T10:00:00Z', end: '2026-11-05T11:00:00Z', timezone: 'Europe/Zurich' });
    const on = applyEdit(ical, { recurrence: { freq: 'DAILY', count: 3 }, reminderMinutes: 60 });
    expect(expandResource(on, ...range('2026-11-01T00:00:00Z', '2026-12-01T00:00:00Z'))).toHaveLength(3);
    const off = applyEdit(on, { recurrence: null, reminderMinutes: null });
    const occ = expandResource(off, ...range('2026-11-01T00:00:00Z', '2026-12-01T00:00:00Z'));
    expect(occ).toHaveLength(1);
    expect(occ[0].reminderMinutes).toBeNull();
  });

  it('bumps SEQUENCE', () => {
    const { ical } = buildEvent({ summary: 'x', allDay: true, start: '2026-11-05', end: '2026-11-06' });
    expect(applyEdit(ical, { summary: 'y' })).toContain('SEQUENCE:1');
  });

  it('turns a timed event all-day', () => {
    const { ical } = buildEvent({ summary: 'x', allDay: false, start: '2026-11-05T10:00:00Z', end: '2026-11-05T11:00:00Z', timezone: 'Europe/Zurich' });
    const out = applyEdit(ical, { allDay: true, start: '2026-11-05', end: '2026-11-06' });
    expect(expandResource(out, ...range('2026-11-01T00:00:00Z', '2026-12-01T00:00:00Z'))[0]).toMatchObject({ allDay: true, start: '2026-11-05', end: '2026-11-06' });
  });
});

describe('a zone only the resource defines', () => {
  const VTZ = ['BEGIN:VTIMEZONE', 'TZID:Paris\\, Madrid',
    'BEGIN:STANDARD', 'DTSTART:16011005T030000', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=10', 'END:STANDARD',
    'BEGIN:DAYLIGHT', 'DTSTART:16010305T020000', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=3', 'END:DAYLIGHT', 'END:VTIMEZONE'];
  const SERIES = cal(...VTZ, 'BEGIN:VEVENT', 'UID:p', 'DTSTAMP:20260101T000000Z', 'SUMMARY:Serie',
    'DTSTART;TZID="Paris, Madrid":20270315T090000', 'DTEND;TZID="Paris, Madrid":20270315T100000', 'RRULE:FREQ=WEEKLY;COUNT=6', 'END:VEVENT');
  const window = range('2027-03-01T00:00:00Z', '2027-05-30T00:00:00Z');

  it('keeps the event in that zone when it is edited', () => {
    const out = applyEdit(SERIES, { allDay: false, start: '2027-03-15T09:00:00Z', end: '2027-03-15T10:00:00Z' }, { scope: 'all' });
    expect(out).toContain('DTSTART;TZID="Paris, Madrid":20270315T100000');
  });

  it('keeps an exception and an exclusion when the series moves', () => {
    const excluded = removeOccurrence(SERIES, '2027-04-05T09:00:00');
    const edited = applyEdit(excluded, { summary: 'Solo', allDay: false, start: '2027-03-23T10:00:00Z', end: '2027-03-23T11:00:00Z' }, { scope: 'this', recurrenceId: '2027-03-22T09:00:00' });
    const out = applyEdit(edited, { allDay: false, start: '2027-03-30T08:00:00Z', end: '2027-03-30T09:00:00Z' }, { scope: 'all', recurrenceId: '2027-03-29T09:00:00' });
    expect(out).toContain('EXDATE;TZID="Paris, Madrid":20270406T100000');
    expect(out).toContain('RECURRENCE-ID;TZID="Paris, Madrid":20270323T100000');
    const occ = expandResource(out, ...window).sort((a, b) => (a.start < b.start ? -1 : 1));
    expect(occ).toHaveLength(5);
    expect(occ.find(o => o.summary === 'Solo').start).toBe('2027-03-23T10:00:00.000Z');
    expect(occ.some(o => o.start.startsWith('2027-04-06'))).toBe(false);
  });

  it('ends a series on the day asked, on a server that keeps only the local date of UNTIL', () => {
    const out = applyEdit(SERIES, { recurrence: { freq: 'DAILY', until: '2027-03-19' } });
    expect(out).toContain('UNTIL=20270319T080000Z');
    const occ = expandResource(out, ...window);
    expect(occ).toHaveLength(5);
    expect(occ[0].recurrence.until).toBe('2027-03-19');
  });
});

describe('text values', () => {
  it('drops the backslash a server puts before a double quote', () => {
    const ics = cal('BEGIN:VEVENT', 'UID:q', 'DTSTAMP:20260101T000000Z', 'SUMMARY:a \\"b\\" c\\, d', 'DTSTART:20261105T100000Z', 'END:VEVENT');
    expect(expandResource(ics, ...range('2026-11-01T00:00:00Z', '2026-11-30T00:00:00Z'))[0].summary).toBe('a "b" c, d');
  });
});

describe('removeOccurrence', () => {
  it('adds an EXDATE in the series\' zone', () => {
    const out = removeOccurrence(WEEKLY, '2026-10-26T09:00:00');
    expect(out).toContain('EXDATE;TZID=Europe/Zurich:20261026T090000');
    expect(expandResource(out, ...range('2026-10-19T00:00:00Z', '2026-11-03T00:00:00Z'))).toHaveLength(2);
  });

  it('removes an override and keeps its occurrence off the series', () => {
    const edited = applyEdit(WEEKLY, { allDay: false, start: '2026-10-28T09:00:00Z', end: '2026-10-28T09:30:00Z' }, { scope: 'this', recurrenceId: '2026-10-26T09:00:00' });
    const out = removeOccurrence(edited, '2026-10-26T09:00:00');
    expect(out).not.toContain('RECURRENCE-ID');
    expect(expandResource(out, ...range('2026-10-19T00:00:00Z', '2026-11-03T00:00:00Z'))).toHaveLength(2);
  });

  it('returns null when the last override of a master-less resource goes', () => {
    const ics = cal('BEGIN:VEVENT', 'UID:s', 'DTSTAMP:20260101T000000Z', 'RECURRENCE-ID:20261103T090000Z', 'DTSTART:20261103T090000Z', 'DTEND:20261103T100000Z', 'END:VEVENT');
    expect(removeOccurrence(ics, '2026-11-03T09:00:00Z')).toBeNull();
  });
});
