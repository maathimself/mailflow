import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, res, next) => {
    if (!req.headers['x-user']) return res.status(401).json({ error: 'Not authenticated' });
    req.session = { userId: req.headers['x-user'] };
    next();
  },
  requireAdmin: (req, res, next) => req.headers['x-admin'] === 'yes' ? next() : res.status(403).json({ error: 'Admin access required' }),
}));
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../services/webhooks.js', () => ({ getWebhook: vi.fn(), removeWebhook: vi.fn(), saveWebhook: vi.fn(), webhookAdminSettings: vi.fn(), saveWebhookAdminSettings: vi.fn(), notifyWebhook: vi.fn() }));
import express from 'express';
import { query } from '../services/db.js';
import router from './webhooks.js';
import { getWebhook, removeWebhook, saveWebhook, webhookAdminSettings, notifyWebhook } from '../services/webhooks.js';
let server, base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.apiToken = req.headers['x-token']; next(); });
  app.use('/api/webhooks', router);
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/webhooks`;
});
afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
beforeEach(() => { vi.clearAllMocks(); query.mockResolvedValue({ rows: [{ is_admin: false }] }); getWebhook.mockResolvedValue({ enabled: false }); webhookAdminSettings.mockResolvedValue({ enabled: false, allowedOrigins: [] }); });
const request = (path = '', options = {}) => fetch(base + path, { ...options, headers: { 'content-type': 'application/json', 'x-user': 'u1', ...options.headers } });
it('requires authentication and rejects API tokens', async () => {
  expect((await fetch(base)).status).toBe(401);
  expect((await request('', { headers: { 'x-token': 'yes' } })).status).toBe(403);
  expect(getWebhook).not.toHaveBeenCalled();
});
it('requires an administrator to read or change policy', async () => {
  expect((await request('/admin')).status).toBe(403);
  expect((await request('/admin', { method: 'PUT', body: '{}' })).status).toBe(403);
  expect((await request('/admin', { headers: { 'x-admin': 'yes' } })).status).toBe(200);
});
it('scopes user settings to the authenticated user', async () => {
  await request();
  expect(getWebhook).toHaveBeenCalledWith('u1');
  saveWebhook.mockResolvedValue({ enabled: false });
  await request('', { method: 'PUT', body: '{"enabled":false}' });
  expect(saveWebhook).toHaveBeenCalledWith('u1', { enabled: false });
});
it('returns safe validation errors and hides unexpected backend errors', async () => {
  saveWebhook.mockRejectedValue(Object.assign(new Error('Invalid webhook format'), { status: 400 }));
  let response = await request('', { method: 'PUT', body: '{}' });
  expect(response.status).toBe(400);
  saveWebhook.mockRejectedValue(new Error('query contains secret-token'));
  response = await request('', { method: 'PUT', body: '{}' });
  expect(response.status).toBe(500);
  expect(await response.text()).not.toContain('secret-token');
});
it('test sends use the shared dispatcher with synthetic data and report rate limits', async () => {
  notifyWebhook.mockResolvedValue({ skipped: 'rate_limit' });
  const response = await request('/test', { method: 'POST', body: '{"url":"https://ignored.example"}' });
  expect(response.status).toBe(429);
  expect(notifyWebhook).toHaveBeenCalledWith({ userId: 'u1', accountName: 'MailFlow test', count: 1, latest: { fromName: 'Test sender', subject: 'Test notification' } });
});

it('deletes only the authenticated user configuration and rejects API tokens', async () => {
  expect((await request('', { method: 'DELETE' })).status).toBe(204);
  expect(removeWebhook).toHaveBeenCalledWith('u1');
  removeWebhook.mockClear();
  expect((await request('', { method: 'DELETE', headers: { 'x-token': 'yes' } })).status).toBe(403);
  expect(removeWebhook).not.toHaveBeenCalled();
});
it.each([false, true])('redacts network policy errors based on current admin status: %s', async isAdmin => {
  query.mockResolvedValue({ rows: [{ is_admin: isAdmin }] });
  const error = 'Destination blocked by network policy';
  const expected = isAdmin ? error : 'Delivery failed';
  notifyWebhook.mockResolvedValue({ error });
  getWebhook.mockResolvedValue({ lastError: error });
  saveWebhook.mockResolvedValue({ lastError: error });
  expect(await (await request('/test', { method: 'POST' })).json()).toEqual({ error: expected });
  expect(await (await request()).json()).toEqual({ lastError: expected });
  expect(await (await request('', { method: 'PUT', body: '{}' })).json()).toEqual({ lastError: expected });
});
