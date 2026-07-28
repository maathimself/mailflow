import nodemailer from 'nodemailer';

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
