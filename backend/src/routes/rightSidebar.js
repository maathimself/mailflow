import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { getRightSidebarSections } from '../services/rightSidebarSections.js';

const router = Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.use(requireAuth);

router.get('/sections', async (req, res) => {
  const { accountId, limit } = req.query;
  if (accountId && !UUID_RE.test(accountId)) {
    return res.status(400).json({ error: 'Invalid account id' });
  }
  res.json(await getRightSidebarSections({
    userId: req.session.userId,
    accountId: accountId || null,
    limit,
  }));
});

export default router;
