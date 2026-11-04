import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./redis.js', () => ({ redisClient: { eval: vi.fn(), isReady: true } }));
vi.mock('./safeFetch.js', () => ({ safeFetch: vi.fn() }));
vi.mock('./encryption.js', () => ({ isEncrypted: value => value?.startsWith('encrypted:'), encrypt: value => value ? `encrypted:${value}` : value, decrypt: value => value?.replace(/^encrypted:/, '') }));
import { query } from './db.js';
import { redisClient } from './redis.js';
import { safeFetch } from './safeFetch.js';
import { getWebhook, saveWebhook, notifyWebhook, webhookRequest, validateAdminSettings } from './webhooks.js';

let row, admin;
beforeEach(() => {
  vi.clearAllMocks();
  row = { enabled: true, format: 'generic', url: 'encrypted:https://example.com/secret', token: 'encrypted:private-token', revision: 'rev-1', failures: 0 };
  admin = { enabled: true, allowedOrigins: [] };
  query.mockImplementation(async sql => ({ rows: sql.includes('system_settings') ? [{ value: JSON.stringify(admin) }] : sql.startsWith('SELECT') ? [row] : [] }));
  redisClient.eval.mockResolvedValue(1);
  safeFetch.mockResolvedValue({ ok: true, status: 200, body: { cancel: vi.fn().mockResolvedValue() } });
});
const send = () => notifyWebhook({ userId: 'user-1', accountName: 'Work', count: 2, latest: { fromName: 'Alice', fromEmail: 'alice@example.com', subject: 'Confidential', body: 'Never send this' } });

describe('webhook privacy and configuration', () => {
  it('never exposes secrets in readback', async () => {
    const settings = await getWebhook('user-1');
    expect(settings.urlConfigured).toBe(true);
    expect(settings.tokenConfigured).toBe(true);
    expect(JSON.stringify(settings)).not.toMatch(/secret|private-token|encrypted/);
  });
  it('normalizes exact origins and rejects paths, credentials and non-HTTP schemes', () => {
    expect(validateAdminSettings({ enabled: true, allowedOrigins: ['https://EXAMPLE.com:443/'] }).allowedOrigins).toEqual(['https://example.com']);
    for (const origin of ['https://example.com/path', 'https://example.com/?token=x', 'https://u:p@example.com', 'file:///tmp/test']) {
      expect(() => validateAdminSettings({ enabled: true, allowedOrigins: [origin] })).toThrow();
    }
  });
  it('encrypts new secrets and retains omitted secrets using SQL parameters', async () => {
    await saveWebhook('user-1', { format: 'ntfy', url: 'https://example.com/topic', token: 'new-token', enabled: true });
    let params = query.mock.calls.find(([sql]) => sql.startsWith('INSERT INTO notification_webhooks'))[1];
    expect(params[3]).toBe('encrypted:https://example.com/topic');
    expect(params[4]).toBe('encrypted:new-token');
    query.mockClear();
    await saveWebhook('user-1', { includeSubject: true });
    params = query.mock.calls.find(([sql]) => sql.startsWith('INSERT INTO notification_webhooks'))[1];
    expect(params[3]).toBeNull();
    expect(params[7]).toBe(false);
  });
  it('rejects invalid settings without exposing the submitted URL', async () => {
    for (const input of [{ url: 'ftp://secret.example/topic' }, { token: 'bad\nheader' }, { includeSender: 'true' }, { headers: {} }, { format: 'bark' }]) {
      await expect(saveWebhook('user-1', input)).rejects.toThrow();
    }
    await expect(saveWebhook('user-1', { url: 'http://public.example/topic' })).rejects.toThrow('HTTPS');
  });
  it('requires a destination to enable', async () => {
    row.url = null;
    await expect(saveWebhook('user-1', { enabled: true })).rejects.toThrow('Configure');
  });
});

describe('webhook delivery', () => {
  it('sends only account and count by default using safeFetch without redirects', async () => {
    expect(await send()).toEqual({ sent: true });
    const [url, options, policy] = safeFetch.mock.calls[0];
    expect(url).toBe('https://example.com/secret');
    expect(JSON.parse(options.body)).toEqual({ account: 'Work', count: 2 });
    expect(options.redirect).toBe('error');
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(policy).toEqual({ allowPrivate: false, allowPrivateNetworks: false, requireHttps: true, blockReserved: true, requirePublicHttps: true });
  });
  it('opts sender and subject in separately and never sends bodies', () => {
    const details = { accountName: 'Work', count: 1, latest: { fromEmail: 'alice@example.com', subject: 'Hello', body: 'private' } };
    expect(JSON.parse(webhookRequest({ ...row, include_sender: true }, details).body)).toEqual({ account: 'Work', count: 1, sender: 'alice@example.com' });
    expect(JSON.parse(webhookRequest({ ...row, include_subject: true }, details).body)).toEqual({ account: 'Work', count: 1, subject: 'Hello' });
  });
  it('uses fixed ntfy and Gotify authentication headers', () => {
    const details = { accountName: 'Work', count: 1 };
    expect(webhookRequest({ ...row, format: 'ntfy' }, details).headers.Authorization).toBe('Bearer private-token');
    expect(webhookRequest({ ...row, format: 'gotify' }, details).headers['X-Gotify-Key']).toBe('private-token');
    expect(JSON.parse(webhookRequest({ ...row, format: 'gotify' }, details).body).message).toContain('Work');
  });
  it('grants private-network mode only for an exact origin', async () => {
    admin.allowedOrigins = ['https://example.com:8443'];
    await send();
    expect(safeFetch.mock.calls[0][2].allowPrivateNetworks).toBe(false);
    admin.allowedOrigins = ['https://example.com'];
    await send();
    expect(safeFetch.mock.calls[1][2]).toEqual({ allowPrivate: false, allowPrivateNetworks: true, requireHttps: false, blockReserved: true, requirePublicHttps: true });
  });
  it('skips disabled and rate-limited sends without recording failures', async () => {
    admin.enabled = false;
    expect(await send()).toEqual({ skipped: 'disabled' });
    admin.enabled = true;
    redisClient.eval.mockResolvedValue(0);
    expect(await send()).toEqual({ skipped: 'rate_limit' });
    expect(safeFetch).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]) => sql.startsWith('UPDATE'))).toBe(false);
  });
  it('fails closed when the shared rate limiter is unavailable', async () => {
    redisClient.eval.mockRejectedValue(new Error('redis unavailable'));
    expect(await send()).toEqual({ skipped: 'unavailable' });
    expect(safeFetch).not.toHaveBeenCalled();
  });
  it('records only sanitized errors and guards the configuration revision', async () => {
    safeFetch.mockRejectedValue(new Error('secret URL and token'));
    expect(await send()).toEqual({ error: 'Delivery failed' });
    const [sql, params] = query.mock.calls.find(([sql]) => sql.startsWith('UPDATE'));
    expect(params).toEqual(['user-1', 'rev-1', 'Delivery failed']);
    expect(sql).toContain('revision = $2');
    expect(sql).toContain('failures + 1 >= 5');
  });
  it('clears failures on success and reports status without response body', async () => {
    await send();
    expect(query.mock.calls.find(([sql]) => sql.startsWith('UPDATE'))[1][2]).toBeNull();
    safeFetch.mockResolvedValue({ ok: false, status: 401 });
    expect(await send()).toEqual({ error: 'Endpoint returned HTTP 401' });
  });
  it('reports timeouts without retrying', async () => {
    safeFetch.mockRejectedValue(Object.assign(new Error('secret'), { name: 'TimeoutError' }));
    expect(await send()).toEqual({ error: 'Delivery timed out' });
    expect(safeFetch).toHaveBeenCalledTimes(1);
  });
});

describe('bounded Redis admission', () => {
  it('skips disconnected Redis without queueing a command', async () => {
    redisClient.isReady = false;
    try {
      expect(await send()).toEqual({ skipped: 'unavailable' });
      expect(redisClient.eval).not.toHaveBeenCalled();
      expect(safeFetch).not.toHaveBeenCalled();
    } finally { redisClient.isReady = true; }
  });
  it('times out stalled admission, prevents accumulation, and never delivers it late', async () => {
    vi.useFakeTimers();
    let finish;
    redisClient.eval.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    try {
      const pending = send();
      await vi.advanceTimersByTimeAsync(5000);
      expect(await pending).toEqual({ skipped: 'unavailable' });
      expect(await send()).toEqual({ skipped: 'unavailable' });
      expect(redisClient.eval).toHaveBeenCalledTimes(1);
      expect(query.mock.calls.some(([sql]) => sql.startsWith('UPDATE'))).toBe(false);
      finish(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(safeFetch).not.toHaveBeenCalled();
      expect(await send()).toEqual({ sent: true });
    } finally { finish?.(1); vi.useRealTimers(); }
  });
  it('uses only the remaining five-second budget for HTTP', async () => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    redisClient.eval.mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve(1), 3000)));
    try {
      const pending = send();
      await vi.advanceTimersByTimeAsync(3000);
      expect(await pending).toEqual({ sent: true });
      expect(timeout).toHaveBeenCalledWith(2000);
    } finally { timeout.mockRestore(); vi.useRealTimers(); }
  });
});
