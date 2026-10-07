import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn(), pool: {} }));
vi.mock('../index.js', () => ({ imapManager: { disconnectUser: vi.fn(), closeSockets: vi.fn() } }));
vi.mock('../services/encryption.js', () => ({
  decrypt: value => value,
  encrypt: value => value,
}));
vi.mock('../services/pushNotifications.js', () => ({ pushConfigured: true }));
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
vi.mock('./oidc.js', () => ({ buildEndSessionUrl: vi.fn(async () => null) }));
vi.mock('../services/categorizer.js', () => ({
  invalidateGlobalCategorizationCache: vi.fn(),
}));
vi.mock('../services/redis.js', () => ({ redisClient: {} }));
vi.mock('../services/rateLimiter.js', () => ({
  consume: vi.fn(),
  reset: vi.fn(),
}));

import express from 'express';
import authRoutes from './auth.js';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';

const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/device-a';

describe('POST /api/auth/logout: push subscription of the signing-out browser', () => {
  let srv, base, sessionUserId, destroyed;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.session = { userId: sessionUserId, destroy: (cb) => { destroyed = true; cb(); } };
      next();
    });
    app.use('/api/auth', authRoutes);
    await new Promise(r => { srv = app.listen(0, r); });
    base = `http://127.0.0.1:${srv.address().port}`;
  });
  afterAll(async () => { await new Promise(r => srv.close(r)); });
  beforeEach(() => {
    sessionUserId = 'user-a';
    destroyed = false;
    query.mockReset().mockResolvedValue({ rows: [] });
    imapManager.disconnectUser.mockReset();
  });

  const logout = async (body) => {
    const init = { method: 'POST' };
    if (body !== undefined) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    const res = await fetch(`${base}/api/auth/logout`, init);
    return { status: res.status, json: await res.json() };
  };
  const pushStatements = () => query.mock.calls
    .filter(([sql]) => sql.includes('push_subscriptions'))
    .map(([sql, params]) => [sql.replace(/\s+/g, ' ').trim(), params]);

  it('deletes the subscription for the endpoint the browser names, for the session user only', async () => {
    // A userId in the body must not choose whose row goes.
    const res = await logout({ pushEndpoint: ENDPOINT, userId: 'user-b' });

    expect(pushStatements()).toEqual([
      ['DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2', ['user-a', ENDPOINT]],
    ]);
    expect(res).toEqual({ status: 200, json: { ok: true, endSessionUrl: null } });
    expect(destroyed).toBe(true);
    expect(imapManager.disconnectUser).toHaveBeenCalledWith('user-a');
  });

  it('still signs out when the delete fails', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    query.mockRejectedValue(new Error('connection terminated'));
    try {
      const res = await logout({ pushEndpoint: ENDPOINT });

      expect(res).toEqual({ status: 200, json: { ok: true, endSessionUrl: null } });
      expect(destroyed).toBe(true);
      await vi.waitFor(() => expect(errors).toHaveBeenCalledWith(
        'logout: failed to delete push subscription:', 'connection terminated',
      ));
    } finally {
      errors.mockRestore();
    }
  });

  it('touches no subscription when the browser names no usable endpoint', async () => {
    // Older clients send no body at all.
    for (const body of [undefined, {}, { pushEndpoint: '' }, { pushEndpoint: ['x'] }, { pushEndpoint: { endpoint: ENDPOINT } }]) {
      const res = await logout(body);
      expect(res.json).toEqual({ ok: true, endSessionUrl: null });
    }
    expect(pushStatements()).toEqual([]);
  });

  it('touches no subscription when there is no signed-in user', async () => {
    sessionUserId = undefined;
    const res = await logout({ pushEndpoint: ENDPOINT });

    expect(res.json).toEqual({ ok: true, endSessionUrl: null });
    expect(pushStatements()).toEqual([]);
    expect(imapManager.disconnectUser).not.toHaveBeenCalled();
  });
});
