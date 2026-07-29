import nodemailer from 'nodemailer';
import { refreshMicrosoftToken } from '../routes/oauth.js';
import { decrypt } from './encryption.js';
import { getConnectionPolicy } from './connectionPolicy.js';
import { resolveForConnection } from './hostValidation.js';

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

export async function createAccountSmtpTransport(inputAccount) {
  let account = inputAccount;
  if (account.oauth_provider === 'microsoft') {
    const expiryMs = account.oauth_token_expiry
      ? new Date(account.oauth_token_expiry).getTime()
      : 0;
    if (expiryMs - Date.now() < 5 * 60 * 1000) {
      account = await refreshMicrosoftToken(account);
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
    const pass = decrypt(account.auth_pass);
    if (!pass) {
      return {
        status: 502,
        error: 'SMTP password is corrupted or missing — please re-enter your account password in Settings.',
      };
    }
    auth = { user: account.auth_user, pass };
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
  const transport = createSmtpTransport(resolved, {
    port: account.smtp_port,
    secure,
    ...(account.smtp_tls === 'none' ? { ignoreTLS: true } : {}),
    auth,
    tls,
  });
  return { account, transport };
}
