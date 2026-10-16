import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';

// The frontend treats any 401 outside /auth/ as an expired MailFlow session and signs the
// user out, so Todoist rejecting the saved token must not come back as a 401. db, encryption
// and auth are stubbed; fetch is stubbed per test to stand in for the Todoist API.
vi.mock('../services/db.js', () => ({
  query: vi.fn(async () => ({ rows: [{ config: { token: 'todoist-token' } }] })),
}));
vi.mock('../services/encryption.js', () => ({ encrypt: (v) => v, decrypt: (v) => v }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'u1' }; next(); },
}));

import express from 'express';
import todoistRoutes from './todoist.js';

const realFetch = globalThis.fetch;
let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/todoist', todoistRoutes);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function todoistAnswers(status, body) {
  const todoist = vi.fn(async () => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  }));
  vi.stubGlobal('fetch', todoist);
  return todoist;
}

function request(method, path, body) {
  return realFetch(`${base}/api/todoist${path}`, {
    method,
    ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
}

describe('Todoist API errors', () => {
  it.each([
    ['GET', '/projects'],
    ['GET', '/labels'],
    ['POST', '/tasks', { content: 'Follow up' }],
  ])('%s %s answers 409, not 401, when Todoist rejects the saved token', async (method, path, body) => {
    const todoist = todoistAnswers(401, { error: 'Unauthorized' });
    const res = await request(method, path, body);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/Disconnect Todoist .+ connect it again/);
    expect(todoist).toHaveBeenCalledWith(
      `https://api.todoist.com/api/v1${path}`,
      expect.objectContaining({ method }),
    );
  });

  it('keeps the status and message of other Todoist errors', async () => {
    todoistAnswers(429, { error: 'Too many requests' });
    const res = await request('GET', '/projects');
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'Too many requests' });
  });
});
