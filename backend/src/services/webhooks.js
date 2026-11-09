import { query } from './db.js';
import { encrypt, decrypt, isEncrypted } from './encryption.js';
import { consume } from './rateLimiter.js';
import { safeFetch } from './safeFetch.js';
import { webhookText } from './webhookText.js';

const formats = ['generic', 'ntfy', 'gotify'];
const bad = message => Object.assign(new Error(message), { status: 400 });
const encryptSecret = value => {
  const result = encrypt(value);
  if (!isEncrypted(result)) throw new Error('Credential encryption unavailable');
  return result;
};
const own = (o, key) => Object.prototype.hasOwnProperty.call(o, key);

export function parseWebhookUrl(value) {
  if (typeof value !== 'string' || value.length > 4096 || (/\s/.test(value) || [...value].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127))) throw bad('Invalid webhook URL');
  let url;
  try { url = new URL(value); } catch { throw bad('Invalid webhook URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw bad('Use an HTTP(S) URL without credentials or a fragment');
  return url;
}

export function validateAdminSettings(input) {
  if (!input || typeof input.enabled !== 'boolean' || !Array.isArray(input.allowedOrigins) || input.allowedOrigins.length > 100) throw bad('Invalid webhook administration settings');
  const allowedOrigins = input.allowedOrigins.map(value => {
    const url = parseWebhookUrl(value);
    if (url.pathname !== '/' || url.search) throw bad('Allowed destinations must be origins without a path or query');
    return url.origin;
  });
  return { enabled: input.enabled, allowedOrigins: [...new Set(allowedOrigins)] };
}

export async function webhookAdminSettings() {
  const { rows } = await query("SELECT value FROM system_settings WHERE key = 'notification_webhooks'");
  try { return validateAdminSettings(JSON.parse(rows[0]?.value)); }
  catch { return { enabled: false, allowedOrigins: [] }; }
}

export async function saveWebhookAdminSettings(input) {
  const settings = validateAdminSettings(input);
  await query(`INSERT INTO system_settings (key, value, updated_at) VALUES ('notification_webhooks', $1, NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [JSON.stringify(settings)]);
  return settings;
}

export function publicWebhook(row, available) {
  return { available, enabled: row?.enabled ?? false, format: row?.format || 'generic',
    urlConfigured: !!row?.url, tokenConfigured: !!row?.token,
    includeSender: row?.include_sender ?? false, includeSubject: row?.include_subject ?? false,
    failures: row?.failures ?? 0, lastError: row?.last_error || null };
}

export async function getWebhook(userId) {
  const [config, result] = await Promise.all([webhookAdminSettings(), query('SELECT * FROM notification_webhooks WHERE user_id = $1', [userId])]);
  return publicWebhook(result.rows[0], config.enabled);
}

export async function removeWebhook(userId) {
  await query('DELETE FROM notification_webhooks WHERE user_id = $1', [userId]);
}

export async function saveWebhook(userId, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad('Invalid webhook settings');
  for (const key of Object.keys(input)) if (!['enabled', 'format', 'url', 'token', 'includeSender', 'includeSubject'].includes(key)) throw bad('Unknown webhook setting');
  for (const key of ['enabled', 'includeSender', 'includeSubject']) if (own(input, key) && typeof input[key] !== 'boolean') throw bad('Invalid webhook setting');
  if (own(input, 'format') && !formats.includes(input.format)) throw bad('Invalid webhook format');
  const admin = await webhookAdminSettings();
  if (!admin.enabled && input.enabled) throw Object.assign(new Error('Webhooks are disabled by the administrator'), { status: 403 });
  const existing = (await query('SELECT * FROM notification_webhooks WHERE user_id = $1', [userId])).rows[0];
  const format = input.format ?? existing?.format ?? 'generic';
  if (format === 'generic' && input.token) throw bad('Tokens are only supported by the ntfy and Gotify presets');
  let url;
  let originChanged = false;
  if (own(input, 'url')) {
    const parsed = parseWebhookUrl(input.url);
    if (parsed.protocol !== 'https:' && !admin.allowedOrigins.includes(parsed.origin)) throw bad('Public webhook URLs must use HTTPS');
    if (existing?.url) {
      try { originChanged = parseWebhookUrl(decrypt(existing.url)).origin !== parsed.origin; }
      catch { originChanged = true; }
    }
    url = encryptSecret(parsed.href);
  }
  if (input.enabled && !url) {
    if (!existing?.url) throw bad('Configure a webhook URL before enabling notifications');
  }
  if (own(input, 'token') && (typeof input.token !== 'string' || input.token.length > 4096 || /[^\x21-\x7e]/.test(input.token))) throw bad('Invalid webhook token');
  const result = await query(`INSERT INTO notification_webhooks (user_id, enabled, format, url, token, include_sender, include_subject)
    VALUES ($1, COALESCE($2,false), COALESCE($3,'generic'), $4, $5, COALESCE($6,false), COALESCE($7,false))
    ON CONFLICT (user_id) DO UPDATE SET
      enabled = COALESCE($2, notification_webhooks.enabled), format = COALESCE($3, notification_webhooks.format),
      url = COALESCE($4, notification_webhooks.url),
      token = CASE WHEN COALESCE($3, notification_webhooks.format) = 'generic' THEN NULL WHEN $8 THEN $5 WHEN $9 OR notification_webhooks.url IS DISTINCT FROM $10 THEN NULL ELSE notification_webhooks.token END,
      include_sender = COALESCE($6, notification_webhooks.include_sender), include_subject = COALESCE($7, notification_webhooks.include_subject),
      failures = CASE WHEN $2 = true THEN 0 ELSE notification_webhooks.failures END,
      last_error = CASE WHEN $2 = true THEN NULL ELSE notification_webhooks.last_error END,
      revision = gen_random_uuid()
    RETURNING *`, [userId, input.enabled ?? null, input.format ?? null, url ?? null,
    own(input, 'token') && input.token ? encryptSecret(input.token) : null, input.includeSender ?? null, input.includeSubject ?? null, own(input, 'token'), originChanged, existing?.url ?? null]);
  return publicWebhook(result.rows[0], admin.enabled);
}

export function webhookRequest(row, { accountName, count, latest = {} }) {
  const payload = { account: String(accountName || 'MailFlow').slice(0, 200), count };
  if (row.include_sender) payload.sender = String(latest.fromName || latest.fromEmail || '').slice(0, 500);
  if (row.include_subject) payload.subject = String(latest.subject || '').slice(0, 1000);
  const token = row.token ? decrypt(row.token) : null;
  if (row.token && !token) throw new Error('Invalid stored credential');
  const headers = { 'Content-Type': 'application/json' };
  const { title, message } = webhookText(row.language, payload);
  if (row.format === 'ntfy') {
    headers['Content-Type'] = 'text/plain; charset=utf-8';
    // ntfy decodes RFC 2047; ASCII encoding keeps Unicode titles valid HTTP headers.
    headers.Title = `=?UTF-8?B?${Buffer.from(title).toString('base64')}?=`;
    if (token) headers.Authorization = `Bearer ${token}`;
    return { method: 'POST', headers, body: message };
  }
  if (row.format === 'gotify') {
    if (token) headers['X-Gotify-Key'] = token;
    return { method: 'POST', headers, body: JSON.stringify({ title, message, priority: 5 }) };
  }
  return { method: 'POST', headers, body: JSON.stringify(payload) };
}

// Database admission cannot be cancelled. If it times out, stop admitting more
// work until it settles, rather than accumulating pending requests.
let stalledAdmissions = 0;
function admitWebhook(userId, timeout) {
  return new Promise(resolve => {
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      stalledAdmissions++;
      resolve(null);
    }, timeout);
    const settle = value => {
      if (expired) stalledAdmissions--;
      else { clearTimeout(timer); resolve(value); }
    };
    Promise.resolve().then(() => consume(`webhook:rate:${userId}`, 10, 60_000)).then(result => !result.limited)
      .then(settle, () => settle(null));
  });
}

export async function notifyWebhook({ userId, accountName, count, latest }) {
  const admin = await webhookAdminSettings();
  if (!admin.enabled) return { skipped: 'disabled' };
  const { rows } = await query(`SELECT w.*, u.preferences->>'language' AS language
    FROM notification_webhooks w JOIN users u ON u.id = w.user_id WHERE w.user_id = $1`, [userId]);
  const row = rows[0];
  if (!row?.enabled || !row.url) return { skipped: 'disabled' };
  if (stalledAdmissions) return { skipped: 'unavailable' };
  const deadline = Date.now() + 5000;
  const admitted = await admitWebhook(userId, 5000);
  if (admitted === null || Date.now() >= deadline) return { skipped: 'unavailable' };
  if (!admitted) return { skipped: 'rate_limit' };
  let error = null;
  try {
    const url = parseWebhookUrl(decrypt(row.url));
    const allowed = admin.allowedOrigins.includes(url.origin);
    const response = await safeFetch(url.href, {
      ...webhookRequest(row, { accountName, count, latest }), redirect: 'error', signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    }, { allowPrivate: false, allowPrivateNetworks: allowed, requireHttps: !allowed, blockReserved: true, requirePublicHttps: true });
    // No response content is needed. Cancel it rather than retaining an unbounded or slow body.
    void response.body?.cancel().catch(() => {});
    if (!response.ok) error = `Endpoint returned HTTP ${response.status}`;
  } catch (err) {
    const code = err?.code || err?.cause?.code;
    error = err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'Delivery timed out' :
      ['ERR_BLOCKED_PRIVATE_IP', 'ERR_INSECURE_TRANSPORT', 'ERR_UNSUPPORTED_SCHEME'].includes(code)
        ? 'Destination blocked by network policy' : 'Delivery failed';
  }
  // Completion order determines consecutive failures. Atomic updates prevent lost increments;
  // revision guards keep an old in-flight delivery from disabling a newly saved endpoint.
  await query(`UPDATE notification_webhooks SET
    failures = CASE WHEN $3::text IS NULL THEN 0 ELSE failures + 1 END,
    last_error = $3,
    enabled = CASE WHEN $3::text IS NOT NULL AND failures + 1 >= 5 THEN false ELSE enabled END
    WHERE user_id = $1 AND revision = $2 AND enabled = true`, [userId, row.revision, error]);
  return error ? { error } : { sent: true };
}
