import { SMTP_AUTH_DISABLED, isSmtpAuthDisabled } from './smtpRefusals.js';

// The decisions of the scheduled sender (#543), kept free of I/O so each can be tested as a
// table: how an error ends an attempt, when a retry is due, what recovery does with a send a
// process left behind, when a message is overdue, when the next tick runs, and the push text.
// services/scheduledSend.js does the database and SMTP work around them.

// A claim lives as long as its process refreshes it (HEARTBEAT_MS); one whose process died is
// recovered once LEASE_MS has passed since the last refresh.
export const LEASE_MS = 3 * 60 * 1000;
export const HEARTBEAT_MS = 60 * 1000;
// No send runs this long (its budgets add up to a few minutes): past it, a claim is not refreshed.
export const CLAIM_CAP_MS = 15 * 60 * 1000;
export const MAX_TICK_MS = 30 * 1000;
export const MIN_TICK_MS = 250;
// A message more than this late is not sent without asking (open question 1).
export const OVERDUE_GRACE_MS = 6 * 60 * 60 * 1000;
// Later than this, a sent message is flagged sent_late, and a due one not yet claimed is logged.
export const LATE_AFTER_MS = 5 * 60 * 1000;
// From the attempt that failed: after the 1st, 1 min; after the 5th, 3 h; the 6th gives up.
export const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 3 * 60 * 60_000];
export const MAX_ATTEMPTS = BACKOFF_MS.length + 1;

// A failure that no retry can fix, with the code the UI maps to words.
export class ScheduledSendError extends Error {
  constructor(scheduledCode, message = scheduledCode) {
    super(message);
    this.name = 'ScheduledSendError';
    this.scheduledCode = scheduledCode;
  }
}

const REAUTH_CODES = new Set(['oauth_reauth', 'oauth_app_config']);
const AUTH_RESPONSE_CODES = new Set([530, 534, 535]);
const TLS_CODE_RE = /^(?:ETLS|ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|SELF_SIGNED_|DEPTH_ZERO_|HOSTNAME_MISMATCH)/;

// The codes a backoff retry leaves in failure_code.
export const RETRY_CODES = new Set(['smtp_temporary', 'connection_failed', 'transient']);

const retry = code => ({ outcome: 'retry', code });
const failed = code => ({ outcome: 'failed', code });
const paused = (pauseReason, code) => ({ outcome: 'paused', pauseReason, code });
const uncertain = code => ({ outcome: 'uncertain', code });

// How an error ends an attempt. `phase` is 'prepare' for anything before the message was handed
// to the transport (building it, refreshing a token, opening the transport), and 'send' for a
// rejection of deliverAndRecord, whose cause is the SMTP error and carries the stage the attempt
// reached (smtpStage, from smtpTransport.js trackStage). A retry is chosen only when the message
// certainly did not go out: the server answered with a 4xx, or the connection failed before the
// server accepted DATA (with a 354, or a 250 from some servers). A connection lost after that, or at a stage that
// is not known, may have delivered it and is uncertain, which is never sent again without the
// user (open question 11).
export function classifySendError(err, { phase }) {
  if (err instanceof ScheduledSendError) return failed(err.scheduledCode);
  // The account may not send over SMTP at all: no retry and no new sign-in changes that.
  if (isSmtpAuthDisabled(err)) return failed(SMTP_AUTH_DISABLED);
  if (phase === 'prepare') {
    if (REAUTH_CODES.has(err?.accountErrorCode)) return paused('needs_reauth', err.accountErrorCode);
    // SendError: 400 is input that no longer passes the send checks, anything else an SMTP
    // configuration the account cannot send with (a corrupted credential, plain-text SMTP).
    if (err?.name === 'SendError') return failed(err.status === 400 ? 'invalid_message' : 'config');
    if (err instanceof TypeError) return failed('invalid_message');
    // The connection policy refused the SMTP host (private or reserved address): no retry
    // changes that, only the account's settings or the admin's policy.
    if (err?.hostRefused) return failed('config');
    // A token endpoint or the database that did not answer: nothing reached SMTP.
    return retry('transient');
  }

  const smtp = err?.cause ?? err;
  const responseCode = Number(smtp?.responseCode ?? err?.responseCode) || null;
  const code = String(smtp?.code ?? '');
  const originalCode = String(smtp?.originalCode ?? '');
  if (responseCode >= 400 && responseCode < 500) return retry('smtp_temporary');
  if (responseCode >= 500 && responseCode < 600) {
    if (code === 'EAUTH' || AUTH_RESPONSE_CODES.has(responseCode)) return paused('needs_reauth', 'auth_failed');
    if (responseCode === 552 || /\b5\.3\.4\b/.test(String(smtp?.response ?? ''))) return failed('too_large');
    return failed('smtp_rejected');
  }
  const stage = smtp?.smtpStage;
  if (!stage || stage.bodyStarted) return uncertain('connection_lost');
  if (code === 'EAUTH') return paused('needs_reauth', 'auth_failed');
  if (TLS_CODE_RE.test(code) || TLS_CODE_RE.test(originalCode)) return failed('tls');
  // nodemailer's own refusals, before anything was sent: no recipients, a bad address, a
  // message over the size the server announced.
  if (code === 'EENVELOPE' || code === 'EMESSAGE') {
    return failed(/size/i.test(String(smtp?.message ?? '')) ? 'too_large' : 'invalid_message');
  }
  return retry('connection_failed');
}

// What a failed attempt leads to: a retry after the backoff for that attempt, or, after the
// last one, giving up. Other outcomes stand as they are.
export function afterFailure(classification, attempts) {
  if (classification.outcome !== 'retry') return classification;
  if (attempts >= MAX_ATTEMPTS) return { outcome: 'failed', code: 'gave_up', lastCode: classification.code };
  return { ...classification, delayMs: BACKOFF_MS[Math.max(0, attempts - 1)] };
}

// What recovery does with a send a process left behind, in this order: SMTP accepted it, so
// only the bookkeeping is left; it was handed to SMTP, so it may have gone out; or nothing
// reached SMTP and it can be claimed again.
export function recoveryAction(row) {
  if (row.smtp_accepted_at) return 'finish_accepted';
  if (row.smtp_started_at) return 'check_sent';
  return 'reschedule';
}

// Whether a claimed message is too late to send without asking, whether it goes out late, and
// why, measured from send_at, on every attempt: a retry after a long outage, or one that recovery
// put back after a crash, is as late as a first attempt would be. The backoff retries add up to
// 4 h 21 min, so they alone never reach the grace, and what the user does to send it now (Send
// now, Resume, Send anyway, a new time) sets send_at, so holding it again cannot loop. `retried`:
// the last attempt ended in a backoff retry, which is why it is late. `dueBeforeStart`: its time
// came before this sender started, so MailFlow was offline then. Otherwise a late message waited
// in the queue, and nothing may tell the user it was offline.
export function lateness({ lagMs, retried = false, dueBeforeStart }) {
  const late = lagMs > LATE_AFTER_MS;
  return {
    overdue: lagMs > OVERDUE_GRACE_MS,
    late,
    lateReason: !late ? null : retried ? 'retried' : dueBeforeStart ? 'offline' : 'delayed',
  };
}

// When the next tick runs: at the next due time, at most MAX_TICK_MS away. A due time already
// past waits the full interval: the claim took what it could, and a send that finishes nudges.
export function nextTickDelay(nextDueMs, nowMs) {
  if (nextDueMs == null) return MAX_TICK_MS;
  const wait = nextDueMs - nowMs;
  if (wait <= 0) return MAX_TICK_MS;
  return Math.min(MAX_TICK_MS, Math.max(MIN_TICK_MS, wait));
}

const FAILED_TEXT = {
  smtp_rejected: 'The mail server refused it.',
  too_large: 'It is too large for the mail server.',
  config: 'The account\'s sending settings need attention.',
  tls: 'The secure connection to the mail server failed.',
  invalid_message: 'The message could not be put together.',
  alias_missing: 'The address it was to be sent from no longer exists.',
  decrypt_failed: 'It could not be decrypted on this server.',
  account_missing: 'Its account no longer exists.',
  gave_up: 'The mail server kept failing, so MailFlow stopped trying.',
  smtp_auth_disabled: 'Microsoft has turned off sending from mail apps (SMTP) for this account. You can still send from Outlook on the web. For a work or school account, your admin can turn it back on.',
};
const PAUSED_TEXT = {
  needs_reauth: 'Sign in to the account again to send it.',
  account_disabled: 'Its account is turned off.',
  edit_abandoned: 'It was open for editing when it was due.',
  restored: 'It was paused when a backup was restored.',
};

function dueText(sendAt, timeZone) {
  const options = { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
  try {
    return new Intl.DateTimeFormat('en-US', { ...options, timeZone: timeZone || 'UTC' }).format(sendAt);
  } catch {
    return new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' }).format(sendAt);
  }
}

// The push for a message that needs the user, in English like the other pushes (open question
// 10). The title is the subject, the only content a push carries; the rest is why and what to do.
export function pushFor({ id, status, failureCode, pauseReason, subject, sendAt, timeZone, offline = false }) {
  let body;
  if (status === 'uncertain') {
    body = 'MailFlow stopped while sending this. It may or may not have been delivered. Check your Sent folder.';
  } else if (status === 'paused' && pauseReason === 'overdue') {
    body = offline
      ? `Not sent: was scheduled for ${dueText(sendAt, timeZone)}. MailFlow was offline. Open to send or reschedule.`
      : `Not sent: was scheduled for ${dueText(sendAt, timeZone)} and is more than 6 hours late. Open to send or reschedule.`;
  } else if (status === 'paused') {
    body = `Not sent: ${PAUSED_TEXT[pauseReason] || 'It is paused.'}`;
  } else {
    body = `Not sent: ${FAILED_TEXT[failureCode] || 'It could not be sent.'}`;
  }
  return {
    title: subject || 'Scheduled message',
    body,
    icon: '/icon-512.png',
    badge: '/badge-96.png',
    tag: `scheduled-${id}`,
    url: `/?scheduled=${id}`,
  };
}
