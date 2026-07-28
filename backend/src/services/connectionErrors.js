// Map IMAP, SMTP, and network connection errors to user-friendly messages that
// do not expose server internals. SMTP categories and messages intentionally
// match sanitizeSmtpError so the connection probe remains consistent with send.
export function sanitizeConnectionError(err) {
  const msg = err?.message || '';
  const code = err?.code || '';
  const responseStatus = err?.responseStatus || '';
  const combined = `${code} ${responseStatus} ${msg}`;

  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|EHOSTUNREACH/i.test(combined)) {
    return 'Could not connect to the mail server. Check your SMTP settings.';
  }
  if (
    err?.authenticationFailed ||
    /AUTHENTICATIONFAILED|535|534|530|invalid.?login|authentication.?fail|bad.*credentials|username.*password|password.*username|login denied/i.test(combined)
  ) {
    return 'Authentication failed. Check your email account credentials.';
  }
  if (/throttl|rate.?limit|too many|4\.2\.|4\.7\.94/i.test(msg)) {
    return 'The mail server is rate limiting sends. Please try again shortly.';
  }
  if (/550|5\.[13]\.|reject|blacklist|spam|not.?accept/i.test(msg)) {
    return 'Message was rejected by the mail server.';
  }
  if (/TLS|SSL|certificate|handshake/i.test(msg)) {
    return 'Secure connection to the mail server failed. Check your TLS settings.';
  }
  if (/connection test timed out/i.test(msg)) {
    return 'Connection test timed out. Check your mail server settings.';
  }
  if (/greeting|capabilit|IMAP4rev/i.test(msg)) {
    return 'Could not establish an IMAP connection. Check your IMAP settings.';
  }
  if (/^(NO|BAD)$/i.test(responseStatus) || /^(NO|BAD)\b/i.test(msg)) {
    return 'The IMAP server rejected the connection. Check your IMAP settings.';
  }
  return 'Failed to send message. Please try again.';
}
