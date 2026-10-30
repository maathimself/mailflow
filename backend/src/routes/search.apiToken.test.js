import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn(async () => ({ rows: [] })) }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => {
    req.session = { userId: req.get('x-test-user') };
    if (req.get('x-test-token')) req.apiToken = { id: req.get('x-test-token'), userId: req.get('x-test-user') };
    next();
  },
}));

import express from 'express';
import searchRoutes from './search.js';

let server;
let base;
beforeAll(async () => {
  const app = express();
  app.use('/api/search', searchRoutes);
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
});

const search = (user, token, path = '/api/search?q=invoice') => fetch(`${base}${path}`, {
  headers: { 'x-test-user': user, ...(token ? { 'x-test-token': token } : {}) },
}).then(r => r.status);

describe('the search limit for API tokens', () => {
  it('is one bucket for all of a user\'s tokens, apart from the browser\'s', async () => {
    for (let i = 0; i < 60; i++) expect(await search('u1', i % 2 ? 't1' : 't2')).toBe(200);
    expect(await search('u1', 't3')).toBe(429);
    expect(await search('u1', 't1', '/api/search/contacts?q=ma')).toBe(429);
    // The person at the browser can still search.
    expect(await search('u1', null)).toBe(200);
    // And another user's tokens have their own.
    expect(await search('u2', 't9')).toBe(200);
  });

  it('is not spent by the browser either', async () => {
    for (let i = 0; i < 60; i++) await search('u3', null);
    expect(await search('u3', null)).toBe(429);
    expect(await search('u3', 't4')).toBe(200);
  });
});
