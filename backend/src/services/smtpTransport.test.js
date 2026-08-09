import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('nodemailer', () => ({ default: { createTransport: vi.fn() } }));
vi.mock('../routes/oauth.js', () => ({ refreshMicrosoftToken: vi.fn() }));
vi.mock('./encryption.js', () => ({ decrypt: vi.fn(v => v) }));
vi.mock('./connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn() }));
vi.mock('./hostValidation.js', () => ({ resolveForConnection: vi.fn() }));

const nodemailer = (await import('nodemailer')).default;
const { refreshMicrosoftToken } = await import('../routes/oauth.js');
const { getConnectionPolicy } = await import('./connectionPolicy.js');
const { resolveForConnection } = await import('./hostValidation.js');
const {
  createAccountSmtpTransport,
  createSmtpTransport,
  isPreDeliveryConnectionError,
} = await import('./smtpTransport.js');

const resolved = {
  host: '203.0.113.10',
  servername: 'smtp.example.com',
  addresses: ['203.0.113.10', '203.0.113.11'],
};

afterEach(() => vi.restoreAllMocks());

describe('createSmtpTransport', () => {
  it('tries the next validated address after a connection-stage failure', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const firstError = Object.assign(new Error('Connection timeout'), {
      code: 'ETIMEDOUT',
      command: 'CONN',
    });
    const sendMail = vi.fn()
      .mockRejectedValueOnce(firstError)
      .mockResolvedValueOnce({ accepted: ['user@example.com'] });
    const close = vi.fn();
    const createTransport = vi.fn(() => ({ sendMail, close }));

    const transport = createSmtpTransport(
      resolved,
      { port: 465, secure: true, tls: { servername: resolved.servername } },
      createTransport,
    );
    const result = await transport.sendMail({ to: 'user@example.com' });

    expect(result.accepted).toEqual(['user@example.com']);
    expect(createTransport).toHaveBeenCalledTimes(2);
    expect(createTransport.mock.calls.map(([options]) => options.host))
      .toEqual(resolved.addresses);
    expect(createTransport.mock.calls[0][0].connectionTimeout)
      .toBeLessThanOrEqual(10_000);
    expect(close).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['AUTH', 'EAUTH'],
    ['MAIL FROM', 'EENVELOPE'],
    ['DATA', 'ETIMEDOUT'],
  ])('does not retry an ambiguous or post-connect %s failure', async (command, code) => {
    const error = Object.assign(new Error(`${command} failed`), { code, command });
    const createTransport = vi.fn(() => ({
      sendMail: vi.fn().mockRejectedValue(error),
      close: vi.fn(),
    }));

    const transport = createSmtpTransport(
      resolved,
      { port: 587, secure: false },
      createTransport,
    );
    await expect(transport.sendMail({ to: 'user@example.com' })).rejects.toBe(error);

    expect(createTransport).toHaveBeenCalledTimes(1);
  });

  it('applies the same address fallback to SMTP verification', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const firstError = Object.assign(new Error('Connection refused'), {
      command: 'CONN',
    });
    const verify = vi.fn().mockRejectedValueOnce(firstError).mockResolvedValueOnce(true);
    const createTransport = vi.fn(() => ({ verify, close: vi.fn() }));
    const transport = createSmtpTransport(
      resolved,
      { port: 587, secure: false },
      createTransport,
    );

    await expect(transport.verify()).resolves.toBe(true);
    expect(createTransport.mock.calls.map(([options]) => options.host))
      .toEqual(resolved.addresses);
  });

  it('recognizes only CONN errors as unambiguously pre-delivery', () => {
    expect(isPreDeliveryConnectionError({ command: 'CONN' })).toBe(true);
    expect(isPreDeliveryConnectionError({ command: 'AUTH' })).toBe(false);
    expect(isPreDeliveryConnectionError(new Error('timeout'))).toBe(false);
  });
});

describe('createAccountSmtpTransport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getConnectionPolicy.mockResolvedValue({
      allowPrivateHosts: false,
      allowInsecureTls: false,
    });
    resolveForConnection.mockResolvedValue(resolved);
    nodemailer.createTransport.mockReturnValue({
      sendMail: vi.fn().mockResolvedValue({ accepted: ['user@example.com'] }),
      close: vi.fn(),
    });
  });

  it('uses decrypted password credentials without exposing them in the result', async () => {
    const result = await createAccountSmtpTransport({
      smtp_host: 'smtp.example.com',
      smtp_port: 587,
      smtp_tls: 'STARTTLS',
      auth_user: 'sender@example.com',
      auth_pass: 'test-password',
      imap_skip_tls_verify: false,
    });
    await result.transport.sendMail({ to: 'user@example.com' });

    expect(result.error).toBeUndefined();
    expect(nodemailer.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        auth: { user: 'sender@example.com', pass: 'test-password' },
        secure: false,
      })
    );
  });

  it('prefers separate SMTP credentials when the account has them', async () => {
    const result = await createAccountSmtpTransport({
      smtp_host: 'smtp.relay.example',
      smtp_port: 587,
      smtp_tls: 'STARTTLS',
      auth_user: 'sender@example.com',
      auth_pass: 'imap-password',
      smtp_auth_user: 'relay-user',
      smtp_auth_pass: 'relay-password',
      imap_skip_tls_verify: false,
    });
    await result.transport.sendMail({ to: 'user@example.com' });

    expect(result.error).toBeUndefined();
    expect(nodemailer.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        auth: { user: 'relay-user', pass: 'relay-password' },
      })
    );
  });

  it('falls back to the IMAP login for whichever SMTP credential is unset', async () => {
    // Separate SMTP username, but no separate SMTP password -> reuse the IMAP password.
    const result = await createAccountSmtpTransport({
      smtp_host: 'smtp.relay.example',
      smtp_port: 587,
      smtp_tls: 'STARTTLS',
      auth_user: 'sender@example.com',
      auth_pass: 'imap-password',
      smtp_auth_user: 'relay-user',
      smtp_auth_pass: null,
      imap_skip_tls_verify: false,
    });
    await result.transport.sendMail({ to: 'user@example.com' });

    expect(nodemailer.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        auth: { user: 'relay-user', pass: 'imap-password' },
      })
    );
  });

  it('refreshes an expired Microsoft token before creating the transport', async () => {
    refreshMicrosoftToken.mockResolvedValue({
      oauth_provider: 'microsoft',
      oauth_access_token: 'fresh-token',
      oauth_token_expiry: new Date(Date.now() + 5 * 60_000),
      auth_user: 'sender@example.com',
      email_address: 'sender@example.com',
      smtp_host: 'smtp.example.com',
      smtp_port: 587,
      smtp_tls: 'STARTTLS',
    });

    const result = await createAccountSmtpTransport({
      id: 'account-1',
      oauth_provider: 'microsoft',
      oauth_access_token: 'expired-token',
      oauth_token_expiry: new Date(0),
      auth_user: 'sender@example.com',
      email_address: 'sender@example.com',
      smtp_host: 'smtp.example.com',
      smtp_port: 587,
      smtp_tls: 'STARTTLS',
    });

    expect(refreshMicrosoftToken).toHaveBeenCalledTimes(1);
    expect(result.account.oauth_access_token).toBe('fresh-token');
  });

  it('returns a policy error instead of creating a plain-text transport', async () => {
    const result = await createAccountSmtpTransport({
      smtp_host: 'smtp.example.com',
      smtp_port: 25,
      smtp_tls: 'none',
      auth_user: 'sender@example.com',
      auth_pass: 'test-password',
    });

    expect(result).toEqual({
      status: 403,
      error: 'Plain-text SMTP is not allowed: admin must enable "Allow insecure TLS"',
    });
    expect(nodemailer.createTransport).not.toHaveBeenCalled();
  });
});
