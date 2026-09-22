import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { getJevStatus, saveJevKey, removeJevKey } from '../services/jev.js';

const router = Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  try {
    res.json(await getJevStatus(req.session.userId));
  } catch {
    res.status(500).json({ error: 'Failed to load Jev status' });
  }
});

router.put('/', async (req, res) => {
  const apiKey = req.body?.apiKey;
  if (typeof apiKey !== 'string' || !apiKey.trim() || apiKey.length > 512 || /[\r\n\0]/.test(apiKey)) {
    return res.status(400).json({ error: 'Invalid Jev API key' });
  }
  try {
    await saveJevKey(req.session.userId, apiKey);
    res.json({ configured: true });
  } catch {
    res.status(500).json({ error: 'Failed to save Jev API key' });
  }
});

router.delete('/', async (req, res) => {
  try {
    await removeJevKey(req.session.userId);
    res.json({ configured: false });
  } catch {
    res.status(500).json({ error: 'Failed to remove Jev API key' });
  }
});

export default router;
