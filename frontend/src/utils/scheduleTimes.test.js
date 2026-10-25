// Send later's times (#543, design 7.3): worked out in the browser's own zone and wall clock,
// across daylight saving changes and in the evening west of UTC, where the UTC date is tomorrow.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import {
  MAX_AHEAD_MS, browserTimeZone, checkSendAt, clockSkewMs, dateBounds, defaultCustom, formatSendAt,
  localDateTimeValue, localDateValue, presets, resolveCustom, resolveLocalDateTime,
} from './scheduleTimes.js';

const originalTz = process.env.TZ;
afterEach(() => { process.env.TZ = originalTz; });

// Node applies a TZ change at once, so each case can run in its own zone.
function inZone(zone, run) {
  process.env.TZ = zone;
  return run();
}
const iso = d => d.toISOString();
const ids = list => list.map(p => p.id);
// ICU puts a narrow no-break space before AM and PM.
const plain = s => s.replace(/\s/g, ' ');

describe('presets', () => {
  test('tomorrow morning across the end of daylight saving time in Berlin', () => inZone('Europe/Berlin', () => {
    // Saturday, Oct 24, 2026, 20:00 CEST; the clocks go back at 03:00 on Sunday.
    const now = new Date('2026-10-24T18:00:00Z');
    const list = presets(now);
    assert.deepEqual(ids(list), ['tomorrowMorning', 'tomorrowAfternoon', 'mondayMorning']);
    assert.equal(iso(list[0].at), '2026-10-25T07:00:00.000Z', '8:00 CET, after the change');
    assert.equal(iso(list[1].at), '2026-10-25T12:00:00.000Z');
    assert.equal(iso(list[2].at), '2026-10-26T07:00:00.000Z');
    assert.equal(list[0].at.getHours(), 8);
  }));

  test('Monday morning is left out on Sundays, where it is tomorrow morning', () => inZone('Europe/Berlin', () => {
    const list = presets(new Date('2026-10-25T17:00:00Z'));
    assert.deepEqual(ids(list), ['tomorrowMorning', 'tomorrowAfternoon']);
    assert.equal(list[0].at.getDay(), 1);
  }));

  test('later today, 6:00 PM, is offered only before 4:00 PM', () => inZone('Europe/Berlin', () => {
    // Tuesday, Oct 27, 2026: 15:59 CET offers it, 16:00 does not.
    const before = presets(new Date('2026-10-27T14:59:00Z'));
    assert.deepEqual(ids(before), ['laterToday', 'tomorrowMorning', 'tomorrowAfternoon', 'mondayMorning']);
    assert.equal(iso(before[0].at), '2026-10-27T17:00:00.000Z');
    assert.deepEqual(ids(presets(new Date('2026-10-27T15:00:00Z'))), ['tomorrowMorning', 'tomorrowAfternoon', 'mondayMorning']);
    assert.equal(iso(presets(new Date('2026-10-27T05:30:00Z'))[0].at), '2026-10-27T17:00:00.000Z', 'early morning too');
  }));

  test('on a Monday, Monday morning is next week', () => inZone('Europe/Berlin', () => {
    const list = presets(new Date('2026-10-26T09:00:00Z'));
    assert.equal(iso(list.find(p => p.id === 'mondayMorning').at), '2026-11-02T07:00:00.000Z');
  }));

  test('in the evening in Los Angeles, tomorrow is the local tomorrow, not the UTC one', () => inZone('America/Los_Angeles', () => {
    // Saturday, Oct 24, 21:30 PDT is already Sunday in UTC.
    const now = new Date('2026-10-25T04:30:00Z');
    assert.equal(iso(presets(now)[0].at), '2026-10-25T15:00:00.000Z');
    assert.equal(localDateValue(now), '2026-10-24');
    assert.notEqual(now.toISOString().slice(0, 10), '2026-10-24', 'precondition: the UTC date differs');
    assert.equal(dateBounds(now).min, '2026-10-24');
  }));
});

describe('custom times', () => {
  test('a time in the spring-forward gap resolves to the first time that exists', () => inZone('Europe/Berlin', () => {
    // Mar 29, 2026: 02:00 to 03:00 does not exist in Berlin.
    const at = resolveCustom('2026-03-29', '02:30');
    assert.equal(iso(at), '2026-03-29T01:30:00.000Z');
    assert.equal(at.getHours(), 3);
    assert.equal(at.getMinutes(), 30);
  }));

  test('reads date and time inputs as local time', () => inZone('America/Los_Angeles', () => {
    assert.equal(iso(resolveCustom('2026-10-28', '08:00')), '2026-10-28T15:00:00.000Z');
    assert.equal(iso(resolveLocalDateTime('2026-10-28T08:00')), '2026-10-28T15:00:00.000Z');
    assert.equal(iso(resolveCustom('2026-10-28', '08:00:00')), '2026-10-28T15:00:00.000Z');
  }));

  test('refuses a missing or impossible date or time', () => {
    assert.equal(resolveCustom('', '08:00'), null);
    assert.equal(resolveCustom('2026-10-28', ''), null);
    assert.equal(resolveCustom('2026-02-30', '08:00'), null, 'does not roll into March');
    assert.equal(resolveCustom('2026-10-28', '24:00'), null);
    assert.equal(resolveCustom('28.10.2026', '08:00'), null);
    assert.equal(resolveLocalDateTime(''), null);
  });

  test('the picker opens on tomorrow morning, and its values round trip', () => inZone('Europe/Berlin', () => {
    const now = new Date('2026-10-24T18:00:00Z');
    const start = defaultCustom(now);
    assert.equal(localDateTimeValue(start), '2026-10-25T08:00');
    assert.equal(iso(resolveLocalDateTime(localDateTimeValue(start))), iso(start));
  }));

  test('the date bounds span today to 366 days ahead', () => inZone('Europe/Berlin', () => {
    const now = new Date('2026-10-24T10:00:00Z');
    assert.deepEqual(dateBounds(now), { min: '2026-10-24', max: '2027-10-25' });
  }));
});

describe('checkSendAt', () => {
  const now = new Date('2026-10-24T10:00:00Z');
  const ahead = ms => new Date(now.getTime() + ms);
  test('names what is wrong with a time', () => {
    assert.equal(checkSendAt(ahead(-1000), now), 'past');
    assert.equal(checkSendAt(ahead(0), now), 'past');
    assert.equal(checkSendAt(ahead(30_000), now), 'tooSoon');
    assert.equal(checkSendAt(ahead(60_000), now), null);
    assert.equal(checkSendAt(ahead(MAX_AHEAD_MS), now), null);
    assert.equal(checkSendAt(ahead(MAX_AHEAD_MS + 1), now), 'tooFar');
    assert.equal(checkSendAt(null, now), 'invalid');
    assert.equal(checkSendAt(new Date('nope'), now), 'invalid');
  });
});

describe('formatSendAt', () => {
  test('spells out the weekday and the date, in local time', () => inZone('Europe/Berlin', () => {
    const now = new Date('2026-10-24T18:00:00Z');
    assert.equal(plain(formatSendAt('2026-10-25T07:00:00.000Z', 'en-US', now)), 'Sun, Oct 25, 8:00 AM');
    assert.equal(plain(formatSendAt(new Date('2026-10-28T12:00:00Z'), 'en-US', now)), 'Wed, Oct 28, 1:00 PM');
  }));

  test('adds the year when it is not this one', () => inZone('Europe/Berlin', () => {
    const now = new Date('2026-10-24T18:00:00Z');
    assert.equal(plain(formatSendAt('2027-01-04T07:00:00.000Z', 'en-US', now)), 'Mon, Jan 4, 2027, 8:00 AM');
  }));

  test('an invalid value is empty', () => {
    assert.equal(formatSendAt('nope', 'en-US'), '');
  });
});

describe('browserTimeZone', () => {
  test('is the IANA zone the browser runs in', () => inZone('America/Los_Angeles', () => {
    assert.equal(browserTimeZone(), 'America/Los_Angeles');
  }));
});

describe('clockSkewMs', () => {
  const now = Date.parse('2026-10-24T10:00:00Z');
  test('says how far this clock is behind (positive) or ahead of the server', () => {
    assert.equal(clockSkewMs('2026-10-24T10:05:00Z', now), 300_000);
    assert.equal(clockSkewMs('2026-10-24T09:57:00Z', now), -180_000);
  });
  test('under a minute, or unknown, is nothing to mention', () => {
    assert.equal(clockSkewMs('2026-10-24T10:00:30Z', now), null);
    assert.equal(clockSkewMs(undefined, now), null);
    assert.equal(clockSkewMs('nope', now), null);
  });
});
