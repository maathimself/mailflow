/**
 * Multi-channel notification sender.
 * Fires webhooks / Feishu cards / DingTalk / WeCom bots when new mail arrives.
 */
import { query } from './db.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Format a date to "YYYY-MM-DD HH:mm" in local time. */
function formatDate(d) {
  if (!d) return '';
  const date = d instanceof Date ? d : new Date(d);
  if (isNaN(date.getTime())) return '';
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Normalize notification data shared across all channel types.
 * Each builder receives these clean fields and only cares about rendering format.
 */
function normalizePayload(data) {
  const fromEmail = data.fromEmail || '(未知)';
  const subject = data.subject || '(无主题)';
  const bodyContent = data.bodyText || data.snippet || data.body || '';
  const count = data.count || 1;
  const isBatch = count > 1;
  const dateFormatted = formatDate(data.date);
  const toRecipients = data.toRecipients || '';

  return { ...data, fromEmail, subject, bodyContent, count, isBatch, dateFormatted, toRecipients };
}

// ── Message templates per platform ──────────────────────────────────────────

function buildFeishuPayload(raw) {
  const d = normalizePayload(raw);

  // Feishu card limits: title=100, div/lark_md=2000, note/plain_text=500
  const safeTitle = d.subject.length > 95 ? d.subject.slice(0, 95) + '...' : d.subject;
  const safeBody = d.bodyContent.length > 1900
    ? d.bodyContent.slice(0, 1900) + '\n\n...（正文过长，已截断）'
    : d.bodyContent;

  const footerLines = [`发件人：${d.fromEmail}`];
  if (d.toRecipients) footerLines.push(`收件人：${d.toRecipients}`);
  if (d.dateFormatted) footerLines.push(`收件时间：${d.dateFormatted}`);

  if (d.isBatch) {
    return {
      msg_type: 'interactive',
      card: {
        header: { title: { content: `📬 ${d.count} 封新邮件`, tag: 'plain_text' }, template: 'blue' },
        elements: [
          { tag: 'div', text: { content: `您收到了 ${d.count} 封新邮件`, tag: 'lark_md' } },
          { tag: 'hr' },
          { tag: 'note', elements: [{ tag: 'plain_text', content: footerLines.join('\n') }] },
        ],
      },
    };
  }

  return {
    msg_type: 'interactive',
    card: {
      header: { title: { content: `📬 ${safeTitle}`, tag: 'plain_text' }, template: 'blue' },
      elements: [
        { tag: 'div', text: { content: safeBody, tag: 'lark_md' } },
        { tag: 'hr' },
        { tag: 'note', elements: [{ tag: 'plain_text', content: footerLines.join('\n') }] },
      ],
    },
  };
}

function buildWebhookPayload(raw) {
  const d = normalizePayload(raw);
  return {
    event: 'new_mail',
    timestamp: new Date().toISOString(),
    title: d.title || d.fromEmail || 'New mail',
    body: d.body || d.subject || '(no subject)',
    bodyText: d.bodyContent || null,
    fromName: d.fromName || '',
    fromEmail: d.fromEmail,
    subject: d.subject,
    count: d.count,
    snippet: d.snippet || '',
    url: d.url || '',
    unreadCount: d.unreadCount,
    date: d.date || null,
    toRecipients: d.toRecipients,
  };
}

function buildDingTalkPayload(raw) {
  const d = normalizePayload(raw);

  // DingTalk markdown text limit: ~20000 chars
  const safeTitle = d.subject.length > 50 ? d.subject.slice(0, 50) + '...' : d.subject;
  const safeBody = d.bodyContent.length > 19000
    ? d.bodyContent.slice(0, 19000) + '\n\n...（正文过长，已截断）'
    : d.bodyContent;

  const footerLines = [`**发件人：**${d.fromEmail}`];
  if (d.toRecipients) footerLines.push(`**收件人：**${d.toRecipients}`);
  if (d.dateFormatted) footerLines.push(`**收件时间：**${d.dateFormatted}`);

  if (d.isBatch) {
    return {
      msgtype: 'markdown',
      markdown: {
        title: `${d.count} 封新邮件`,
        text: `## 📬 ${d.count} 封新邮件\n\n您收到了 ${d.count} 封新邮件\n\n---\n\n${footerLines.join('\n\n')}`,
      },
    };
  }

  return {
    msgtype: 'markdown',
    markdown: {
      title: safeTitle,
      text: `## 📬 ${safeTitle}\n\n${safeBody}\n\n---\n\n${footerLines.join('\n\n')}`,
    },
  };
}

const PAYLOAD_BUILDERS = {
  feishu: buildFeishuPayload,
  dingtalk: buildDingTalkPayload,
  webhook: buildWebhookPayload,
  wecom: buildWebhookPayload, // WeCom uses standard webhook format
};

// ── Send to a single channel ────────────────────────────────────────────────

async function sendToChannel(channel, data) {
  const builder = PAYLOAD_BUILDERS[channel.type] || buildWebhookPayload;
  const payload = builder(data);
  const body = JSON.stringify(payload);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(channel.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const errorBody = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${errorBody.slice(0, 200)}`);
    }

    // Feishu returns {"code":0,"msg":"success"} on success
    const result = await res.json().catch(() => null);
    if (result && result.code !== undefined && result.code !== 0) {
      throw new Error(`Feishu error code ${result.code}: ${result.msg || 'unknown'}`);
    }

    // DingTalk returns {"errcode":0,"errmsg":"ok"}
    if (result && result.errcode !== undefined && result.errcode !== 0) {
      throw new Error(`DingTalk error code ${result.errcode}: ${result.errmsg || 'unknown'}`);
    }

    return { success: true };
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      throw new Error('Request timed out after 10s');
    }
    throw err;
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Send new-mail notification to all configured channels for a user.
 * Non-blocking — errors are logged but never thrown.
 *
 * @param {string} userId
 * @param {object} data - { title, body, fromName, fromEmail, subject, bodyText, count, url, ... }
 */
export async function sendNotificationsToUser(userId, data) {
  try {
    const result = await query(
      `SELECT id, type, name, url, config
       FROM notification_channels
       WHERE user_id = $1 AND enabled = true`,
      [userId]
    );

    if (result.rows.length === 0) return;

    const dataWithUrl = {
      ...data,
      url: data.url || process.env.APP_URL || '',
    };

    // Fire all channels in parallel, log results
    const outcomes = await Promise.allSettled(
      result.rows.map(channel =>
        sendToChannel(channel, dataWithUrl).catch(err => {
          console.warn(
            `[notify] Channel "${channel.name}" (${channel.type}) failed:`,
            err.message
          );
          throw err; // re-throw so allSettled records it as rejected
        })
      )
    );
  } catch (err) {
    console.error('[notify] Error fetching channels:', err.message);
  }
}

/**
 * Send a test notification to a specific channel URL to verify configuration.
 */
export async function sendTestNotification(type, url) {
  const builder = PAYLOAD_BUILDERS[type] || buildWebhookPayload;
  const testData = {
    title: 'MailFlow Test',
    body: 'This is a test notification from MailFlow.',
    bodyText: 'This is a test notification from MailFlow.',
    fromName: 'MailFlow',
    fromEmail: 'test@mailflow.local',
    subject: 'MailFlow Test Notification',
    snippet: 'This is a test notification from MailFlow.',
    count: 1,
    url: process.env.APP_URL || '',
    date: new Date(),
    toRecipients: 'you@example.com',
  };
  const payload = builder(testData);
  const body = JSON.stringify(payload);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const errorBody = await res.text().catch(() => '');
      return { ok: false, error: `HTTP ${res.status}: ${errorBody.slice(0, 200)}` };
    }

    const result = await res.json().catch(() => null);
    return { ok: true, result };
  } catch (err) {
    clearTimeout(timeout);
    return { ok: false, error: err.message };
  }
}
