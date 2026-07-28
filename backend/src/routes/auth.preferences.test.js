import { beforeEach, describe, expect, it, vi } from 'vitest';

const { query, updateSyncIntervalForUser } = vi.hoisted(() => ({
  query: vi.fn(),
  updateSyncIntervalForUser: vi.fn(),
}));

vi.mock('../services/db.js', () => ({ query, pool: {} }));
vi.mock('../index.js', () => ({
  imapManager: { updateSyncIntervalForUser },
}));
vi.mock('../services/redis.js', () => ({
  redisClient: { get: vi.fn(), set: vi.fn(), del: vi.fn() },
}));

import authRoutes from './auth.js';

function preferencesHandler() {
  const layer = authRoutes.stack.find(item => (
    item.route?.path === '/preferences' && item.route.methods.patch
  ));
  return layer.route.stack[0].handle;
}

function responseRecorder() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

async function patchPreferences(body) {
  const req = { body, session: { userId: 'user-1' } };
  const res = responseRecorder();
  await preferencesHandler()(req, res);
  return res;
}

describe('PATCH /preferences undoSendSeconds', () => {
  beforeEach(() => {
    query.mockReset();
    query.mockResolvedValue({ rows: [] });
    updateSyncIntervalForUser.mockReset();
  });

  it('stores an allowed undo window in the next SQL bind', async () => {
    const res = await patchPreferences({ undoSendSeconds: 60 });

    expect(res.statusCode).toBe(200);
    const [sql, binds] = query.mock.calls[0];
    expect(sql).toContain(
      "CASE WHEN $38::int IS NOT NULL THEN jsonb_build_object('undoSendSeconds', $38::int)",
    );
    expect(binds).toHaveLength(38);
    expect(binds[37]).toBe('60');
  });

  it('does not store a value outside the supported undo choices', async () => {
    await patchPreferences({ undoSendSeconds: 45 });

    const [, binds] = query.mock.calls[0];
    expect(binds[37]).toBeNull();
  });
});
