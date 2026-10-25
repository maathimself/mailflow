import { appLocale } from './formatDate.js';
import { browserTimeZone, formatSendAt } from './scheduleTimes.js';
import { scheduleErrorText } from './scheduledCompose.js';

// The Scheduled view (#543, design 5.2 and 5.3): what GET /api/mail/scheduled returns, put in the
// view's sections, with what each message is doing and why in words, the actions its state allows
// (routes/scheduled.js), and what a change seen over the WebSocket is worth telling the user.

// Failed, paused and uncertain messages wait for the user (design 2.1).
export const ATTENTION_STATUSES = new Set(['failed', 'paused', 'uncertain']);

const bySendAt = (a, b) => (new Date(a.sendAt) - new Date(b.sendAt)) || String(a.id).localeCompare(String(b.id));
const bySentAt = (a, b) => (new Date(b.sentAt || 0) - new Date(a.sentAt || 0)) || String(a.id).localeCompare(String(b.id));

// A deleted message that can still be restored at `now`.
export const isRestorable = (row, now = Date.now()) => row?.status === 'cancelled'
  && Boolean(row.restoreUntil) && new Date(row.restoreUntil).getTime() > (now instanceof Date ? now.getTime() : now);

// The sections, in the order the view shows them: Needs attention, Scheduled (scheduled, being
// edited or being sent), soonest first, the recently sent ones, newest first, and the deleted ones
// still in their restore window, the last deleted first.
export function groupScheduled(messages = [], now = Date.now()) {
  const attention = [];
  const upcoming = [];
  const sent = [];
  const deleted = [];
  for (const m of messages) {
    if (ATTENTION_STATUSES.has(m.status)) attention.push(m);
    else if (m.status === 'sent') sent.push(m);
    else if (m.status === 'cancelled') { if (isRestorable(m, now)) deleted.push(m); }
    else upcoming.push(m);
  }
  const byRestoreUntil = (a, b) => (new Date(b.restoreUntil) - new Date(a.restoreUntil)) || String(a.id).localeCompare(String(b.id));
  return {
    attention: attention.sort(bySendAt), upcoming: upcoming.sort(bySendAt), sent: sent.sort(bySentAt), deleted: deleted.sort(byRestoreUntil),
  };
}

// When the next deleted message's restore window closes, so the view can drop it then; null if none.
export function nextRestoreEnd(messages = [], now = Date.now()) {
  const ends = messages.filter(m => isRestorable(m, now)).map(m => new Date(m.restoreUntil).getTime());
  return ends.length ? Math.min(...ends) : null;
}

// A message the sender tried and will try again (a retry is `scheduled` with the last failure kept).
export const isRetrying = row => row?.status === 'scheduled' && Number(row.attempts) > 0 && Boolean(row.failureCode);

// What the user can do with a message, in the order the menu lists them, as routes/scheduled.js
// allows them: edit, reschedule and send now from scheduled, paused, failed and uncertain (send
// now and reschedule ask first for uncertain and restored ones), resume from paused and failed,
// send anyway and mark as sent for uncertain only, cancel (Delete, with Undo) from anything but
// sending and sent, and delete for good from anything but sending. One being edited can be opened
// (the composer offers to take it over) or deleted; one being sent, nothing; a deleted one, in its
// window, restored or deleted for good.
export function rowActions(row) {
  switch (row?.status) {
    case 'scheduled': return ['edit', 'reschedule', 'sendNow', 'cancel', 'delete'];
    case 'editing': return ['edit', 'cancel', 'delete'];
    case 'paused':
    case 'failed': return ['edit', 'resume', 'reschedule', 'sendNow', 'cancel', 'delete'];
    case 'uncertain': return ['sendAnyway', 'markSent', 'edit', 'reschedule', 'cancel', 'delete'];
    case 'sent': return [...(row.result?.sentFolder && row.result?.messageId ? ['viewSent'] : []), 'remove'];
    case 'cancelled': return ['restore', 'delete'];
    default: return [];
  }
}

// The actions a row shows on hover (desktop) beside its More button: the one that moves it on,
// and Delete.
export function hoverActions(row) {
  const all = rowActions(row);
  if (row?.status === 'cancelled') return ['restore'];
  const lead = ['sendAnyway', 'resume', 'sendNow'].find(a => all.includes(a));
  return ['edit', 'reschedule', lead, 'cancel'].filter(a => a && all.includes(a));
}

// What a click (or Enter, or a tap on a phone) does: edit, or for a sent message open its copy.
export function primaryAction(row) {
  const all = rowActions(row);
  return all.includes('edit') ? 'edit' : all.includes('viewSent') ? 'viewSent' : null;
}

export const ACTION_LABELS = {
  edit: 'scheduled.actions.edit',
  reschedule: 'scheduled.actions.reschedule',
  sendNow: 'scheduled.actions.sendNow',
  resume: 'scheduled.actions.resume',
  retry: 'scheduled.actions.retry',
  sendAnyway: 'scheduled.actions.sendAnyway',
  markSent: 'scheduled.actions.markSent',
  cancel: 'scheduled.actions.cancel',
  delete: 'scheduled.actions.delete',
  viewSent: 'scheduled.actions.viewSent',
  remove: 'scheduled.actions.remove',
  restore: 'scheduled.actions.restore',
};
// Resume reads "Try again" for a message that failed.
export const actionLabelKey = (action, row) => (action === 'resume' && row?.status === 'failed' ? ACTION_LABELS.retry : ACTION_LABELS[action]);

// Why a message waits for the user, from its pause reason or failure code (scheduledSendRules.js).
const PAUSE_REASONS = {
  overdue: 'scheduled.reason.overdue',
  restored: 'scheduled.reason.restored',
  edit_abandoned: 'scheduled.reason.editAbandoned',
  account_disabled: 'scheduled.reason.accountDisabled',
  needs_reauth: 'scheduled.reason.needsReauth',
  user: 'scheduled.reason.user',
};
const FAILURE_REASONS = {
  smtp_rejected: 'scheduled.reason.smtpRejected',
  too_large: 'scheduled.reason.tooLarge',
  config: 'scheduled.reason.config',
  tls: 'scheduled.reason.tls',
  invalid_message: 'scheduled.reason.invalidMessage',
  alias_missing: 'scheduled.reason.aliasMissing',
  decrypt_failed: 'scheduled.reason.decryptFailed',
  account_missing: 'scheduled.reason.accountMissing',
  gave_up: 'scheduled.reason.gaveUp',
};

export function reasonKey(row) {
  if (row?.status === 'uncertain') return 'scheduled.reason.uncertain';
  if (row?.status === 'paused') return PAUSE_REASONS[row.pauseReason] || 'scheduled.reason.paused';
  if (row?.status === 'failed') return FAILURE_REASONS[row.failureCode] || 'scheduled.reason.failed';
  if (row?.status === 'cancelled') return 'scheduled.reason.deleted';
  if (isRetrying(row)) return 'scheduled.reason.retrying';
  return null;
}

// The status chip, in words (design 5.2: text, not color alone). A plain scheduled message has none.
export function chipKey(row) {
  switch (row?.status) {
    case 'sending': return 'scheduled.chip.sending';
    case 'editing': return 'scheduled.chip.editing';
    case 'failed': return 'scheduled.chip.failed';
    case 'paused': return 'scheduled.chip.paused';
    case 'uncertain': return 'scheduled.chip.uncertain';
    case 'sent': return row.sentLate ? 'scheduled.chip.sentLate' : 'scheduled.chip.sent';
    case 'cancelled': return 'scheduled.chip.deleted';
    default: return isRetrying(row) ? 'scheduled.chip.retrying' : null;
  }
}
export const chipTone = row => (ATTENTION_STATUSES.has(row?.status) ? 'alert' : row?.status === 'sent' ? 'done' : 'info');

// "Alice" from "Alice <alice@example.com>", the address when there is no name.
export function addressName(value) {
  if (value && typeof value === 'object') return String(value.name || value.address || '').trim();
  const s = String(value || '').trim();
  const m = /^"?([^"<]*?)"?\s*<([^>]+)>$/.exec(s);
  if (m) return m[1].trim() || m[2].trim();
  return s;
}

// The first `max` recipients by name, and how many more there are in To, Cc and Bcc.
export function recipientsOf(summary, max = 2) {
  const names = (Array.isArray(summary?.to) ? summary.to : []).map(addressName).filter(Boolean);
  const shown = names.slice(0, max);
  const more = names.length - shown.length + (Number(summary?.ccCount) || 0) + (Number(summary?.bccCount) || 0);
  return { names: shown, more };
}

const dayNumber = d => Math.round(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 86_400_000);

// A send time in the user's zone: "Today 6:00 PM", "Tomorrow 8:00 AM", "Yesterday 8:00 AM", or
// "Tue, Oct 28, 8:00 AM" (formatSendAt).
export function formatScheduledTime(value, { t, locale, now = new Date() }) {
  const d = value instanceof Date ? value : new Date(value);
  if (!value || Number.isNaN(d.getTime())) return '';
  const time = new Intl.DateTimeFormat(locale ?? appLocale(), { hour: 'numeric', minute: '2-digit' }).format(d);
  const days = dayNumber(d) - dayNumber(now);
  if (days === 0) return t('scheduled.when.today', { time });
  if (days === 1) return t('scheduled.when.tomorrow', { time });
  if (days === -1) return t('scheduled.when.yesterday', { time });
  return formatSendAt(d, locale, now);
}

// The time in the zone it was scheduled in, when that is not this browser's and reads differently
// (open question 9): { time: "Sun 8:00 AM", zone: "Europe/Berlin" }, or null.
export function storedZoneTime(value, timeZone, { locale, here = browserTimeZone() } = {}) {
  if (!value || !timeZone || timeZone === here) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const options = { weekday: 'short', hour: 'numeric', minute: '2-digit' };
  try {
    const there = new Intl.DateTimeFormat(locale ?? appLocale(), { ...options, timeZone }).format(d);
    const local = new Intl.DateTimeFormat(locale ?? appLocale(), { ...options, ...(here ? { timeZone: here } : {}) }).format(d);
    return there === local ? null : { time: there, zone: timeZone };
  } catch {
    return null;
  }
}

// The lines a sent message's row adds: late, refused and deferred recipients, and its Sent copy.
// A message the user marked as sent has no outcome of its own (sentCopySaved is null).
export function sentNotes(row, { t, locale, now = new Date() }) {
  const result = row?.result;
  if (row?.status !== 'sent' || !result) return [];
  const notes = [];
  const when = v => formatScheduledTime(v, { t, locale, now });
  if (result.sentCopySaved == null && !result.messageId) {
    notes.push({ key: 'marked', tone: 'info', text: t('scheduled.sent.markedSent') });
    return notes;
  }
  if (row.sentLate) {
    const values = { scheduled: when(row.sendAt), sent: when(row.sentAt) };
    notes.push({
      key: 'late', tone: 'info',
      text: result.lateReason === 'offline' ? t('scheduled.sent.lateOffline', values) : t('scheduled.sent.late', values),
    });
  }
  if (result.rejected?.length) {
    notes.push({ key: 'rejected', tone: 'alert', text: t('scheduled.sent.refused', { list: result.rejected.join(', ') }) });
  }
  if (result.deferred?.length) {
    notes.push({ key: 'deferred', tone: 'alert', text: t('scheduled.sent.deferred', { list: result.deferred.join(', ') }) });
  }
  if (result.sentCopySaved === false) {
    notes.push({
      key: 'copy', tone: 'alert',
      text: result.sentCopyReason === 'no_sent_folder' ? t('scheduled.sent.noSentFolder') : t('scheduled.sent.noSentCopy'),
    });
  }
  return notes;
}

// The row's accessible name (design 5.4): "Scheduled for Sun 8:00 AM, to Alice and Bob, subject
// Q4 numbers, Failed: The mail server refused it." `reason` is the reason as the row says it.
export function rowLabel(row, { t, when, summary, reason }) {
  const { names, more } = recipientsOf(summary);
  const parts = [
    row.status === 'sent' ? t('scheduled.a11y.sentAt', { when }) : t('scheduled.a11y.scheduledFor', { when }),
  ];
  if (names.length) {
    parts.push(more ? t('scheduled.a11y.toMore', { names: names.join(', '), more }) : t('scheduled.a11y.to', { names: names.join(', ') }));
  }
  parts.push(t('scheduled.a11y.subject', { subject: summary?.subject || t('common.noSubject') }));
  const chip = chipKey(row);
  if (chip) parts.push(reason ? `${t(chip)}: ${reason}` : t(chip));
  return parts.join(', ');
}

const escapePlain = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// The composer's data for editing a message, from GET /api/mail/scheduled/:id: the spec's fields
// as a reopened message has them, what the composer was (spec.compose), and `scheduled`
// (utils/scheduledCompose.js). The composer takes the hold itself; `restored` is not set, since
// this is not a message undo send gave back.
export function composeDataFromScheduled(detail) {
  const spec = detail?.spec || {};
  const compose = spec.compose && typeof spec.compose === 'object' ? spec.compose : {};
  const context = {};
  for (const key of ['isReply', 'isReplyAll', 'isForward', 'threadId', 'originalFrom', 'allRecipients']) {
    if (compose[key] !== undefined && compose[key] !== null) context[key] = compose[key];
  }
  return {
    ...context,
    accountId: detail.accountId,
    ...(spec.aliasId ? { aliasId: spec.aliasId } : {}),
    to: spec.to || [],
    cc: spec.cc || [],
    bcc: spec.bcc || [],
    subject: spec.subject || '',
    body: spec.body || '',
    ...(spec.quotedBody ? { quotedBody: spec.quotedBody } : {}),
    ...(spec.quotedBodyHtml ? { quotedBodyHtml: spec.quotedBodyHtml } : {}),
    // What it was to be sent with: an empty one is the signature turned off. The composer reads
    // it as HTML, so a plain-text one is escaped, as buildRestoreData does for undo send.
    signature: spec.plaintextEmail === true ? escapePlain(spec.signature ?? '') : (spec.signature ?? ''),
    ...(spec.priority && spec.priority !== 'normal' ? { priority: spec.priority } : {}),
    ...(spec.inReplyTo ? { inReplyTo: spec.inReplyTo } : {}),
    ...(spec.references ? { references: spec.references } : {}),
    scheduled: {
      id: detail.id,
      version: detail.version,
      sendAt: detail.sendAt,
      timeZone: detail.timeZone ?? null,
      attachments: (detail.attachments || []).map(a => ({
        index: a.index, filename: a.filename, size: a.size, contentType: a.contentType, kind: a.kind,
      })),
    },
  };
}

// What the server answers when it would not change a message, as the user is told it.
const STATE_TEXT = {
  sending: 'scheduled.errors.sending',
  sent: 'scheduled.errors.sent',
  cancelled: 'scheduled.errors.cancelled',
  editing: 'scheduled.errors.editing',
};
export function actionErrorText(err, t) {
  switch (err?.code) {
    case 'needs_reauth': return t('scheduled.errors.needsReauth');
    case 'account_disabled': return t('scheduled.errors.accountDisabled');
    case 'held_elsewhere': return t('compose.scheduleSend.errors.heldElsewhere');
    case 'undo_expired': return t('scheduled.errors.undoExpired');
    case 'decrypt_failed': return t('scheduled.reason.decryptFailed');
    case 'too_soon':
    case 'too_far':
    case 'version_conflict':
      return scheduleErrorText(err, t);
    default: break;
  }
  if (err?.status === 404) return t('scheduled.errors.notFound');
  if (err?.status === 409 && STATE_TEXT[err.state]) return t(STATE_TEXT[err.state]);
  return err?.message || t('scheduled.errors.failed');
}

// What to tell the user about the changes between two lists (design 5.3): a message the sender
// sent, and one that came to need the user from scheduled or sending (the sender failed, paused or
// stopped it), or that an editor left when it was due. Changes the user made (Keep paused, a
// release that puts a failed message back as it was, Mark as sent) are not told: they know.
export function changeNotices(previous, next) {
  if (!previous || !next) return [];
  const before = new Map(previous.map(m => [m.id, m]));
  const notices = [];
  for (const row of next) {
    const was = before.get(row.id);
    if (!was || was.status === row.status) continue;
    if (row.status === 'sent' && was.status !== 'uncertain') {
      notices.push({ kind: 'sent', row, summary: row.summary || was.summary || null });
    } else if (ATTENTION_STATUSES.has(row.status) && !(row.status === 'paused' && row.pauseReason === 'user')
      && (was.status === 'scheduled' || was.status === 'sending' || (was.status === 'editing' && row.pauseReason === 'edit_abandoned'))) {
      notices.push({ kind: 'attention', row, summary: row.summary || was.summary || null });
    }
  }
  return notices;
}

// The in-tab toast for a notice (design 5.3): a sent message, with View (its copy in Sent, else
// the Scheduled view), and a message that needs the user, a persistent error with Open.
export function noticeToast(notice, { t, openView, openSent }) {
  const { row } = notice;
  const subject = notice.summary?.subject || t('common.noSubject');
  if (notice.kind === 'sent') {
    const copy = row.result?.sentFolder && row.result?.messageId;
    return {
      title: t('scheduled.toast.sent'),
      body: notice.summary ? subject : t('scheduled.sentMessage'),
      onAction: copy ? () => openSent(row) : () => openView(row.id),
    };
  }
  const reason = reasonKey(row);
  return {
    type: 'error', persistent: true, allowWrap: true,
    title: subject,
    body: t('scheduled.toast.notSent', { reason: reason ? t(reason) : t('scheduled.reason.failed') }),
    actionLabel: t('scheduled.toast.open'),
    onAction: () => openView(row.id),
  };
}

// The id a notification link names (/?scheduled=<id>), when it is one.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function scheduledLinkId(url, origin = 'https://mailflow.invalid') {
  try {
    const id = new URL(url, origin).searchParams.get('scheduled');
    return id && UUID_RE.test(id) ? id : null;
  } catch {
    return null;
  }
}
