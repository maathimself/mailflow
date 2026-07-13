import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import express from 'express';

vi.mock('../index.js', () => ({
  imapManager: { updateSyncIntervalForUser: vi.fn() },
}));
vi.mock('../services/db.js', () => ({
  query: vi.fn(),
  pool: { connect: vi.fn() },
}));

const { query } = await import('../services/db.js');
const { default: authRouter } = await import('./auth.js');

let server;
let baseUrl;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { userId: 7 };
    next();
  });
  app.use('/api/auth', authRouter);
  server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
});

beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue({ rows: [] });
});

async function patchPreferences(body) {
  return fetch(`${baseUrl}/api/auth/preferences`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('PATCH /api/auth/preferences senderFavicons', () => {
  it.each([true, false])('persists the boolean value %s as parameter 31', async senderFavicons => {
    const res = await patchPreferences({ senderFavicons });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, parameters] = query.mock.calls[0];
    expect(sql).toContain("jsonb_build_object('senderFavicons', $31::boolean)");
    expect(parameters).toHaveLength(31);
    expect(parameters[30]).toBe(senderFavicons);
  });

  it.each([null, 'true', 1, {}, []])('rejects the non-boolean value %j without querying', async senderFavicons => {
    const res = await patchPreferences({ senderFavicons });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'senderFavicons must be a boolean' });
    expect(query).not.toHaveBeenCalled();
  });

  it('passes null as parameter 31 when the key is omitted, so the merge leaves the stored value untouched', async () => {
    const res = await patchPreferences({ theme: 'dark' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, parameters] = query.mock.calls[0];
    const normalizedSql = sql.replace(/\s+/g, ' ');
    expect(normalizedSql).toContain(
      "CASE WHEN $31::boolean IS NOT NULL THEN jsonb_build_object('senderFavicons', $31::boolean) ELSE '{}'::jsonb END"
    );
    expect(parameters).toHaveLength(31);
    expect(parameters[30]).toBeNull();
  });
});
