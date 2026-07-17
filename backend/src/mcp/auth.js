import crypto from 'crypto';
import { query } from '../services/db.js';

// Plaintext tokens are shown once at mint time; we persist only the hash.
export function generateToken() {
  return 'mcp_' + crypto.randomBytes(32).toString('base64url');
}

export function hashToken(plaintext) {
  return crypto.createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

// The scope object pins multi-user isolation: every MCP tool call is bounded to
// exactly this user's enabled accounts. msgvault is single-archive; Mailflow is not.
export async function resolveScope(userId) {
  const { rows } = await query(
    'SELECT id FROM email_accounts WHERE user_id = $1 AND enabled = true',
    [userId],
  );
  return { userId, accountIds: rows.map((r) => r.id) };
}

export async function mcpBearerAuth(req, res, next) {
  try {
    const header = req.get('Authorization') || '';
    const m = /^Bearer\s+(.+)$/i.exec(header);
    if (!m) return res.status(401).json({ error: 'invalid_token' });

    const { rows } = await query(
      'SELECT id, user_id FROM api_tokens WHERE token_hash = $1',
      [hashToken(m[1].trim())],
    );
    if (!rows.length) return res.status(401).json({ error: 'invalid_token' });

    // Best-effort recency stamp; never block the request on it.
    await query('UPDATE api_tokens SET last_used_at = NOW() WHERE id = $1', [rows[0].id])
      .catch(() => {});

    req.mcpTokenId = rows[0].id; // rate-limit key: per token, not per IP
    req.mcpScope = await resolveScope(rows[0].user_id);
    next();
  } catch (err) {
    next(err);
  }
}
