import { query } from './db.js';
import { decrypt } from './encryption.js';
import { resolveForConnection } from './hostValidation.js';
import { createSmtpTransport } from './smtpTransport.js';
import { getConnectionPolicy } from './connectionPolicy.js';

// No system email to send with: a permanent condition, unlike a send that fails. The second
// sign-in step tells them apart (services/secondFactor.js).
export class SystemEmailNotConfigured extends Error {
  constructor() { super('System email is not configured'); this.name = 'SystemEmailNotConfigured'; }
}

export async function sendSystemEmail({ to, subject, text, html }) {
  const sysResult = await query(
    "SELECT value FROM system_settings WHERE key = 'system_email_config'"
  );
  if (!sysResult.rows.length) throw new SystemEmailNotConfigured();
  const cfg = JSON.parse(sysResult.rows[0].value);
  const pass = cfg.pass ? decrypt(cfg.pass) : null;
  if (!cfg.host || !cfg.user || !pass) throw new SystemEmailNotConfigured();
  // Honor the "Allow private / local hosts" policy so a self-hosted System Email relay on a
  // private IP can send verification/2FA codes and invites (#358); off by default.
  const policy = await getConnectionPolicy();
  const resolved = await resolveForConnection(cfg.host, { allowPrivate: policy.allowPrivateHosts });
  const tls = { rejectUnauthorized: true };
  if (resolved.servername) tls.servername = resolved.servername;
  const transport = createSmtpTransport(resolved, {
    port: cfg.port || 587,
    secure: (cfg.port || 587) === 465,
    auth: { user: cfg.user, pass },
    tls,
  });
  const from = `${cfg.fromName || 'MailFlow'} <${cfg.fromEmail || cfg.user}>`;
  await transport.sendMail({ from, to, subject, text, html });
}
