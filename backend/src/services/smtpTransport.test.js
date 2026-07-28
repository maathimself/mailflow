import { afterEach, describe, it, expect, vi } from 'vitest';
import { createSmtpTransport, isPreDeliveryConnectionError } from './smtpTransport.js';

const resolved = {
  host: '203.0.113.10',
  servername: 'smtp.example.com',
  addresses: ['203.0.113.10', '203.0.113.11'],
};

afterEach(() => vi.restoreAllMocks());

describe('createSmtpTransport', () => {
  it('tries the next validated address after a connection-stage failure', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const firstError = Object.assign(new Error('Connection timeout'), { code: 'ETIMEDOUT', command: 'CONN' });
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
    expect(createTransport.mock.calls.map(([options]) => options.host)).toEqual(resolved.addresses);
    expect(createTransport.mock.calls[0][0].connectionTimeout).toBeLessThanOrEqual(10_000);
    expect(close).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['AUTH', 'EAUTH'],
    ['MAIL FROM', 'EENVELOPE'],
    ['DATA', 'ETIMEDOUT'],
  ])('does not retry an ambiguous or post-connect %s failure', async (command, code) => {
    const error = Object.assign(new Error(`${command} failed`), { code, command });
    const createTransport = vi.fn(() => ({ sendMail: vi.fn().mockRejectedValue(error), close: vi.fn() }));

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
    const firstError = Object.assign(new Error('Connection refused'), { command: 'CONN' });
    const verify = vi.fn().mockRejectedValueOnce(firstError).mockResolvedValueOnce(true);
    const createTransport = vi.fn(() => ({ verify, close: vi.fn() }));
    const transport = createSmtpTransport(resolved, { port: 587, secure: false }, createTransport);

    await expect(transport.verify()).resolves.toBe(true);
    expect(createTransport.mock.calls.map(([options]) => options.host)).toEqual(resolved.addresses);
  });

  it('recognizes only CONN errors as unambiguously pre-delivery', () => {
    expect(isPreDeliveryConnectionError({ command: 'CONN' })).toBe(true);
    expect(isPreDeliveryConnectionError({ command: 'AUTH' })).toBe(false);
    expect(isPreDeliveryConnectionError(new Error('timeout'))).toBe(false);
  });
});
