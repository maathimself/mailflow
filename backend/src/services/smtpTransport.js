import nodemailer from 'nodemailer';
import { decrypt } from './encryption.js';
import { getConnectionPolicy } from './connectionPolicy.js';
import { resolveForConnection } from './hostValidation.js';
import { ensureFreshOAuthAccount } from './oauth/tokenManager.js';
import { OAUTH_SEND_FAILURES, isOAuthAccount } from './oauth/constants.js';

const SMTP_ATTEMPT_TIMEOUT_MS = 10_000;
const SMTP_FAILOVER_BUDGET_MS = 45_000;

export function isPreDeliveryConnectionError(err) {
  return err?.command === 'CONN';
}

async function runWithAddressFallback({
  resolved,
  transportOptions,
  operation,
  createTransport = nodemailer.createTransport,
  now = Date.now,
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
    const transport = createTransport({
      ...transportOptions,
      host: candidates[i],
      connectionTimeout: attemptTimeout,
      greetingTimeout: attemptTimeout,
    });

    try {
      return await operation(transport);
    } catch (err) {
      lastError = err;
      if (!isPreDeliveryConnectionError(err) || i === candidates.length - 1) throw err;
      console.warn('SMTP connection failed; retrying another validated address:', err.message);
    } finally {
      transport.close?.();
    }
  }

  throw lastError;
}

export function createSmtpTransport(resolved, transportOptions, createTransport = nodemailer.createTransport) {
  return {
    sendMail: mailOptions => runWithAddressFallback({
      resolved,
      transportOptions,
      operation: transport => transport.sendMail(mailOptions),
      createTransport,
    }),
    verify: () => runWithAddressFallback({
      resolved,
      transportOptions,
      operation: transport => transport.verify(),
      createTransport,
    }),
  };
}

// A server rejection of the AUTH exchange. Nodemailer tags it EAUTH with the AUTH command;
// EAUTH with command 'API' is a client-side credential problem that no refresh fixes.
// AUTH runs before MAIL FROM, so a message rejected here was never accepted for delivery.
export function isSmtpAuthRejection(err) {
  return err?.code === 'EAUTH' && /^AUTH\b/i.test(String(err?.command || ''));
}

// Stable, secret-free results for token-manager failures before a transport exists.
function oauthRefreshFailureResult(err) {
  const failure = Object.hasOwn(OAUTH_SEND_FAILURES, err?.code) ? OAUTH_SEND_FAILURES[err.code] : null;
  return failure ? { status: failure.status, code: err.code, error: failure.error } : null;
}

function oauthAuth(account) {
  const accessToken = decrypt(account.oauth_access_token);
  return accessToken ? { type: 'OAuth2', user: account.auth_user || account.email_address, accessToken } : null;
}

// OAuth transport: when the server rejects the token at AUTH (e.g. revoked early or clock
// skew), force one refresh and repeat the operation once with the new token. A failure of
// the forced refresh (including oauth_reconnect_required) propagates as the OAuthTokenError.
function createOAuthSmtpTransport(account, resolved, transportOptions) {
  const run = async (operation) => {
    try {
      return await operation(createSmtpTransport(resolved, transportOptions));
    } catch (err) {
      if (!isSmtpAuthRejection(err)) throw err;
      const refreshed = await ensureFreshOAuthAccount(account, { force: true });
      const auth = oauthAuth(refreshed);
      if (!auth) throw err;
      return await operation(createSmtpTransport(resolved, { ...transportOptions, auth }));
    }
  };
  return {
    sendMail: mailOptions => run(transport => transport.sendMail(mailOptions)),
    verify: () => run(transport => transport.verify()),
  };
}

export async function createAccountSmtpTransport(inputAccount) {
  let account = inputAccount;
  const isOAuth = isOAuthAccount(account);
  if (isOAuth) {
    // Single entry point for every provider: refreshes an expired token (with cross-process
    // dedup) and returns the row whose token the transport must use.
    try {
      account = await ensureFreshOAuthAccount(account);
    } catch (err) {
      const result = oauthRefreshFailureResult(err);
      if (result) return result;
      throw err;
    }
  }

  let auth;
  if (isOAuth && account.oauth_access_token) {
    auth = oauthAuth(account);
    if (!auth) {
      return {
        status: 502,
        error: 'OAuth access token is corrupted — please reconnect your account.',
      };
    }
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
  const resolved = await resolveForConnection(account.smtp_host, {
    allowPrivate: policy.allowPrivateHosts,
  });
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
  const transportOptions = {
    port: account.smtp_port,
    secure,
    ...(account.smtp_tls === 'none' ? { ignoreTLS: true } : {}),
    auth,
    tls,
  };
  const transport = isOAuth
    ? createOAuthSmtpTransport(account, resolved, transportOptions)
    : createSmtpTransport(resolved, transportOptions);
  return { account, transport };
}
