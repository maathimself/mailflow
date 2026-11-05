// Run with: node --test src/components/calendar/calendarEvents.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';

process.env.TZ = 'Europe/Paris';
const e = await import('./calendarEvents.js');

const timed = () => e.emptyForm({ calendarId: 'c1', start: '2026-11-05T08:00:00.000Z', end: '2026-11-05T09:00:00.000Z' });

describe('describeError', () => {
  it('tells a conflict, a refusal and an unreachable server apart', () => {
    assert.deepEqual(e.describeError({ status: 409, code: 'conflict' }), { key: 'calendar.errors.conflict', refetch: true });
    assert.equal(e.describeError({ status: 409 }).key, 'calendar.errors.busy');
    assert.equal(e.describeError({ status: 403, code: 'read_only' }).key, 'calendar.errors.readOnly');
    const bad = e.describeError({ status: 502, message: 'nope' });
    assert.deepEqual([bad.key, bad.message, bad.refetch], ['calendar.errors.server', 'nope', true]);
    assert.equal(e.describeError(new Error('x')).key, 'calendar.errors.generic');
  });
});

describe('buildPayload', () => {
  it('sends a timed event as instants with the zone, and no recurrence as null', () => {
    const { payload } = e.buildPayload({ ...timed(), summary: ' Lunch ' });
    assert.equal(payload.summary, 'Lunch');
    assert.equal(payload.start, '2026-11-05T08:00:00.000Z');
    assert.equal(payload.end, '2026-11-05T09:00:00.000Z');
    assert.equal(payload.timezone, e.browserZone());
    assert.equal(payload.recurrence, null);
    assert.equal(payload.reminderMinutes, null);
  });

  it('sends an all-day event as days with the end exclusive and no zone', () => {
    const form = e.emptyForm({ calendarId: 'c1', allDay: true, start: '2026-03-28', end: '2026-03-30' });
    assert.equal(form.endDay, '2026-03-29');
    const { payload } = e.buildPayload({ ...form, summary: 'Trip' });
    assert.deepEqual([payload.start, payload.end, 'timezone' in payload], ['2026-03-28', '2026-03-30', false]);
  });

  it('refuses an empty title, an end before the start and a missing calendar', () => {
    assert.equal(e.buildPayload({ ...timed(), summary: '  ' }).error, 'calendar.form.titleRequired');
    assert.equal(e.buildPayload({ ...timed(), summary: 'x', endLocal: '2026-11-05T08:00' }).error, 'calendar.form.endBeforeStart');
    assert.equal(e.buildPayload({ ...timed(), summary: 'x', calendarId: '' }).error, 'calendar.form.calendarRequired');
  });

  it('builds recurrence rules and leaves them out for scope this and for custom rules', () => {
    const form = { ...timed(), summary: 'x', freq: 'WEEKLY', interval: 2, ends: 'count', count: 5 };
    assert.deepEqual(e.buildPayload(form).payload.recurrence, { freq: 'WEEKLY', interval: 2, count: 5 });
    assert.deepEqual(e.buildPayload({ ...form, ends: 'until', until: '2027-01-01' }).payload.recurrence, { freq: 'WEEKLY', interval: 2, until: '2027-01-01' });
    assert.equal(e.buildPayload({ ...form, ends: 'until', until: '2020-01-01' }).error, 'calendar.form.untilBeforeStart');
    assert.equal('recurrence' in e.buildPayload(form, { scope: 'this' }).payload, false);
    assert.equal('recurrence' in e.buildPayload(form, { recurrenceCustom: true }).payload, false);
  });

  it('sends the reminder in minutes, null for none', () => {
    assert.equal(e.buildPayload({ ...timed(), summary: 'x', reminder: '0' }).payload.reminderMinutes, 0);
    assert.equal(e.buildPayload({ ...timed(), summary: 'x', reminder: '45' }).payload.reminderMinutes, 45);
  });
});

describe('scopes', () => {
  const occ = { calendarId: 'c1', recurrenceId: 'R1', summary: 's', allDay: false };
  it('names the occurrence on both scopes, and drops the calendar for this', () => {
    assert.deepEqual(e.withScope({ calendarId: 'c1', summary: 's' }, occ, 'all'), { calendarId: 'c1', summary: 's', scope: 'all', recurrenceId: 'R1' });
    assert.deepEqual(e.withScope({ calendarId: 'c1', summary: 's' }, occ, 'this'), { summary: 's', scope: 'this', recurrenceId: 'R1' });
  });

  it('sends no recurrenceId for a plain event', () => {
    assert.equal('recurrenceId' in e.withScope({}, { recurrenceId: null }, 'all'), false);
  });

  it('a drag sends times only, never recurrence or reminder', () => {
    const p = e.movePayload(occ, { start: 'a', end: 'b' }, 'this');
    assert.equal('recurrence' in p, false);
    assert.equal('reminderMinutes' in p, false);
    assert.deepEqual([p.start, p.end, p.scope], ['a', 'b', 'this']);
  });
});

describe('form helpers', () => {
  it('moves the end with the start', () => {
    const f = e.changeStart(timed(), '2026-11-06T09:00');
    assert.equal(f.endLocal, '2026-11-06T10:00');
  });

  it('keeps an unknown reminder as an option', () => {
    assert.equal(e.reminderOptions('45').extra, 45);
    assert.equal(e.reminderOptions('10').extra, null);
  });

  it('offers other accounts only when creating', () => {
    const cals = [{ id: 1, accountId: 'a' }, { id: 2, accountId: 'b' }, { id: 3, accountId: 'a', readOnly: true }];
    assert.deepEqual(e.offeredCalendars(cals, { editing: false }).map(c => c.id), [1, 2]);
    assert.deepEqual(e.offeredCalendars(cals, { editing: true, accountId: 'a' }).map(c => c.id), [1]);
  });

  it('turns only http and https text into links', () => {
    const parts = e.linkify('Join https://meet.example/x, or javascript:alert(1) now');
    assert.deepEqual(parts.filter(p => p.href).map(p => p.href), ['https://meet.example/x']);
    assert.equal(parts.map(p => p.text).join(''), 'Join https://meet.example/x, or javascript:alert(1) now');
  });
});
