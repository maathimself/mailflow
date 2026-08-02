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

describe('PATCH /auth/preferences undoSendSeconds', () => {
  it('stores an allowed undo window after the existing preference binds', async () => {
    const req = { session: { userId: 'user-1' }, body: { undoSendSeconds: 60 } };
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await patchPreferences(req, res);

    const [sql, binds] = query.mock.calls[0];
    expect(sql).toContain(
      "CASE WHEN $41::int IS NOT NULL THEN jsonb_build_object('undoSendSeconds', $41::int)",
    );
    expect(binds).toHaveLength(41);
    expect(binds[40]).toBe('60');
  });

  it('does not store a value outside the supported undo choices', async () => {
    const req = { session: { userId: 'user-1' }, body: { undoSendSeconds: 45 } };
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await patchPreferences(req, res);

    const [, binds] = query.mock.calls[0];
    expect(binds[40]).toBeNull();
  });
});
