import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { logAuthEvent } from '../services/authEvents.js';
import { uuidParam } from '../utils/uuid.js';
import {
  apiTokensEnabled, countTokens, createToken, deleteToken, expiryDate, listTokens, MAX_TOKENS_PER_USER,
  normalizeIp, normalizeScopes, normalizeTokenName, TOKENS_OFF_ERROR,
} from '../services/apiTokens.js';
import { confirmReauth, expiryChoicesFor, oidcConfirmationState, reauthFor } from '../services/apiTokenReauth.js';

// Personal API tokens (#617): Settings → Security lists, creates and revokes them with the browser
// session. A token itself can only ask who it is.
const router = Router();

router.get('/self', (req, res) => {
  // 401 rather than 404, so a client can tell a token that never arrived (a proxy that drops the
  // Authorization header) from a server without token support.
  if (!req.apiToken) return res.status(401).json({ error: 'This endpoint needs an API token' });
  const { id, name, scopes, createdAt, expiresAt, username } = req.apiToken;
  res.json({ id, name, scopes, createdAt, expiresAt, username });
});

// The allowlist keeps tokens off everything below; this keeps them off if it ever does not.
router.use((req, res, next) => {
  if (req.apiToken) return res.status(403).json({ error: 'This API token cannot be used for this request' });
  next();
});
router.use(requireAuth);
router.param('id', uuidParam('id'));

const loadUser = async userId => (await query(
  'SELECT id, username, password_hash, totp_enabled, totp_secret FROM users WHERE id = $1',
  [userId]
)).rows[0];

router.get('/', async (req, res) => {
  const user = await loadUser(req.session.userId);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  const reauth = await reauthFor(user);
  res.json({
    enabled: await apiTokensEnabled(),
    reauth,
    ...(reauth === 'oidc' ? { oidc: await oidcConfirmationState(req, user) } : {}),
    expiryChoices: expiryChoicesFor(reauth),
    maxTokens: MAX_TOKENS_PER_USER,
    tokens: await listTokens(user.id),
  });
});

const describeExpiry = days => `Choose an expiry of ${days.slice(0, -1).join(', ')} or ${days.at(-1)} days`;

router.post('/', async (req, res) => {
  if (!(await apiTokensEnabled())) return res.status(403).json({ error: TOKENS_OFF_ERROR });
  const user = await loadUser(req.session.userId);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  const { name: rawName, scopes: rawScopes, expiresInDays } = req.body ?? {};

  const { name, error: nameError } = normalizeTokenName(rawName);
  if (nameError) return res.status(400).json({ error: nameError });
  const scopes = normalizeScopes(rawScopes);
  if (!scopes) return res.status(400).json({ error: 'Choose at least one scope: read, organize or draft' });
  const reauth = await reauthFor(user);
  const choices = expiryChoicesFor(reauth);
  if (!choices.includes(expiresInDays)) return res.status(400).json({ error: describeExpiry(choices) });
  const limitReached = { error: `You already have ${MAX_TOKENS_PER_USER} API tokens. Revoke one to create another.` };
  // Checked again when the token is stored; this answers before a two-factor code is spent.
  if (await countTokens(user.id) >= MAX_TOKENS_PER_USER) return res.status(400).json(limitReached);

  const { refusal, confirmedWith, oidcProviderId } = await confirmReauth(req, user, reauth);
  if (refusal) return res.status(refusal.status).set(refusal.headers ?? {}).json(refusal.body);

  const created = await createToken(user.id, {
    name, scopes, expiresAt: expiryDate(expiresInDays), confirmedWith, oidcProviderId,
  });
  if (!created) return res.status(400).json(limitReached);
  const { apiToken } = created;
  logAuthEvent('api_token_created', { userId: user.id, username: user.username, ip: normalizeIp(req.ip), success: true });
  console.log(`[apiToken] ${user.username} created token ${JSON.stringify(apiToken.name)} (${apiToken.id}) scopes=${apiToken.scopes.join(',')} expires=${new Date(apiToken.expiresAt).toISOString()} confirmed=${confirmedWith}`);
  res.status(201).json(created);
});

router.delete('/:id', async (req, res) => {
  const name = await deleteToken(req.session.userId, req.params.id);
  if (name === null) return res.status(404).json({ error: 'API token not found' });
  const userResult = await query('SELECT username FROM users WHERE id = $1', [req.session.userId]);
  const username = userResult.rows[0]?.username ?? req.session.username ?? null;
  logAuthEvent('api_token_revoked', { userId: req.session.userId, username, ip: normalizeIp(req.ip), success: true });
  console.log(`[apiToken] ${username} revoked token ${JSON.stringify(name)} (${req.params.id})`);
  res.json({ ok: true });
});

export default router;
