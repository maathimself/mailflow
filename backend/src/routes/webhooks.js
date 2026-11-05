import { Router } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { getWebhook, removeWebhook, saveWebhook, webhookAdminSettings, saveWebhookAdminSettings, notifyWebhook } from '../services/webhooks.js';
import { query } from '../services/db.js';

const router = Router();
router.use((req, res, next) => req.apiToken ? res.status(403).json({ error: 'Session authentication required' }) : next());
router.use(requireAuth);
const handle = fn => async (req, res) => {
  try { await fn(req, res); }
  catch (err) { res.status(err.status === 400 || err.status === 403 ? err.status : 500).json({ error: err.status === 400 || err.status === 403 ? err.message : 'Unable to update webhook settings' }); }
};
// Check current privileges server-side for both immediate and stored failures.
async function visibleResult(req, result) {
  const blocked = 'Destination blocked by network policy';
  if (result.error !== blocked && result.lastError !== blocked) return result;
  const { rows } = await query('SELECT is_admin FROM users WHERE id = $1', [req.session.userId]);
  if (rows[0]?.is_admin) return result;
  return { ...result, ...(result.error === blocked ? { error: 'Delivery failed' } : {}),
    ...(result.lastError === blocked ? { lastError: 'Delivery failed' } : {}) };
}
router.get('/admin', requireAdmin, handle(async (_req, res) => res.json(await webhookAdminSettings())));
router.put('/admin', requireAdmin, handle(async (req, res) => res.json(await saveWebhookAdminSettings(req.body))));
router.get('/', handle(async (req, res) => res.json(await visibleResult(req, await getWebhook(req.session.userId)))));
router.put('/', handle(async (req, res) => res.json(await visibleResult(req, await saveWebhook(req.session.userId, req.body)))));
router.delete('/', handle(async (req, res) => { await removeWebhook(req.session.userId); res.sendStatus(204); }));
router.post('/test', handle(async (req, res) => {
  const result = await notifyWebhook({ userId: req.session.userId, accountName: 'MailFlow test', count: 1,
    latest: { fromName: 'Test sender', subject: 'Test notification' } });
  res.status(result.sent ? 200 : result.skipped === 'rate_limit' ? 429 : result.skipped === 'disabled' ? 403 : 502).json(await visibleResult(req, result));
}));
export default router;
