import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { redisClient } from '../services/redis.js';
import { holdSend, cancelSend, getSendStatus } from '../services/sendHold.js';
import {
  UUID_RE, SendError, sanitizeSmtpError, publicSendCode, missingSendFields, validateSendInput,
  resolveIdentity, resolveForwarded, prepareDelivery, deliverAndRecord,
} from '../services/outgoingMail.js';

const router = Router();
router.use(requireAuth);


// What is left of a held send's undo window. The client counts down from this, not from its own
// clock against sendAt, and not from when it sent the request (an upload would eat into it).
const remainingUntil = sendAt => Math.max(0, Date.parse(sendAt) - Date.now());

// The longest an undo window can be. The client asks for its own (10 s by default).
const MAX_UNDO_SECONDS = 30;

router.post('/send', async (req, res) => {
  const { undoSeconds, draft } = req.body;
  const userId = req.session.userId;
  // With an undo window, delivery waits that long on the server (services/sendHold.js).
  // Everything that can fail on the input still runs now, so those errors surface at once.
  const holdMs = Number.isInteger(undoSeconds) && undoSeconds > 0
    ? Math.min(undoSeconds, MAX_UNDO_SECONDS) * 1000
    : 0;
  // The draft this message was written in, deleted once it is delivered (see deleteSentDraft).
  const sentDraft = draft && typeof draft === 'object' && !Array.isArray(draft)
    ? { uid: draft.uid, folder: draft.folder, accountId: draft.accountId }
    : null;
  const missing = missingSendFields(req.body);
  if (missing) return res.status(400).json({ error: missing });

  // Idempotency guard. The client sends a stable X-Idempotency-Key per logical send: a
  // sequential retry after a lost success response returns the cached result, and a
  // concurrent same-key submit is blocked by the reservation set just before delivery
  // (below). Neither can produce a duplicate email.
  const idempotencyKey = typeof req.headers['x-idempotency-key'] === 'string'
    ? req.headers['x-idempotency-key'].slice(0, 128)
    : null;
  const idemKeyRedis = idempotencyKey ? `send_idem:${req.session.userId}:${idempotencyKey}` : null;
  if (idemKeyRedis) {
    let cached;
    try { cached = await redisClient.get(idemKeyRedis); }
    catch { return res.status(503).json({ error: 'Sending is temporarily unavailable. Please try again shortly.' }); }
    if (cached === '__inflight__') return res.status(409).json({ error: 'This message is already being sent.' });
    if (cached) {
      const previous = JSON.parse(cached);
      if (!previous.pending) return res.json(previous);
      // A held send: the answer the first request got, with the time left now. One the server lost
      // in a crash before it started was never delivered, so its key is freed and this request
      // sends anew. One that had started stays answered: it may have gone out.
      const { status } = await getSendStatus(userId, previous.pendingId);
      if (status !== 'lost') return res.json({ ...previous, remainingMs: remainingUntil(previous.sendAt) });
      try { await redisClient.del(idemKeyRedis); }
      catch { return res.status(503).json({ error: 'Sending is temporarily unavailable. Please try again shortly.' }); }
    }
  }

  // Input, identity and forwarded content. Their errors are answered as they are; anything
  // unexpected goes on to the error handler.
  let input, identity, forwarded;
  try {
    input = validateSendInput(req.body);
    identity = await resolveIdentity(userId, input);
    forwarded = await resolveForwarded(userId, input);
  } catch (err) {
    if (err instanceof SendError) return res.status(err.status).json({ error: err.message });
    throw err;
  }

  let reservationAcquired = false;
  try {
    const delivery = await prepareDelivery(input, identity, forwarded);

    // Reserve the idempotency key atomically right before delivery so a concurrent
    // same-key submit cannot also send (the post-send cache alone can't stop concurrent
    // duplicates). Overwritten with the result on success; released in the catch only if
    // delivery never happened, so a genuine retry after a pre-send failure can proceed.
    if (idemKeyRedis) {
      // TTL comfortably above the worst-case send (large attachment over a slow SMTP
      // server) so the in-flight guard cannot lapse while this request is still running.
      let reserved;
      try { reserved = await redisClient.set(idemKeyRedis, '__inflight__', { NX: true, EX: 300 }); }
      catch { return res.status(503).json({ error: 'Sending is temporarily unavailable. Please try again shortly.' }); }
      if (reserved !== 'OK') return res.status(409).json({ error: 'This message is already being sent.' });
      reservationAcquired = true;
    }

    const message = { userId, input, identity, delivery, sentDraft };
    const hooks = {
      // Overwrite the in-flight reservation with the final result so a retry after a lost
      // response returns this instead of re-sending.
      onResult: sendResult => {
        if (idemKeyRedis) redisClient.set(idemKeyRedis, JSON.stringify(sendResult), { EX: 86400 }).catch(() => {});
      },
      // A failure before reservation must not delete a concurrent request's lock.
      onFailure: () => {
        if (idemKeyRedis && reservationAcquired) redisClient.del(idemKeyRedis).catch(() => {});
      },
    };

    if (holdMs) {
      const { id, sendAt } = await holdSend({
        userId,
        delayMs: holdMs,
        run: onDelivered => deliverAndRecord(message, { ...hooks, onDelivered }),
        // An undone send frees its idempotency key, so the reopened message can be sent again.
        onCancel: async () => { if (idemKeyRedis) await redisClient.del(idemKeyRedis); },
      });
      const pendingResult = { ok: true, pending: true, pendingId: id, sendAt, remainingMs: remainingUntil(sendAt) };
      // A retry of this same request (lost response) gets the held send back, not a second one.
      if (idemKeyRedis) redisClient.set(idemKeyRedis, JSON.stringify(pendingResult), { EX: 86400 }).catch(() => {});
      return res.status(202).json(pendingResult);
    }

    res.json(await deliverAndRecord(message, hooks));
  } catch (err) {
    if (err.publicMessage) return res.status(500).json({ error: err.publicMessage, ...(err.publicCode ? { code: err.publicCode } : {}) });
    if (err instanceof SendError) {
      // An SMTP configuration the account cannot send with (prepareDelivery). It comes before the
      // reservation today, but a reservation this request holds must never outlive its answer.
      if (idemKeyRedis && reservationAcquired) redisClient.del(idemKeyRedis).catch(() => {});
      return res.status(err.status).json({ error: err.message });
    }
    console.error('Send failed:', err.message);
    // A failure before reservation must not delete a concurrent request's lock.
    if (idemKeyRedis && reservationAcquired) redisClient.del(idemKeyRedis).catch(() => {});
    res.status(500).json({ error: sanitizeSmtpError(err), ...(publicSendCode(err) ? { code: publicSendCode(err) } : {}) });
  }
});

// Where a held send stands: pending, sending, sent (with the usual send result), failed (with a
// message), cancelled, lost (held when the server stopped, never delivered) or unknown.
router.get('/send/:id', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
  res.json(await getSendStatus(req.session.userId, req.params.id));
});

// Undo: cancels a held send that has not started yet.
router.post('/send/:id/cancel', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
  res.json(await cancelSend(req.session.userId, req.params.id));
});

export default router;
