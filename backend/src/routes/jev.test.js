import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import express from 'express';

vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: req.headers['x-user'] || 'user-a' }; next(); } }));
vi.mock('../services/jev.js', () => ({
  getJevStatus: vi.fn(async () => ({ configured: true })),
  saveJevKey: vi.fn(async () => {}),
  removeJevKey: vi.fn(async () => {}),
}));

import router from './jev.js';
import { getJevStatus, saveJevKey, removeJevKey } from '../services/jev.js';

let server;
let base;
beforeEach(async () => {
  vi.clearAllMocks();
  const app = express(); app.use(express.json()); app.use('/api/jev', router);
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterEach(async () => { await new Promise(resolve => server.close(resolve)); });

it('scopes status, save, and deletion to session user and never returns the key', async () => {
  const status = await fetch(`${base}/api/jev`, { headers: { 'x-user': 'user-b' } });
  expect(await status.json()).toEqual({ configured: true });
  expect(getJevStatus).toHaveBeenCalledWith('user-b');
  const saved = await fetch(`${base}/api/jev`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-user': 'user-b' }, body: JSON.stringify({ apiKey: 'private' }) });
  expect(await saved.json()).toEqual({ configured: true });
  expect(saveJevKey).toHaveBeenCalledWith('user-b', 'private');
  await fetch(`${base}/api/jev`, { method: 'DELETE', headers: { 'x-user': 'user-b' } });
  expect(removeJevKey).toHaveBeenCalledWith('user-b');
});

it('rejects invalid input before storage', async () => {
  const response = await fetch(`${base}/api/jev`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey: 'bad\nkey' }) });
  expect(response.status).toBe(400);
  expect(saveJevKey).not.toHaveBeenCalled();
});
