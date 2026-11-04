import { Router } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { getWebhook, saveWebhook, webhookAdminSettings, saveWebhookAdminSettings, notifyWebhook } from '../services/webhooks.js';

const router = Router();
router.use((req, res, next) => req.apiToken ? res.status(403).json({ error: 'Session authentication required' }) : next());
router.use(requireAuth);
const handle = fn => async (req, res) => {
  try { await fn(req, res); }
  catch (err) { res.status(err.status === 400 || err.status === 403 ? err.status : 500).json({ error: err.status === 400 || err.status === 403 ? err.message : 'Unable to update webhook settings' }); }
};
router.get('/admin', requireAdmin, handle(async (_req, res) => res.json(await webhookAdminSettings())));
router.put('/admin', requireAdmin, handle(async (req, res) => res.json(await saveWebhookAdminSettings(req.body))));
router.get('/', handle(async (req, res) => res.json(await getWebhook(req.session.userId))));
router.put('/', handle(async (req, res) => res.json(await saveWebhook(req.session.userId, req.body))));
router.post('/test', handle(async (req, res) => {
  const result = await notifyWebhook({ userId: req.session.userId, accountName: 'MailFlow test', count: 1,
    latest: { fromName: 'Test sender', subject: 'Test notification' } });
  res.status(result.sent ? 200 : result.skipped === 'rate_limit' ? 429 : result.skipped === 'disabled' ? 403 : 502).json(result);
}));
export default router;
