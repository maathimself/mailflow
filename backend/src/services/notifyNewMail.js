import { newMailPushPayload } from './inboxRules.js';
import { query } from './db.js';
import { sendPushToUser } from './pushNotifications.js';
import { notifyWebhook } from './webhooks.js';

// Called only for alert-eligible INBOX arrivals. Delivery never blocks mail sync.
export function notifyNewMail({ userId, accountName, alertMessages, alertCount }) {
  const latest = alertMessages[alertMessages.length - 1];
  // Each channel starts independently; webhook failures must never delay Web Push.
  notifyWebhook({ userId, accountName, count: alertCount, latest })
    .catch(() => console.warn('Webhook notification unavailable'));
  const basePayload = newMailPushPayload(alertMessages, alertCount);
  // Try to include the total unread count for the home screen badge.
  // If the query fails for any reason, send the push without it so
  // notifications are never silently dropped.
  query(
    `SELECT COUNT(*)::int AS total FROM messages m
     JOIN email_accounts a ON a.id = m.account_id
     WHERE a.user_id = $1 AND a.enabled = true AND m.folder = 'INBOX' AND m.is_read = false AND m.is_deleted = false`,
    [userId]
  ).then(r => {
    sendPushToUser(userId, { ...basePayload, unreadCount: r.rows[0]?.total ?? 0 })
      .catch(err => console.warn('Push notification error:', err.message));
  }).catch(() => {
    sendPushToUser(userId, basePayload)
      .catch(err => console.warn('Push notification error:', err.message));
  });
}
