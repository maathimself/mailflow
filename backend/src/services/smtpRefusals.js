// SMTP refusals that need words of their own, recognized the same way for an ordinary send
// (outgoingMail.js) and a scheduled one (scheduledSendRules.js). Free of I/O.

// Microsoft refuses SMTP AUTH for a mailbox, or a whole tenant, whose SMTP sending is turned off:
// by a work tenant's admin or, for many new personal Outlook.com accounts, by Microsoft itself
// (aka.ms/smtp_auth_disabled):
//   535 5.7.139 Authentication unsuccessful, SmtpClientAuthentication is disabled for the Mailbox.
// The sign-in itself worked, so signing in again cannot fix it. Only these words are matched, not
// the 5.7.139 code: Microsoft gives it to other refusals too (basic authentication disabled,
// Conditional Access, security defaults), which a new sign-in or an admin can fix.
export const SMTP_AUTH_DISABLED = 'smtp_auth_disabled';

export function isSmtpAuthDisabled(err) {
  const smtp = err?.cause ?? err;
  const text = [smtp?.response, smtp?.message, err?.message].filter(s => typeof s === 'string').join(' ');
  return /SmtpClientAuthentication is disabled/i.test(text);
}
