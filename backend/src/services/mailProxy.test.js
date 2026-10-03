import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./hostValidation.js', () => ({ resolveForConnection: vi.fn() }));
import { query } from './db.js';
import { resolveForConnection } from './hostValidation.js';
import { decrypt } from './encryption.js';
import { getAccountProxyUrl, prepareMailProxySettings, publicMailProxySettings, assertProxyDestination, mailConnectionError } from './mailProxy.js';

const previous = { enabled: true, type: 'http', host: 'proxy.example.com', port: 8080, allowPrivate: false, username: '', password: '' };
beforeEach(() => {
  vi.clearAllMocks();
  process.env.ENCRYPTION_KEY = '12'.repeat(32);
  resolveForConnection.mockResolvedValue({ host: '203.0.113.5' });
  query.mockResolvedValue({ rows: [{ value: JSON.stringify(previous) }] });
});
describe('outbound mail proxy settings', () => {
  it('encrypts both credentials, masks reads and keeps omitted secrets', async () => {
    const next = await prepareMailProxySettings({ username: 'a@b', password: 'secret:% /' }, previous);
    expect(next.username).toMatch(/^enc:v1:/);
    expect(next.password).toMatch(/^enc:v1:/);
    expect(decrypt(next.password)).toBe('secret:% /');
    expect(publicMailProxySettings(next)).toEqual({ ...previous, username: undefined, password: undefined, hasUsername: true, hasPassword: true });
    expect(await prepareMailProxySettings({ port: 8081 }, next)).toMatchObject({ password: next.password, username: next.username });
    expect((await prepareMailProxySettings({ password: '' }, next)).password).toBe('');
  });
  it.each([{ host: 'http://user:pass@host' }, { host: 'host/path' }, { host: 'host\r\nX: y' }, { port: 0 }, { port: 65536 }, { type: 'socks5' }, { enabled: 'false' }, { password: 'bad\nsecret' }])('rejects malformed configuration %j', async input => {
    await expect(prepareMailProxySettings(input, previous)).rejects.toThrow();
  });
  it('requires an explicit admin opt-in for a private proxy endpoint', async () => {
    resolveForConnection.mockRejectedValueOnce(new Error('Host cannot be a private or reserved IP address'));
    await expect(prepareMailProxySettings({ host: '127.0.0.1' }, previous)).rejects.toThrow('private');
    await prepareMailProxySettings({ host: '127.0.0.1', allowPrivate: true }, previous);
    expect(resolveForConnection).toHaveBeenLastCalledWith('127.0.0.1', { allowPrivate: true });
  });
  it('leaves direct accounts independent of the proxy configuration', async () => {
    expect(await getAccountProxyUrl({}, 'imap')).toBeUndefined();
    expect(query).not.toHaveBeenCalled();
  });
  it('pins the proxy address and encodes special credentials without exposing them', async () => {
    const settings = await prepareMailProxySettings({ username: 'user@proxy', password: 'a:b/% c' }, previous);
    query.mockResolvedValue({ rows: [{ value: JSON.stringify(settings) }] });
    const url = new URL(await getAccountProxyUrl({ smtp_use_proxy: true }, 'smtp'));
    expect(url.hostname).toBe('203.0.113.5');
    expect(decodeURIComponent(url.username)).toBe('user@proxy');
    expect(decodeURIComponent(url.password)).toBe('a:b/% c');
    expect(resolveForConnection).toHaveBeenLastCalledWith(previous.host, { allowPrivate: false });
  });
  it('formats IPv6 proxy endpoints correctly', async () => {
    resolveForConnection.mockResolvedValue({ host: '2001:db8::5' });
    expect(await getAccountProxyUrl({ imap_use_proxy: true }, 'imap')).toBe('http://[2001:db8::5]:8080/');
  });
  it('fails closed when selected proxy is disabled, unresolved or has corrupt credentials', async () => {
    query.mockResolvedValueOnce({ rows: [{ value: JSON.stringify({ ...previous, enabled: false }) }] });
    await expect(getAccountProxyUrl({ imap_use_proxy: true }, 'imap')).rejects.toMatchObject({ stage: 'proxy' });
    resolveForConnection.mockResolvedValueOnce({ host: 'unresolved.example' });
    await expect(getAccountProxyUrl({ imap_use_proxy: true }, 'imap')).rejects.toThrow('resolved');
    query.mockResolvedValueOnce({ rows: [{ value: JSON.stringify({ ...previous, password: 'enc:v1:bad' }) }] });
    await expect(getAccountProxyUrl({ imap_use_proxy: true }, 'imap')).rejects.toThrow('decrypted');
  });
  it('never delegates destination DNS to the proxy', () => {
    expect(() => assertProxyDestination({ host: 'mail.example.com' })).toThrow('validated');
    expect(() => assertProxyDestination({ host: '203.0.113.4' })).not.toThrow();
  });
  it('distinguishes proxy authentication from provider failures without reflecting untrusted error text', () => {
    expect(mailConnectionError({ message: 'Failed to setup proxy connection', _err: { message: 'HTTP 407 secret' } })).toEqual({ stage: 'proxy', error: 'Proxy authentication failed. Check the proxy credentials.' });
    expect(mailConnectionError({ message: '535 bad secret', code: 'EAUTH' })).toEqual({ stage: 'provider', error: 'Mail server connection or authentication failed. Check the server settings, credentials and TLS policy.' });
    expect(JSON.stringify(mailConnectionError({ code: 'EPROXY', message: 'http://user:secret@proxy' }))).not.toContain('secret');
  });
});
