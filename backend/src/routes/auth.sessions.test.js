import { beforeEach, describe, expect, it, vi } from 'vitest';

// Password reset revokes sessions by scanning the Redis session store.

vi.mock('../services/db.js', () => ({ query: vi.fn(), pool: {} }));
vi.mock('../index.js', () => ({
  imapManager: {
    updateSyncIntervalForUser: vi.fn(),
    updateFolderSyncIntervalForUser: vi.fn(),
  },
}));
vi.mock('../services/encryption.js', () => ({
  decrypt: value => value,
  encrypt: value => value,
}));
vi.mock('../services/pushNotifications.js', () => ({ pushConfigured: false }));
vi.mock('../services/hostValidation.js', () => ({
  validateHost: vi.fn(),
  resolveForConnection: vi.fn(),
}));
vi.mock('../services/connectionPolicy.js', () => ({
  getConnectionPolicy: vi.fn(),
}));
vi.mock('../services/authLimiter.js', () => ({
  authLimiterConfig: { maxRequests: 10, windowMs: 900000 },
}));
vi.mock('../services/authEvents.js', () => ({ logAuthEvent: vi.fn() }));
vi.mock('../services/mailer.js', () => ({ sendSystemEmail: vi.fn() }));
vi.mock('./oidc.js', () => ({ buildEndSessionUrl: vi.fn() }));
vi.mock('../services/categorizer.js', () => ({
  invalidateGlobalCategorizationCache: vi.fn(),
}));
vi.mock('../services/redis.js', () => ({
  redisClient: { scan: vi.fn(), get: vi.fn(), del: vi.fn() },
}));
vi.mock('../services/rateLimiter.js', () => ({
  consume: vi.fn(),
  reset: vi.fn(),
}));

import { redisClient } from '../services/redis.js';
import { destroyUserSessions } from './auth.js';

beforeEach(() => {
  redisClient.scan.mockReset();
  redisClient.get.mockReset();
  redisClient.del.mockReset().mockResolvedValue(1);
});

describe('destroyUserSessions', () => {
  it('walks the string SCAN cursor of the redis client and stops at "0"', async () => {
    const sessions = {
      'sess:a': JSON.stringify({ userId: 'user-1' }),
      'sess:b': JSON.stringify({ userId: 'user-2' }),
      'sess:c': JSON.stringify({ userId: 'user-1' }),
    };
    redisClient.scan
      .mockResolvedValueOnce({ cursor: '17', keys: ['sess:a', 'sess:b'] })
      .mockResolvedValueOnce({ cursor: '0', keys: ['sess:c'] });
    redisClient.get.mockImplementation(async key => sessions[key] ?? null);

    await destroyUserSessions('user-1');

    expect(redisClient.scan).toHaveBeenCalledTimes(2);
    expect(redisClient.scan.mock.calls[0]).toEqual(['0', { MATCH: 'sess:*', COUNT: 200 }]);
    expect(redisClient.scan.mock.calls[1]).toEqual(['17', { MATCH: 'sess:*', COUNT: 200 }]);
    expect(redisClient.del.mock.calls).toEqual([['sess:a'], ['sess:c']]);
  });

  it('terminates after a single empty page', async () => {
    redisClient.scan.mockResolvedValue({ cursor: '0', keys: [] });

    await destroyUserSessions('user-1');

    expect(redisClient.scan).toHaveBeenCalledTimes(1);
    expect(redisClient.del).not.toHaveBeenCalled();
  });
});
