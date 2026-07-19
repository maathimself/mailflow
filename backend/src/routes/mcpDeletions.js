import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { executeDeletionBatch, unstageDeletionBatch } from '../mcp/engineAdapter.js';

// Session-authenticated execute/unstage endpoints for MCP deletion batches. The
// stage_deletion tool only RECORDS a batch; flipping messages.is_deleted (Mailflow's
// soft delete) happens here, behind a browser session, never from the token. Both
// operations are scoped to req.session.userId, so a user cannot execute/cancel
// another user's batch.
const router = Router();
router.use(requireAuth);

router.post('/:id/execute', async (req, res) => {
  const n = await executeDeletionBatch(req.params.id, req.session.userId);
  if (n === null) return res.status(404).json({ error: 'not found' });
  res.json({ batch_id: req.params.id, status: 'executed', deleted: n });
});

router.delete('/:id', async (req, res) => {
  const ok = await unstageDeletionBatch(req.params.id, req.session.userId);
  if (!ok) return res.status(404).json({ error: 'not found' });
  res.status(204).end();
});

export default router;
