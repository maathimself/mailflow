import { withTransaction as defaultWithTransaction } from './db.js';
import { deleteDraft as defaultDeleteDraft } from './draftService.js';
import { sendMessage as defaultSendMessage } from './sendService.js';
import { sanitizeSmtpError } from './mail/smtp.js';

export const MAX_UNDO_SECONDS = 120;
export const UNDO_CHOICES = [0, 10, 30, 60, 120];

export function normalizeUndoWindow(requested, preference) {
  const raw = requested ?? preference ?? 0;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.min(Math.trunc(seconds), MAX_UNDO_SECONDS);
}

export async function enqueue({
  userId,
  accountId,
  payload,
  undoSeconds,
  idempotencyKey,
  subject,
  toPreview,
  messageId,
}, deps) {
  const storedPayload = { ...payload, account_id: accountId };
  const result = await deps.query(
    `INSERT INTO outbox_messages
       (user_id, account_id, payload, send_at, subject, to_preview, message_id, idempotency_key)
     VALUES ($1, $2, $3, NOW() + ($4 * INTERVAL '1 second'), $5, $6, $7, $8)
     ON CONFLICT (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL
     DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
     RETURNING id, send_at`,
    [
      userId,
      accountId,
      storedPayload,
      undoSeconds,
      subject,
      toPreview,
      messageId,
      idempotencyKey || null,
    ],
  );
  return {
    outbox_id: result.rows[0].id,
    send_at: result.rows[0].send_at,
    undo_seconds: undoSeconds,
  };
}

export async function cancel({ id, userId }, deps = {}) {
  const withTransaction = deps.withTransaction || defaultWithTransaction;
  return withTransaction(async (client) => {
    const cancelled = await client.query(
      `UPDATE outbox_messages
          SET status='cancelled', payload='{}'::jsonb, updated_at=NOW()
        WHERE id=$1 AND user_id=$2 AND status='pending'
      RETURNING id`,
      [id, userId],
    );
    if (cancelled.rows.length) return { cancelled: true };

    const existing = await client.query(
      'SELECT status FROM outbox_messages WHERE id=$1 AND user_id=$2',
      [id, userId],
    );
    if (!existing.rows.length) return { cancelled: false, reason: 'not_found' };
    if (existing.rows[0].status === 'cancelled') {
      return { cancelled: false, reason: 'cancelled' };
    }
    if (existing.rows[0].status === 'sent' || existing.rows[0].status === 'claimed') {
      return { cancelled: false, reason: 'already_sent' };
    }
    return { cancelled: false, reason: 'not_found' };
  });
}

export async function listPending({ userId }, deps) {
  const result = await deps.query(
    `SELECT id, subject, to_preview, send_at
       FROM outbox_messages
      WHERE user_id=$1 AND status='pending'
      ORDER BY send_at`,
    [userId],
  );
  return result.rows;
}

export async function claimDue({ limit = 50 } = {}, deps = {}) {
  const withTransaction = deps.withTransaction || defaultWithTransaction;
  return withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE outbox_messages o
          SET status='claimed', claimed_at=NOW(), attempts=attempts+1, updated_at=NOW()
         FROM (SELECT id FROM outbox_messages
                WHERE status='pending' AND send_at <= NOW()
                ORDER BY send_at
                FOR UPDATE SKIP LOCKED
                LIMIT $1) d
        WHERE o.id = d.id
      RETURNING o.*`,
      [limit],
    );
    return result.rows;
  });
}

export async function markSent(id, sentMessageId, deps) {
  const result = await deps.query(
    `UPDATE outbox_messages
        SET status='sent', payload='{}'::jsonb, sent_message_id=$2,
            error=NULL, updated_at=NOW()
      WHERE id=$1 AND status='claimed'`,
    [id, sentMessageId],
  );
  return result.rowCount;
}

export async function markFailed(id, error, deps) {
  const result = await deps.query(
    `UPDATE outbox_messages
        SET status='failed', payload='{}'::jsonb, error=$2, updated_at=NOW()
      WHERE id=$1 AND status='claimed'`,
    [id, error],
  );
  return result.rowCount;
}

export async function sweepStaleClaims(deps) {
  const result = await deps.query(
    `UPDATE outbox_messages
        SET status='failed', payload='{}'::jsonb,
            error='delivery interrupted — the send was not retried; check your Sent folder',
            updated_at=NOW()
      WHERE status='claimed' AND claimed_at < NOW() - INTERVAL '5 minutes'`,
  );
  return result.rowCount;
}

export async function purgeTerminalRows(deps) {
  const result = await deps.query(
    `DELETE FROM outbox_messages
      WHERE status IN ('sent','cancelled','failed')
        AND updated_at < NOW() - INTERVAL '7 days'`,
  );
  return result.rowCount;
}

export function startOutboxWorker(deps, { tickMs = 5000 } = {}) {
  let running = false;
  let tickCount = 0;
  let stopped = false;
  const deliver = deps.sendMessage || defaultSendMessage;

  sweepStaleClaims(deps)
    .catch(err => console.error('Outbox stale-claim sweep error:', err.message));

  const timer = setInterval(() => {
    if (running || stopped) return;
    running = true;
    tickCount += 1;

    (async () => {
      if (tickCount % 12 === 0) await sweepStaleClaims(deps);
      if (tickCount % 720 === 0) await purgeTerminalRows(deps);

      const rows = await claimDue({ limit: 50 }, deps);
      for (const row of rows) {
        try {
          const accountResult = await deps.query(
            'SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2',
            [row.account_id, row.user_id],
          );
          if (!accountResult.rows.length) throw new Error('Account not found');
          const account = accountResult.rows[0];

          const result = await deliver({
            ...row.payload,
            userId: row.user_id,
            account,
            account_id: row.account_id,
            messageId: row.message_id,
          }, deps);
          await markSent(row.id, result.messageId || row.message_id, deps);
          const draft = row.payload?.deleteDraftOnSend;
          if (draft) {
            try {
              let draftAccount = account;
              if (draft.accountId && draft.accountId !== account.id) {
                const sourceAccountResult = await deps.query(
                  'SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2',
                  [draft.accountId, row.user_id],
                );
                if (!sourceAccountResult.rows.length) {
                  throw new Error('Source draft account not found');
                }
                draftAccount = sourceAccountResult.rows[0];
              }
              const deleteDraft = deps.draftService?.deleteDraft || defaultDeleteDraft;
              await deleteDraft({
                account: draftAccount,
                uid: draft.uid,
                folder: draft.folder,
              }, deps);
            } catch (err) {
              console.error('Outbox draft cleanup error:', err.message);
            }
          }
        } catch (err) {
          await markFailed(row.id, sanitizeSmtpError(err), deps);
        }
      }
    })()
      .catch(err => console.error('Outbox worker error:', err.message))
      .finally(() => { running = false; });
  }, tickMs);
  timer.unref?.();

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
  };
}
