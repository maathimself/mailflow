import 'express-async-errors';
import express from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api.js', () => ({
  requireAuth: (req, res, next) => {
    if (!req.headers['x-user']) return res.sendStatus(401);
    req.session = { userId: req.headers['x-user'] }; next();
  },
  isPluginActivated: vi.fn(),
  storage: { listValues: vi.fn(), getValue: vi.fn(), put: vi.fn(), del: vi.fn() },
}));
import { isPluginActivated, storage } from '../api.js';
import router from './routes.js';

const records = new Map();
const payload = { name: ' Welcome ', body: '<p>Welcome!</p>' };
let server;
async function request(method, path = '', body, user = 'alice') {
  const app = express();
  app.use(express.json()); app.use('/templates', router);
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/templates${path}`, {
      method, headers: { 'content-type': 'application/json', ...(user ? { 'x-user': user } : {}) },
      ...(body && method !== 'GET' ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, data: response.status === 204 || response.status === 401 ? null : await response.json() };
  } finally { await new Promise(resolve => server.close(resolve)); }
}
beforeEach(() => {
  vi.clearAllMocks(); records.clear();
  isPluginActivated.mockResolvedValue(true);
  storage.put.mockImplementation(async (_plugin, key, { value, ownerId }) => records.set(key, { value, owner_id: ownerId }));
  storage.getValue.mockImplementation(async (_plugin, key) => records.get(key) || null);
  storage.listValues.mockImplementation(async (_plugin, owner) => [...records.values()].filter(row => row.owner_id === owner));
  storage.del.mockImplementation(async (_plugin, key) => records.delete(key));
});
describe('templates API', () => {
  it('requires authentication and plugin activation', async () => {
    expect((await request('GET', '', null, null)).status).toBe(401);
    isPluginActivated.mockResolvedValue(false);
    for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
      expect((await request(method, '', payload)).status).toBe(403);
    }
    expect(storage.listValues).not.toHaveBeenCalled();
  });
  it('creates, lists, reads, edits and deletes an owned template', async () => {
    const created = await request('POST', '', payload);
    expect(created.status).toBe(201);
    expect(created.data).toMatchObject({ ...payload, name: 'Welcome' });
    expect(created.data.subject).toBe('');
    const legacy = await request('POST', '', { ...payload, to: ['old@example.com'], subject: 'Old subject' });
    expect(legacy.data).not.toHaveProperty('to');
    expect(legacy.data.subject).toBe('Old subject');
    await request('DELETE', `/${legacy.data.id}`);
    const path = `/${created.data.id}`;
    const list = await request('GET');
    expect(list.data).toHaveLength(1);
    expect(list.data[0].body).toBeUndefined();
    expect((await request('GET', path)).data.body).toBe(payload.body);
    const updated = await request('PUT', path, { ...payload, name: 'Updated', subject: 'Saved subject' });
    expect(updated.data).toMatchObject({ name: 'Updated', subject: 'Saved subject' });
    expect((await request('GET', path)).data.subject).toBe('Saved subject');
    expect((await request('DELETE', path)).status).toBe(204);
    expect((await request('GET', path)).status).toBe(404);
  });
  it('isolates lists and every operation between users', async () => {
    const { data } = await request('POST', '', payload);
    expect((await request('GET', '', null, 'bob')).data).toEqual([]);
    for (const method of ['GET', 'PUT', 'DELETE']) {
      expect((await request(method, `/${data.id}`, method === 'PUT' ? payload : null, 'bob')).status).toBe(404);
    }
    expect((await request('GET', `/${data.id}`)).data.body).toBe(payload.body);
  });
  it('validates fields and rejects invalid IDs without a storage lookup', async () => {
    for (const changes of [{ name: '' }, { name: 'x'.repeat(201) }, { body: 123 }, { body: null }, { subject: 123 }, { subject: 'x'.repeat(2001) }, { subject: 'Header\r\nInjected' }]) {
      expect((await request('POST', '', { ...payload, ...changes })).status).toBe(400);
    }
    expect((await request('GET', '/invalid')).status).toBe(404);
    expect(storage.getValue).not.toHaveBeenCalled();
    expect(storage.put).not.toHaveBeenCalled();
  });
});
