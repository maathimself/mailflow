import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { query, testConnection } = vi.hoisted(() => ({
  query: vi.fn(),
  testConnection: vi.fn(),
}));

vi.mock('../services/db.js', () => ({ query }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => {
    req.session = { userId: 'user-1' };
    next();
  },
}));
vi.mock('../index.js', () => ({ imapManager: {} }));
vi.mock('../services/connectionTest.js', () => ({ testConnection }));
vi.mock('../services/accountService.js', () => ({
  ALLOWED_IMAP_PORTS: new Set([143, 993]),
  ALLOWED_SMTP_PORTS: new Set([465, 587]),
  createAccount: vi.fn(),
  reconcileConnectionState: vi.fn(),
  validatePort: vi.fn(),
}));

import 'express-async-errors';
import express from 'express';
import accountRoutes from './accounts.js';

const account = {
  id: 'account-1',
  user_id: 'user-1',
  imap_host: 'imap.example.com',
  smtp_host: 'smtp.example.com',
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/accounts', accountRoutes);
  return app;
}

let server;
let base;

beforeAll(async () => {
  await new Promise(resolve => {
    server = buildApp().listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
});

beforeEach(() => {
  query.mockReset();
  testConnection.mockReset();
});

async function postTestConnection(id = account.id) {
  const response = await fetch(`${base}/api/accounts/${id}/test-connection`, {
    method: 'POST',
  });
  return {
    status: response.status,
    body: await response.json(),
  };
}

describe('POST /api/accounts/:id/test-connection', () => {
  it('404s an absent or unowned account', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    const response = await postTestConnection('foreign-account');

    expect(response).toEqual({
      status: 404,
      body: { error: 'Account not found' },
    });
    expect(query).toHaveBeenCalledWith(
      'SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2',
      ['foreign-account', 'user-1']
    );
    expect(testConnection).not.toHaveBeenCalled();
  });

  it('returns both successful probe legs', async () => {
    query.mockResolvedValueOnce({ rows: [account] });
    testConnection.mockResolvedValueOnce({
      imap: { ok: true },
      smtp: { ok: true },
    });

    const response = await postTestConnection();

    expect(response).toEqual({
      status: 200,
      body: { imap: { ok: true }, smtp: { ok: true } },
    });
    expect(testConnection).toHaveBeenCalledWith(account);
  });

  it.each([
    ['IMAP', {
      imap: { ok: false, error: 'Authentication failed.' },
      smtp: { ok: true },
    }],
    ['SMTP', {
      imap: { ok: true },
      smtp: { ok: false, error: 'Could not connect.' },
    }],
  ])('returns the per-leg failure shape when %s fails', async (_leg, probeResult) => {
    query.mockResolvedValueOnce({ rows: [account] });
    testConnection.mockResolvedValueOnce(probeResult);

    const response = await postTestConnection();

    expect(response.status).toBe(200);
    expect(response.body).toEqual(probeResult);
  });
});
