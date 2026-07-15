import { Router } from 'express';

import { requireAuth } from '../middleware/auth.js';
import {
  getConflict,
  listConflicts,
  resolveConflict,
} from '../services/carddavConflictService.js';

const router = Router();
router.use(requireAuth);

function conflictError(res, error) {
  const status = {
    ERR_CARDDAV_CONFLICT_RESOLUTION: 400,
    ERR_CARDDAV_CONFLICT_NOT_FOUND: 404,
    ERR_CARDDAV_CONFLICT_STALE: 409,
    ERR_CARDDAV_READ_ONLY: 403,
  }[error.code];
  if (status) return res.status(status).json({ error: error.message });
  throw error;
}

router.get('/', async (req, res) => {
  res.json({ conflicts: await listConflicts(req.session.userId) });
});

router.get('/:id', async (req, res) => {
  const conflict = await getConflict(req.session.userId, req.params.id);
  if (!conflict) return res.status(404).json({ error: 'CardDAV conflict not found' });
  res.json(conflict);
});

router.post('/:id/resolve', async (req, res) => {
  try {
    res.json(await resolveConflict(
      req.session.userId,
      req.params.id,
      req.body?.resolution,
    ));
  } catch (error) {
    conflictError(res, error);
  }
});

export default router;
