import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
}));
vi.mock('../index.js', () => ({
  imapManager: {
    connectAccount: vi.fn().mockResolvedValue(undefined),
    disconnectAccount: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => {
    req.session = { userId: 'u1' };
    next();
  },
}));
vi.mock('../services/encryption.js', () => ({
  encrypt: vi.fn(value => value ? `encrypted:${value}` : value),
}));
vi.mock('../services/fastmailClient.js', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, loadFastmailSession: vi.fn() };
});
vi.mock('../services/fastmailAliasSync.js', () => ({
  syncFastmailAliases: vi.fn(),
}));
vi.mock('../services/connectionPolicy.js', () => ({
  getConnectionPolicy: vi.fn().mockResolvedValue({
    allowPrivateHosts: false,
    allowNonstandardPorts: false,
  }),
}));

import express from 'express';
import { query, withTransaction } from '../services/db.js';
import { fastmailConfigError, fastmailSyncError, loadFastmailSession } from '../services/fastmailClient.js';
import { syncFastmailAliases } from '../services/fastmailAliasSync.js';
import accountRoutes from './accounts.js';

const aliasBody = {
  name: 'Fastmail Alias',
  email: 'alias@example.com',
  reply_to: null,
  signature: null,
};

const tx = { query: vi.fn() };
let server;
let base;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/accounts', accountRoutes);
  return app;
}

const api = (path, { method = 'GET', body } = {}) => fetch(`${base}${path}`, {
  method,
  headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

beforeAll(async () => {
  await new Promise(resolve => { server = buildApp().listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
});

beforeEach(() => {
  query.mockReset();
  withTransaction.mockReset();
  tx.query.mockReset();
  tx.query.mockResolvedValue({ rows: [] });
  withTransaction.mockImplementation(fn => fn(tx));
  loadFastmailSession.mockResolvedValue({ apiUrl: 'https://api.fastmail.com/jmap/api/' });
  syncFastmailAliases.mockResolvedValue([]);
});

describe('Fastmail account API boundary', () => {
  it('never returns fastmail_api_token and reports only configuration state', async () => {
    query.mockResolvedValueOnce({ rows: [{
      id: 'a1', user_id: 'u1', email_address: 'owner@example.com',
      fastmail_api_token: 'enc:v1:secret', fastmail_last_sync: null,
      fastmail_sync_error: null,
    }] });
    query.mockResolvedValueOnce({ rows: [] });

    const res = await api('/accounts');
    const body = await res.json();
    expect(body[0].fastmail_configured).toBe(true);
    expect(body[0]).not.toHaveProperty('fastmail_api_token');
  });

  it('rejects editing and deleting provider-managed aliases', async () => {
    query.mockResolvedValue({ rows: [{ id: 'al1', provenance: 'fastmail' }] });
    expect((await api('/accounts/a1/aliases/al1', { method: 'PUT', body: aliasBody })).status).toBe(409);
    expect((await api('/accounts/a1/aliases/al1', { method: 'DELETE' })).status).toBe(409);
  });

  it('disconnects Fastmail atomically without deleting manual aliases', async () => {
    query.mockResolvedValue({ rows: [{ id: 'a1' }] });
    tx.query.mockResolvedValueOnce({ rows: [{ id: 'a1', user_id: 'u1', fastmail_api_token: null }] });

    const res = await api('/accounts/a1', { method: 'PUT', body: { fastmail_api_token: null } });
    const body = await res.json();

    expect(withTransaction).toHaveBeenCalledTimes(1);
    expect(tx.query).toHaveBeenCalledWith(
      "DELETE FROM account_aliases WHERE account_id = $1 AND provenance = 'fastmail'",
      ['a1'],
    );
    expect(tx.query.mock.calls.some(([sql]) => sql.includes('fastmail_identity_promotions'))).toBe(false);
    expect(body.fastmail_configured).toBe(false);
    expect(body).not.toHaveProperty('fastmail_api_token');
  });

  it('validates a token before inserting an account and maps configuration errors to 422', async () => {
    loadFastmailSession.mockRejectedValue(fastmailConfigError('Fastmail API token is missing Masked Email permission'));

    const res = await api('/accounts', { method: 'POST', body: {
      name: 'Fastmail', email_address: 'owner@example.com',
      fastmail_api_token: 'invalid-token',
    } });

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'Fastmail API token is missing Masked Email permission' });
    expect(query).not.toHaveBeenCalled();
  });

  it('still creates the account when token validation hits a transient reach failure', async () => {
    loadFastmailSession.mockRejectedValue(fastmailSyncError('Could not reach Fastmail'));
    query
      .mockResolvedValueOnce({ rows: [{
        id: 'a1', name: 'Fastmail', email_address: 'owner@example.com',
        fastmail_api_token: 'encrypted:valid-token',
      }] })
      .mockResolvedValueOnce({ rows: [{
        id: 'a1', name: 'Fastmail', email_address: 'owner@example.com',
        fastmail_api_token: 'encrypted:valid-token',
        fastmail_sync_error: 'Could not reach Fastmail',
      }] })
      .mockResolvedValueOnce({ rows: [] });
    syncFastmailAliases.mockRejectedValue(fastmailSyncError('Could not reach Fastmail'));

    const res = await api('/accounts', { method: 'POST', body: {
      name: 'Fastmail', email_address: 'owner@example.com',
      fastmail_api_token: 'valid-token',
    } });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.fastmail_configured).toBe(true);
    expect(body.fastmail_sync_error).toBe('Could not reach Fastmail');
    expect(body).not.toHaveProperty('fastmail_api_token');
    expect(syncFastmailAliases).toHaveBeenCalledWith('a1');
  });

  it('retains a newly saved account and returns its safe sync status when initial sync fails', async () => {
    query
      .mockResolvedValueOnce({ rows: [{
        id: 'a1', name: 'Fastmail', email_address: 'owner@example.com',
        fastmail_api_token: 'encrypted:valid-token',
      }] })
      .mockResolvedValueOnce({ rows: [{
        id: 'a1', name: 'Fastmail', email_address: 'owner@example.com',
        fastmail_api_token: 'encrypted:valid-token',
        fastmail_sync_error: 'Could not reach Fastmail',
      }] })
      .mockResolvedValueOnce({ rows: [] });
    syncFastmailAliases.mockRejectedValue(new Error('private remote detail'));

    const res = await api('/accounts', { method: 'POST', body: {
      name: 'Fastmail', email_address: 'owner@example.com',
      fastmail_api_token: 'valid-token',
    } });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.fastmail_sync_error).toBe('Could not reach Fastmail');
    expect(body.fastmail_configured).toBe(true);
    expect(body).not.toHaveProperty('fastmail_api_token');
    expect(syncFastmailAliases).toHaveBeenCalledWith('a1');
  });

  it('validates a replacement token before updating the account row', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'a1' }] });
    loadFastmailSession.mockRejectedValue(fastmailConfigError('Fastmail rejected the API token or its permissions'));

    const res = await api('/accounts/a1', { method: 'PUT', body: {
      fastmail_api_token: 'invalid-token',
    } });

    expect(res.status).toBe(422);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('marks a saved replacement token for a post-flight synchronization', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'a1' }] })
      .mockResolvedValueOnce({ rows: [{
        id: 'a1', name: 'Fastmail', email_address: 'owner@example.com',
        fastmail_api_token: 'encrypted:new-token',
      }] })
      .mockResolvedValueOnce({ rows: [{
        id: 'a1', email_address: 'owner@example.com',
        fastmail_api_token: 'encrypted:new-token', fastmail_sync_error: null,
      }] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await api('/accounts/a1', { method: 'PUT', body: {
      fastmail_api_token: 'new-token',
    } });

    expect(res.status).toBe(200);
    expect(syncFastmailAliases).toHaveBeenCalledWith('a1', { credentialChanged: true });
  });

  it('refreshes an owned configured account and returns the reloaded safe snapshot', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'a1', fastmail_api_token: 'encrypted:token' }] })
      .mockResolvedValueOnce({ rows: [{
        id: 'a1', email_address: 'owner@example.com', fastmail_api_token: 'encrypted:token',
        fastmail_sync_error: null,
      }] })
      .mockResolvedValueOnce({ rows: [{
        id: 'alias-1', account_id: 'a1', email: 'mask@example.com', provenance: 'fastmail',
      }] });

    const res = await api('/accounts/a1/fastmail/refresh', { method: 'POST' });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(syncFastmailAliases).toHaveBeenCalledWith('a1');
    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('WHERE id = $1 AND user_id = $2'),
      ['a1', 'u1'],
    );
    expect(body.aliases).toHaveLength(1);
    expect(body.fastmail_configured).toBe(true);
    expect(body).not.toHaveProperty('fastmail_api_token');
  });

  it('returns the persisted safe error when manual refresh fails', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'a1', fastmail_api_token: 'encrypted:token' }] })
      .mockResolvedValueOnce({ rows: [{
        id: 'a1', fastmail_api_token: 'encrypted:token',
        fastmail_sync_error: 'Fastmail synchronization failed',
      }] })
      .mockResolvedValueOnce({ rows: [] });
    syncFastmailAliases.mockRejectedValue(new Error('token and full inventory'));

    const res = await api('/accounts/a1/fastmail/refresh', { method: 'POST' });

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: 'Fastmail synchronization failed', code: 'FASTMAIL_SYNC_FAILED',
    });
  });
});
