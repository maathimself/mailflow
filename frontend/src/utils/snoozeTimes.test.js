// The custom snooze picker's dates in the browser's own zone, across the UTC midnight: west of
// UTC the UTC date is already tomorrow in the evening, east of it still yesterday in the morning.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { SNOOZE_DEFAULT_TIME, snoozeCustomUntil, snoozeDefaultDate, snoozeMinDate } from './snoozeTimes.js';

const originalTz = process.env.TZ;
afterEach(() => { process.env.TZ = originalTz; });

function inZone(zone, run) {
  process.env.TZ = zone;
  return run();
}

describe('custom snooze picker', () => {
  test('in the evening in Los Angeles, the earliest date is today there, not the UTC date', () => inZone('America/Los_Angeles', () => {
    // Saturday, Oct 24, 2026, 21:30 PDT is Sunday, Oct 25 in UTC.
    const now = new Date('2026-10-25T04:30:00Z');
    assert.equal(now.toISOString().slice(0, 10), '2026-10-25', 'precondition: the UTC date is tomorrow');
    assert.equal(snoozeMinDate(now), '2026-10-24');
    assert.equal(snoozeDefaultDate(now), '2026-10-25');
  }));

  test('in the morning in Tokyo, the earliest date is today there, not yesterday', () => inZone('Asia/Tokyo', () => {
    // Sunday, Oct 25, 2026, 07:15 JST is still Saturday, Oct 24 in UTC.
    const now = new Date('2026-10-24T22:15:00Z');
    assert.equal(now.toISOString().slice(0, 10), '2026-10-24', 'precondition: the UTC date is yesterday');
    assert.equal(snoozeMinDate(now), '2026-10-25');
    assert.equal(snoozeDefaultDate(now), '2026-10-26');
  }));

  test('the default date rolls over the end of a month and a year', () => inZone('America/Los_Angeles', () => {
    assert.equal(snoozeDefaultDate(new Date('2027-01-01T07:00:00Z')), '2027-01-01');
    assert.equal(snoozeDefaultDate(new Date('2026-11-01T06:30:00Z')), '2026-11-01');
  }));

  test('the picked date and time are local time in Los Angeles', () => inZone('America/Los_Angeles', () => {
    assert.equal(snoozeCustomUntil('2026-10-24', '22:00').toISOString(), '2026-10-25T05:00:00.000Z');
    assert.equal(snoozeCustomUntil('2026-10-25', SNOOZE_DEFAULT_TIME).toISOString(), '2026-10-25T16:00:00.000Z');
  }));

  test('the picked date and time are local time in Tokyo', () => inZone('Asia/Tokyo', () => {
    assert.equal(snoozeCustomUntil('2026-10-25', '08:00').toISOString(), '2026-10-24T23:00:00.000Z');
  }));

  test('a missing or impossible date resolves to nothing', () => {
    assert.equal(snoozeCustomUntil('', '09:00'), null);
    assert.equal(snoozeCustomUntil('2026-02-30', '09:00'), null);
    assert.equal(snoozeCustomUntil('2026-10-25', ''), null);
  });
});
