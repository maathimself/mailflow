import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));
import { query } from './db.js';
import { CONNECT_WAIT_MS, reportConnect } from './connectReport.js';

// What a sign-in or "Try again" reports about the account's first connection (#674): only
// "connected" once the mailbox has accepted the login.
describe('reportConnect', () => {
  beforeEach(() => { query.mockReset(); query.mockResolvedValue({ rows: [] }); });

  it('waits about 20 seconds by default', () => {
    expect(CONNECT_WAIT_MS).toBe(20000);
  });

  it('is connected when the connect attempt succeeds', async () => {
    expect(await reportConnect(Promise.resolve(true), 'a1')).toEqual({ connection: 'connected' });
    expect(query).not.toHaveBeenCalled();
  });

  it('is connected as soon as the login is live, before the first sync finishes', async () => {
    let live = false;
    setTimeout(() => { live = true; }, 20);
    const report = await reportConnect(new Promise(() => {}), 'a1', { waitMs: 2000, isConnected: () => live, checkEveryMs: 5 });
    expect(report).toEqual({ connection: 'connected' });
  });

  it('reports the recorded error when the attempt fails', async () => {
    query.mockResolvedValue({ rows: [{ sync_error: 'User is authenticated but not connected.', sync_error_code: 'ms_imap_disabled_personal' }] });
    expect(await reportConnect(Promise.resolve(false), 'a1')).toEqual({
      connection: 'failed', code: 'ms_imap_disabled_personal', error: 'User is authenticated but not connected.',
    });
    expect(query).toHaveBeenCalledWith('SELECT sync_error, sync_error_code FROM email_accounts WHERE id = $1', ['a1']);
  });

  it('treats a rejected attempt like a failed one', async () => {
    query.mockResolvedValue({ rows: [{ sync_error: 'read ETIMEDOUT', sync_error_code: null }] });
    expect(await reportConnect(Promise.reject(new Error('boom')), 'a1')).toEqual({ connection: 'failed', code: 'connection', error: 'read ETIMEDOUT' });
  });

  it('says still connecting when the attempt ended without an error to show', async () => {
    // A first refusal is held back as transient, or another connect was already running.
    expect(await reportConnect(Promise.resolve(false), 'a1')).toEqual({ connection: 'connecting' });
  });

  it('says still connecting when the wait runs out, instead of claiming either outcome', async () => {
    const report = await reportConnect(new Promise(() => {}), 'a1', { waitMs: 30, checkEveryMs: 5 });
    expect(report).toEqual({ connection: 'connecting' });
    expect(query).not.toHaveBeenCalled();
  });
});
