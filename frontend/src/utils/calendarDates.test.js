// Run with: node --test src/utils/calendarDates.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';

process.env.TZ = 'Europe/Paris';
const c = await import('./calendarDates.js');

describe('day arithmetic', () => {
  it('adds days and months without a time zone', () => {
    assert.equal(c.addDays('2026-03-29', 1), '2026-03-30');
    assert.equal(c.addDays('2026-12-31', 1), '2027-01-01');
    assert.equal(c.addDays('2026-03-01', -1), '2026-02-28');
    assert.equal(c.addMonths('2026-01-31', 1), '2026-02-28');
    assert.equal(c.addMonths('2026-01-15', -2), '2025-11-15');
    assert.equal(c.dayDiff('2026-03-28', '2026-03-30'), 2);
  });

  it('counts across a DST change in whole days', () => {
    assert.equal(c.dayDiff('2026-10-24', '2026-10-26'), 2);
  });

  it('finds the first day of the week and the week', () => {
    assert.equal(c.startOfWeek('2026-11-05', 1), '2026-11-02');
    assert.equal(c.startOfWeek('2026-11-05', 0), '2026-11-01');
    assert.equal(c.startOfWeek('2026-11-01', 1), '2026-10-26');
    assert.deepEqual(c.weekDays('2026-11-05', 1)[6], '2026-11-08');
  });

  it('builds only the weeks a month needs', () => {
    assert.equal(c.monthGrid('2027-02-10', 1).length, 4);
    assert.equal(c.monthGrid('2026-11-10', 1).length, 6);
    assert.equal(c.monthGrid('2026-11-10', 0).length, 5);
    assert.equal(c.monthGrid('2026-08-10', 1).length, 6);
    const grid = c.monthGrid('2026-11-10', 1);
    assert.equal(grid[0][0], '2026-10-26');
    assert.equal(grid[5][6], '2026-12-06');
  });

  it('reads the first day of the week from the locale, Monday when unknown', () => {
    assert.equal(c.firstDayOfWeek('en-US'), 0);
    assert.equal(c.firstDayOfWeek('fr'), 1);
    assert.equal(c.firstDayOfWeek('de-DE'), 1);
    assert.equal(c.firstDayOfWeek('not a locale'), 1);
  });
});

describe('visible range', () => {
  it('spans local midnights, so a DST week is 167 hours', () => {
    const r = c.visibleRange('week', '2026-03-25', 1);
    assert.equal(r.first, '2026-03-23');
    assert.equal(r.endDay, '2026-03-30');
    assert.equal((new Date(r.to) - new Date(r.from)) / 3_600_000, 167);
  });

  it('shifts the anchor by the size of the view', () => {
    assert.equal(c.shiftAnchor('month', '2026-01-31', 1), '2026-02-28');
    assert.equal(c.shiftAnchor('week', '2026-11-05', -1), '2026-10-29');
    assert.equal(c.shiftAnchor('day', '2026-11-05', 1), '2026-11-06');
    assert.equal(c.shiftAnchor('agenda', '2026-11-05', 1), '2026-12-05');
  });
});

describe('occurrences', () => {
  it('takes all-day dates as they are, end exclusive', () => {
    const occ = { allDay: true, start: '2026-03-28', end: '2026-03-30' };
    assert.deepEqual(c.occurrenceDays(occ), { startDay: '2026-03-28', endDay: '2026-03-30' });
    assert.equal(c.occursOnDay(occ, '2026-03-29'), true);
    assert.equal(c.occursOnDay(occ, '2026-03-30'), false);
  });

  it('gives an inverted all-day event its start day', () => {
    assert.deepEqual(c.occurrenceDays({ allDay: true, start: '2026-03-28', end: '2026-03-28' }), { startDay: '2026-03-28', endDay: '2026-03-29' });
  });

  it('places timed events by local day, midnight end excluded', () => {
    const late = { allDay: false, start: '2026-11-05T22:00:00.000Z', end: '2026-11-05T22:30:00.000Z' };
    assert.deepEqual(c.occurrenceDays(late), { startDay: '2026-11-05', endDay: '2026-11-06' });
    const toMidnight = { allDay: false, start: '2026-11-05T21:00:00.000Z', end: '2026-11-05T23:00:00.000Z' };
    assert.deepEqual(c.occurrenceDays(toMidnight), { startDay: '2026-11-05', endDay: '2026-11-06' });
    const overnight = { allDay: false, start: '2026-11-05T21:00:00.000Z', end: '2026-11-06T08:00:00.000Z' };
    assert.deepEqual(c.occurrenceDays(overnight), { startDay: '2026-11-05', endDay: '2026-11-07' });
  });

  it('measures minutes from local midnight on a 23 hour day', () => {
    // 2026-03-29: Paris skips 02:00-03:00. 09:00 local is 07:00Z there.
    const occ = { allDay: false, start: '2026-03-29T07:00:00.000Z', end: '2026-03-29T08:30:00.000Z' };
    assert.deepEqual(c.minutesOnDay(occ, '2026-03-29'), { startMin: 540, endMin: 630 });
  });

  it('measures minutes on a 25 hour day', () => {
    // 2026-10-25: Paris repeats 02:00-03:00. 09:00 local is 08:00Z.
    const occ = { allDay: false, start: '2026-10-25T08:00:00.000Z', end: '2026-10-25T09:00:00.000Z' };
    assert.deepEqual(c.minutesOnDay(occ, '2026-10-25'), { startMin: 540, endMin: 600 });
  });

  it('clips an overnight event to each day', () => {
    const occ = { allDay: false, start: '2026-11-05T21:00:00.000Z', end: '2026-11-06T08:00:00.000Z' };
    assert.deepEqual(c.minutesOnDay(occ, '2026-11-05'), { startMin: 22 * 60, endMin: 1440 });
    assert.deepEqual(c.minutesOnDay(occ, '2026-11-06'), { startMin: 0, endMin: 9 * 60 });
  });

  it('orders all-day first, then by start', () => {
    const list = [
      { allDay: false, start: '2026-11-05T10:00:00.000Z', summary: 'b' },
      { allDay: true, start: '2026-11-05', summary: 'z' },
      { allDay: false, start: '2026-11-05T08:00:00.000Z', summary: 'a' },
    ].sort(c.compareOccurrences);
    assert.deepEqual(list.map(o => o.summary), ['z', 'a', 'b']);
  });
});

describe('layoutColumns', () => {
  it('puts overlapping events side by side and lets others keep the full width', () => {
    const map = c.layoutColumns([
      { id: 'a', startMin: 540, endMin: 600 },
      { id: 'b', startMin: 570, endMin: 630 },
      { id: 'c', startMin: 600, endMin: 660 },
      { id: 'd', startMin: 720, endMin: 780 },
    ]);
    assert.deepEqual(map.get('a'), { col: 0, cols: 2 });
    assert.deepEqual(map.get('b'), { col: 1, cols: 2 });
    assert.deepEqual(map.get('c'), { col: 0, cols: 2 });
    assert.deepEqual(map.get('d'), { col: 0, cols: 1 });
  });

  it('treats a very short event as a slot long', () => {
    const map = c.layoutColumns([
      { id: 'a', startMin: 540, endMin: 540 },
      { id: 'b', startMin: 545, endMin: 560 },
    ]);
    assert.equal(map.get('a').cols, 2);
  });
});

describe('layoutWeek', () => {
  const days = c.weekDays('2026-11-05', 1);
  it('spans multi-day events and stacks overlaps in lanes', () => {
    const occs = [
      { id: 1, allDay: true, start: '2026-11-03', end: '2026-11-06', summary: 'trip' },
      { id: 2, allDay: true, start: '2026-11-04', end: '2026-11-05', summary: 'day' },
      { id: 3, allDay: true, start: '2026-11-06', end: '2026-11-07', summary: 'later' },
    ];
    const { segments, laneCount } = c.layoutWeek(occs, days);
    const by = Object.fromEntries(segments.map(s => [s.occ.id, s]));
    assert.deepEqual([by[1].startCol, by[1].endCol, by[1].lane], [1, 4, 0]);
    assert.equal(by[2].lane, 1);
    assert.equal(by[3].lane, 0);
    assert.equal(laneCount, 2);
  });

  it('clips an event that continues past the week and flags it', () => {
    const { segments } = c.layoutWeek([{ allDay: true, start: '2026-11-07', end: '2026-11-12', summary: 'x' }], days);
    assert.deepEqual([segments[0].startCol, segments[0].endCol, segments[0].after, segments[0].before], [5, 7, true, false]);
    const prev = c.layoutWeek([{ allDay: true, start: '2026-10-30', end: '2026-11-03', summary: 'x' }], days).segments[0];
    assert.deepEqual([prev.startCol, prev.endCol, prev.before], [0, 1, true]);
  });

  it('ignores events outside the days and counts what a lane limit hides', () => {
    const occs = [
      { allDay: true, start: '2026-11-02', end: '2026-11-03', summary: 'a' },
      { allDay: true, start: '2026-11-02', end: '2026-11-04', summary: 'b' },
      { allDay: true, start: '2026-11-02', end: '2026-11-03', summary: 'c' },
      { allDay: true, start: '2026-12-02', end: '2026-12-03', summary: 'far' },
    ];
    const { segments } = c.layoutWeek(occs, days);
    assert.equal(segments.length, 3);
    assert.deepEqual(c.hiddenCounts(segments, 7, 2), [1, 0, 0, 0, 0, 0, 0]);
  });
});

describe('shiftOccurrence', () => {
  it('moves all-day events by days without touching Date', () => {
    assert.deepEqual(c.shiftOccurrence({ allDay: true, start: '2026-03-28', end: '2026-03-30' }, { days: 2 }), { start: '2026-03-30', end: '2026-04-01' });
  });

  it('keeps the wall-clock time across a DST change', () => {
    // Sat 2026-03-28 09:00-10:00 Paris (08:00Z) moved to Sunday the 29th: still 09:00 local (07:00Z).
    const moved = c.shiftOccurrence({ allDay: false, start: '2026-03-28T08:00:00.000Z', end: '2026-03-28T09:00:00.000Z' }, { days: 1 });
    assert.deepEqual(moved, { start: '2026-03-29T07:00:00.000Z', end: '2026-03-29T08:00:00.000Z' });
  });

  it('moves by minutes and resizes the end only', () => {
    const occ = { allDay: false, start: '2026-11-05T09:00:00.000Z', end: '2026-11-05T10:00:00.000Z' };
    assert.deepEqual(c.shiftOccurrence(occ, { minutes: 30 }), { start: '2026-11-05T09:30:00.000Z', end: '2026-11-05T10:30:00.000Z' });
    assert.deepEqual(c.shiftOccurrence(occ, { minutes: 45, resize: true }), { start: occ.start, end: '2026-11-05T10:45:00.000Z' });
  });

  it('never resizes below one snap step', () => {
    const occ = { allDay: false, start: '2026-11-05T09:00:00.000Z', end: '2026-11-05T10:00:00.000Z' };
    assert.equal(c.shiftOccurrence(occ, { minutes: -120, resize: true }).end, '2026-11-05T09:15:00.000Z');
  });

  it('snaps minutes', () => {
    assert.equal(c.snapMinutes(527), 525);
    assert.equal(c.snapMinutes(533), 540);
  });
});

describe('local inputs', () => {
  it('round-trips a datetime-local value in the local zone', () => {
    const iso = c.fromLocalInput('2026-11-05T09:30');
    assert.equal(iso, '2026-11-05T08:30:00.000Z');
    assert.equal(c.toLocalInput(iso), '2026-11-05T09:30');
    assert.equal(c.fromLocalInput(''), null);
    assert.equal(c.toLocalInput('nope'), '');
  });

  it('builds a slot on a spring-forward day by wall clock', () => {
    assert.equal(c.slotToDate('2026-03-29', 9 * 60).toISOString(), '2026-03-29T07:00:00.000Z');
  });
});

describe('writing', () => {
  it('formats a day string in the local calendar, not UTC', () => {
    assert.equal(c.formatDayText('2026-03-29', { day: 'numeric', month: 'long' }, 'en-US'), 'March 29');
  });

  it('titles each view', () => {
    assert.equal(c.formatTitle('month', '2026-11-05', 1, 'en-US'), 'November 2026');
    assert.match(c.formatTitle('week', '2026-11-05', 1, 'en-US'), /Nov 2.*8, 2026/);
    assert.match(c.formatTitle('day', '2026-11-05', 1, 'en-US'), /Thursday, November 5, 2026/);
  });

  it('writes the time of a timed event and the days of an all-day one', () => {
    const timed = { allDay: false, start: '2026-11-05T08:00:00.000Z', end: '2026-11-05T09:30:00.000Z' };
    assert.match(c.formatWhen(timed, 'en-US'), /Nov(ember)? 5, 2026, 9:00.AM . 10:30.AM/);
    const span = { allDay: true, start: '2026-03-28', end: '2026-03-30' };
    assert.match(c.formatWhen(span, 'en-US'), /March 28.*29, 2026/);
  });
});
