import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';

vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: 'u1' }; next(); } }));
const broadcast = vi.hoisted(() => vi.fn());
vi.mock('../index.js', () => ({ imapManager: { broadcast } }));
vi.mock('../services/tags/store.js', () => ({
  listDefinitions: vi.fn(), createDefinition: vi.fn(), updateDefinition: vi.fn(), deleteDefinition: vi.fn(),
  tagsForMessages: vi.fn(), setManualTag: vi.fn(), copiesOfMessage: vi.fn(),
}));

import 'express-async-errors';
import express from 'express';
import * as store from '../services/tags/store.js';
import routes from './tags.js';

const ID = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';
let server, base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/tags', routes);
  app.use((err, _req, res, next) => { void next; res.status(500).json({ error: String(err.message) }); });
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/tags`;
});
afterAll(() => new Promise((r) => server.close(r)));
beforeEach(() => { vi.clearAllMocks(); });
const call = (method, path, body) => fetch(base + path, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });

describe('definitions', () => {
  it('validates a new tag and refuses a duplicate name', async () => {
    expect((await call('POST', '/definitions', {})).status).toBe(400);
    expect((await call('POST', '/definitions', { name: '   ' })).status).toBe(400);
    expect((await call('POST', '/definitions', { name: 'X', color: 'red' })).status).toBe(400);
    expect((await call('POST', '/definitions', { name: 'X', color: 12 })).status).toBe(400);
    store.createDefinition.mockResolvedValue(null);
    expect((await call('POST', '/definitions', { name: 'Urgent' })).status).toBe(409);
    store.createDefinition.mockResolvedValue({ id: ID, name: 'Travel' });
    const ok = await call('POST', '/definitions', { name: ' Travel ', color: '#00aa00' });
    expect(ok.status).toBe(201);
    expect(store.createDefinition).toHaveBeenLastCalledWith('u1', { name: 'Travel', color: '#00aa00' });
  });

  it('updates only the name and colour, and answers 404, 409 or 400 when it cannot', async () => {
    store.updateDefinition.mockResolvedValue({ id: ID });
    await call('PATCH', `/definitions/${ID}`, { user_id: 'someone-else', name: 'New name' });
    expect(store.updateDefinition).toHaveBeenCalledWith('u1', ID, { name: 'New name' });
    store.updateDefinition.mockResolvedValue(null);
    expect((await call('PATCH', `/definitions/${ID}`, { name: 'x' })).status).toBe(404);
    store.updateDefinition.mockResolvedValue('duplicate');
    expect((await call('PATCH', `/definitions/${ID}`, { name: 'x' })).status).toBe(409);
    expect((await call('PATCH', '/definitions/not-a-uuid', { name: 'x' })).status).toBe(400);
    expect((await call('PATCH', `/definitions/${ID}`, { name: '' })).status).toBe(400);
  });

  it('deletes a tag, and 404s one that is not the user\'s', async () => {
    store.deleteDefinition.mockResolvedValue(false);
    expect((await call('DELETE', `/definitions/${ID}`)).status).toBe(404);
    store.deleteDefinition.mockResolvedValue(true);
    expect((await call('DELETE', `/definitions/${ID}`)).status).toBe(200);
    expect((await call('DELETE', '/definitions/nope')).status).toBe(400);
  });
});

describe('messages', () => {
  it('validates and limits the batch lookup', async () => {
    expect((await call('GET', '/messages?ids=nope')).status).toBe(400);
    expect((await call('GET', `/messages?ids=${Array(201).fill(ID).join(',')}`)).status).toBe(400);
    store.tagsForMessages.mockResolvedValue({ [ID]: [] });
    expect((await call('GET', `/messages?ids=${ID}`)).status).toBe(200);
    expect(store.tagsForMessages).toHaveBeenCalledWith('u1', [ID]);
  });

  it('adds or removes a tag by hand, tells the open tabs, and 404s a message or tag that is not the user\'s', async () => {
    store.setManualTag.mockResolvedValue(true);
    store.copiesOfMessage.mockResolvedValue([ID]);
    expect((await call('PUT', `/messages/${ID}/tags/${ID2}`, { applied: false })).status).toBe(200);
    expect(store.setManualTag).toHaveBeenCalledWith('u1', ID, ID2, false);
    expect(broadcast).toHaveBeenCalledWith({ type: 'tags_updated', messageIds: [ID] }, 'u1');
    expect((await call('PUT', `/messages/${ID}/tags/${ID2}`, {})).status).toBe(400);
    expect((await call('PUT', `/messages/nope/tags/${ID2}`, { applied: true })).status).toBe(400);
    store.setManualTag.mockResolvedValue(false);
    broadcast.mockClear();
    expect((await call('PUT', `/messages/${ID}/tags/${ID2}`, { applied: true })).status).toBe(404);
    expect(broadcast).not.toHaveBeenCalled();
  });
});

describe('keeping other views in step', () => {
  it('tells the open tabs about every copy of the email when a tag is set by hand', async () => {
    store.setManualTag.mockResolvedValue(true);
    store.copiesOfMessage.mockResolvedValue([ID, ID2]);
    await call('PUT', `/messages/${ID}/tags/${ID2}`, { applied: true });
    expect(store.copiesOfMessage).toHaveBeenCalledWith('u1', ID);
    expect(broadcast).toHaveBeenCalledWith({ type: 'tags_updated', messageIds: [ID, ID2] }, 'u1');
  });

  it('tells the open tabs when a tag is created, renamed or deleted', async () => {
    store.createDefinition.mockResolvedValue({ id: ID, name: 'Travel' });
    store.updateDefinition.mockResolvedValue({ id: ID });
    store.deleteDefinition.mockResolvedValue(true);
    await call('POST', '/definitions', { name: 'Travel' });
    await call('PATCH', `/definitions/${ID}`, { name: 'Trips' });
    await call('DELETE', `/definitions/${ID}`);
    expect(broadcast.mock.calls.filter(([m]) => m.type === 'tag_definitions_updated')).toHaveLength(3);
    broadcast.mockClear();
    store.updateDefinition.mockResolvedValue(null);
    await call('PATCH', `/definitions/${ID}`, { name: 'x' });
    expect(broadcast).not.toHaveBeenCalled();
  });
});
