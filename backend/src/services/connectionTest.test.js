import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const {
  ImapFlow,
  makeClientCfg,
  buildSmtpTransport,
  resolveForConnection,
  getConnectionPolicy,
  imapConnect,
  imapLogout,
  imapClose,
  smtpVerify,
  smtpClose,
} = vi.hoisted(() => {
  const imapConnect = vi.fn();
  const imapLogout = vi.fn();
  const imapClose = vi.fn();
  return {
    ImapFlow: vi.fn(function MockImapFlow() {
      this.connect = imapConnect;
      this.logout = imapLogout;
      this.close = imapClose;
    }),
    makeClientCfg: vi.fn(),
    buildSmtpTransport: vi.fn(),
    resolveForConnection: vi.fn(),
    getConnectionPolicy: vi.fn(),
    imapConnect,
    imapLogout,
    imapClose,
    smtpVerify: vi.fn(),
    smtpClose: vi.fn(),
  };
});

vi.mock('imapflow', () => ({ ImapFlow }));
vi.mock('./imapManager.js', () => ({ makeClientCfg }));
vi.mock('./mail/smtp.js', () => ({ buildSmtpTransport }));
vi.mock('./hostValidation.js', () => ({ resolveForConnection }));
vi.mock('./connectionPolicy.js', () => ({ getConnectionPolicy }));

import { testConnection } from './connectionTest.js';

const account = {
  imap_host: 'imap.example.com',
  smtp_host: 'smtp.example.com',
  imap_port: 993,
  smtp_port: 587,
};

beforeEach(() => {
  ImapFlow.mockClear();
  makeClientCfg.mockReset().mockReturnValue({ host: '203.0.113.10' });
  resolveForConnection.mockReset().mockResolvedValue({
    host: '203.0.113.10',
    servername: 'imap.example.com',
  });
  getConnectionPolicy.mockReset().mockResolvedValue({
    allowPrivateHosts: false,
    allowInsecureTls: false,
  });
  imapConnect.mockReset().mockResolvedValue(undefined);
  imapLogout.mockReset().mockResolvedValue(undefined);
  imapClose.mockReset();
  smtpVerify.mockReset().mockResolvedValue(true);
  smtpClose.mockReset();
  buildSmtpTransport.mockReset().mockResolvedValue({
    transport: { verify: smtpVerify, close: smtpClose },
    account,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('testConnection', () => {
  it('returns success for both probes', async () => {
    await expect(testConnection(account)).resolves.toEqual({
      imap: { ok: true },
      smtp: { ok: true },
    });
    expect(imapLogout).toHaveBeenCalledOnce();
    expect(smtpVerify).toHaveBeenCalledOnce();
  });

  it('keeps SMTP successful when IMAP fails', async () => {
    imapConnect.mockRejectedValueOnce(new Error('authenticationFailed: invalid login'));

    const result = await testConnection(account);

    expect(result.imap).toEqual({
      ok: false,
      error: 'Authentication failed. Check your email account credentials.',
    });
    expect(result.smtp).toEqual({ ok: true });
    expect(smtpVerify).toHaveBeenCalledOnce();
  });

  it('keeps IMAP successful when SMTP fails', async () => {
    smtpVerify.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));

    const result = await testConnection(account);

    expect(result.imap).toEqual({ ok: true });
    expect(result.smtp).toEqual({
      ok: false,
      error: 'Could not connect to the mail server. Check your SMTP settings.',
    });
  });

  it('force-closes a timed-out IMAP probe without hanging SMTP', async () => {
    vi.useFakeTimers();
    imapConnect.mockReturnValueOnce(new Promise(() => {}));

    const pending = testConnection(account);
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await pending;

    expect(imapClose).toHaveBeenCalled();
    expect(result.imap).toEqual({
      ok: false,
      error: 'Connection test timed out. Check your mail server settings.',
    });
    expect(result.smtp).toEqual({ ok: true });
  });

  it('force-closes a timed-out SMTP probe without hanging IMAP', async () => {
    vi.useFakeTimers();
    smtpVerify.mockReturnValueOnce(new Promise(() => {}));

    const pending = testConnection(account);
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await pending;

    expect(smtpClose).toHaveBeenCalled();
    expect(result.imap).toEqual({ ok: true });
    expect(result.smtp).toEqual({
      ok: false,
      error: 'Connection test timed out. Check your mail server settings.',
    });
  });

  it('imports only the named makeClientCfg helper from imapManager', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./connectionTest.js', import.meta.url)),
      'utf8'
    );
    const imapManagerImport = source.match(
      /import\s+([^;]+)\s+from\s+['"]\.\/imapManager\.js['"]/
    );

    expect(imapManagerImport?.[1]).toMatch(/^\{\s*makeClientCfg\s*\}$/);
    expect(source).not.toMatch(/import\s+imapManager\b/);
    expect(source.replace(/^import .*$/gm, '')).not.toMatch(/\bimapManager\./);
  });
});
