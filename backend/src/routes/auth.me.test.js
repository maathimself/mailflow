import { beforeEach, describe, expect, it, vi } from 'vitest';

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
vi.mock('../services/lastSeen.js', () => ({ touchLastSeen: vi.fn() }));
vi.mock('../services/authEvents.js', () => ({ logAuthEvent: vi.fn() }));
vi.mock('../services/mailer.js', () => ({ sendSystemEmail: vi.fn() }));
vi.mock('./oidc.js', () => ({ buildEndSessionUrl: vi.fn() }));
vi.mock('../services/categorizer.js', () => ({
  invalidateGlobalCategorizationCache: vi.fn(),
}));
vi.mock('../services/redis.js', () => ({ redisClient: {} }));
vi.mock('../services/rateLimiter.js', () => ({
  consume: vi.fn(),
  reset: vi.fn(),
}));

import { query } from '../services/db.js';
import { touchLastSeen } from '../services/lastSeen.js';
import { getMe } from './auth.js';

const reply = () => ({ status: vi.fn().mockReturnThis(), json: vi.fn() });

beforeEach(() => {
  query.mockReset();
  touchLastSeen.mockReset();
});

describe('GET /auth/me', () => {
  it("records the user's activity, since every app start calls it outside requireAuth", async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'user-1', username: 'maria', is_admin: false, totp_enabled: false }] });
    const res = reply();
    await getMe({ session: { userId: 'user-1' } }, res);
    expect(touchLastSeen).toHaveBeenCalledWith('user-1');
    expect(res.json.mock.calls[0][0].user.username).toBe('maria');
  });

  it('records nothing for a session whose user no longer exists', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const res = reply();
    await getMe({ session: { userId: 'gone' } }, res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(touchLastSeen).not.toHaveBeenCalled();
  });
});
