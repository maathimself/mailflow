import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import {
  completeAccountStage,
  discardAccountStage,
  listStages,
} from '../services/accountService.js';

const router = Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  res.json(await listStages(req.session.userId));
});

router.post('/:id/execute', async (req, res) => {
  try {
    const account = await completeAccountStage({
      stageId: req.params.id,
      userId: req.session.userId,
      credentials: req.body,
    });
    if (!account) return res.status(404).json({ error: 'not found' });
    res.json(account);
  } catch (err) {
    // completeAccountStage throws when defense-in-depth revalidation (host/port)
    // fails on the merged credentials — surface that as a real client error
    // rather than falling through to the generic 500 handler.
    if (!err.expose) throw err;
    res.status(err.status || 400).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  const ok = await discardAccountStage({
    stageId: req.params.id,
    userId: req.session.userId,
  });
  if (!ok) return res.status(404).json({ error: 'not found' });
  res.status(204).end();
});

export default router;
