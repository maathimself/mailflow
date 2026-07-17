import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';

// The route must not hold SQL: it parses, calls the service, and JSON-frames.
// Mock inline + import the mocked binding (avoids the vi.mock hoisting TDZ trap).
vi.mock('../services/search/searchService.js', () => ({ search: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: 'u1' }; next(); } }));
vi.mock('../services/db.js', () => ({ query: vi.fn() }));

import { search } from '../services/search/searchService.js';
import searchRouter from './search.js';

function makeApp() {
  const app = express();
  app.use((req, _res, next) => { req.session = { userId: 'u1' }; next(); });
  app.use('/api/search', searchRouter);
  return app;
}

async function get(app, path) {
  const { default: request } = await import('node:http');
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      request.get(`http://127.0.0.1:${port}${path}`, (res) => {
        let body = '';
        res.on('data', c => (body += c));
        res.on('end', () => { server.close(); resolve({ status: res.statusCode, json: JSON.parse(body || '{}') }); });
      });
    });
  });
}

beforeEach(() => search.mockReset());

describe('GET /api/search', () => {
  it('short-circuits a blank query with { messages: [] } and never calls the service', async () => {
    const res = await get(makeApp(), '/api/search?q=');
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ messages: [] });
    expect(search).not.toHaveBeenCalled();
  });

  it('rejects an over-500-char query with 400', async () => {
    const res = await get(makeApp(), `/api/search?q=${'a'.repeat(501)}`);
    expect(res.status).toBe(400);
  });

  it('returns a superset response: messages + query + mode + page + unsupported + errors', async () => {
    search.mockResolvedValue({ messages: [{ id: 'm1' }], mode: 'lexical', page: { offset: 0, limit: 50, hasMore: false } });
    const res = await get(makeApp(), '/api/search?q=larger:5M%20invoice');
    expect(res.status).toBe(200);
    expect(res.json.messages).toEqual([{ id: 'm1' }]);
    expect(res.json.query).toBe('larger:5M invoice');
    expect(res.json.mode).toBe('lexical');
    expect(res.json.page).toEqual({ offset: 0, limit: 50, hasMore: false });
    // larger: is recognized but unserviceable — surfaced, not silently dropped.
    expect(res.json.unsupported).toEqual([{ key: 'larger', token: 'larger:5m' }]);
    expect(res.json.errors).toEqual([]);
  });
});

describe('GET /api/search mode passthrough (Phase 4 Task 7)', () => {
  beforeEach(() => search.mockReset());

  it('defaults mode to lexical when absent', async () => {
    search.mockResolvedValue({ messages: [], mode: 'lexical', page: { offset: 0, limit: 50, hasMore: false } });
    await get(makeApp(), '/api/search?q=hello');
    expect(search.mock.calls[0][0].mode).toBe('lexical');
  });

  it('passes mode=hybrid straight through', async () => {
    search.mockResolvedValue({ messages: [], mode: 'hybrid', pool_saturated: false, generation: null, page: { offset: 0, limit: 50, hasMore: false } });
    await get(makeApp(), '/api/search?q=hello&mode=hybrid');
    expect(search.mock.calls[0][0].mode).toBe('hybrid');
  });

  it('passes mode=vector straight through', async () => {
    search.mockResolvedValue({ messages: [], mode: 'vector', pool_saturated: false, generation: null, page: { offset: 0, limit: 50, hasMore: false } });
    await get(makeApp(), '/api/search?q=hello&mode=vector');
    expect(search.mock.calls[0][0].mode).toBe('vector');
  });

  it('coerces an unknown mode to lexical', async () => {
    search.mockResolvedValue({ messages: [], mode: 'lexical', page: { offset: 0, limit: 50, hasMore: false } });
    await get(makeApp(), '/api/search?q=hello&mode=bogus');
    expect(search.mock.calls[0][0].mode).toBe('lexical');
  });

  it('returns the service response including fellBack (superset)', async () => {
    search.mockResolvedValue({ messages: [], mode: 'lexical', fellBack: true, page: { offset: 0, limit: 50, hasMore: false } });
    const res = await get(makeApp(), '/api/search?q=hello&mode=hybrid');
    expect(res.json.mode).toBe('lexical');
    expect(res.json.fellBack).toBe(true);
  });
});
