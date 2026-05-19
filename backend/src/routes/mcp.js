import { Router } from 'express';
import { randomBytes } from 'crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { requireAuth } from '../middleware/auth.js';
import { query } from '../services/db.js';
import { createMcpServer } from '../mcp/server.js';

export default function mcpRoutes(imapManager) {
  const router = Router();

  // ── API key management (session-authenticated) ─────────────────────────────

  router.use('/key', requireAuth);

  router.get('/key', async (req, res, next) => {
    try {
      const { rows } = await query(
        'SELECT mcp_api_key IS NOT NULL as has_key FROM users WHERE id = $1',
        [req.session.userId]
      );
      res.json({ hasKey: rows[0]?.has_key ?? false });
    } catch (err) { next(err); }
  });

  router.post('/key/generate', async (req, res, next) => {
    try {
      const key = randomBytes(32).toString('hex');
      await query('UPDATE users SET mcp_api_key = $1 WHERE id = $2', [key, req.session.userId]);
      res.json({ key });
    } catch (err) { next(err); }
  });

  router.delete('/key', async (req, res, next) => {
    try {
      await query('UPDATE users SET mcp_api_key = NULL WHERE id = $1', [req.session.userId]);
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  // ── MCP protocol endpoint (Bearer token authenticated) ─────────────────────

  router.all('/stream', async (req, res, next) => {
    try {
      const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
      if (!token) return res.status(401).json({ error: 'Missing API key' });

      const { rows } = await query(
        'SELECT id FROM users WHERE mcp_api_key = $1',
        [token]
      );
      if (!rows.length) return res.status(401).json({ error: 'Invalid API key' });
      const userId = rows[0].id;

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      const server = createMcpServer(userId, imapManager);
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) { next(err); }
  });

  return router;
}
