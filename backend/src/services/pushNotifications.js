import webPush from 'web-push';
import { query } from './db.js';

const vapidPublicKey  = process.env.VAPID_PUBLIC_KEY;
const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;
// subject must be either a mailto: or an https: URL identifying the sender
const vapidSubject =
  process.env.VAPID_SUBJECT ||
  (process.env.APP_URL ? process.env.APP_URL : 'mailto:admin@mailflow.local');

export const pushConfigured = !!(vapidPublicKey && vapidPrivateKey);

if (pushConfigured) {
  webPush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
} else {
  console.log('Push notifications disabled: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY not set.');
}

/**
 * Send a Web Push notification to every subscribed device for a user.
 * Stale subscriptions (410 / 404 from the push service) are pruned automatically.
 * Errors from individual devices never throw — they are logged and skipped so
 * one bad subscription can't block delivery to the rest.
 */
export async function sendPushToUser(userId, payload) {
  if (!pushConfigured) return;

  const result = await query(
    'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1',
    [userId]
  );
  if (result.rows.length === 0) return;

  const body = JSON.stringify(payload);
  const staleIds = [];

  await Promise.allSettled(result.rows.map(async (row) => {
    const subscription = {
      endpoint: row.endpoint,
      keys: { p256dh: row.p256dh, auth: row.auth },
    };
    try {
      await webPush.sendNotification(subscription, body, {
        // TTL: how long (seconds) the push service should retain an undelivered message.
        // 24 hours is reasonable for email notifications — if the device is offline
        // longer than that, the notification is no longer timely.
        TTL: 86400,
      });
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        // Push service has invalidated this subscription — remove it.
        staleIds.push(row.id);
      } else {
        console.warn(`Push send failed for user ${userId} endpoint ${row.endpoint.slice(0, 40)}…:`, err.message);
      }
    }
  }));

  if (staleIds.length > 0) {
    await query('DELETE FROM push_subscriptions WHERE id = ANY($1)', [staleIds])
      .catch(err => console.error('Failed to prune stale push subscriptions:', err.message));
  }
}
