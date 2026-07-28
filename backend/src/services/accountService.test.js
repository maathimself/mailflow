import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  query,
  encrypt,
  validateHost,
  getConnectionPolicy,
  connectAccount,
  disconnectAccount,
} = vi.hoisted(() => ({
  query: vi.fn(),
  encrypt: vi.fn(value => value ? `encrypted:${value}` : value),
  validateHost: vi.fn(),
  getConnectionPolicy: vi.fn(),
  connectAccount: vi.fn(),
  disconnectAccount: vi.fn(),
}));

vi.mock('./db.js', () => ({ query }));
vi.mock('./encryption.js', () => ({ encrypt }));
vi.mock('./hostValidation.js', () => ({ validateHost }));
vi.mock('./connectionPolicy.js', () => ({ getConnectionPolicy }));
vi.mock('../index.js', () => ({
  imapManager: { connectAccount, disconnectAccount },
}));

import { SAFE_FIELDS } from './accountFields.js';
import {
  completeAccountStage,
  createAccount,
  discardAccountStage,
  listStages,
  reconcileConnectionState,
  stageAccount,
} from './accountService.js';

const validFields = {
  name: 'Primary',
  sender_name: 'Sender',
  email_address: 'sender@example.com',
  protocol: 'imap',
  imap_host: 'imap.example.com',
  imap_port: 993,
  smtp_host: 'smtp.example.com',
  smtp_port: 587,
  auth_user: 'sender@example.com',
  auth_pass: 'password',
};

beforeEach(() => {
  query.mockReset();
  encrypt.mockClear();
  validateHost.mockReset().mockResolvedValue(null);
  getConnectionPolicy.mockReset().mockResolvedValue({
    allowPrivateHosts: false,
    allowNonstandardPorts: false,
  });
  connectAccount.mockReset().mockResolvedValue(undefined);
  disconnectAccount.mockReset().mockResolvedValue(undefined);
});

describe('createAccount', () => {
  it('rejects an invalid host', async () => {
    validateHost.mockResolvedValueOnce('Host cannot be a local address');

    await expect(createAccount({ userId: 'user-1', fields: validFields })).resolves.toEqual({
      error: 'IMAP: Host cannot be a local address',
      status: 400,
    });
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects an invalid port', async () => {
    const result = await createAccount({
      userId: 'user-1',
      fields: { ...validFields, imap_port: 25 },
    });

    expect(result).toEqual({
      error: 'IMAP: Port 25 is not allowed. Allowed: 143, 993',
      status: 400,
    });
    expect(query).not.toHaveBeenCalled();
  });

  it('encrypts auth_pass, starts a fire-and-forget connection, and returns only safe fields', async () => {
    const inserted = {
      id: 'account-1',
      user_id: 'user-1',
      ...validFields,
      auth_pass: 'encrypted:password',
      oauth_access_token: 'secret-access',
      oauth_refresh_token: 'secret-refresh',
      signature: '<b onclick="bad()">Sender</b>',
      enabled: true,
    };
    query.mockResolvedValueOnce({ rows: [inserted] });
    connectAccount.mockReturnValueOnce(new Promise(() => {}));

    const result = await createAccount({ userId: 'user-1', fields: validFields });

    expect(encrypt).toHaveBeenCalledWith('password');
    expect(query.mock.calls[0][1]).toContain('encrypted:password');
    expect(connectAccount).toHaveBeenCalledWith(inserted);
    expect(Object.keys(result.account)).toEqual(SAFE_FIELDS);
    expect(result.account.signature).toBe('<b>Sender</b>');
    expect(result.account).not.toHaveProperty('auth_pass');
  });
});

describe('reconcileConnectionState', () => {
  it('disconnects only when disabling', async () => {
    reconcileConnectionState({
      id: 'disable-1',
      updates: { enabled: false },
      before: { gtdFoldersChanged: false },
      updated: { protocol: 'imap', enabled: false },
    });

    await vi.waitFor(() => expect(disconnectAccount).toHaveBeenCalledWith('disable-1'));
    expect(query).not.toHaveBeenCalled();
    expect(connectAccount).not.toHaveBeenCalled();
  });

  it.each([
    ['enabled', { enabled: true }, false],
    ['auth_user', { auth_user: 'new-user' }, false],
    ['auth_pass', { auth_pass: 'new-pass' }, false],
    ['imap_host', { imap_host: 'new.example.com' }, false],
    ['imap_port', { imap_port: 143 }, false],
    ['imap_tls', { imap_tls: false }, false],
    ['imap_skip_tls_verify', { imap_skip_tls_verify: true }, false],
    ['gtd_enabled', { gtd_enabled: true }, false],
    ['gtdFoldersChanged', {}, true],
  ])('reconnects for the %s trigger', async (name, updates, gtdFoldersChanged) => {
    const id = `trigger-${name}`;
    const fresh = { id, protocol: 'imap', enabled: true };
    query.mockResolvedValueOnce({ rows: [fresh] });

    reconcileConnectionState({
      id,
      updates,
      before: { gtdFoldersChanged },
      updated: fresh,
    });

    await vi.waitFor(() => expect(connectAccount).toHaveBeenCalledWith(fresh));
    expect(disconnectAccount).toHaveBeenCalledWith(id);
  });

  it('does nothing when no reconnect field changed', async () => {
    reconcileConnectionState({
      id: 'noop-1',
      updates: { color: '#ffffff' },
      before: { gtdFoldersChanged: false },
      updated: { protocol: 'imap', enabled: true },
    });
    await Promise.resolve();

    expect(disconnectAccount).not.toHaveBeenCalled();
    expect(connectAccount).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('gives disabling precedence over another reconnect trigger', async () => {
    reconcileConnectionState({
      id: 'disable-precedence',
      updates: { enabled: false, auth_user: 'new-user' },
      before: { gtdFoldersChanged: false },
      updated: { protocol: 'imap', enabled: false },
    });

    await vi.waitFor(() => expect(disconnectAccount).toHaveBeenCalledWith('disable-precedence'));
    expect(query).not.toHaveBeenCalled();
    expect(connectAccount).not.toHaveBeenCalled();
  });
});

describe('staged accounts', () => {
  it.each([
    ['auth_pass', ''],
    ['oauth_access_token', null],
    ['oauth_refresh_token', false],
  ])('hard-rejects payloads containing the secret key %s', async (key, value) => {
    const payload = { ...validFields };
    delete payload.auth_pass;
    payload[key] = value;
    await expect(stageAccount({
      userId: 'user-1',
      payload,
    })).rejects.toThrow(`Staged account payload cannot contain ${key}`);
    expect(query).not.toHaveBeenCalled();
  });

  it('validates staged hosts before inserting', async () => {
    validateHost.mockResolvedValueOnce('Host cannot be a local address');
    const payload = { ...validFields };
    delete payload.auth_pass;

    await expect(stageAccount({
      userId: 'user-1',
      payload,
    })).resolves.toEqual({
      error: 'IMAP: Host cannot be a local address',
      status: 400,
    });
    expect(query).not.toHaveBeenCalled();
  });

  it('validates staged ports before inserting', async () => {
    const payload = { ...validFields, smtp_port: 25 };
    delete payload.auth_pass;
    const result = await stageAccount({
      userId: 'user-1',
      payload,
    });

    expect(result).toEqual({
      error: 'SMTP: Port 25 is not allowed. Allowed: 465, 587',
      status: 400,
    });
    expect(query).not.toHaveBeenCalled();
  });

  it('lists only staged rows scoped to the user', async () => {
    const rows = [{ id: 'stage-1', status: 'staged' }];
    query.mockResolvedValueOnce({ rows });

    await expect(listStages('user-1')).resolves.toEqual(rows);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("user_id = $1 AND status = 'staged'"),
      ['user-1']
    );
  });

  it('completes a scoped stage by merging fresh credentials and marking it completed', async () => {
    const payload = { ...validFields };
    delete payload.auth_pass;
    const inserted = {
      id: 'account-from-stage',
      user_id: 'user-1',
      ...payload,
      auth_pass: 'encrypted:fresh-password',
      enabled: true,
    };
    query
      .mockResolvedValueOnce({ rows: [{ id: 'stage-1', payload }] })
      .mockResolvedValueOnce({ rows: [inserted] })
      .mockResolvedValueOnce({ rows: [{ id: 'stage-1', status: 'completed' }] });

    const result = await completeAccountStage({
      stageId: 'stage-1',
      userId: 'user-1',
      credentials: { auth_pass: 'fresh-password' },
    });

    expect(result.id).toBe('account-from-stage');
    expect(encrypt).toHaveBeenCalledWith('fresh-password');
    expect(query.mock.calls[0]).toEqual([
      expect.stringContaining("user_id = $2 AND status = 'staged'"),
      ['stage-1', 'user-1'],
    ]);
    expect(query.mock.calls[1][0]).toContain('INSERT INTO email_accounts');
    expect(query.mock.calls[2]).toEqual([
      expect.stringContaining("SET status = 'completed', completed_account_id = $1"),
      ['account-from-stage', 'stage-1', 'user-1'],
    ]);
  });

  it('returns null when completing a missing, foreign, or non-staged row', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    await expect(completeAccountStage({
      stageId: 'foreign-stage',
      userId: 'user-1',
      credentials: { auth_pass: 'fresh-password' },
    })).resolves.toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('discards only a scoped stage that is still staged', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'stage-1' }] });

    await expect(discardAccountStage({
      stageId: 'stage-1',
      userId: 'user-1',
    })).resolves.toBe(true);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("status = 'staged'"),
      ['stage-1', 'user-1']
    );
  });

  it('cannot discard a missing, foreign, completed, or discarded stage', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    await expect(discardAccountStage({
      stageId: 'not-staged',
      userId: 'user-1',
    })).resolves.toBe(false);
  });
});
