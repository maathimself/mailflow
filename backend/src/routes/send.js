import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { imapManager } from '../index.js';
import { query } from '../services/db.js';
import { redisClient } from '../services/redis.js';
import { sendOrEnqueue } from '../services/sendService.js';
import * as outboxService from '../services/outboxService.js';
import { normalizeUndoWindow } from '../services/outboxService.js';
import { sanitizeSmtpError } from '../services/mail/smtp.js';
import { refreshMicrosoftToken } from './oauth.js';

const router = Router();
router.use(requireAuth);

router.post('/send', async (req, res) => {
  const { accountId, to } = req.body;
  if (!accountId || !to?.length) {
    return res.status(400).json({ error: 'accountId and to required' });
  }
  const requestedUndo = req.body.undoSendSeconds;
  if (
    requestedUndo !== undefined &&
    (
      typeof requestedUndo !== 'number' ||
      !Number.isInteger(requestedUndo) ||
      requestedUndo < 0 ||
      requestedUndo > 120
    )
  ) {
    return res.status(400).json({ error: 'undoSendSeconds must be an integer from 0 to 120' });
  }

  try {
    // Ownership remains at the HTTP boundary. Services only receive this already-scoped row.
    const [accountResult, prefResult] = await Promise.all([
      query('SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2', [
        accountId,
        req.session.userId,
      ]),
      query('SELECT preferences FROM users WHERE id = $1', [req.session.userId]),
    ]);
    if (!accountResult.rows.length) {
      return res.status(404).json({ error: 'Account not found' });
    }

    const preferences = prefResult.rows[0]?.preferences || {};
    const undoSeconds = normalizeUndoWindow(
      requestedUndo,
      preferences.undoSendSeconds,
    );
    const result = await sendOrEnqueue({
      ...req.body,
      userId: req.session.userId,
      account: accountResult.rows[0],
      plaintextEmail: preferences.plaintextEmail === true,
      undoSeconds,
      idempotencyKey: typeof req.headers['x-idempotency-key'] === 'string'
        ? req.headers['x-idempotency-key']
        : null,
    }, {
      query,
      imapManager,
      redisClient,
      refreshMicrosoftToken,
      outboxService,
    });

    if (result.queued) return res.status(202).json(result);

    // Preserve the REST response contract while the service exposes a richer receipt to MCP.
    const response = { ok: true };
    if (result.sentCopySaved === false) response.sentCopySaved = false;
    return res.json(response);
  } catch (err) {
    console.error('Send failed:', err.message);
    const body = { error: err.expose ? err.message : sanitizeSmtpError(err) };
    if (err.code === 'alias_not_found') body.code = err.code;
    return res.status(err.status || 500).json(body);
  }
});

router.post('/outbox/:id/cancel', async (req, res) => {
  try {
    const result = await outboxService.cancel(
      { id: req.params.id, userId: req.session.userId },
      { query },
    );
    if (result.cancelled || result.reason === 'cancelled') return res.json({ ok: true });
    if (result.reason === 'already_sent') {
      return res.status(409).json({ error: 'already_sent' });
    }
    return res.status(404).json({ error: 'not_found' });
  } catch (err) {
    console.error('Outbox cancel failed:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/outbox', async (req, res) => {
  try {
    const pending = await outboxService.listPending(
      { userId: req.session.userId },
      { query },
    );
    return res.json({ pending });
  } catch (err) {
    console.error('Outbox list failed:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
