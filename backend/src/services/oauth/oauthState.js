import { createHash, randomBytes } from 'crypto';
import { redisClient } from '../redis.js';

export const OAUTH_STATE_TTL_SECONDS = 600;

// 32 random bytes encode to 43 base64url characters; anything else was not issued here.
const STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

// Key by a hash of the state so the raw value (which travels through the browser and
// the provider) is never used directly as a Redis key.
function stateKey(provider, state) {
  const digest = createHash('sha256').update(state).digest('hex');
  return `oauth:state:${provider}:${digest}`;
}

// Create a single-use state plus a PKCE S256 pair. The verifier stays in Redis; only
// the state and the challenge leave the server.
export async function createOAuthState({ provider, userId, loginHint = null }) {
  const state = randomBytes(32).toString('base64url');
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');

  await redisClient.set(
    stateKey(provider, state),
    JSON.stringify({ userId, codeVerifier, loginHint: loginHint || null }),
    { NX: true, EX: OAUTH_STATE_TTL_SECONDS },
  );
  return { state, codeChallenge };
}

// Atomically fetch and delete the pending flow. Returns null for missing, malformed,
// expired or already used states.
export async function consumeOAuthState({ provider, state }) {
  if (typeof state !== 'string' || !STATE_PATTERN.test(state)) return null;
  const raw = await redisClient.getDel(stateKey(provider, state));
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data.userId !== 'string' || typeof data.codeVerifier !== 'string') return null;
    return { userId: data.userId, codeVerifier: data.codeVerifier, loginHint: data.loginHint || null };
  } catch {
    return null;
  }
}
