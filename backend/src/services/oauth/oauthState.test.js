import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'crypto';

// In-memory stand-in for the Redis commands the state store uses.
const store = vi.hoisted(() => new Map());
vi.mock('../redis.js', () => ({
  redisClient: {
    set: vi.fn(async (key, value, opts) => {
      store.set(key, { value, opts });
      return 'OK';
    }),
    getDel: vi.fn(async (key) => {
      const entry = store.get(key);
      store.delete(key);
      return entry ? entry.value : null;
    }),
  },
}));

const { redisClient } = await import('../redis.js');
const { createOAuthState, consumeOAuthState, OAUTH_STATE_TTL_SECONDS } = await import('./oauthState.js');

const base64url = (buf) => buf.toString('base64url');

beforeEach(() => {
  store.clear();
  redisClient.set.mockClear();
  redisClient.getDel.mockClear();
});

describe('OAuth state + PKCE store', () => {
  it('creates a random state and an S256 challenge, keeping the verifier server-side with a 600 s TTL', async () => {
    const a = await createOAuthState({ provider: 'google', userId: 'u1', loginHint: 'x@gmail.com' });
    const b = await createOAuthState({ provider: 'google', userId: 'u1' });

    expect(OAUTH_STATE_TTL_SECONDS).toBe(600);
    expect(a.state).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    expect(a.state).not.toBe(b.state);
    expect(Object.keys(a).sort()).toEqual(['codeChallenge', 'state']);

    const [key, raw, opts] = redisClient.set.mock.calls[0];
    // The raw state is not used as the Redis key.
    expect(key).not.toContain(a.state);
    expect(opts).toEqual({ NX: true, EX: 600 });
    const saved = JSON.parse(raw);
    expect(saved).toEqual({ userId: 'u1', codeVerifier: expect.any(String), loginHint: 'x@gmail.com' });
    expect(saved.codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(a.codeChallenge).toBe(base64url(createHash('sha256').update(saved.codeVerifier).digest()));
    expect(a.codeChallenge).not.toBe(saved.codeVerifier);
  });

  it('consumes a state exactly once', async () => {
    const { state } = await createOAuthState({ provider: 'google', userId: 'u1' });
    const first = await consumeOAuthState({ provider: 'google', state });
    expect(first).toEqual({ userId: 'u1', codeVerifier: expect.any(String), loginHint: null });
    expect(await consumeOAuthState({ provider: 'google', state })).toBeNull();
    expect(redisClient.getDel).toHaveBeenCalledTimes(2);
  });

  it('does not accept a state issued for another provider', async () => {
    const { state } = await createOAuthState({ provider: 'google', userId: 'u1' });
    expect(await consumeOAuthState({ provider: 'microsoft', state })).toBeNull();
  });

  it.each([undefined, '', 'short', 'x'.repeat(500), ['arr'], 'bad chars!!'.repeat(5)])(
    'rejects malformed state %j without touching Redis', async (state) => {
      expect(await consumeOAuthState({ provider: 'google', state })).toBeNull();
      expect(redisClient.getDel).not.toHaveBeenCalled();
    },
  );

  it('treats unparsable stored data as an unknown state', async () => {
    const { state } = await createOAuthState({ provider: 'google', userId: 'u1' });
    const [key] = redisClient.set.mock.calls[0];
    store.set(key, { value: 'not-json' });
    expect(await consumeOAuthState({ provider: 'google', state })).toBeNull();
  });
});
