import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../index.js', () => ({ imapManager: {} }));
vi.mock('../services/db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock('../services/encryption.js', () => ({ encrypt: (v) => v, decrypt: (v) => v }));

import express from 'express';
import oauthRoutes from './oauth.js';
import { MAILFLOW_MS_CLIENT_ID } from '../services/microsoftBuiltinApp.js';
import { msBuiltinAppShipped } from '../services/microsoftOAuthClient.js';

// Until MailFlow's registered client ID replaces the all-zero placeholder, a build has no
// built-in app and the device-code flow behaves as it did before #674.
describe.skipIf(msBuiltinAppShipped())('built-in Microsoft app placeholder', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.MS_CLIENT_ID;
  });

  it('is the all-zero placeholder', () => {
    expect(MAILFLOW_MS_CLIENT_ID).toBe('00000000-0000-0000-0000-000000000000');
  });

  it('returns the not-configured error without calling Microsoft', async () => {
    delete process.env.MS_CLIENT_ID;
    const fetchMock = vi.fn();
    const app = express();
    app.use((req, _res, next) => { req.session = { userId: 'user-1' }; next(); });
    app.use('/oauth', oauthRoutes);
    const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fetchMock);
    try {
      const res = await realFetch(`http://127.0.0.1:${server.address().port}/oauth/microsoft/device`, { method: 'POST' });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/Microsoft integration not configured/);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
});
