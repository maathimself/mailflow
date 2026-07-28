import nodemailer from 'nodemailer';
import { decrypt as defaultDecrypt } from '../encryption.js';
import { resolveForConnection as defaultResolveForConnection } from '../hostValidation.js';
import { getConnectionPolicy as defaultGetConnectionPolicy } from '../connectionPolicy.js';

function exposedError(message, status) {
  return Object.assign(new Error(message), { status, expose: true });
}

export async function buildSmtpTransport(inputAccount, deps = {}) {
  let account = inputAccount;
  const decrypt = deps.decrypt || defaultDecrypt;
  const getConnectionPolicy = deps.getConnectionPolicy || defaultGetConnectionPolicy;
  const resolveForConnection = deps.resolveForConnection || defaultResolveForConnection;
  const createTransport = deps.createTransport || nodemailer.createTransport.bind(nodemailer);

  if (account.oauth_provider === 'microsoft') {
    // Only refresh when the token is near/at expiry (mirrors imapManager's
    // ensureFreshToken). Refreshing on every send needlessly rotates the AAD
    // refresh token and can invalidate it under concurrent sends.
    const expiryMs = account.oauth_token_expiry ? new Date(account.oauth_token_expiry).getTime() : 0;
    if (expiryMs - Date.now() < 5 * 60 * 1000) {
      account = await deps.refreshMicrosoftToken(account);
    }
  }

  let smtpAuth;
  if ((account.oauth_provider === 'microsoft' || account.oauth_provider === 'google')
      && account.oauth_access_token) {
    const accessToken = decrypt(account.oauth_access_token);
    if (!accessToken) {
      throw exposedError('OAuth access token is corrupted — please reconnect your account.', 502);
    }
    smtpAuth = {
      type: 'OAuth2',
      user: account.auth_user || account.email_address,
      accessToken,
    };
  } else {
    const pass = decrypt(account.auth_pass);
    if (!pass) {
      throw exposedError('SMTP password is corrupted or missing — please re-enter your account password in Settings.', 502);
    }
    smtpAuth = { user: account.auth_user, pass };
  }

  const policy = await getConnectionPolicy();
  const smtpResolved = await resolveForConnection(account.smtp_host, { allowPrivate: policy.allowPrivateHosts });
  const smtpPlain = account.smtp_tls !== 'STARTTLS' && account.smtp_tls !== 'SSL';
  if (!policy.allowInsecureTls && smtpPlain) {
    throw exposedError('Plain-text SMTP is not allowed: admin must enable "Allow insecure TLS"', 403);
  }
  const smtpTls = { rejectUnauthorized: !(policy.allowInsecureTls && account.imap_skip_tls_verify) };
  if (smtpResolved.servername) smtpTls.servername = smtpResolved.servername;
  // For 'SSL': force direct TLS. For 'none': plain with no upgrade.
  // For 'STARTTLS' (or any other/legacy value): fall back to port-based detection
  // so existing accounts stored with the default 'STARTTLS' on port 465 keep working.
  const smtpSecure = account.smtp_tls === 'SSL' || (account.smtp_tls !== 'none' && account.smtp_port === 465);
  const transport = createTransport({
    host: smtpResolved.host,
    port: account.smtp_port,
    secure: smtpSecure,
    ...(account.smtp_tls === 'none' ? { ignoreTLS: true } : {}),
    auth: smtpAuth,
    tls: smtpTls,
  });

  return { transport, account };
}

// Map SMTP/connection errors to user-friendly messages that don't expose server internals.
export function sanitizeSmtpError(err) {
  const msg = err?.message || '';
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|EHOSTUNREACH/i.test(msg)) {
    return 'Could not connect to the mail server. Check your SMTP settings.';
  }
  if (/535|534|530|invalid.?login|authentication.?fail|bad.*credentials|username.*password|password.*username/i.test(msg)) {
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
  return 'Failed to send message. Please try again.';
}
