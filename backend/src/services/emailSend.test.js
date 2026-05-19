import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./encryption.js', () => ({ decrypt: vi.fn() }));
vi.mock('./hostValidation.js', () => ({ resolveForConnection: vi.fn() }));
vi.mock('../utils/redact.js', () => ({ redactEmail: vi.fn(x => x) }));
vi.mock('../routes/oauth.js', () => ({ refreshMicrosoftToken: vi.fn(a => a) }));
vi.mock('nodemailer', () => ({
  default: {
    createTransport: vi.fn(),
  },
}));
vi.mock('sanitize-html', () => {
  const fn = vi.fn(html => html);
  fn.defaults = { allowedTags: [] };
  return { default: fn };
});

import { query } from './db.js';
import { decrypt } from './encryption.js';
import { resolveForConnection } from './hostValidation.js';
import nodemailer from 'nodemailer';
import { normalizeRecipients, sanitizeHeaderValue, buildSmtpTransport, sendEmail } from './emailSend.js';

beforeEach(() => vi.clearAllMocks());

// ── normalizeRecipients ───────────────────────────────────────────────────────

describe('normalizeRecipients', () => {
  it('throws 400 when input is not an array', () => {
    expect(() => normalizeRecipients('a@b.com', 'to')).toThrow();
    expect(() => normalizeRecipients('a@b.com', 'to')).toThrowError(/must be an array/);
  });

  it('throws 400 on empty string element', () => {
    expect(() => normalizeRecipients([''], 'to')).toThrow(/empty or not a string/);
  });

  it('throws 400 on newline injection', () => {
    expect(() => normalizeRecipients(['a@b.com\r\nBcc: evil@x.com'], 'to')).toThrow(/invalid characters/);
  });

  it('throws 400 on invalid email (no @)', () => {
    expect(() => normalizeRecipients(['notanemail'], 'to')).toThrow(/not a valid email/);
  });

  it('throws 400 on @ at the start', () => {
    expect(() => normalizeRecipients(['@domain.com'], 'to')).toThrow(/not a valid email/);
  });

  it('trims whitespace from addresses', () => {
    const result = normalizeRecipients(['  user@example.com  '], 'to');
    expect(result).toEqual(['user@example.com']);
  });

  it('accepts a valid list', () => {
    const result = normalizeRecipients(['a@b.com', 'c@d.org'], 'to');
    expect(result).toEqual(['a@b.com', 'c@d.org']);
  });
});

// ── sanitizeHeaderValue ───────────────────────────────────────────────────────

describe('sanitizeHeaderValue', () => {
  it('strips carriage return and newline', () => {
    expect(sanitizeHeaderValue('Hello\r\nInjected')).toBe('HelloInjected');
  });

  it('strips null bytes', () => {
    expect(sanitizeHeaderValue('Hi\0there')).toBe('Hithere');
  });

  it('trims whitespace', () => {
    expect(sanitizeHeaderValue('  Subject  ')).toBe('Subject');
  });

  it('returns empty string for non-string', () => {
    expect(sanitizeHeaderValue(null)).toBe('');
    expect(sanitizeHeaderValue(undefined)).toBe('');
  });
});

// ── buildSmtpTransport ────────────────────────────────────────────────────────

describe('buildSmtpTransport', () => {
  it('throws 502 when password decrypt returns falsy', async () => {
    decrypt.mockReturnValueOnce(null);
    resolveForConnection.mockResolvedValueOnce({ host: 'smtp.example.com' });
    const account = { auth_user: 'u', auth_pass: 'enc', smtp_host: 'smtp.example.com', smtp_port: 587 };
    await expect(buildSmtpTransport(account)).rejects.toMatchObject({ status: 502 });
  });

  it('throws 502 when OAuth access token is corrupted', async () => {
    decrypt.mockReturnValueOnce(null);
    const account = {
      oauth_provider: 'google', oauth_access_token: 'enc',
      email_address: 'u@g.com', smtp_host: 'smtp.gmail.com', smtp_port: 587,
    };
    await expect(buildSmtpTransport(account)).rejects.toMatchObject({ status: 502 });
  });

  it('creates transport with password auth', async () => {
    decrypt.mockReturnValueOnce('secret123');
    resolveForConnection.mockResolvedValueOnce({ host: 'smtp.example.com' });
    nodemailer.createTransport.mockReturnValueOnce({ sendMail: vi.fn() });
    const account = {
      auth_user: 'user@example.com', auth_pass: 'enc',
      smtp_host: 'smtp.example.com', smtp_port: 587,
    };
    await buildSmtpTransport(account);
    expect(nodemailer.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ auth: { user: 'user@example.com', pass: 'secret123' } })
    );
  });
});

// ── sendEmail ─────────────────────────────────────────────────────────────────

describe('sendEmail', () => {
  it('throws 400 when accountId missing', async () => {
    await expect(sendEmail({ to: ['a@b.com'], subject: 'Hi', body: '' }, 'u1', null))
      .rejects.toMatchObject({ status: 400 });
  });

  it('throws 400 when to is empty', async () => {
    await expect(sendEmail({ accountId: 'acc1', to: [], subject: 'Hi', body: '' }, 'u1', null))
      .rejects.toMatchObject({ status: 400 });
  });

  it('throws 404 when account not found in DB', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    query.mockResolvedValueOnce({ rows: [] });
    await expect(sendEmail({ accountId: 'acc1', to: ['a@b.com'], subject: 'Hi', body: '' }, 'u1', null))
      .rejects.toMatchObject({ status: 404 });
  });

  it('sends mail via transport for OAuth account (no raw capture)', async () => {
    const sendMail = vi.fn().mockResolvedValue({});
    nodemailer.createTransport.mockReturnValue({ sendMail });
    decrypt.mockReturnValue('tok123');
    resolveForConnection.mockResolvedValue({ host: 'smtp.gmail.com' });

    query.mockResolvedValueOnce({ rows: [{
      id: 'acc1', email_address: 'me@gmail.com', sender_name: 'Me',
      oauth_provider: 'google', oauth_access_token: 'enc',
      smtp_host: 'smtp.gmail.com', smtp_port: 587, signature: null,
      folder_mappings: null,
    }] });
    query.mockResolvedValueOnce({ rows: [{ preferences: {} }] });
    query.mockResolvedValueOnce({ rows: [] });

    await sendEmail({ accountId: 'acc1', to: ['them@example.com'], subject: 'Test', body: 'Hello' }, 'u1', null);

    expect(sendMail).toHaveBeenCalledOnce();
    const opts = sendMail.mock.calls[0][0];
    expect(opts.to).toBe('them@example.com');
    expect(opts.subject).toBe('Test');
  });

  it('throws 400 when attachments is not an array', async () => {
    await expect(sendEmail({
      accountId: 'acc1', to: ['a@b.com'], subject: 'Hi', body: '', attachments: 'bad',
    }, 'u1', null)).rejects.toMatchObject({ status: 400 });
  });

  it('throws 400 when attachment filename is missing', async () => {
    await expect(sendEmail({
      accountId: 'acc1', to: ['a@b.com'], subject: 'Hi', body: '',
      attachments: [{ content: 'abc' }],
    }, 'u1', null)).rejects.toMatchObject({ status: 400 });
  });
});
