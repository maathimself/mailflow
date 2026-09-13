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
    connectAccount: vi.fn(() => Promise.resolve(true)),
    disconnectAccount: vi.fn(() => Promise.resolve()),
  },
}));
vi.mock('../services/encryption.js', () => ({ encrypt: vi.fn(v => `enc:${v}`), decrypt: vi.fn() }));
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

const ID = '55555555-5555-5555-5555-555555555555';
const row = { id: ID, user_id: 'user-1', enabled: true, protocol: 'imap', imap_host: 'imap.example.com' };

// An authentication failure parks the account behind a long connect cooldown. The user fixing
// their credentials, or explicitly asking to reconnect, is exactly the signal that it may work
// now, so both paths must lift the cooldown before connecting or the attempt is silently skipped.
describe('account routes lift the connect cooldown before reconnecting', () => {
  let server;
  let base;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/accounts', accountRoutes);
    await new Promise(resolve => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise(resolve => server.close(resolve)); });

  beforeEach(() => {
    vi.clearAllMocks();
    query.mockReset();
    query.mockImplementation(async () => ({ rows: [row] }));
  });

  const waitFor = async (predicate) => {
    for (let i = 0; i < 50 && !predicate(); i++) await new Promise(r => setTimeout(r, 10));
  };

  it('POST /:id/reconnect clears the cooldown, then connects', async () => {
    const res = await fetch(`${base}/api/accounts/${ID}/reconnect`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(imapManager.clearConnectCooldown).toHaveBeenCalledWith(ID);
    expect(imapManager.connectAccount).toHaveBeenCalledTimes(1);
    expect(imapManager.clearConnectCooldown.mock.invocationCallOrder[0])
      .toBeLessThan(imapManager.connectAccount.mock.invocationCallOrder[0]);
  });

  it('PUT /:id with new credentials clears the cooldown, then connects', async () => {
    const res = await fetch(`${base}/api/accounts/${ID}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ auth_pass: 'new-password' }),
    });
    expect(res.status).toBe(200);
    await waitFor(() => imapManager.connectAccount.mock.calls.length > 0);
    expect(imapManager.clearConnectCooldown).toHaveBeenCalledWith(ID);
    expect(imapManager.connectAccount).toHaveBeenCalledTimes(1);
    expect(imapManager.clearConnectCooldown.mock.invocationCallOrder[0])
      .toBeLessThan(imapManager.connectAccount.mock.invocationCallOrder[0]);
  });

  it('PUT /:id with a cosmetic change leaves the cooldown alone', async () => {
    const res = await fetch(`${base}/api/accounts/${ID}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ color: '#123456' }),
    });
    expect(res.status).toBe(200);
    await new Promise(r => setTimeout(r, 30));
    expect(imapManager.clearConnectCooldown).not.toHaveBeenCalled();
    expect(imapManager.connectAccount).not.toHaveBeenCalled();
  });
});
