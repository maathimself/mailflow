import nodemailer from 'nodemailer';
import { query } from './db.js';
import { decrypt } from './encryption.js';
import { resolveForConnection } from './hostValidation.js';

export async function sendSystemEmail({ to, subject, text, html }) {
  const sysResult = await query(
    "SELECT value FROM system_settings WHERE key = 'system_email_config'"
  );
  if (!sysResult.rows.length) throw new Error('System email is not configured');
  const cfg = JSON.parse(sysResult.rows[0].value);
  const pass = cfg.pass ? decrypt(cfg.pass) : null;
  if (!cfg.host || !cfg.user || !pass) throw new Error('System email is not configured');
  const resolved = await resolveForConnection(cfg.host);
  const tls = { rejectUnauthorized: true };
  if (resolved.servername) tls.servername = resolved.servername;
  const transport = nodemailer.createTransport({
    host: resolved.host,
    port: cfg.port || 587,
    secure: (cfg.port || 587) === 465,
    auth: { user: cfg.user, pass },
    tls,
  });
  const from = `${cfg.fromName || 'MailFlow'} <${cfg.fromEmail || cfg.user}>`;
  await transport.sendMail({ from, to, subject, text, html });
}
