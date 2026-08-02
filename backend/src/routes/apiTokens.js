import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { ALL_SCOPES, expandScopes, generateToken, hashToken } from '../mcp/auth.js';

const router = Router();
router.use(requireAuth);

router.post('/', async (req, res) => {
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name is required' });
  const requestedScopes = Array.isArray(req.body?.scopes) && req.body.scopes.length
    ? req.body.scopes
    : ['read'];
  const unknownScopes = requestedScopes.filter((scope) => !ALL_SCOPES.includes(scope));
  if (unknownScopes.length) {
    return res.status(400).json({ error: `unknown scope(s): ${unknownScopes.join(', ')}` });
  }
  const scopes = expandScopes(requestedScopes);
  const token = generateToken();
  const { rows } = await query(
    'INSERT INTO api_tokens (user_id, token_hash, name, scopes) VALUES ($1, $2, $3, $4) RETURNING id, name, scopes',
    [req.session.userId, hashToken(token), name, scopes],
  );
  // Plaintext returned exactly once; only the hash was persisted.
  res.status(201).json({
    id: rows[0].id,
    name: rows[0].name,
    scopes: rows[0].scopes,
    token,
  });
});

router.get('/', async (req, res) => {
  const { rows } = await query(
    'SELECT id, name, scopes, created_at, last_used_at FROM api_tokens WHERE user_id = $1 ORDER BY created_at DESC',
    [req.session.userId],
  );
  res.json({ tokens: rows });
});

router.delete('/:id', async (req, res) => {
  const { rowCount } = await query(
    'DELETE FROM api_tokens WHERE id = $1 AND user_id = $2',
    [req.params.id, req.session.userId],
  );
  if (!rowCount) return res.status(404).json({ error: 'not found' });
  res.status(204).end();
});

export default router;
