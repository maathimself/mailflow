import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { query } from '../services/db.js';
import { consume } from '../services/rateLimiter.js';
import { getSenderFavicon, normalizeSenderDomain } from '../services/senderFavicon.js';

function setPrivateNoStore(res) {
  res.set('Cache-Control', 'private, no-store');
}

export function createSenderFaviconHandler({
  queryFn = query,
  consumeFn = consume,
  getFavicon = getSenderFavicon,
  normalizeDomain = normalizeSenderDomain,
} = {}) {
  return async function senderFaviconHandler(req, res) {
    setPrivateNoStore(res);
    const userId = req.session.userId;
    const result = await queryFn('SELECT preferences FROM users WHERE id = $1', [userId]);
    const preferences = result.rows[0]?.preferences || {};
    if (preferences.senderFavicons === false) return res.status(404).end();

    const domain = normalizeDomain(req.params.domain);
    if (!domain) return res.status(400).end();

    const limit = await consumeFn(`sender-favicon:${userId}`, 300, 60_000);
    if (limit.limited) {
      res.set('Retry-After', String(Math.max(1, Math.ceil(limit.resetMs / 1000))));
      return res.status(429).end();
    }

    const favicon = await getFavicon(domain);
    if (favicon.kind !== 'image') return res.status(404).end();
    res.set('Content-Type', 'image/png');
    res.set('Content-Length', String(favicon.bytes.length));
    return res.send(favicon.bytes);
  };
}

const router = Router();
router.use((_req, res, next) => {
  setPrivateNoStore(res);
  next();
});
router.use(requireAuth);
router.get('/:domain', createSenderFaviconHandler());
export default router;
