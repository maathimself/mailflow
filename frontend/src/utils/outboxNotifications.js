import { handleComposeRequest } from './composeRequest.js';

function timestamp(value) {
  if (typeof value === 'number') return value;
  return new Date(value).getTime();
}

export function secondsUntil(countdownUntil, now = Date.now()) {
  const remainingMs = timestamp(countdownUntil) - now;
  if (!Number.isFinite(remainingMs)) return 0;
  return Math.max(0, Math.ceil(remainingMs / 1000));
}

export function notificationDurationMs(notification, now = Date.now()) {
  if (Number.isFinite(notification.durationMs)) {
    return Math.max(0, notification.durationMs);
  }
  if (notification.countdownUntil != null) {
    const remainingMs = timestamp(notification.countdownUntil) - now;
    return Number.isFinite(remainingMs) ? Math.max(0, remainingMs) : 0;
  }
  return notification.onUndo ? 6000 : 5000;
}

export function createOutboxNotification({
  entry,
  capturedPayload,
  cancelOutbox,
  openCompose,
  addNotification,
  t,
  now = Date.now(),
}) {
  const outboxId = entry.outboxId ?? entry.id;
  const countdownUntil = entry.sendAt ?? entry.send_at;
  const body = entry.subject || t('common.noSubject');

  return {
    persistent: true,
    durationMs: notificationDurationMs({ countdownUntil }, now),
    title: t('compose.sending.title'),
    body,
    countdownUntil,
    onUndo: async () => {
      try {
        await cancelOutbox(outboxId);
        if (capturedPayload) {
          await handleComposeRequest(() => openCompose(capturedPayload), { addNotification, t });
        }
      } catch (error) {
        if (error?.status !== 409) throw error;
        addNotification({
          type: 'error',
          title: t('compose.sending.tooLate'),
          body,
        });
      }
    },
  };
}
