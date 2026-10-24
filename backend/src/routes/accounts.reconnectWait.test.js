import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

// The account row, as the engine and the route see it.
const row = vi.hoisted(() => ({ sync_error: null, sync_error_code: null }));
const engine = vi.hoisted(() => ({
  clearConnectCooldown: vi.fn(), connectAccount: vi.fn(), isConnected: vi.fn(() => false),
  forgetAccountError: vi.fn(async () => { row.sync_error = null; row.sync_error_code = null; }),
}));
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: 'u1' }; next(); } }));
vi.mock('../index.js', () => ({ imapManager: engine }));

import 'express-async-errors';
import express from 'express';
import { query } from '../services/db.js';
import accountRoutes from './accounts.js';

const ID = '11111111-1111-4111-8111-111111111111';

// "Try again" in the sign-in flow has to say whether it worked (#674): ?wait=1 answers with the
// connection report, and without it the reconnect stays in the background as before.
describe('POST /api/accounts/:id/reconnect', () => {
  let server;
  let base;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/accounts', accountRoutes);
    await new Promise(resolve => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(() => new Promise(resolve => server.close(resolve)));
  beforeEach(() => {
    engine.connectAccount.mockReset();
    // The error from before the retry.
    row.sync_error = 'User is authenticated but not connected.';
    row.sync_error_code = 'ms_imap_disabled_personal';
    query.mockReset().mockImplementation(async (sql) => {
      if (/SELECT \* FROM email_accounts WHERE id = \$1 AND user_id = \$2/.test(sql)) return { rows: [{ id: ID, user_id: 'u1' }] };
      if (/SELECT sync_error, sync_error_code/.test(sql)) return { rows: [{ ...row }] };
      return { rows: [] };
    });
  });

  const reconnect = async (qs = '') => (await fetch(`${base}/api/accounts/${ID}/reconnect${qs}`, { method: 'POST' })).json();

  it('answers at once without wait', async () => {
    engine.connectAccount.mockReturnValue(new Promise(() => {}));
    expect(await reconnect()).toEqual({ ok: true });
    expect(engine.clearConnectCooldown).toHaveBeenCalledWith(ID);
  });

  it('with wait, reports the failure the attempt recorded', async () => {
    engine.connectAccount.mockImplementation(async () => {
      row.sync_error = 'User is authenticated but not connected.';
      row.sync_error_code = 'ms_imap_disabled_personal';
      return false;
    });
    expect(await reconnect('?wait=1')).toEqual({
      ok: true, connection: 'failed', code: 'ms_imap_disabled_personal', error: 'User is authenticated but not connected.',
    });
  });

  // connectAccount returns false at once when another connect is running: that is not the
  // previous failure again.
  it('with wait, does not report the error from before as the result', async () => {
    engine.connectAccount.mockResolvedValue(false);
    expect(await reconnect('?wait=1')).toEqual({ ok: true, connection: 'connecting' });
    expect(engine.forgetAccountError).toHaveBeenCalledWith(ID, 'u1');
  });

  it('with wait, reports a connection that worked', async () => {
    engine.connectAccount.mockResolvedValue(true);
    expect(await reconnect('?wait=1')).toEqual({ ok: true, connection: 'connected' });
  });
});
