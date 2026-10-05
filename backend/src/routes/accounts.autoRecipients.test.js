import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => {
    req.session = { userId: 'user-1' };
    next();
  },
}));
vi.mock('../index.js', () => ({
  imapManager: {
    clearConnectCooldown: vi.fn(),
    disconnectAccount: vi.fn().mockResolvedValue(),
    connectAccount: vi.fn().mockResolvedValue(),
  },
}));
vi.mock('../services/connectionPolicy.js', () => ({
  getConnectionPolicy: vi.fn().mockResolvedValue({
    allowPrivateHosts: false,
    allowInsecureTls: false,
    allowNonstandardPorts: false,
  }),
}));

import express from 'express';
import accountRoutes from './accounts.js';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';

const ACCOUNT_ID = '44444444-4444-4444-4444-444444444444';
// An enabled IMAP account, so saving would reconnect it if these fields were a reconnect trigger.
const ACCOUNT_ROW = { id: ACCOUNT_ID, protocol: 'imap', enabled: true, auto_cc_addresses: [], auto_bcc_addresses: [] };

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/accounts', accountRoutes);
  return app;
}

// The UPDATE returns the values it was given, as RETURNING * would after node-pg parses a text[].
function stubQueries() {
  query.mockImplementation(async (sql, params) => {
    if (sql.startsWith('SELECT id FROM email_accounts')) return { rows: [{ id: ACCOUNT_ID }] };
    if (sql.startsWith('SELECT * FROM email_accounts')) return { rows: [ACCOUNT_ROW] };
    if (sql.startsWith('UPDATE email_accounts')) {
      const row = { ...ACCOUNT_ROW };
      for (const [, column, n] of sql.matchAll(/(\w+) = \$(\d+)/g)) row[column] = params[n - 1];
      return { rows: [row] };
    }
    throw new Error(`Unexpected query: ${sql}`);
  });
}

function updateCall() {
  return query.mock.calls.find(([sql]) => sql.startsWith('UPDATE email_accounts'));
}

describe('PUT /api/accounts/:id automatic Cc and Bcc', () => {
  let server;
  let base;

  beforeAll(async () => {
    await new Promise(resolve => {
      server = buildApp().listen(0, resolve);
    });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    query.mockReset();
    stubQueries();
  });

  function put(body) {
    return fetch(`${base}/api/accounts/${ACCOUNT_ID}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('stores each normalized list as a real array and returns it', async () => {
    const response = await put({
      auto_cc_addresses: ['boss@example.com'],
      auto_bcc_addresses: [' Me@Example.com ', 'me@example.com', 'other@example.invalid'],
    });

    expect(response.status).toBe(200);
    const [sql, params] = updateCall();
    expect(sql).toContain('auto_cc_addresses = $1, auto_bcc_addresses = $2');
    expect(params[0]).toEqual(['boss@example.com']);
    expect(Array.isArray(params[1])).toBe(true);
    expect(params[1]).toEqual(['Me@Example.com', 'other@example.invalid']);
    const body = await response.json();
    expect(body.auto_cc_addresses).toEqual(['boss@example.com']);
    expect(body.auto_bcc_addresses).toEqual(['Me@Example.com', 'other@example.invalid']);
  });

  it.each([
    ['auto_cc_addresses', 'Boss <boss@example.com>', 'Automatic Cc'],
    ['auto_bcc_addresses', 'a@example.com\r\nBcc: x@example.invalid', 'Automatic Bcc'],
  ])('rejects an invalid %s entry with 400 and writes nothing', async (field, entry, label) => {
    const response = await put({ [field]: ['ok@example.com', entry] });

    expect(response.status).toBe(400);
    const { error } = await response.json();
    expect(error).toContain(label);
    expect(error).toContain(JSON.stringify(entry));
    // Only the ownership check ran.
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('rejects an address that is in both lists, ignoring case', async () => {
    const response = await put({ auto_cc_addresses: ['A@example.com'], auto_bcc_addresses: ['a@example.com'] });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('"A@example.com" cannot be in both Automatic Cc and Automatic Bcc');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('clears the lists with [] or null and does not reconnect the account', async () => {
    const response = await put({ auto_cc_addresses: null, auto_bcc_addresses: [] });

    expect(response.status).toBe(200);
    const [, params] = updateCall();
    expect(params.slice(0, 2)).toEqual([[], []]);
    const body = await response.json();
    expect(body.auto_cc_addresses).toEqual([]);
    expect(body.auto_bcc_addresses).toEqual([]);
    expect(imapManager.clearConnectCooldown).not.toHaveBeenCalled();
    expect(imapManager.disconnectAccount).not.toHaveBeenCalled();
    expect(imapManager.connectAccount).not.toHaveBeenCalled();
  });
});
