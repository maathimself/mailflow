import nodemailer from 'nodemailer';
import { refreshMicrosoftToken, refreshGoogleToken } from '../routes/oauth.js';
import { decrypt } from './encryption.js';
import { getConnectionPolicy } from './connectionPolicy.js';
import { resolveForConnection } from './hostValidation.js';

const SMTP_ATTEMPT_TIMEOUT_MS = 10_000;
const SMTP_FAILOVER_BUDGET_MS = 45_000;

// EHLO/HELO client identity (#492). nodemailer's default is os.hostname(), and when that
// is not an FQDN — every Docker container with a default hostname — it sends
// `EHLO [127.0.0.1]` instead. cPanel/Exim logs that literally ("Sender Host: 127.0.0.1",
// verified in the reporter's Track Delivery screenshot next to their real Sender IP), and
// spam routers like Bluehost's treat a loopback HELO from a remote address as a forgery
// signal and discard the mail. Identify as the instance's public hostname instead:
// SMTP_EHLO_NAME wins when set, otherwise APP_URL's hostname when it is a real FQDN,
// otherwise nodemailer's default stands. Pure; exported for tests.
export function smtpClientName(env = process.env) {
  const explicit = (env.SMTP_EHLO_NAME || '').trim();
  if (explicit) return explicit;
  try {
    const host = new URL(env.APP_URL).hostname;
    // A bare IP as EHLO carries the same spam signal the fallback does; only a dotted
    // name that is not an IPv4 literal improves on nodemailer's default.
    if (host && host.includes('.') && !/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host;
  } catch { /* APP_URL unset or unparseable — keep nodemailer's default */ }
  return undefined;
}

export function isPreDeliveryConnectionError(err) {
  return err?.command === 'CONN';
}

// How far one SMTP attempt got, read from the client commands and server replies nodemailer
// logs: whether MAIL FROM went out (a transaction began), and whether the server accepted DATA,
// after which nodemailer streams the body. nodemailer takes any 2xx or 3xx reply to DATA as that
// acceptance (some servers answer 250, not 354), so the body counts as started at that reply, not
// at the DATA command: with PIPELINING (Gmail, Outlook, Postfix) DATA is written together with the
// envelope, before any reply, and a server cannot take a body it never asked for.
//
// From MAIL FROM on, each command written (MAIL, every RCPT, DATA, QUIT) is queued, and each
// server reply answers the oldest one, which holds with and without PIPELINING since replies come
// in command order. Anything that does not fit (a reply with no command waiting before the body
// started, another command such as RSET) makes the matching unreliable, and then the body counts
// as started as soon as DATA was written: such an attempt ends uncertain, never retried.
//
// Only those two facts are kept; nothing else of the log is looked at or stored. nodemailer
// reports a socket error or timeout at any stage as command 'CONN', even after the body (#685),
// so this is what tells a connection that never reached the transaction from one that did.
export function createStageTracker() {
  const stage = { mailFromSent: false, bodyStarted: false };
  const waiting = [];
  let dataWritten = false;
  let unreliable = false;
  const giveUp = () => {
    unreliable = true;
    if (dataWritten) stage.bodyStarted = true;
  };
  const client = command => {
    if (!stage.mailFromSent) {
      if (command.startsWith('MAIL FROM:')) {
        stage.mailFromSent = true;
        waiting.push('MAIL');
      }
      return;
    }
    if (command.startsWith('RCPT TO:')) waiting.push('RCPT');
    else if (command === 'QUIT') waiting.push('QUIT');
    else if (command === 'DATA') {
      waiting.push('DATA');
      dataWritten = true;
      if (unreliable) stage.bodyStarted = true;
    } else giveUp();
  };
  const server = reply => {
    if (!stage.mailFromSent) return;
    const answered = waiting.shift();
    // After the body started, the reply to its end has no command of its own.
    if (!answered) {
      if (!stage.bodyStarted) giveUp();
      return;
    }
    if (answered === 'DATA' && /^[23]/.test(reply)) stage.bodyStarted = true;
  };
  const note = (entry, message) => {
    if (typeof message !== 'string') return;
    if (entry?.tnx === 'client') client(message);
    else if (entry?.tnx === 'server') server(message);
  };
  const logger = { trace() {}, debug: note, info() {}, warn() {}, error() {}, fatal() {} };
  return { stage, transportOptions: { logger, transactionLog: true } };
}

// Every attempt, whatever the caller, records how far it got (createStageTracker), and the next
// address is tried only when the failed attempt never sent MAIL FROM: a connection lost later may
// have delivered the message already (#685). `trackStage` changes none of that; it only copies the
// stage onto a failed send as err.smtpStage.
async function runWithAddressFallback({
  resolved,
  transportOptions,
  operation,
  createTransport = nodemailer.createTransport,
  now = Date.now,
  trackStage = false,
}) {
  const candidates = [...new Set(
    resolved.addresses?.length ? resolved.addresses : [resolved.host]
  )];
  const startedAt = now();
  let lastError;

  for (let i = 0; i < candidates.length; i++) {
    const remaining = SMTP_FAILOVER_BUDGET_MS - (now() - startedAt);
    if (remaining < 2000 && lastError) throw lastError;
    const attemptTimeout = Math.max(1000, Math.min(SMTP_ATTEMPT_TIMEOUT_MS, Math.floor(remaining / 2)));
    const tracker = createStageTracker();
    const transport = createTransport({
      // Before the spread so an explicit transportOptions.name would still win.
      name: smtpClientName(),
      ...transportOptions,
      ...tracker.transportOptions,
      host: candidates[i],
      connectionTimeout: attemptTimeout,
      greetingTimeout: attemptTimeout,
    });

    try {
      return await operation(transport);
    } catch (err) {
      lastError = err;
      if (trackStage && err && typeof err === 'object') err.smtpStage = { ...tracker.stage };
      const failOver = isPreDeliveryConnectionError(err) && !tracker.stage.mailFromSent;
      if (!failOver || i === candidates.length - 1) throw err;
      console.warn('SMTP connection failed; retrying another validated address:', err.message);
    } finally {
      transport.close?.();
    }
  }

  throw lastError;
}

export function createSmtpTransport(resolved, transportOptions, createTransport = nodemailer.createTransport, { trackStage = false } = {}) {
  return {
    sendMail: mailOptions => runWithAddressFallback({
      resolved,
      transportOptions,
      operation: transport => transport.sendMail(mailOptions),
      createTransport,
      trackStage,
    }),
    verify: () => runWithAddressFallback({
      resolved,
      transportOptions,
      operation: transport => transport.verify(),
      createTransport,
    }),
  };
}

// Failover is gated on MAIL FROM for every send (runWithAddressFallback). `trackStage`, which
// scheduled send passes, only adds err.smtpStage to a failed send.
export async function createAccountSmtpTransport(inputAccount, { trackStage = false } = {}) {
  let account = inputAccount;
  const refreshers = { microsoft: refreshMicrosoftToken, google: refreshGoogleToken };
  const refresh = refreshers[account.oauth_provider];
  if (refresh) {
    const expiryMs = account.oauth_token_expiry
      ? new Date(account.oauth_token_expiry).getTime()
      : 0;
    if (expiryMs - Date.now() < 5 * 60 * 1000) {
      account = await refresh(account);
    }
  }

  let auth;
  if (
    (account.oauth_provider === 'microsoft' || account.oauth_provider === 'google')
    && account.oauth_access_token
  ) {
    const accessToken = decrypt(account.oauth_access_token);
    if (!accessToken) {
      return {
        status: 502,
        error: 'OAuth access token is corrupted — please reconnect your account.',
      };
    }
    auth = {
      type: 'OAuth2',
      user: account.auth_user || account.email_address,
      accessToken,
    };
  } else {
    // Separate SMTP credentials (issue #353): if the account has its own SMTP
    // username/password, use them; otherwise fall back to the IMAP login. Each
    // side falls back independently, so a different-username/same-password (or the
    // reverse) config also works. Empty/NULL columns are falsy and fall through.
    const pass = decrypt(account.smtp_auth_pass || account.auth_pass);
    if (!pass) {
      return {
        status: 502,
        error: 'SMTP password is corrupted or missing — please re-enter your account password in Settings.',
      };
    }
    auth = { user: account.smtp_auth_user || account.auth_user, pass };
  }

  const policy = await getConnectionPolicy();
  // A refusal here is the connection policy's (a private or reserved address), which no retry
  // changes, so it is marked for the scheduled sender to tell from a passing failure.
  const resolved = await resolveForConnection(account.smtp_host, {
    allowPrivate: policy.allowPrivateHosts,
  }).catch(err => { throw Object.assign(err, { hostRefused: true }); });
  const plain = account.smtp_tls !== 'STARTTLS' && account.smtp_tls !== 'SSL';
  if (!policy.allowInsecureTls && plain) {
    return {
      status: 403,
      error: 'Plain-text SMTP is not allowed: admin must enable "Allow insecure TLS"',
    };
  }

  const tls = {
    rejectUnauthorized: !(policy.allowInsecureTls && account.imap_skip_tls_verify),
  };
  if (resolved.servername) tls.servername = resolved.servername;
  const secure = account.smtp_tls === 'SSL'
    || (account.smtp_tls !== 'none' && account.smtp_port === 465);
  const transport = createSmtpTransport(resolved, {
    port: account.smtp_port,
    secure,
    ...(account.smtp_tls === 'none' ? { ignoreTLS: true } : {}),
    // nodemailer only upgrades when EHLO advertises STARTTLS, so a server that leaves it
    // out, or anyone on the path who strips it, would get AUTH and the message in
    // cleartext. Fail instead, unless the admin allows insecure connections.
    requireTLS: !secure && !policy.allowInsecureTls,
    auth,
    tls,
  }, undefined, { trackStage });
  return { account, transport };
}
