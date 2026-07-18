import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';

// Alias CRUD is exercised through the mounted accounts router so these tests cover the
// ownership checks, successful mutations, and the owner-address cache boundary together.
// The DB, app entrypoint, and auth middleware are stubbed to keep the harness isolated.
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'u1' }; next(); },
}));
vi.mock('../index.js', () => ({ imapManager: {} }));
vi.mock('../services/gtdTransitions.js', () => ({
  invalidateOwnerAddressesCache: vi.fn(),
}));

// index.js normally installs this Express 4 patch before mounting routes. Because index.js is
// mocked above, install it explicitly and give rejected async handlers the same 500 boundary.
import 'express-async-errors';
import express from 'express';
import { query } from '../services/db.js';
import { invalidateOwnerAddressesCache } from '../services/gtdTransitions.js';
import accountRoutes from './accounts.js';

const URL_ACCOUNT_ID = 'account-from-url';
const CHECKED_ACCOUNT_ID = 'account-from-ownership-check';
const ALIAS_ID = 'alias-1';
const insertedAlias = {
  id: ALIAS_ID,
  account_id: URL_ACCOUNT_ID,
  name: 'Work',
  email: 'work@example.com',
  reply_to: null,
  signature: null,
};
const updatedAlias = { ...insertedAlias, account_id: CHECKED_ACCOUNT_ID, name: 'Updated' };

// Route every query the three mutation handlers issue. The checked account id deliberately
// differs from the URL id so PUT/DELETE cannot pass by invalidating the convenient value.
function stubQueries({ accountExists = true, checkedAccountId = CHECKED_ACCOUNT_ID, mutationError = null } = {}) {
  query.mockImplementation(async (sql) => {
    if (sql.includes('FROM account_aliases a') && sql.includes('JOIN email_accounts e')) {
      return { rows: checkedAccountId ? [{ id: ALIAS_ID, account_id: checkedAccountId }] : [] };
    }
    if (sql.startsWith('SELECT id FROM email_accounts')) {
      return { rows: accountExists ? [{ id: URL_ACCOUNT_ID }] : [] };
    }
    if (sql.startsWith('INSERT INTO account_aliases')) {
      if (mutationError) throw mutationError;
      return { rows: [insertedAlias] };
    }
    if (sql.startsWith('UPDATE account_aliases')) {
      if (mutationError) throw mutationError;
      return { rows: [updatedAlias] };
    }
    if (sql.startsWith('DELETE FROM account_aliases')) {
      if (mutationError) throw mutationError;
      return { rows: [] };
    }
    throw new Error(`Unexpected query: ${sql}`);
  });
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/accounts', accountRoutes);
  app.use((err, _req, res, next) => {
    void err;
    void next;
    res.status(500).json({ error: 'Internal server error' });
  });
  return app;
}

function request(method, path, body) {
  return fetch(`${base}/api/accounts/${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

const aliasBody = { name: 'Work', email: 'work@example.com' };

let server;
let base;

beforeAll(async () => {
  await new Promise((resolve) => { server = buildApp().listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  query.mockReset();
  invalidateOwnerAddressesCache.mockReset();
  stubQueries();
});

describe('account alias mutations invalidate the owner-address cache', () => {
  it('invalidates the URL account once after a successful INSERT', async () => {
    const res = await request('POST', `${URL_ACCOUNT_ID}/aliases`, aliasBody);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(insertedAlias);
    expect(invalidateOwnerAddressesCache).toHaveBeenCalledOnce();
    expect(invalidateOwnerAddressesCache).toHaveBeenCalledWith(URL_ACCOUNT_ID);
  });

  it('invalidates the ownership-check account once after a successful UPDATE', async () => {
    const res = await request('PUT', `${URL_ACCOUNT_ID}/aliases/${ALIAS_ID}`, {
      ...aliasBody,
      name: 'Updated',
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(updatedAlias);
    expect(invalidateOwnerAddressesCache).toHaveBeenCalledOnce();
    expect(invalidateOwnerAddressesCache).toHaveBeenCalledWith(CHECKED_ACCOUNT_ID);
  });

  it('invalidates the ownership-check account once after a successful DELETE', async () => {
    const res = await request('DELETE', `${URL_ACCOUNT_ID}/aliases/${ALIAS_ID}`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(invalidateOwnerAddressesCache).toHaveBeenCalledOnce();
    expect(invalidateOwnerAddressesCache).toHaveBeenCalledWith(CHECKED_ACCOUNT_ID);
  });
});

// A missing ownership row exits before mutation, so neither a guessed URL account nor a stale
// alias account may be evicted from the owner-address cache.
describe('account alias ownership failures do not invalidate the cache', () => {
  it('returns 404 for PUT when the alias ownership check finds no row', async () => {
    stubQueries({ checkedAccountId: null });

    const res = await request('PUT', `${URL_ACCOUNT_ID}/aliases/${ALIAS_ID}`, aliasBody);

    expect(res.status).toBe(404);
    expect(query).toHaveBeenCalledTimes(1);
    expect(invalidateOwnerAddressesCache).not.toHaveBeenCalled();
  });

  it('returns 404 for DELETE when the alias ownership check finds no row', async () => {
    stubQueries({ checkedAccountId: null });

    const res = await request('DELETE', `${URL_ACCOUNT_ID}/aliases/${ALIAS_ID}`);

    expect(res.status).toBe(404);
    expect(query).toHaveBeenCalledTimes(1);
    expect(invalidateOwnerAddressesCache).not.toHaveBeenCalled();
  });
});

// Cache invalidation is sequenced after the mutation. A rejected write reaches the app-level
// async error boundary as a 500 and must leave the existing cache entry untouched.
describe('account alias mutation failures do not invalidate the cache', () => {
  it('returns 500 without invalidating when INSERT rejects', async () => {
    stubQueries({ mutationError: new Error('insert failed') });

    const res = await request('POST', `${URL_ACCOUNT_ID}/aliases`, aliasBody);

    expect(res.status).toBe(500);
    expect(query).toHaveBeenCalledTimes(2);
    expect(invalidateOwnerAddressesCache).not.toHaveBeenCalled();
  });
});
