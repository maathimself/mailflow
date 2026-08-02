import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';

const {
  listStages,
  completeAccountStage,
  discardAccountStage,
} = vi.hoisted(() => ({
  listStages: vi.fn(),
  completeAccountStage: vi.fn(),
  discardAccountStage: vi.fn(),
}));

vi.mock('../services/accountService.js', () => ({
  listStages,
  completeAccountStage,
  discardAccountStage,
}));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => {
    req.session = { userId: 'user-1' };
    next();
  },
}));

import router from './mcpAccountStages.js';

function appWith() {
  const app = express();
  app.use(express.json());
  app.use('/api/mcp-account-stages', router);
  return app;
}

async function call(app, method, path, body) {
  const { createServer } = await import('node:http');
  const server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(base + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    return {
      status: response.status,
      body: text ? JSON.parse(text) : null,
    };
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

beforeEach(() => {
  listStages.mockReset();
  completeAccountStage.mockReset();
  discardAccountStage.mockReset();
});

describe('GET /api/mcp-account-stages', () => {
  it('lists stages scoped to the session user', async () => {
    const rows = [{ id: 'stage-1', status: 'staged', payload: { name: 'Work' } }];
    listStages.mockResolvedValueOnce(rows);

    const response = await call(appWith(), 'GET', '/api/mcp-account-stages');

    expect(response).toEqual({ status: 200, body: rows });
    expect(listStages).toHaveBeenCalledWith('user-1');
  });
});

describe('POST /api/mcp-account-stages/:id/execute', () => {
  it.each(['foreign', 'absent', 'completed'])(
    '404s a %s stage',
    async suffix => {
      completeAccountStage.mockResolvedValueOnce(null);

      const response = await call(
        appWith(),
        'POST',
        `/api/mcp-account-stages/${suffix}/execute`,
        { auth_pass: 'fresh-password' }
      );

      expect(response.status).toBe(404);
    }
  );

  it('surfaces a defense-in-depth revalidation failure as a shaped error, not a generic 500', async () => {
    completeAccountStage.mockRejectedValueOnce(
      Object.assign(new Error('IMAP: Host cannot be a local address'), { status: 400, expose: true })
    );

    const response = await call(
      appWith(),
      'POST',
      '/api/mcp-account-stages/stage-1/execute',
      { auth_pass: 'fresh-password' }
    );

    expect(response).toEqual({
      status: 400,
      body: { error: 'IMAP: Host cannot be a local address' },
    });
  });

  it('passes fresh credentials to completion and returns the created safe account', async () => {
    const credentials = {
      auth_pass: 'fresh-password',
      oauth_access_token: 'fresh-token',
    };
    const account = {
      id: 'account-1',
      name: 'Work',
      email_address: 'work@example.com',
    };
    completeAccountStage.mockResolvedValueOnce(account);

    const response = await call(
      appWith(),
      'POST',
      '/api/mcp-account-stages/stage-1/execute',
      credentials
    );

    expect(response).toEqual({ status: 200, body: account });
    expect(completeAccountStage).toHaveBeenCalledWith({
      stageId: 'stage-1',
      userId: 'user-1',
      credentials,
    });
  });
});

describe('DELETE /api/mcp-account-stages/:id', () => {
  it('discards a scoped staged account with 204', async () => {
    discardAccountStage.mockResolvedValueOnce(true);

    const response = await call(
      appWith(),
      'DELETE',
      '/api/mcp-account-stages/stage-1'
    );

    expect(response).toEqual({ status: 204, body: null });
    expect(discardAccountStage).toHaveBeenCalledWith({
      stageId: 'stage-1',
      userId: 'user-1',
    });
  });

  it('404s an absent, foreign, completed, or discarded stage', async () => {
    discardAccountStage.mockResolvedValueOnce(false);

    const response = await call(
      appWith(),
      'DELETE',
      '/api/mcp-account-stages/not-staged'
    );

    expect(response.status).toBe(404);
  });
});
