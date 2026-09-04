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
import { patchPreferences } from './auth.js';

beforeEach(() => {
  query.mockReset().mockResolvedValue({ rows: [] });
});

describe('PATCH /auth/preferences folderOrder', () => {
  it('merges folderOrder into existing preferences as JSONB', async () => {
    const folderOrder = { 'account-1': ['Archive', 'INBOX'] };
    const req = { session: { userId: 'user-1' }, body: { folderOrder } };
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };

    await patchPreferences(req, res);

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('SET preferences = preferences');
    expect(sql).toContain(
      "jsonb_build_object('folderOrder', $39::jsonb)",
    );
    expect(params[0]).toBe('user-1');
    expect(params[38]).toBe(JSON.stringify(folderOrder));
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });
});

describe('PATCH /auth/preferences senderFavicons', () => {
  it('merges the senderFavicons boolean into preferences as JSONB', async () => {
    const req = { session: { userId: 'user-1' }, body: { senderFavicons: true } };
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };

    await patchPreferences(req, res);

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain(
      "jsonb_build_object('senderFavicons', $40::boolean)",
    );
    expect(params[0]).toBe('user-1');
    expect(params[39]).toBe(true);
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });

  it('rejects a non-boolean senderFavicons without querying', async () => {
    const req = { session: { userId: 'user-1' }, body: { senderFavicons: 'yes' } };
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };

    await patchPreferences(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'senderFavicons must be a boolean' });
    expect(query).not.toHaveBeenCalled();
  });
});

describe('PATCH /auth/preferences defaultSender (#417)', () => {
  const run = async (body) => {
    const req = { session: { userId: 'user-1' }, body };
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await patchPreferences(req, res);
    return res;
  };
  const A = '11111111-1111-4111-8111-111111111111';
  const B = '22222222-2222-4222-8222-222222222222';

  it('persists an account default', async () => {
    const res = await run({ defaultSender: `account:${A}` });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("jsonb_build_object('defaultSender', $42::text)");
    expect(params[41]).toBe(`account:${A}`);
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });

  it('persists an alias default, so an identity can be the default and not just an account', async () => {
    await run({ defaultSender: `alias:${A}:${B}` });
    expect(query.mock.calls[0][1][41]).toBe(`alias:${A}:${B}`);
  });

  it('persists an empty string, which is how the preference is cleared', async () => {
    // '' is meaningful: it means "no preference, fall back to last used". It must be
    // written rather than treated as an absent key, or clearing would silently no-op.
    await run({ defaultSender: '' });
    expect(query.mock.calls[0][1][41]).toBe('');
  });

  it('leaves the stored value untouched when the key is absent', async () => {
    await run({ theme: 'dark' });
    expect(query.mock.calls[0][1][41]).toBe(null);
  });

  it('rejects malformed values instead of storing something unusable', async () => {
    for (const bad of ['account:not-a-uuid', 'alias:only-one', `alias:${A}`, 'nonsense',
                       `ACCOUNT:${A}`, 42, {}, [], `account:${A} extra`]) {
      query.mockClear();
      const res = await run({ defaultSender: bad });
      expect(res.status, `${JSON.stringify(bad)} should be rejected`).toHaveBeenCalledWith(400);
      expect(query).not.toHaveBeenCalled();
    }
  });
});
