import { describe, expect, it, vi } from 'vitest';
import { buildSmtpTransport, sanitizeSmtpError } from './smtp.js';

function baseAccount(overrides = {}) {
  return {
    id: 'account-1',
    email_address: 'sender@example.com',
    auth_user: 'smtp-user',
    auth_pass: 'encrypted-password',
    smtp_host: 'smtp.example.com',
    smtp_port: 587,
    smtp_tls: 'STARTTLS',
    imap_skip_tls_verify: false,
    ...overrides,
  };
}

function baseDeps(overrides = {}) {
  return {
    decrypt: vi.fn(value => `decrypted:${value}`),
    refreshMicrosoftToken: vi.fn(),
    getConnectionPolicy: vi.fn().mockResolvedValue({
      allowPrivateHosts: false,
      allowInsecureTls: false,
    }),
    resolveForConnection: vi.fn().mockResolvedValue({
      host: '203.0.113.10',
      servername: 'smtp.example.com',
    }),
    createTransport: vi.fn(options => ({ options })),
    ...overrides,
  };
}

describe('buildSmtpTransport', () => {
  it('refreshes a near-expiry Microsoft account and builds OAuth2 transport options', async () => {
    const refreshed = baseAccount({
      oauth_provider: 'microsoft',
      oauth_access_token: 'new-token',
      oauth_token_expiry: new Date(Date.now() + 3_600_000).toISOString(),
      smtp_port: 465,
    });
    const deps = baseDeps({
      refreshMicrosoftToken: vi.fn().mockResolvedValue(refreshed),
    });
    const stale = { ...refreshed, oauth_access_token: 'old-token', oauth_token_expiry: new Date(0).toISOString() };

    const result = await buildSmtpTransport(stale, deps);

    expect(deps.refreshMicrosoftToken).toHaveBeenCalledWith(stale);
    expect(result.account).toBe(refreshed);
    expect(deps.createTransport).toHaveBeenCalledWith({
      host: '203.0.113.10',
      port: 465,
      secure: true,
      auth: {
        type: 'OAuth2',
        user: 'smtp-user',
        accessToken: 'decrypted:new-token',
      },
      tls: {
        rejectUnauthorized: true,
        servername: 'smtp.example.com',
      },
    });
  });

  it('uses password auth and preserves explicit no-TLS behavior when policy permits it', async () => {
    const deps = baseDeps({
      getConnectionPolicy: vi.fn().mockResolvedValue({
        allowPrivateHosts: true,
        allowInsecureTls: true,
      }),
      resolveForConnection: vi.fn().mockResolvedValue({ host: '10.0.0.2' }),
    });
    const account = baseAccount({ smtp_tls: 'none', imap_skip_tls_verify: true });

    await buildSmtpTransport(account, deps);

    expect(deps.resolveForConnection).toHaveBeenCalledWith('smtp.example.com', { allowPrivate: true });
    expect(deps.createTransport).toHaveBeenCalledWith({
      host: '10.0.0.2',
      port: 587,
      secure: false,
      ignoreTLS: true,
      auth: { user: 'smtp-user', pass: 'decrypted:encrypted-password' },
      tls: { rejectUnauthorized: false },
    });
  });

  it('refuses plain SMTP unless insecure TLS is enabled', async () => {
    const error = await buildSmtpTransport(baseAccount({ smtp_tls: 'none' }), baseDeps()).catch(err => err);
    expect(error).toMatchObject({
      message: 'Plain-text SMTP is not allowed: admin must enable "Allow insecure TLS"',
      status: 403,
      expose: true,
    });
  });

  it.each([
    [baseAccount({ oauth_provider: 'google', oauth_access_token: 'bad' }), 'OAuth access token is corrupted — please reconnect your account.'],
    [baseAccount({ auth_pass: 'bad' }), 'SMTP password is corrupted or missing — please re-enter your account password in Settings.'],
  ])('exposes credential corruption without attempting a connection', async (account, message) => {
    const deps = baseDeps({ decrypt: vi.fn().mockReturnValue(null) });
    const error = await buildSmtpTransport(account, deps).catch(err => err);
    expect(error).toMatchObject({ message, status: 502, expose: true });
    expect(deps.createTransport).not.toHaveBeenCalled();
  });
});

describe('sanitizeSmtpError', () => {
  it.each([
    ['connect ECONNREFUSED 127.0.0.1', 'Could not connect to the mail server. Check your SMTP settings.'],
    ['535 invalid login', 'Authentication failed. Check your email account credentials.'],
    ['server rate limit', 'The mail server is rate limiting sends. Please try again shortly.'],
    ['550 rejected as spam', 'Message was rejected by the mail server.'],
    ['TLS certificate handshake', 'Secure connection to the mail server failed. Check your TLS settings.'],
    ['secret internal server detail', 'Failed to send message. Please try again.'],
  ])('sanitizes %j', (message, expected) => {
    expect(sanitizeSmtpError(new Error(message))).toBe(expected);
  });
});
