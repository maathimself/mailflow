// The order read-state requests go out in, per message (utils/readOrder.js).
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { orderedRead, reserveReadIntent, releaseReadIntent, readIntentSince, readIntentIdsSince, _resetReadOrder, _readIntentSize } from './readOrder.js';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

beforeEach(() => _resetReadOrder());

describe('orderedRead', () => {
  // The server writes the row as a request arrives, so an unread held behind a slow read would
  // leave the message read there, and in every list refresh, until the read answered.
  test('a request goes out at once, even with an earlier one for the message unanswered', async () => {
    const sent = [];
    const first = deferred();
    orderedRead(['m1'], ids => { sent.push(['read', ids]); return first.promise; });
    const b = orderedRead(['m1'], ids => { sent.push(['unread', ids]); return 'ok'; });
    assert.deepEqual(sent, [['read', ['m1']], ['unread', ['m1']]]);
    assert.equal(await b, 'ok');
    first.resolve();
  });

  test('a failure reaches the caller', async () => {
    await assert.rejects(orderedRead(['m1'], () => Promise.reject(new Error('boom'))), /boom/);
    await assert.rejects(orderedRead(['m1'], () => { throw new Error('sync'); }), /sync/);
  });

  test('with since, messages acted on after the reservation are left out', async () => {
    const since = reserveReadIntent();
    await orderedRead(['m1'], () => 'unread');
    assert.equal(readIntentSince('m1', since), true);
    assert.equal(readIntentSince('m2', since), false);
    let sent = null;
    await orderedRead(['m1', 'm2'], ids => { sent = ids; return 'ok'; }, { since });
    assert.deepEqual(sent, ['m2']);
  });

  test('with since and every message acted on since, nothing is sent', async () => {
    const since = reserveReadIntent();
    await orderedRead(['m1'], () => 'unread');
    let called = false;
    assert.equal(await orderedRead(['m1'], () => { called = true; }, { since }), null);
    assert.equal(called, false);
  });

  test('readIntentIdsSince lists the messages acted on after the reservation', async () => {
    await orderedRead(['m1'], () => 'read');
    const since = reserveReadIntent();
    await orderedRead(['m2', 'm3'], () => 'unread');
    assert.deepEqual([...readIntentIdsSince(since)].sort(), ['m2', 'm3']);
  });

  test('with no reservation outstanding, nothing is kept', async () => {
    await orderedRead(['m1', 'm2'], () => 'ok');
    assert.equal(_readIntentSize(), 0);
  });

  test('releasing reservations drops what none of them can ask about', async () => {
    const older = reserveReadIntent();
    await orderedRead(['m1'], () => 'ok');
    const newer = reserveReadIntent();
    await orderedRead(['m2'], () => 'ok');
    assert.equal(_readIntentSize(), 2);
    releaseReadIntent(older);
    assert.equal(_readIntentSize(), 1, 'm1 is at or below the oldest reservation left');
    assert.equal(readIntentSince('m2', newer), true, 'what the newer one can see stays');
    releaseReadIntent(newer);
    assert.equal(_readIntentSize(), 0, 'none outstanding, nothing kept');
  });

  test('an action before the reservation does not take the message out', async () => {
    await orderedRead(['m1'], () => 'unread');
    const since = reserveReadIntent();
    let sent = null;
    await orderedRead(['m1'], ids => { sent = ids; }, { since });
    assert.deepEqual(sent, ['m1']);
  });
});
