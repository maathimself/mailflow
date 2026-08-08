import { Router } from 'express';
import { requireAdmin } from '../middleware/auth.js';
import { listJobs } from '../services/backgroundJobs.js';

const router = Router();

// GET /api/admin/indexing/status — admin-gated (same guard as routes/ai.js).
// Surfaces every background drainer's progress, e.g. "FTS backfill: N/M".
router.get('/status', requireAdmin, async (_req, res) => {
  res.json({ jobs: await listJobs() });
});

export default router;
