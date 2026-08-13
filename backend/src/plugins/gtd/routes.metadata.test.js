import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';

vi.mock('../../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'u1' }; next(); },
}));
vi.mock('./gtdConfig.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, getGtdConfig: vi.fn() };
});

import express from 'express';
import { query } from '../../services/db.js';
import { getGtdConfig, DEFAULT_GTD_FOLDERS } from './gtdConfig.js';
import gtdRoutes from './routes.js';

const ACCOUNT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const M1 = '11111111-1111-4111-8111-111111111111';
const M2 = '22222222-2222-4222-8222-222222222222';
let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/gtd', gtdRoutes);
  await new Promise(resolve => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => new Promise(resolve => server.close(resolve)));

beforeEach(() => {
  query.mockReset();
  getGtdConfig.mockReset();
  getGtdConfig.mockResolvedValue({ enabled: true, folders: DEFAULT_GTD_FOLDERS });
  query.mockImplementation(async sql => {
    if (sql.startsWith('SELECT * FROM email_accounts')) return { rows: [{ id: ACCOUNT, user_id: 'u1' }] };
    if (sql.includes('FROM messages target')) return { rows: [
      { message_id: M1, folder: 'Watch', date: new Date('2026-07-01T00:00:00.000Z') },
      { message_id: M1, folder: 'Todo', date: new Date('2026-08-01T00:00:00.000Z') },
      { message_id: M2, folder: 'Reference', date: null },
    ] };
    return { rows: [] };
  });
});

const metadata = body => fetch(`${base}/api/gtd/metadata`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe('POST /api/gtd/metadata', () => {
  it.each([
    { accountId: 'bad', messageIds: [M1] },
    { accountId: [ACCOUNT], messageIds: [M1] },
    { accountId: ACCOUNT, messageIds: [] },
    { accountId: ACCOUNT, messageIds: ['bad'] },
    { accountId: ACCOUNT, messageIds: Array.from({ length: 101 }, (_, i) => `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`) },
  ])('rejects malformed or unbounded input before capability calls', async body => {
    const res = await metadata(body);
    expect(res.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it('returns 404 when the account is not owned by the session user', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const res = await metadata({ accountId: ACCOUNT, messageIds: [M1] });
    expect(res.status).toBe(404);
  });

  it('returns no metadata when GTD is disabled without reading label copies', async () => {
    getGtdConfig.mockResolvedValueOnce({ enabled: false, folders: DEFAULT_GTD_FOLDERS });
    const res = await metadata({ accountId: ACCOUNT, messageIds: [M1] });
    expect(await res.json()).toEqual({ messages: {} });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('deduplicates ids and returns canonical states with per-state and newest dates', async () => {
    const res = await metadata({ accountId: ACCOUNT, messageIds: [M1, M1, M2] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ messages: {
      [M1]: {
        states: ['todo', 'watch'],
        dates: { todo: '2026-08-01T00:00:00.000Z', watch: '2026-07-01T00:00:00.000Z' },
        date: '2026-08-01T00:00:00.000Z',
      },
      [M2]: { states: ['reference'], dates: { reference: null }, date: null },
    } });
    const labelCall = query.mock.calls.find(([sql]) => sql.includes('FROM messages target'));
    expect(labelCall[1][1]).toEqual([M1, M2]);
  });

  it('honors configured folder overrides', async () => {
    getGtdConfig.mockResolvedValueOnce({
      enabled: true,
      folders: { ...DEFAULT_GTD_FOLDERS, todo: 'Next Actions' },
    });
    query.mockImplementation(async sql => {
      if (sql.startsWith('SELECT * FROM email_accounts')) return { rows: [{ id: ACCOUNT, user_id: 'u1' }] };
      if (sql.includes('FROM messages target')) return { rows: [
        { message_id: M1, folder: 'Next Actions', date: new Date('2026-08-02T00:00:00.000Z') },
      ] };
      return { rows: [] };
    });
    const res = await metadata({ accountId: ACCOUNT, messageIds: [M1] });
    expect((await res.json()).messages[M1].states).toEqual(['todo']);
  });
});
