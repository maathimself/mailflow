import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createOutboxNotification,
  notificationDurationMs,
  secondsUntil,
} from './outboxNotifications.js';

const NOW = Date.parse('2026-07-28T12:00:00.000Z');

test('countdown math rounds partial seconds up and stops at zero', () => {
  assert.equal(secondsUntil('2026-07-28T12:00:02.001Z', NOW), 3);
  assert.equal(secondsUntil('2026-07-28T12:00:02.000Z', NOW), 2);
  assert.equal(secondsUntil('2026-07-28T11:59:59.000Z', NOW), 0);
});

test('notification duration follows the remaining undo window', () => {
  assert.equal(notificationDurationMs({
    countdownUntil: '2026-07-28T12:02:00.000Z',
  }, NOW), 120_000);
  assert.equal(notificationDurationMs({ onUndo: () => {} }, NOW), 6_000);
  assert.equal(notificationDurationMs({}, NOW), 5_000);
});

test('undo cancels the queued message and reopens the captured compose payload', async () => {
  const calls = [];
  const capturedPayload = {
    accountId: 'account-1',
    to: ['recipient@example.com'],
    subject: 'Queued subject',
    body: '<p>Queued body</p>',
    inReplyTo: '<parent@example.com>',
    references: '<root@example.com> <parent@example.com>',
  };
  const notification = createOutboxNotification({
    entry: {
      outboxId: 'outbox-1',
      sendAt: '2026-07-28T12:00:30.000Z',
      subject: 'Queued subject',
    },
    capturedPayload,
    now: NOW,
    cancelOutbox: async id => { calls.push(['cancel', id]); },
    openCompose: payload => { calls.push(['open', payload]); },
    addNotification: value => { calls.push(['notify', value]); },
    t: key => key,
  });

  assert.equal(notification.persistent, true);
  assert.equal(notification.countdownUntil, '2026-07-28T12:00:30.000Z');
  assert.equal(notification.durationMs, 30_000);
  assert.equal(notification.title, 'compose.sending.title');
  assert.equal(notification.body, 'Queued subject');

  await notification.onUndo();
  assert.deepEqual(calls, [
    ['cancel', 'outbox-1'],
    ['open', capturedPayload],
  ]);
});

test('a 409 undo response shows the too-late toast without reopening compose', async () => {
  const notifications = [];
  let reopened = false;
  const tooLate = Object.assign(new Error('already_sent'), { status: 409 });
  const notification = createOutboxNotification({
    entry: {
      id: 'outbox-2',
      send_at: '2026-07-28T12:00:10.000Z',
      subject: 'Already sent',
    },
    now: NOW,
    cancelOutbox: async () => { throw tooLate; },
    openCompose: () => { reopened = true; },
    addNotification: value => notifications.push(value),
    t: key => key,
  });

  await notification.onUndo();

  assert.equal(reopened, false);
  assert.deepEqual(notifications, [{
    type: 'error',
    title: 'compose.sending.tooLate',
    body: 'Already sent',
  }]);
});

test('restored outbox entries cancel without trying to reopen unavailable compose data', async () => {
  const calls = [];
  const notification = createOutboxNotification({
    entry: {
      id: 'outbox-restored',
      send_at: '2026-07-28T12:00:10.000Z',
      subject: '',
    },
    now: NOW,
    cancelOutbox: async id => { calls.push(['cancel', id]); },
    openCompose: payload => { calls.push(['open', payload]); },
    addNotification: value => { calls.push(['notify', value]); },
    t: key => key,
  });

  assert.equal(notification.body, 'common.noSubject');
  await notification.onUndo();
  assert.deepEqual(calls, [['cancel', 'outbox-restored']]);
});

test('undo reports a compose reopen failure without leaking a rejected event promise', async () => {
  const failure = new Error('PRIVATE_REOPEN_DETAIL_SENTINEL');
  const notifications = [];
  const notification = createOutboxNotification({
    entry: { id: 'outbox-reopen-failure', subject: 'Synthetic subject' },
    capturedPayload: { subject: 'Synthetic subject' },
    cancelOutbox: async () => {},
    openCompose: async () => { throw failure; },
    addNotification: value => notifications.push(value),
    t: (key, values) => values?.message ? `${key}:${values.message}` : key,
  });

  await notification.onUndo();
  assert.deepEqual(notifications, [{
    type: 'error', title: 'compose.requestFailed',
  }]);
});
