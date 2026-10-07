import { createServer } from 'net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('nodemailer', () => ({ default: { createTransport: vi.fn() } }));
vi.mock('../routes/oauth.js', () => ({ refreshMicrosoftToken: vi.fn(), refreshGoogleToken: vi.fn() }));
vi.mock('./encryption.js', () => ({ decrypt: vi.fn(v => v) }));
vi.mock('./connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn() }));
vi.mock('./hostValidation.js', () => ({ resolveForConnection: vi.fn() }));

const nodemailer = (await import('nodemailer')).default;
const { refreshMicrosoftToken, refreshGoogleToken } = await import('../routes/oauth.js');
const { getConnectionPolicy } = await import('./connectionPolicy.js');
const { resolveForConnection } = await import('./hostValidation.js');
const {
  createAccountSmtpTransport,
  createSmtpTransport,
  isPreDeliveryConnectionError,
  smtpClientName,
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

  it('identifies itself to the server with the instance hostname, not [127.0.0.1] (#492)', async () => {
    // nodemailer's EHLO default is os.hostname(), which in a container is a bare label,
    // and nodemailer then substitutes `[127.0.0.1]` — which Bluehost's spam router logged
    // as "Sender Host: 127.0.0.1" and treated as forgery, discarding the mail.
    const prev = process.env.APP_URL;
    process.env.APP_URL = 'https://mail.example.com';
    try {
      const createTransport = vi.fn(() => ({
        sendMail: vi.fn().mockResolvedValue({ accepted: ['a@b.c'] }),
        close: vi.fn(),
      }));
      const transport = createSmtpTransport(resolved, { port: 465, secure: true }, createTransport);
      await transport.sendMail({ to: 'a@b.c' });
      expect(createTransport.mock.calls[0][0].name).toBe('mail.example.com');
    } finally {
      if (prev === undefined) delete process.env.APP_URL; else process.env.APP_URL = prev;
    }
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

// Its EHLO reply offers AUTH but not STARTTLS, as a relay without TLS does, or as any EHLO
// does after someone on the path has stripped STARTTLS from it.
async function startSmtpServerWithoutStarttls() {
  const commands = [];
  const sockets = new Set();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    let buffered = '';
    let inData = false;
    socket.write('220 smtp.example.com ESMTP\r\n');
    socket.on('data', chunk => {
      buffered += chunk.toString('latin1');
      let end;
      while ((end = buffered.indexOf('\r\n')) >= 0) {
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            socket.write('250 2.0.0 Queued\r\n');
          }
          continue;
        }
        const verb = line.split(' ')[0].toUpperCase();
        commands.push(verb);
        if (verb === 'EHLO') socket.write('250-smtp.example.com\r\n250 AUTH PLAIN\r\n');
        else if (verb === 'AUTH') socket.write('235 2.7.0 Authentication successful\r\n');
        else if (verb === 'MAIL' || verb === 'RCPT') socket.write('250 2.1.0 OK\r\n');
        else if (verb === 'DATA') {
          inData = true;
          socket.write('354 Go ahead\r\n');
        } else if (verb === 'QUIT') socket.end('221 2.0.0 Bye\r\n');
        else socket.write('502 5.5.1 Unrecognized command\r\n');
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    commands,
    close: () => {
      for (const socket of sockets) socket.destroy();
      return new Promise(resolve => server.close(resolve));
    },
  };
}

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

  it('refreshes an expired Google token before creating the transport', async () => {
    refreshGoogleToken.mockResolvedValue({
      oauth_provider: 'google',
      oauth_access_token: 'fresh-google-token',
      oauth_token_expiry: new Date(Date.now() + 5 * 60_000),
      auth_user: 'sender@gmail.com',
      email_address: 'sender@gmail.com',
      smtp_host: 'smtp.gmail.com',
      smtp_port: 587,
      smtp_tls: 'STARTTLS',
    });

    const result = await createAccountSmtpTransport({
      id: 'account-2',
      oauth_provider: 'google',
      oauth_access_token: 'expired-token',
      oauth_token_expiry: new Date(0),
      auth_user: 'sender@gmail.com',
      email_address: 'sender@gmail.com',
      smtp_host: 'smtp.gmail.com',
      smtp_port: 587,
      smtp_tls: 'STARTTLS',
    });

    expect(refreshGoogleToken).toHaveBeenCalledTimes(1);
    expect(refreshMicrosoftToken).not.toHaveBeenCalled();
    expect(result.account.oauth_access_token).toBe('fresh-google-token');
  });

  it('leaves a still-valid Google token alone', async () => {
    const result = await createAccountSmtpTransport({
      id: 'account-3',
      oauth_provider: 'google',
      oauth_access_token: 'valid-token',
      oauth_token_expiry: new Date(Date.now() + 60 * 60_000),
      auth_user: 'sender@gmail.com',
      email_address: 'sender@gmail.com',
      smtp_host: 'smtp.gmail.com',
      smtp_port: 587,
      smtp_tls: 'STARTTLS',
    });

    expect(refreshGoogleToken).not.toHaveBeenCalled();
    expect(result.account.oauth_access_token).toBe('valid-token');
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

  async function sendToServerWithoutStarttls() {
    const server = await startSmtpServerWithoutStarttls();
    try {
      const { default: realNodemailer } = await vi.importActual('nodemailer');
      nodemailer.createTransport.mockImplementation(realNodemailer.createTransport);
      resolveForConnection.mockResolvedValue({ host: '127.0.0.1', addresses: ['127.0.0.1'] });

      const result = await createAccountSmtpTransport({
        smtp_host: 'smtp.example.com',
        smtp_port: server.port,
        smtp_tls: 'STARTTLS',
        auth_user: 'sender@example.com',
        auth_pass: 'test-password',
      });
      const outcome = await result.transport
        .sendMail({ from: 'sender@example.com', to: 'user@example.com', text: 'Hello' })
        .catch(err => err);
      return { commands: server.commands, outcome };
    } finally {
      await server.close();
    }
  }

  it('fails instead of authenticating in cleartext when EHLO does not offer STARTTLS', async () => {
    const { commands, outcome } = await sendToServerWithoutStarttls();

    expect(commands).toEqual(['EHLO', 'STARTTLS']);
    expect(outcome).toMatchObject({ code: 'ETLS', command: 'STARTTLS' });
  });

  it('still sends to a server without STARTTLS when the admin allows insecure TLS', async () => {
    getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: false, allowInsecureTls: true });

    const { commands, outcome } = await sendToServerWithoutStarttls();

    expect(outcome.accepted).toEqual(['user@example.com']);
    expect(commands).toContain('AUTH');
    expect(commands).not.toContain('STARTTLS');
  });
});

describe('smtpClientName (#492)', () => {
  it('prefers an explicit SMTP_EHLO_NAME', () => {
    expect(smtpClientName({ SMTP_EHLO_NAME: 'mx.corp.example', APP_URL: 'https://other.example.com' })).toBe('mx.corp.example');
  });
  it('falls back to the APP_URL hostname when it is a real FQDN', () => {
    expect(smtpClientName({ APP_URL: 'https://mail.example.com/base' })).toBe('mail.example.com');
  });
  it.each([
    [{ APP_URL: 'https://192.168.1.5' }],          // an IP EHLO is the same spam signal
    [{ APP_URL: 'https://mailflow' }],             // bare label: no better than the default
    [{ APP_URL: 'not a url' }],
    [{}],
  ])('leaves nodemailer\'s default alone for %j', (env) => {
    expect(smtpClientName(env)).toBeUndefined();
  });
});
