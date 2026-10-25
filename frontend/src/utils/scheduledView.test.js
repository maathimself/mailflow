// The Scheduled view's model (#543, design 5.2, 5.3 and 7.3): its sections, the actions each state
// allows (as routes/scheduled.js allows them), the reasons in words, the sent notices, the
// composer's data for an edit, the refusals, and what a change seen over the WebSocket is told.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import {
  actionErrorText, actionLabelKey, addressName, changeNotices, chipKey, composeDataFromScheduled, formatScheduledTime,
  groupScheduled, hoverActions, noticeToast, primaryAction, reasonKey, recipientsOf, rowActions, rowLabel,
  nextRestoreEnd, scheduledLinkId, sentNotes, storedZoneTime,
} from './scheduledView.js';

const t = (key, opts) => (opts ? `${key}:${JSON.stringify(opts)}` : key);
const plain = s => s.replace(/\s/g, ' ');
const originalTz = process.env.TZ;
afterEach(() => { process.env.TZ = originalTz; });

const row = (over = {}) => ({
  id: over.id || 'a', accountId: 'acct', status: 'scheduled', sendAt: '2026-10-26T07:00:00.000Z', timeZone: 'Europe/Berlin',
  version: 1, attempts: 0, sentAt: null, sentLate: false, pauseReason: null, failureCode: null, failureDetail: null,
  summary: { subject: 'Q4 numbers', to: ['Alice <alice@example.invalid>', 'bob@example.invalid'], ccCount: 0, bccCount: 0, snippet: 'Here', attachmentCount: 0 },
  result: null, ...over,
});

describe('groupScheduled', () => {
  test('needs attention first, then scheduled by time, then sent newest first; cancelled is left out', () => {
    const list = [
      row({ id: 's2', sendAt: '2026-10-28T07:00:00Z' }),
      row({ id: 'sent-old', status: 'sent', sentAt: '2026-10-20T07:00:00Z' }),
      row({ id: 'f', status: 'failed', sendAt: '2026-10-27T07:00:00Z' }),
      row({ id: 'e', status: 'editing', sendAt: '2026-10-25T07:00:00Z' }),
      row({ id: 'u', status: 'uncertain', sendAt: '2026-10-21T07:00:00Z' }),
      row({ id: 'sent-new', status: 'sent', sentAt: '2026-10-23T07:00:00Z' }),
      row({ id: 'p', status: 'paused', sendAt: '2026-10-22T07:00:00Z' }),
      row({ id: 'x', status: 'sending', sendAt: '2026-10-24T07:00:00Z' }),
      row({ id: 'c', status: 'cancelled' }),
      row({ id: 'd1', status: 'cancelled', restoreUntil: '2026-10-27T09:05:00Z' }),
      row({ id: 'd2', status: 'cancelled', restoreUntil: '2026-10-27T09:08:00Z' }),
      row({ id: 'gone', status: 'cancelled', restoreUntil: '2026-10-27T08:59:00Z' }),
    ];
    const now = new Date('2026-10-27T09:00:00Z');
    const g = groupScheduled(list, now);
    assert.deepEqual(g.deleted.map(r => r.id), ['d2', 'd1'], 'in their window, the last deleted first');
    assert.equal(nextRestoreEnd(list, now), Date.parse('2026-10-27T09:05:00Z'));
    assert.equal(nextRestoreEnd([row()], now), null);
    assert.deepEqual(g.attention.map(r => r.id), ['u', 'p', 'f']);
    assert.deepEqual(g.upcoming.map(r => r.id), ['x', 'e', 's2']);
    assert.deepEqual(g.sent.map(r => r.id), ['sent-new', 'sent-old']);
  });
});

describe('rowActions', () => {
  test('each state offers what the API allows from it', () => {
    assert.deepEqual(rowActions(row()), ['edit', 'reschedule', 'sendNow', 'cancel', 'delete']);
    assert.deepEqual(rowActions(row({ status: 'editing' })), ['edit', 'cancel', 'delete']);
    assert.deepEqual(rowActions(row({ status: 'sending' })), []);
    assert.deepEqual(rowActions(row({ status: 'paused' })), ['edit', 'resume', 'reschedule', 'sendNow', 'cancel', 'delete']);
    assert.deepEqual(rowActions(row({ status: 'failed' })), ['edit', 'resume', 'reschedule', 'sendNow', 'cancel', 'delete']);
    assert.deepEqual(rowActions(row({ status: 'uncertain' })), ['sendAnyway', 'markSent', 'edit', 'reschedule', 'cancel', 'delete']);
    assert.deepEqual(rowActions(row({ status: 'sent', result: { sentFolder: 'Sent', messageId: '<m@x>' } })), ['viewSent', 'remove']);
    assert.deepEqual(rowActions(row({ status: 'sent', result: { sentFolder: null, messageId: null } })), ['remove']);
    assert.deepEqual(rowActions(row({ status: 'cancelled' })), ['restore', 'delete']);
    assert.deepEqual(hoverActions(row({ status: 'cancelled' })), ['restore']);
    assert.equal(primaryAction(row({ status: 'cancelled' })), null);
    assert.equal(chipKey(row({ status: 'cancelled' })), 'scheduled.chip.deleted');
    assert.equal(reasonKey(row({ status: 'cancelled' })), 'scheduled.reason.deleted');
  });

  test('hover shows the way forward and Delete; a click edits, or opens the Sent copy', () => {
    assert.deepEqual(hoverActions(row()), ['edit', 'reschedule', 'sendNow', 'cancel']);
    assert.deepEqual(hoverActions(row({ status: 'paused' })), ['edit', 'reschedule', 'resume', 'cancel']);
    assert.deepEqual(hoverActions(row({ status: 'uncertain' })), ['edit', 'reschedule', 'sendAnyway', 'cancel']);
    assert.equal(primaryAction(row()), 'edit');
    assert.equal(primaryAction(row({ status: 'sending' })), null);
    assert.equal(primaryAction(row({ status: 'sent', result: { sentFolder: 'Sent', messageId: '<m@x>' } })), 'viewSent');
  });

  test('Resume reads Try again for a failed message', () => {
    assert.equal(actionLabelKey('resume', row({ status: 'failed' })), 'scheduled.actions.retry');
    assert.equal(actionLabelKey('resume', row({ status: 'paused' })), 'scheduled.actions.resume');
    assert.equal(actionLabelKey('cancel', row()), 'scheduled.actions.cancel');
  });
});

describe('reasons and chips', () => {
  test('every pause reason and failure code has its words', () => {
    const pauses = { overdue: 'overdue', restored: 'restored', edit_abandoned: 'editAbandoned', account_disabled: 'accountDisabled', needs_reauth: 'needsReauth', user: 'user' };
    for (const [code, key] of Object.entries(pauses)) assert.equal(reasonKey(row({ status: 'paused', pauseReason: code })), `scheduled.reason.${key}`);
    const failures = {
      smtp_rejected: 'smtpRejected', too_large: 'tooLarge', config: 'config', tls: 'tls', invalid_message: 'invalidMessage',
      alias_missing: 'aliasMissing', decrypt_failed: 'decryptFailed', account_missing: 'accountMissing', gave_up: 'gaveUp',
    };
    for (const [code, key] of Object.entries(failures)) assert.equal(reasonKey(row({ status: 'failed', failureCode: code })), `scheduled.reason.${key}`);
    assert.equal(reasonKey(row({ status: 'failed', failureCode: 'something_new' })), 'scheduled.reason.failed');
    assert.equal(reasonKey(row({ status: 'paused', pauseReason: 'later' })), 'scheduled.reason.paused');
    assert.equal(reasonKey(row({ status: 'uncertain', failureCode: 'connection_lost' })), 'scheduled.reason.uncertain');
    assert.equal(reasonKey(row()), null);
    assert.equal(reasonKey(row({ attempts: 2, failureCode: 'smtp_temporary' })), 'scheduled.reason.retrying');
  });

  test('chips are text for every state', () => {
    assert.equal(chipKey(row()), null);
    assert.equal(chipKey(row({ status: 'sending' })), 'scheduled.chip.sending');
    assert.equal(chipKey(row({ status: 'editing' })), 'scheduled.chip.editing');
    assert.equal(chipKey(row({ status: 'failed' })), 'scheduled.chip.failed');
    assert.equal(chipKey(row({ status: 'paused' })), 'scheduled.chip.paused');
    assert.equal(chipKey(row({ status: 'uncertain' })), 'scheduled.chip.uncertain');
    assert.equal(chipKey(row({ status: 'sent' })), 'scheduled.chip.sent');
    assert.equal(chipKey(row({ status: 'sent', sentLate: true })), 'scheduled.chip.sentLate');
    assert.equal(chipKey(row({ attempts: 1, failureCode: 'transient' })), 'scheduled.chip.retrying');
  });
});

describe('recipients and times', () => {
  test('names first, addresses when there is no name, and how many more in To, Cc and Bcc', () => {
    assert.equal(addressName('"Alice A." <alice@x>'), 'Alice A.');
    assert.equal(addressName('<bob@x>'), 'bob@x');
    assert.equal(addressName({ name: '', address: 'c@x' }), 'c@x');
    assert.deepEqual(recipientsOf({ to: ['Alice <a@x>', 'b@x', 'Carol <c@x>'], ccCount: 1, bccCount: 1 }), { names: ['Alice', 'b@x'], more: 3 });
    assert.deepEqual(recipientsOf(null), { names: [], more: 0 });
  });

  test('today, tomorrow and yesterday by the local calendar, else the date', () => {
    process.env.TZ = 'America/Los_Angeles';
    // 9:00 PM on Oct 24 in Los Angeles is already Oct 25 in UTC.
    const now = new Date('2026-10-25T04:00:00Z');
    assert.equal(plain(formatScheduledTime('2026-10-25T05:30:00Z', { t, locale: 'en-US', now })), 'scheduled.when.today:{"time":"10:30 PM"}');
    assert.equal(plain(formatScheduledTime('2026-10-25T15:00:00Z', { t, locale: 'en-US', now })), 'scheduled.when.tomorrow:{"time":"8:00 AM"}');
    assert.equal(plain(formatScheduledTime('2026-10-24T03:00:00Z', { t, locale: 'en-US', now })), 'scheduled.when.yesterday:{"time":"8:00 PM"}');
    assert.equal(plain(formatScheduledTime('2026-10-28T15:00:00Z', { t, locale: 'en-US', now })), 'Wed, Oct 28, 8:00 AM');
    assert.equal(formatScheduledTime(null, { t, now }), '');
  });

  test('the zone it was scheduled in shows when it is not this one and reads differently', () => {
    const at = '2026-10-26T07:00:00Z';
    assert.equal(storedZoneTime(at, 'Europe/Berlin', { locale: 'en-US', here: 'Europe/Berlin' }), null);
    // Paris and Berlin read the same.
    assert.equal(storedZoneTime(at, 'Europe/Berlin', { locale: 'en-US', here: 'Europe/Paris' }), null);
    const there = storedZoneTime(at, 'Europe/Berlin', { locale: 'en-US', here: 'America/New_York' });
    assert.equal(plain(there.time), 'Mon 8:00 AM');
    assert.equal(there.zone, 'Europe/Berlin');
    assert.equal(storedZoneTime(at, null, { here: 'UTC' }), null);
    assert.equal(storedZoneTime(at, 'Not/AZone', { here: 'UTC' }), null);
  });
});

describe('sentNotes', () => {
  const now = new Date('2026-10-26T12:00:00Z');
  test('late (offline or not), refused and deferred recipients, and a missing Sent copy', () => {
    process.env.TZ = 'UTC';
    const notes = sentNotes(row({
      status: 'sent', sentLate: true, sentAt: '2026-10-26T10:42:00Z',
      result: { sentFolder: null, messageId: '<m@x>', sentCopySaved: false, sentCopyReason: 'no_sent_folder', rejected: ['x@y'], deferred: ['d@y', 'e@y'], lateReason: 'offline' },
    }), { t, locale: 'en-US', now });
    assert.deepEqual(notes.map(n => n.key), ['late', 'rejected', 'deferred', 'copy']);
    assert.match(notes[0].text, /^scheduled\.sent\.lateOffline:/);
    assert.match(notes[1].text, /"list":"x@y"/);
    assert.match(notes[2].text, /"list":"d@y, e@y"/);
    assert.equal(notes[3].text, 'scheduled.sent.noSentFolder');
    const delayed = sentNotes(row({ status: 'sent', sentLate: true, sentAt: '2026-10-26T10:00:00Z', result: { messageId: '<m@x>', sentCopySaved: false, sentCopyReason: 'not_in_sent', lateReason: 'retried', rejected: [], deferred: [] } }), { t, now });
    assert.match(delayed[0].text, /^scheduled\.sent\.late:/);
    assert.equal(delayed[1].text, 'scheduled.sent.noSentCopy');
  });

  test('on time with its copy: nothing to add; marked as sent by the user says so', () => {
    assert.deepEqual(sentNotes(row({ status: 'sent', result: { sentFolder: 'Sent', messageId: '<m@x>', sentCopySaved: true, rejected: [], deferred: [] } }), { t, now }), []);
    const marked = sentNotes(row({ status: 'sent', result: { sentFolder: null, messageId: null, sentCopySaved: null, rejected: [], deferred: [] } }), { t, now });
    assert.deepEqual(marked.map(n => n.text), ['scheduled.sent.markedSent']);
    assert.deepEqual(sentNotes(row(), { t, now }), []);
  });
});

test('rowLabel names the time, recipients, subject and state with its reason', () => {
  const label = rowLabel(row({ status: 'failed', failureCode: 'smtp_rejected' }), {
    t, when: 'Mon 8:00 AM', summary: row().summary, reason: 'The mail server refused it.',
  });
  assert.equal(label, [
    'scheduled.a11y.scheduledFor:{"when":"Mon 8:00 AM"}',
    'scheduled.a11y.to:{"names":"Alice, bob@example.invalid"}',
    'scheduled.a11y.subject:{"subject":"Q4 numbers"}',
    'scheduled.chip.failed: The mail server refused it.',
  ].join(', '));
  const sent = rowLabel(row({ status: 'sent' }), { t, when: 'Today 8:00 AM', summary: null });
  assert.match(sent, /^scheduled\.a11y\.sentAt/);
  assert.match(sent, /common\.noSubject/);
});

describe('composeDataFromScheduled', () => {
  test('the spec as the composer opens it, with what it was and the scheduled message', () => {
    const data = composeDataFromScheduled({
      id: 'id1', accountId: 'acct', version: 4, sendAt: '2026-10-26T07:00:00Z', timeZone: 'Europe/Berlin', status: 'scheduled',
      spec: {
        v: 1, messageId: '<m@x>', aliasId: 'al1', to: ['Bob <b@x>'], cc: ['c@x'], bcc: [], subject: 'Re: Q4', body: '<p>Hi</p>',
        bodyIsHtml: true, quotedBody: '> old', quotedBodyHtml: '<blockquote>old</blockquote>', signature: null,
        inReplyTo: '<orig@x>', references: '<orig@x>', priority: 'high',
        compose: { isReply: true, isReplyAll: false, threadId: 't1', originalFrom: 'Bob <b@x>', allRecipients: ['b@x'] },
      },
      attachments: [{ index: 0, filename: 'q4.pdf', size: 10, contentType: 'application/pdf', kind: 'upload', extra: 1 }],
    });
    assert.deepEqual(data, {
      isReply: true, isReplyAll: false, threadId: 't1', originalFrom: 'Bob <b@x>', allRecipients: ['b@x'],
      accountId: 'acct', aliasId: 'al1', to: ['Bob <b@x>'], cc: ['c@x'], bcc: [], subject: 'Re: Q4', body: '<p>Hi</p>',
      quotedBody: '> old', quotedBodyHtml: '<blockquote>old</blockquote>', signature: '', priority: 'high',
      inReplyTo: '<orig@x>', references: '<orig@x>',
      scheduled: {
        id: 'id1', version: 4, sendAt: '2026-10-26T07:00:00Z', timeZone: 'Europe/Berlin',
        attachments: [{ index: 0, filename: 'q4.pdf', size: 10, contentType: 'application/pdf', kind: 'upload' }],
      },
    });
    assert.equal('restored' in data, false, 'not a message undo send gave back');
    assert.equal('editToken' in data.scheduled, false, 'the composer takes the hold itself');
  });

  test('a plain-text signature is escaped, since the composer reads it as HTML', () => {
    const data = composeDataFromScheduled({
      id: 'i', accountId: 'a', version: 1, sendAt: 'x', attachments: [],
      spec: { to: [], subject: '', body: 'Hi', bodyIsHtml: false, plaintextEmail: true, signature: 'Maria <maria@x.com>\nR&D' },
    });
    assert.equal(data.signature, 'Maria &lt;maria@x.com&gt;\nR&amp;D');
    const html = composeDataFromScheduled({
      id: 'i', accountId: 'a', version: 1, sendAt: 'x', attachments: [], spec: { to: [], signature: '<b>Maria</b>' },
    });
    assert.equal(html.signature, '<b>Maria</b>');
  });

  test('a new message keeps its signature and no reply context', () => {
    const data = composeDataFromScheduled({ id: 'i', accountId: 'a', version: 1, sendAt: 'x', spec: { to: [], subject: '', body: '', signature: '<b>Me</b>' }, attachments: [] });
    assert.equal(data.signature, '<b>Me</b>');
    assert.equal(data.isReply, undefined);
    assert.equal(data.scheduled.timeZone, null);
  });
});

describe('actionErrorText', () => {
  const err = (status, extra = {}, message = 'server words') => Object.assign(new Error(message), { status, ...extra });
  test('every refusal code the actions can meet', () => {
    assert.equal(actionErrorText(err(409, { code: 'needs_reauth' }), t), 'scheduled.errors.needsReauth');
    assert.equal(actionErrorText(err(409, { code: 'account_disabled' }), t), 'scheduled.errors.accountDisabled');
    assert.equal(actionErrorText(err(409, { code: 'held_elsewhere' }), t), 'compose.scheduleSend.errors.heldElsewhere');
    assert.equal(actionErrorText(err(409, { code: 'undo_expired' }), t), 'scheduled.errors.undoExpired');
    assert.equal(actionErrorText(err(409, { code: 'version_conflict' }), t), 'compose.scheduleSend.errors.versionConflict');
    assert.equal(actionErrorText(err(500, { code: 'decrypt_failed' }), t), 'scheduled.reason.decryptFailed');
    assert.equal(actionErrorText(err(400, { code: 'too_soon' }), t), 'server words', 'no clock note without the server time');
  });
  test('a state refusal in words, a missing message, and anything else in the server words', () => {
    assert.equal(actionErrorText(err(409, { state: 'sending' }), t), 'scheduled.errors.sending');
    assert.equal(actionErrorText(err(409, { state: 'sent' }), t), 'scheduled.errors.sent');
    assert.equal(actionErrorText(err(409, { state: 'cancelled' }), t), 'scheduled.errors.cancelled');
    assert.equal(actionErrorText(err(409, { state: 'editing' }), t), 'scheduled.errors.editing');
    assert.equal(actionErrorText(err(409, { state: 'paused' }), t), 'server words');
    assert.equal(actionErrorText(err(404), t), 'scheduled.errors.notFound');
    assert.equal(actionErrorText(err(422, { code: 'too_many' }, 'You can have at most 100'), t), 'You can have at most 100');
    assert.equal(actionErrorText(err(500, {}, ''), t), 'scheduled.errors.failed');
  });
});

describe('changeNotices', () => {
  test('sent and needing attention are told; what the user did is not', () => {
    const before = [
      row({ id: 'a', status: 'sending' }),
      row({ id: 'b', status: 'scheduled' }),
      row({ id: 'c', status: 'editing' }),
      row({ id: 'd', status: 'editing' }),
      row({ id: 'e', status: 'scheduled' }),
      row({ id: 'f', status: 'uncertain' }),
      row({ id: 'g', status: 'scheduled' }),
    ];
    const after = [
      row({ id: 'a', status: 'sent', summary: null }),
      row({ id: 'b', status: 'failed', failureCode: 'smtp_rejected' }),
      row({ id: 'c', status: 'paused', pauseReason: 'edit_abandoned' }),
      row({ id: 'd', status: 'failed' }),
      row({ id: 'e', status: 'paused', pauseReason: 'user' }),
      row({ id: 'f', status: 'sent', summary: null }),
      row({ id: 'g', status: 'scheduled' }),
      row({ id: 'new', status: 'failed' }),
    ];
    const notices = changeNotices(before, after);
    assert.deepEqual(notices.map(n => [n.kind, n.row.id]), [['sent', 'a'], ['attention', 'b'], ['attention', 'c']]);
    assert.equal(notices[0].summary.subject, 'Q4 numbers', 'the subject from before it was sent');
    assert.deepEqual(changeNotices(null, after), []);
  });

  test('the toasts: View for a sent one, a persistent Open for one that needs the user', () => {
    const opened = [];
    const deps = { t, openView: id => opened.push(['view', id]), openSent: r => opened.push(['sent', r.id]) };
    const sent = noticeToast({ kind: 'sent', row: row({ id: 'a', status: 'sent', result: { sentFolder: 'Sent', messageId: '<m@x>' } }), summary: row().summary }, deps);
    assert.equal(sent.title, 'scheduled.toast.sent');
    assert.equal(sent.body, 'Q4 numbers');
    sent.onAction();
    const lost = noticeToast({ kind: 'sent', row: row({ id: 'b', status: 'sent', result: {} }), summary: null }, deps);
    assert.equal(lost.body, 'scheduled.sentMessage');
    lost.onAction();
    const failed = noticeToast({ kind: 'attention', row: row({ id: 'c', status: 'failed', failureCode: 'tls' }), summary: row().summary }, deps);
    assert.equal(failed.type, 'error');
    assert.equal(failed.persistent, true);
    assert.equal(failed.body, 'scheduled.toast.notSent:{"reason":"scheduled.reason.tls"}');
    assert.equal(failed.actionLabel, 'scheduled.toast.open');
    failed.onAction();
    assert.deepEqual(opened, [['sent', 'a'], ['view', 'b'], ['view', 'c']]);
  });
});

test('scheduledLinkId takes the id of a push link only', () => {
  assert.equal(scheduledLinkId('/?scheduled=22222222-2222-4222-8222-222222222222'), '22222222-2222-4222-8222-222222222222');
  assert.equal(scheduledLinkId('https://mail.example/?scheduled=../../etc'), null);
  assert.equal(scheduledLinkId('/?m=abc'), null);
  assert.equal(scheduledLinkId('http://[bad'), null);
});
