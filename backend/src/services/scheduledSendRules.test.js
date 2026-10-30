import { describe, expect, it } from 'vitest';
import {
  BACKOFF_MS, LATE_AFTER_MS, MAX_ATTEMPTS, MAX_TICK_MS, MIN_TICK_MS, OVERDUE_GRACE_MS, ScheduledSendError,
  afterFailure, classifySendError, lateness, nextTickDelay, pushFor, recoveryAction,
} from './scheduledSendRules.js';

// The shapes deliverAndRecord rejects with: the SMTP error as cause, with the stage the attempt
// reached (smtpTransport.js trackStage). nodemailer tags every socket error 'CONN' (#685).
const smtpError = (fields, stage) => Object.assign(new Error('Send failed'), {
  publicMessage: 'Failed to send message. Please try again.',
  cause: Object.assign(new Error(fields.message || 'smtp error'), fields, stage === undefined ? {} : { smtpStage: stage }),
});
const NONE = { mailFromSent: false, bodyStarted: false };
const MAIL = { mailFromSent: true, bodyStarted: false };
const DATA = { mailFromSent: true, bodyStarted: true };
const sendError = (name, status, message = 'x') => Object.assign(new Error(message), { name, status });
// Microsoft's reply when SMTP AUTH is turned off for the mailbox (aka.ms/smtp_auth_disabled).
const AUTH_DISABLED = '535 5.7.139 Authentication unsuccessful, SmtpClientAuthentication is disabled for the Mailbox. Visit https://aka.ms/smtp_auth_disabled for more information.';

describe('classifySendError', () => {
  it.each([
    // phase, error, outcome, code, pause reason
    ['4xx before MAIL FROM (greeting)', 'send', smtpError({ responseCode: 421, code: 'EPROTOCOL', command: 'CONN', response: '421 busy' }, NONE), 'retry', 'smtp_temporary'],
    ['4xx at RCPT', 'send', smtpError({ responseCode: 450, code: 'EENVELOPE', command: 'RCPT TO' }, MAIL), 'retry', 'smtp_temporary'],
    ['4.7.x throttling at MAIL FROM', 'send', smtpError({ responseCode: 451, code: 'EENVELOPE', command: 'MAIL FROM', response: '451 4.7.1 slow down' }, MAIL), 'retry', 'smtp_temporary'],
    ['4xx reply to the message data', 'send', smtpError({ responseCode: 452, code: 'EMESSAGE', command: 'DATA' }, DATA), 'retry', 'smtp_temporary'],
    ['connection refused', 'send', smtpError({ code: 'ESOCKET', originalCode: 'ECONNREFUSED', command: 'CONN' }, NONE), 'retry', 'connection_failed'],
    ['DNS failure', 'send', smtpError({ code: 'EDNS', command: 'CONN' }, NONE), 'retry', 'connection_failed'],
    ['greeting timeout', 'send', smtpError({ code: 'ETIMEDOUT', command: 'CONN' }, NONE), 'retry', 'connection_failed'],
    ['socket reset mid-envelope, before the 354 (PIPELINING wrote DATA already)', 'send', smtpError({ code: 'ESOCKET', command: 'CONN' }, MAIL), 'retry', 'connection_failed'],
    ['socket reset after the 354 (#685: still CONN)', 'send', smtpError({ code: 'ESOCKET', command: 'CONN' }, DATA), 'uncertain', 'connection_lost'],
    ['timeout after the 354', 'send', smtpError({ code: 'ETIMEDOUT', command: 'CONN' }, DATA), 'uncertain', 'connection_lost'],
    ['connection error with the stage unknown', 'send', smtpError({ code: 'ECONNECTION', command: 'CONN' }), 'uncertain', 'connection_lost'],
    ['550 at RCPT', 'send', smtpError({ responseCode: 550, code: 'EENVELOPE', command: 'RCPT TO' }, MAIL), 'failed', 'smtp_rejected'],
    ['554 to the data', 'send', smtpError({ responseCode: 554, code: 'EMESSAGE', command: 'DATA' }, DATA), 'failed', 'smtp_rejected'],
    ['552 too large', 'send', smtpError({ responseCode: 552, code: 'EMESSAGE', command: 'DATA' }, DATA), 'failed', 'too_large'],
    ['5.3.4 too large', 'send', smtpError({ responseCode: 554, code: 'EMESSAGE', command: 'DATA', response: '554 5.3.4 Message too big' }, DATA), 'failed', 'too_large'],
    ['535 bad credentials', 'send', smtpError({ responseCode: 535, code: 'EAUTH', command: 'AUTH PLAIN' }, NONE), 'paused', 'auth_failed', 'needs_reauth'],
    ['535 bad credentials, with an enhanced code (Outlook)', 'send', smtpError({ responseCode: 535, code: 'EAUTH', command: 'AUTH XOAUTH2', message: 'Invalid login: 535 5.7.3 Authentication unsuccessful', response: '535 5.7.3 Authentication unsuccessful' }, NONE), 'paused', 'auth_failed', 'needs_reauth'],
    ['535 5.7.139: SMTP sending turned off for the mailbox (Outlook)', 'send', smtpError({ responseCode: 535, code: 'EAUTH', command: 'AUTH XOAUTH2', message: `Invalid login: ${AUTH_DISABLED}`, response: AUTH_DISABLED }, NONE), 'failed', 'smtp_auth_disabled'],
    ['the same refusal for a whole tenant', 'send', smtpError({ responseCode: 535, code: 'EAUTH', command: 'AUTH XOAUTH2', message: 'Invalid login: 535 5.7.139 Authentication unsuccessful, SmtpClientAuthentication is disabled for the Tenant. Visit https://aka.ms/smtp_auth_disabled for more information.' }, NONE), 'failed', 'smtp_auth_disabled'],
    // Other 5.7.139 refusals a new sign-in or an admin can fix: still a sign-in to redo.
    ['535 5.7.139 basic authentication disabled', 'send', smtpError({ responseCode: 535, code: 'EAUTH', command: 'AUTH LOGIN', message: 'Invalid login: 535 5.7.139 Authentication unsuccessful, basic authentication is disabled.', response: '535 5.7.139 Authentication unsuccessful, basic authentication is disabled.' }, NONE), 'paused', 'auth_failed', 'needs_reauth'],
    ['535 5.7.139 Conditional Access', 'send', smtpError({ responseCode: 535, code: 'EAUTH', command: 'AUTH XOAUTH2', message: 'Invalid login: 535 5.7.139 Authentication unsuccessful, the request did not meet the criteria to be authenticated successfully. Contact your administrator.', response: '535 5.7.139 Authentication unsuccessful, the request did not meet the criteria to be authenticated successfully. Contact your administrator.' }, NONE), 'paused', 'auth_failed', 'needs_reauth'],
    ['the same refusal said only in words', 'send', smtpError({ code: 'EAUTH', command: 'AUTH XOAUTH2', message: 'Invalid login: SmtpClientAuthentication is disabled for the Mailbox' }, NONE), 'failed', 'smtp_auth_disabled'],
    ['530 authentication required', 'send', smtpError({ responseCode: 530, code: 'EENVELOPE', command: 'MAIL FROM' }, MAIL), 'paused', 'auth_failed', 'needs_reauth'],
    ['EAUTH without a reply (missing credentials)', 'send', smtpError({ code: 'EAUTH', command: 'API' }, NONE), 'paused', 'auth_failed', 'needs_reauth'],
    ['454 temporary authentication failure', 'send', smtpError({ responseCode: 454, code: 'EAUTH', command: 'AUTH XOAUTH2' }, NONE), 'retry', 'smtp_temporary'],
    ['STARTTLS failed', 'send', smtpError({ code: 'ETLS', command: 'STARTTLS' }, NONE), 'failed', 'tls'],
    ['expired certificate', 'send', smtpError({ code: 'ESOCKET', originalCode: 'CERT_HAS_EXPIRED', command: 'CONN' }, NONE), 'failed', 'tls'],
    ['self-signed certificate', 'send', smtpError({ code: 'ESOCKET', originalCode: 'SELF_SIGNED_CERT_IN_CHAIN', command: 'CONN' }, NONE), 'failed', 'tls'],
    ['nodemailer refuses an oversized message', 'send', smtpError({ code: 'EMESSAGE', command: 'MAIL FROM', message: 'Message size larger than allowed 1000' }, NONE), 'failed', 'too_large'],
    ['nodemailer refuses the envelope', 'send', smtpError({ code: 'EENVELOPE', command: 'API', message: 'No recipients defined' }, NONE), 'failed', 'invalid_message'],
    ['OAuth sign-in needed again', 'prepare', Object.assign(new Error('refresh'), { accountErrorCode: 'oauth_reauth' }), 'paused', 'oauth_reauth', 'needs_reauth'],
    ['OAuth app misconfigured', 'prepare', Object.assign(new Error('refresh'), { accountErrorCode: 'oauth_app_config' }), 'paused', 'oauth_app_config', 'needs_reauth'],
    ['token endpoint unreachable', 'prepare', new Error('fetch failed'), 'retry', 'transient'],
    ['SMTP host refused by the connection policy', 'prepare', Object.assign(new Error('Host resolves to a private or reserved IP address'), { hostRefused: true }), 'failed', 'config'],
    ['corrupted credential', 'prepare', sendError('SendError', 502), 'failed', 'config'],
    ['plain-text SMTP refused', 'prepare', sendError('SendError', 403), 'failed', 'config'],
    ['stored input no longer valid', 'prepare', sendError('SendError', 400), 'failed', 'invalid_message'],
    ['bad fixed Message-ID', 'prepare', new TypeError('messageId must look like <local@domain>'), 'failed', 'invalid_message'],
    ['alias gone', 'prepare', new ScheduledSendError('alias_missing'), 'failed', 'alias_missing'],
    ['decrypt failure', 'prepare', new ScheduledSendError('decrypt_failed'), 'failed', 'decrypt_failed'],
  ])('%s', (_name, phase, err, outcome, code, pauseReason) => {
    const result = classifySendError(err, { phase });
    expect(result.outcome).toBe(outcome);
    expect(result.code).toBe(code);
    if (pauseReason) expect(result.pauseReason).toBe(pauseReason);
  });

  it('never retries what may have been delivered, whatever command nodemailer names', () => {
    for (const command of ['CONN', 'DATA', 'MAIL FROM', undefined]) {
      for (const code of ['ESOCKET', 'ETIMEDOUT', 'ECONNECTION', 'EPROTOCOL']) {
        expect(classifySendError(smtpError({ code, command }, DATA), { phase: 'send' }).outcome).toBe('uncertain');
        expect(classifySendError(smtpError({ code, command }), { phase: 'send' }).outcome).toBe('uncertain');
      }
    }
  });
});

describe('afterFailure', () => {
  it('backs off 1 min, 5 min, 15 min, 1 h, 3 h, then gives up after the 6th attempt', () => {
    const transient = { outcome: 'retry', code: 'smtp_temporary' };
    expect([1, 2, 3, 4, 5].map(a => afterFailure(transient, a).delayMs))
      .toEqual([60_000, 300_000, 900_000, 3_600_000, 10_800_000]);
    expect(BACKOFF_MS.reduce((a, b) => a + b, 0)).toBe(261 * 60_000);
    expect(MAX_ATTEMPTS).toBe(6);
    expect(afterFailure(transient, 6)).toEqual({ outcome: 'failed', code: 'gave_up', lastCode: 'smtp_temporary' });
  });

  it('leaves other outcomes alone', () => {
    const outcome = { outcome: 'uncertain', code: 'connection_lost' };
    expect(afterFailure(outcome, 6)).toBe(outcome);
  });
});

describe('recoveryAction', () => {
  it('reads acceptance first, then the start, so an accepted message is never sent again', () => {
    expect(recoveryAction({ smtp_started_at: null, smtp_accepted_at: null })).toBe('reschedule');
    expect(recoveryAction({ smtp_started_at: new Date(), smtp_accepted_at: null })).toBe('check_sent');
    expect(recoveryAction({ smtp_started_at: new Date(), smtp_accepted_at: new Date() })).toBe('finish_accepted');
    // The schema forbids this, but acceptance would still win.
    expect(recoveryAction({ smtp_started_at: null, smtp_accepted_at: new Date() })).toBe('finish_accepted');
  });
});

describe('lateness', () => {
  const first = { dueBeforeStart: true };
  it('sends up to 6 h late, flagged late after 5 min, and holds anything later', () => {
    expect(lateness({ ...first, lagMs: 30_000 })).toEqual({ overdue: false, late: false, lateReason: null });
    expect(lateness({ ...first, lagMs: LATE_AFTER_MS })).toEqual({ overdue: false, late: false, lateReason: null });
    expect(lateness({ ...first, lagMs: LATE_AFTER_MS + 1 })).toEqual({ overdue: false, late: true, lateReason: 'offline' });
    expect(lateness({ ...first, lagMs: OVERDUE_GRACE_MS })).toMatchObject({ overdue: false, late: true });
    expect(lateness({ ...first, lagMs: OVERDUE_GRACE_MS + 1 })).toMatchObject({ overdue: true, late: true });
  });

  it('holds a retry that is more than 6 h late too, but never the backoff alone', () => {
    expect(lateness({ lagMs: OVERDUE_GRACE_MS + 1, retried: true, dueBeforeStart: false }))
      .toEqual({ overdue: true, late: true, lateReason: 'retried' });
    // Every backoff delay after a first attempt on time, with a minute per attempt to spare.
    const backoff = BACKOFF_MS.reduce((sum, d) => sum + d, 0) + MAX_ATTEMPTS * 60_000;
    expect(backoff).toBeLessThan(OVERDUE_GRACE_MS);
    expect(lateness({ lagMs: backoff, retried: true, dueBeforeStart: false }).overdue).toBe(false);
  });

  it('calls it retried only when a backoff retry made it late', () => {
    expect(lateness({ lagMs: 20 * 60_000, retried: false, dueBeforeStart: false }).lateReason).toBe('delayed');
    // Send now and Resume set send_at, so they are not late at all.
    expect(lateness({ lagMs: 2000, retried: false, dueBeforeStart: true }))
      .toEqual({ overdue: false, late: false, lateReason: null });
  });

  it('says offline only for a message whose time came before the sender started', () => {
    expect(lateness({ lagMs: 20 * 60_000, dueBeforeStart: false }).lateReason).toBe('delayed');
    expect(lateness({ lagMs: 20 * 60_000, dueBeforeStart: true }).lateReason).toBe('offline');
  });
});

describe('nextTickDelay', () => {
  const now = 1_000_000;
  it('ticks at the next due time, within bounds', () => {
    expect(nextTickDelay(null, now)).toBe(MAX_TICK_MS);
    expect(nextTickDelay(now + 5000, now)).toBe(5000);
    expect(nextTickDelay(now + 10, now)).toBe(MIN_TICK_MS);
    expect(nextTickDelay(now + 3_600_000, now)).toBe(MAX_TICK_MS);
  });
  it('waits the full interval for a due time already past, instead of spinning', () => {
    expect(nextTickDelay(now - 1, now)).toBe(MAX_TICK_MS);
    expect(nextTickDelay(now, now)).toBe(MAX_TICK_MS);
  });
});

describe('pushFor', () => {
  const base = { id: 'abc', subject: 'Q4 numbers', sendAt: new Date('2026-10-26T07:00:00Z'), timeZone: 'Europe/Berlin' };
  it('says why and what to do, with the subject as title and a deep link', () => {
    expect(pushFor({ ...base, status: 'failed', failureCode: 'smtp_rejected' }))
      .toMatchObject({ title: 'Q4 numbers', body: 'Not sent: The mail server refused it.', url: '/?scheduled=abc', tag: 'scheduled-abc' });
    expect(pushFor({ ...base, status: 'paused', pauseReason: 'needs_reauth' }).body).toBe('Not sent: Sign in to the account again to send it.');
    expect(pushFor({ ...base, status: 'paused', pauseReason: 'overdue', offline: true }).body)
      .toBe('Not sent: was scheduled for Mon, Oct 26, 8:00 AM. MailFlow was offline. Open to send or reschedule.');
    // Overdue while MailFlow ran (a queue, never a retry): nothing about being offline.
    expect(pushFor({ ...base, status: 'paused', pauseReason: 'overdue' }).body)
      .toBe('Not sent: was scheduled for Mon, Oct 26, 8:00 AM and is more than 6 hours late. Open to send or reschedule.');
    expect(pushFor({ ...base, status: 'uncertain' }).body).toMatch(/may or may not have been delivered/);
    expect(pushFor({ ...base, status: 'failed', failureCode: 'smtp_auth_disabled' }).body)
      .toBe('Not sent: Microsoft has turned off sending from mail apps (SMTP) for this account. You can still send from Outlook on the web. For a work or school account, your admin can turn it back on.');
  });
  it('falls back to a generic title and UTC for an unknown zone', () => {
    const push = pushFor({ ...base, subject: null, timeZone: 'Not/AZone', status: 'paused', pauseReason: 'overdue', offline: true });
    expect(push.title).toBe('Scheduled message');
    expect(push.body).toContain('7:00 AM');
  });
});
