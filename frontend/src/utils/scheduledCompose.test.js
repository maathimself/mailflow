// The composer's side of scheduled send (#543): the edit hold and its lease, the create key, and
// what the server's refusals tell the user.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  HOLD_RENEW_MS, SCHEDULED_VIEW, createEditHold, isScheduledEdit, needsConfirmation, newClientKey,
  once, openScheduledView, scheduleErrorText, sendNowUndoMs, undoSchedule, undoSendNow,
} from './scheduledCompose.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const settle = () => new Promise(r => setTimeout(r, 0));
const t = (key, opts) => (opts ? `${key}:${JSON.stringify(opts)}` : key);

// A fake api.scheduled and a timer the test fires by hand.
function harness({ hold, release } = {}) {
  const calls = [];
  const timers = [];
  const api = {
    hold: async (id, token) => {
      calls.push(['hold', id, token]);
      return hold ? hold(token, calls) : { editToken: token || 'tok-1', version: 3, statusBefore: 'scheduled' };
    },
    release: async (id, token, options) => {
      calls.push(options ? ['release', id, token, options] : ['release', id, token]);
      if (release) return release(token, options);
      return { status: 'scheduled' };
    },
    releaseOnUnload: (id, token) => { calls.push(['releaseOnUnload', id, token]); },
  };
  const deps = {
    api,
    schedule: (fn, ms) => { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; },
    unschedule: timer => { if (timer) timer.cleared = true; },
  };
  const fire = async () => {
    const live = timers.filter(x => !x.cleared);
    for (const timer of live) timer.cleared = true;
    for (const timer of live) await timer.fn();
  };
  const pending = () => timers.filter(x => !x.cleared);
  return { api, deps, calls, fire, pending };
}

describe('createEditHold', () => {
  test('takes the hold, renews it with its token every five minutes, and releases it', async () => {
    const h = harness();
    const hold = createEditHold({ id: 'm1', version: 3 }, h.deps);
    const r = await hold.start();
    assert.deepEqual(r, { ok: true, version: 3, statusBefore: 'scheduled' });
    assert.equal(hold.isHeld(), true);
    assert.equal(hold.token(), 'tok-1');
    assert.equal(h.pending()[0].ms, HOLD_RENEW_MS);
    await h.fire();
    assert.deepEqual(h.calls[1], ['hold', 'm1', 'tok-1'], 'a renewal passes the token');
    assert.equal(h.pending().length, 1, 'and arms the next one');
    await hold.release();
    assert.deepEqual(h.calls.at(-1), ['release', 'm1', 'tok-1']);
    assert.equal(h.pending().length, 0);
    assert.equal(hold.isHeld(), false);
  });

  test('renews the hold the opener already took', async () => {
    const h = harness();
    const hold = createEditHold({ id: 'm1', version: 3, editToken: 'given' }, h.deps);
    await hold.start();
    assert.deepEqual(h.calls[0], ['hold', 'm1', 'given']);
  });

  test('gives back at once a message newer than the one it opened, paused when it is due', async () => {
    const h = harness({ hold: () => ({ editToken: 'tok-1', version: 5, statusBefore: 'scheduled' }) });
    const lost = [];
    const hold = createEditHold({ id: 'm1', version: 3 }, { ...h.deps, onLost: err => lost.push(err.code) });
    const r = await hold.start();
    await settle();
    assert.equal(r.ok, false);
    assert.equal(r.stale, true);
    assert.deepEqual(lost, ['version_conflict']);
    assert.deepEqual(h.calls.at(-1), ['release', 'm1', 'tok-1']);
    assert.equal(hold.isHeld(), false);
    assert.equal(h.pending().length, 0, 'no renewals');

    const due = harness({ hold: () => ({ editToken: 'tok-2', version: 5, statusBefore: 'scheduled' }) });
    await createEditHold({ id: 'm1', version: 3 }, { ...due.deps, isDue: () => true }).start();
    await settle();
    assert.deepEqual(due.calls.at(-1), ['release', 'm1', 'tok-2', { keepPaused: true }]);
  });

  test('a refused hold is not held, and nothing is released', async () => {
    const h = harness({ hold: () => { throw Object.assign(new Error('This message is being sent now.'), { status: 409 }); } });
    const hold = createEditHold({ id: 'm1', version: 3 }, h.deps);
    const r = await hold.start();
    assert.equal(r.ok, false);
    assert.equal(r.error.message, 'This message is being sent now.');
    await hold.release();
    assert.equal(h.calls.filter(c => c[0] === 'release').length, 0);
  });

  test('a renewal the server refuses tells the composer it lost the message', async () => {
    let n = 0;
    const h = harness({ hold: () => { if (n++ === 0) return { editToken: 'tok-1', version: 3 }; throw Object.assign(new Error('gone'), { status: 409 }); } });
    const lost = [];
    const hold = createEditHold({ id: 'm1', version: 3 }, { ...h.deps, onLost: err => lost.push(err.code) });
    await hold.start();
    await h.fire();
    assert.deepEqual(lost, ['hold_lost']);
    assert.equal(hold.isHeld(), false);
    assert.equal(h.pending().length, 0, 'no more renewals');
    await hold.release();
    assert.equal(h.calls.filter(c => c[0] === 'release').length, 0, 'a lost hold is not released');
  });

  test('a renewal that finds a newer version is a conflict, and gives the hold back', async () => {
    let n = 0;
    const h = harness({ hold: () => ({ editToken: 'tok-2', version: n++ === 0 ? 3 : 4 }) });
    const lost = [];
    const hold = createEditHold({ id: 'm1', version: 3 }, { ...h.deps, onLost: err => lost.push(err.code) });
    await hold.start();
    await h.fire();
    await settle();
    assert.deepEqual(lost, ['version_conflict']);
    assert.deepEqual(h.calls.at(-1), ['release', 'm1', 'tok-2']);
  });

  test('a renewal still out when the hold ends changes nothing', async () => {
    let answerRenewal;
    let n = 0;
    const h = harness({ hold: () => (n++ === 0 ? { editToken: 'tok-1', version: 3 } : new Promise(r => { answerRenewal = r; })) });
    const lost = [];
    const hold = createEditHold({ id: 'm1', version: 3 }, { ...h.deps, onLost: err => lost.push(err) });
    await hold.start();
    const renewing = h.fire();
    await settle();
    hold.settle();
    answerRenewal({ editToken: 'tok-1', version: 4 });
    await renewing;
    await settle();
    assert.equal(lost.length, 0);
    assert.equal(h.pending().length, 0, 'not armed again');
    assert.equal(h.calls.filter(c => c[0] === 'release').length, 0);
  });

  test('handBack ends the hold only once the server took it back', async () => {
    let fail = true;
    const h = harness({ release: () => { if (fail) throw new TypeError('Failed to fetch'); return { status: 'paused' }; } });
    const hold = createEditHold({ id: 'm1', version: 3 }, h.deps);
    await hold.start();
    await assert.rejects(hold.handBack({ keepPaused: true }), /Failed to fetch/);
    assert.equal(hold.isHeld(), true, 'still held after a failed request, so it can be tried again');
    assert.equal(h.pending().length, 1, 'and still renewed');
    fail = false;
    await hold.handBack({ keepPaused: true });
    assert.deepEqual(h.calls.at(-1), ['release', 'm1', 'tok-1', { keepPaused: true }]);
    assert.equal(hold.isHeld(), false);
    assert.equal(h.pending().length, 0);
    await hold.release();
    assert.equal(h.calls.filter(c => c[0] === 'release').length, 2, 'not released again on close');
  });

  test('closed while a handBack is out, a failed one neither re-arms nor revives the hold', async () => {
    let failRelease;
    const h = harness({ release: () => new Promise((_, reject) => { failRelease = reject; }) });
    const hold = createEditHold({ id: 'm1', version: 3 }, { ...h.deps, isDue: () => true });
    await hold.start();
    const out = hold.handBack({ keepPaused: true });
    await settle();
    await hold.release(); // the composer unmounts
    assert.equal(h.calls.filter(c => c[0] === 'release').length, 1, 'no second release while one is out');
    failRelease(new TypeError('Failed to fetch'));
    await assert.rejects(out, /Failed to fetch/);
    assert.equal(hold.isHeld(), false, 'not held again');
    assert.equal(h.pending().length, 0, 'no renewal armed on a dead composer');
    assert.deepEqual(h.calls.at(-1), ['releaseOnUnload', 'm1', 'tok-1'], 'one last release that outlives the page');
  });

  test('a page going away while Keep paused is out sends its keepalive release paused, once', async () => {
    let failRelease;
    const h = harness({ release: () => new Promise((_, reject) => { failRelease = reject; }) });
    h.api.releaseOnUnload = (id, token, options) => { h.calls.push(['releaseOnUnload', id, token, options]); };
    const hold = createEditHold({ id: 'm1', version: 3 }, h.deps);
    await hold.start();
    const out = hold.handBack({ keepPaused: true });
    await settle();
    await hold.release({ unloading: true });
    assert.deepEqual(h.calls.at(-1), ['releaseOnUnload', 'm1', 'tok-1', { keepPaused: true }]);
    failRelease(new TypeError('Failed to fetch'));
    await assert.rejects(out);
    assert.equal(h.calls.filter(c => c[0] === 'releaseOnUnload').length, 1, 'not sent twice');
    assert.equal(h.pending().length, 0);
  });

  test('the last release of a closed composer keeps a due message paused', async () => {
    let failRelease;
    const h = harness({ hold: () => ({ editToken: 'tok-1', version: 3, statusBefore: 'scheduled' }),
      release: () => new Promise((_, reject) => { failRelease = reject; }) });
    h.api.releaseOnUnload = (id, token, options) => { h.calls.push(['releaseOnUnload', id, token, options]); };
    const hold = createEditHold({ id: 'm1', version: 3 }, { ...h.deps, isDue: () => true });
    await hold.start();
    const out = hold.handBack();
    await settle();
    await hold.release();
    failRelease(new TypeError('Failed to fetch'));
    await assert.rejects(out);
    assert.deepEqual(h.calls.at(-1), ['releaseOnUnload', 'm1', 'tok-1', { keepPaused: true }]);
  });

  test('handBack the server refuses means the hold is gone', async () => {
    const h = harness({ release: () => { throw Object.assign(new Error('gone'), { status: 409, code: 'hold_lost' }); } });
    const hold = createEditHold({ id: 'm1', version: 3 }, h.deps);
    await hold.start();
    await assert.rejects(hold.handBack());
    assert.equal(hold.isHeld(), false);
    assert.equal(h.pending().length, 0);
  });

  test('a renewal that fails on the network tries again at the next one', async () => {
    let n = 0;
    const h = harness({ hold: () => { if (n++ === 1) throw new TypeError('Failed to fetch'); return { editToken: 'tok-1', version: 3 }; } });
    const lost = [];
    const hold = createEditHold({ id: 'm1', version: 3 }, { ...h.deps, onLost: err => lost.push(err) });
    await hold.start();
    await h.fire();
    assert.equal(lost.length, 0);
    assert.equal(hold.isHeld(), true);
    assert.equal(h.pending().length, 1);
    await h.fire();
    assert.equal(h.calls.filter(c => c[0] === 'hold').length, 3);
  });

  test('closed while the hold was being taken, it hands the message straight back', async () => {
    let resolveHold;
    const h = harness({ hold: () => new Promise(r => { resolveHold = r; }) });
    const hold = createEditHold({ id: 'm1', version: 3 }, h.deps);
    const started = hold.start();
    await settle();
    await hold.release();
    resolveHold({ editToken: 'tok-9', version: 3 });
    const r = await started;
    await settle();
    assert.equal(r.closed, true);
    assert.deepEqual(h.calls.at(-1), ['release', 'm1', 'tok-9']);
    assert.equal(h.pending().length, 0);
  });

  test('after a save or an unschedule it neither renews nor releases', async () => {
    const h = harness();
    const hold = createEditHold({ id: 'm1', version: 3 }, h.deps);
    await hold.start();
    hold.settle();
    assert.equal(h.pending().length, 0);
    await hold.release();
    assert.equal(h.calls.filter(c => c[0] === 'release').length, 0);
  });

  test('after held_elsewhere, start({ takeover }) takes the hold from the other window', async () => {
    let n = 0;
    const h = harness({ hold: () => {
      if (n++ === 0) throw Object.assign(new Error('open elsewhere'), { status: 409, code: 'held_elsewhere' });
      return { editToken: 'tok-9', version: 3, statusBefore: 'scheduled' };
    } });
    const hold = createEditHold({ id: 'm1', version: 3 }, h.deps);
    const first = await hold.start();
    assert.equal(first.ok, false);
    assert.equal(first.error.code, 'held_elsewhere');
    const second = await hold.start({ takeover: true });
    assert.equal(second.ok, true);
    assert.deepEqual(h.calls[1], ['hold', 'm1', null]);
    assert.equal(hold.token(), 'tok-9');
    assert.equal(hold.isHeld(), true);
    assert.equal(h.pending().length, 1, 'renewed from then on');
  });

  test('a page going away releases with keepalive', async () => {
    const h = harness();
    const hold = createEditHold({ id: 'm1', version: 3 }, h.deps);
    await hold.start();
    await hold.release({ unloading: true });
    assert.deepEqual(h.calls.at(-1), ['releaseOnUnload', 'm1', 'tok-1']);
  });

  test('check() renews at once, and a message deleted or taken elsewhere is lost then', async () => {
    let answer = null;
    const h = harness({ hold: (token) => {
      if (answer) throw answer;
      return { editToken: token || 'tok-1', version: 3, statusBefore: 'scheduled' };
    } });
    const lost = [];
    const hold = createEditHold({ id: 'm1', version: 3 }, { ...h.deps, onLost: err => lost.push(err) });
    await hold.start();
    await hold.check();
    assert.deepEqual(h.calls.map(c => c[0]), ['hold', 'hold'], 'renewed without waiting for the timer');
    assert.equal(h.pending().length, 1, 'one renewal armed, not two');
    answer = Object.assign(new Error('Scheduled message not found'), { status: 404 });
    await hold.check();
    assert.equal(hold.isHeld(), false);
    assert.equal(lost[0].code, 'hold_lost');
    assert.equal(lost[0].status, 404);
    assert.equal(h.pending().length, 0);
    await hold.check();
    assert.equal(h.calls.length, 3, 'nothing more once lost');
  });

  test('a check() while a renewal is out renews once more after it', async () => {
    let resolveFirst;
    let n = 0;
    const h = harness({ hold: (token) => {
      n += 1;
      if (n === 2) return new Promise(r => { resolveFirst = () => r({ editToken: token, version: 3 }); });
      return { editToken: token || 'tok-1', version: 3, statusBefore: 'scheduled' };
    } });
    const hold = createEditHold({ id: 'm1', version: 3 }, h.deps);
    await hold.start();
    const first = hold.check();
    await settle();
    hold.check();
    resolveFirst();
    await first;
    await settle();
    assert.equal(h.calls.filter(c => c[0] === 'hold').length, 3, 'the start, the renewal out, and one after it');
    assert.equal(h.pending().length, 1);
  });

  test('markLost stops the renewals for a hold a save found lost', async () => {
    const h = harness();
    const hold = createEditHold({ id: 'm1', version: 3 }, h.deps);
    await hold.start();
    hold.markLost();
    assert.equal(hold.isHeld(), false);
    assert.equal(h.pending().length, 0);
  });
});

describe('newClientKey', () => {
  test('is a v4 UUID, also without crypto.randomUUID (plain HTTP)', () => {
    assert.match(newClientKey(), UUID_V4);
    const insecure = { getRandomValues: a => globalThis.crypto.getRandomValues(a) };
    const key = newClientKey(insecure);
    assert.match(key, UUID_V4);
    assert.notEqual(newClientKey(insecure), key);
  });
});

describe('scheduleErrorText', () => {
  const now = Date.parse('2026-10-24T10:00:00Z');
  test('leads with the server message and explains a clock that is off', () => {
    const err = Object.assign(new Error('The scheduled time must be at least a minute from now.'), { code: 'too_soon', serverNow: '2026-10-24T10:07:00.000Z' });
    const text = scheduleErrorText(err, t, { now, locale: 'en-US' });
    assert.match(text, /^compose\.scheduleSend\.errors\.tooSoon compose\.scheduleSend\.errors\.clockBehind:/);
    assert.match(text, /"minutes":7/);
    const ahead = Object.assign(new Error('A message can be scheduled at most 366 days ahead.'), { code: 'too_far', serverNow: '2026-10-24T09:50:00.000Z' });
    assert.match(scheduleErrorText(ahead, t, { now, locale: 'en-US' }), /clockAhead:.*"minutes":10/);
  });

  test('a clock that is right adds nothing', () => {
    const err = Object.assign(new Error('Too soon.'), { code: 'too_soon', serverNow: '2026-10-24T10:00:20.000Z' });
    assert.equal(scheduleErrorText(err, t, { now }), 'compose.scheduleSend.errors.tooSoon');
  });

  test('a lost hold and a newer version are told in the composer text', () => {
    assert.equal(scheduleErrorText({ code: 'hold_lost', message: 'x' }, t), 'compose.scheduleSend.errors.holdLost');
    assert.equal(scheduleErrorText({ code: 'hold_lost', status: 409, state: 'editing' }, t), 'compose.scheduleSend.errors.holdLost');
    assert.equal(scheduleErrorText({ code: 'hold_lost', status: 404 }, t), 'compose.scheduleSend.errors.deletedElsewhere');
    assert.equal(scheduleErrorText({ code: 'hold_lost', status: 409, state: 'cancelled' }, t), 'compose.scheduleSend.errors.deletedElsewhere');
    assert.equal(scheduleErrorText({ code: 'hold_lost', status: 409, state: 'sent' }, t), 'compose.scheduleSend.errors.sentElsewhere');
    assert.equal(scheduleErrorText({ code: 'hold_lost', status: 409, state: 'sending' }, t), 'compose.scheduleSend.errors.sentElsewhere');
    assert.equal(scheduleErrorText({ code: 'held_elsewhere', message: 'x' }, t), 'compose.scheduleSend.errors.heldElsewhere');
    assert.equal(scheduleErrorText({ code: 'version_conflict', message: 'x' }, t), 'compose.scheduleSend.errors.versionConflict');
  });

  test('limits and rate limits are told in the user\'s language', () => {
    for (const [code, key] of [
      ['too_many', 'compose.scheduleSend.errors.tooMany'], ['too_much_storage', 'compose.scheduleSend.errors.tooMuchStorage'],
      ['payload_too_large', 'compose.scheduleSend.errors.payloadTooLarge'], ['rate_limited', 'compose.scheduleSend.errors.rateLimited'],
      ['decrypt_failed', 'scheduled.reason.decryptFailed'], ['sending_now', 'scheduled.errors.aboutToSend'],
    ]) {
      assert.equal(scheduleErrorText(Object.assign(new Error(`server says ${code}`), { code }), t), key);
    }
    assert.equal(scheduleErrorText(new Error('Total attachment size exceeds 25 MB'), t), 'Total attachment size exceeds 25 MB', 'anything else in the server words');
    assert.equal(scheduleErrorText({}, t), 'compose.scheduleSend.errors.failed');
  });
});

describe('the rest', () => {
  test('needsConfirmation is the two questions the server asks', () => {
    assert.equal(needsConfirmation({ code: 'confirm_uncertain' }), true);
    assert.equal(needsConfirmation({ code: 'confirm_restored' }), true);
    assert.equal(needsConfirmation({ code: 'hold_lost' }), false);
    assert.equal(needsConfirmation(null), false);
  });

  test('isScheduledEdit is a composer opened on a scheduled message', () => {
    assert.equal(isScheduledEdit({ scheduled: { id: 'm1' } }), true);
    assert.equal(isScheduledEdit({}), false);
    assert.equal(isScheduledEdit(null), false);
  });

  test('openScheduledView selects the Scheduled view with no account', () => {
    const seen = [];
    openScheduledView({ getState: () => ({ setSelectedAccount: (...args) => seen.push(args) }) });
    assert.deepEqual(seen, [[null, SCHEDULED_VIEW]]);
    assert.equal(SCHEDULED_VIEW, '__scheduled__');
  });

  test('openScheduledView with an id highlights that message there', () => {
    const seen = [];
    openScheduledView({ getState: () => ({
      setScheduledHighlight: id => seen.push(['highlight', id]), setSelectedAccount: (...args) => seen.push(args),
    }) }, 'id-1');
    assert.deepEqual(seen, [['highlight', 'id-1'], [null, SCHEDULED_VIEW]]);
  });
});

describe('undoing a schedule', () => {
  test('cancels it, then reopens the composer with it', async () => {
    const order = [];
    const ok = await undoSchedule({ id: 's1', restoreData: { subject: 'Hi' } }, {
      cancel: async id => { order.push(['cancel', id]); },
      reopen: data => { order.push(['reopen', data.subject]); },
      notify: n => order.push(['notify', n]),
      t,
    });
    assert.equal(ok, true);
    assert.deepEqual(order, [['cancel', 's1'], ['reopen', 'Hi']]);
  });

  test('a refused cancel says the server message and reopens nothing', async () => {
    const seen = [];
    const ok = await undoSchedule({ id: 's1', restoreData: {} }, {
      cancel: async () => { throw Object.assign(new Error('This message has already been sent.'), { status: 409 }); },
      reopen: () => seen.push('reopen'),
      notify: n => seen.push(n),
      t,
    });
    assert.equal(ok, false);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].type, 'error');
    assert.equal(seen[0].body, 'This message has already been sent.');
  });
});

describe('undoing a schedule when the answer is lost', () => {
  test('tries the cancel once more, and reopens when it went through', async () => {
    const seen = [];
    let n = 0;
    const ok = await undoSchedule({ id: 's1', restoreData: { subject: 'Hi' } }, {
      cancel: async () => { if (n++ === 0) throw new TypeError('Failed to fetch'); return { status: 'cancelled' }; },
      reopen: data => seen.push(['reopen', data.subject]),
      notify: n2 => seen.push(n2), t,
    });
    assert.equal(ok, true);
    assert.equal(n, 2);
    assert.deepEqual(seen, [['reopen', 'Hi']]);
  });

  test('one that still fails points to the Scheduled view', async () => {
    const seen = [];
    let opened = 0;
    let tries = 0;
    const ok = await undoSchedule({ id: 's1', restoreData: {} }, {
      cancel: async () => { tries++; throw new TypeError('Failed to fetch'); },
      reopen: () => seen.push('reopen'), notify: n => seen.push(n), openView: () => { opened++; }, t,
    });
    assert.equal(ok, false);
    assert.equal(tries, 2);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].title, 'compose.scheduleSend.undoFailedOpen');
    assert.equal(seen[0].persistent, true);
    seen[0].onAction();
    assert.equal(opened, 1);
  });
});

describe('once', () => {
  test('runs its function a single time, however often it is called', async () => {
    let runs = 0;
    const undo = once(async () => { runs++; return 'done'; });
    const [a, b] = await Promise.all([undo(), undo()]);
    assert.equal(runs, 1);
    assert.equal(a, 'done');
    assert.equal(b, 'done');
  });
});

describe('undoing Send now', () => {
  test('the window counts from when the request went out', () => {
    assert.equal(sendNowUndoMs(1000, 1000), 10_000);
    assert.equal(sendNowUndoMs(1000, 2500), 8500);
    assert.equal(sendNowUndoMs(1000, 20_000), 0);
  });

  test('puts back what it replaced and says when it goes, or that it is back as it was', async () => {
    const seen = [];
    const calls = [];
    await undoSendNow({ id: 'm1', undoToken: 'tok', subject: 'Hi' }, {
      undo: async (id, token) => { calls.push([id, token]); return { status: 'scheduled', sendAt: '2026-10-28T07:00:00.000Z' }; },
      notify: n => seen.push(n), t, locale: 'en-US',
    });
    assert.deepEqual(calls, [['m1', 'tok']]);
    assert.match(seen[0].title, /^compose\.scheduleSend\.scheduledFor:/);
    await undoSendNow({ id: 'm1', undoToken: 'tok', subject: 'Hi' }, {
      undo: async () => ({ status: 'paused', sendAt: null }), notify: n => seen.push(n), t,
    });
    assert.equal(seen[1].title, 'compose.scheduleSend.sendNow.undone');
  });

  test('a message whose time passed comes back paused, and says so', async () => {
    const seen = [];
    await undoSendNow({ id: 'm1', undoToken: 'tok', subject: 'Hi' }, {
      undo: async () => ({ status: 'paused', pauseReason: 'user', sendAt: '2026-10-24T07:00:00.000Z' }), notify: n => seen.push(n), t,
    });
    assert.equal(seen[0].title, 'compose.scheduleSend.edit.keptPaused');
  });

  test('an undo refused because the message is open in another window says that', async () => {
    const seen = [];
    await undoSendNow({ id: 'm1', undoToken: 'tok', subject: 'Hi' }, {
      undo: async () => { throw Object.assign(new Error('This message is open in another window.'), { status: 409, code: 'held_elsewhere' }); },
      notify: n => seen.push(n), t,
    });
    assert.equal(seen[0].body, 'compose.scheduleSend.errors.heldElsewhere');
  });

  test('a refused undo says the server message', async () => {
    const seen = [];
    const ok = await undoSendNow({ id: 'm1', undoToken: 'tok', subject: 'Hi' }, {
      undo: async () => { throw new Error('Too late to undo: the message is going out.'); },
      notify: n => seen.push(n), t,
    });
    assert.equal(ok, false);
    assert.equal(seen[0].type, 'error');
    assert.equal(seen[0].body, 'Too late to undo: the message is going out.');
  });

  test('too late to undo is said in the user\'s language', async () => {
    const seen = [];
    await undoSendNow({ id: 'm1', undoToken: 'tok', subject: 'Hi' }, {
      undo: async () => { throw Object.assign(new Error('Too late to undo: the message is going out.'), { status: 409, code: 'undo_expired' }); },
      notify: n => seen.push(n), t,
    });
    assert.equal(seen[0].body, 'scheduled.errors.undoExpired');
  });
});
