import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../index.js', () => ({ imapManager: { reconnectAccount: vi.fn().mockResolvedValue(), clearConnectCooldown: vi.fn() } }));
vi.mock('../services/db.js', () => ({ query: vi.fn(), pool: {} }));
vi.mock('../services/redis.js', () => ({ redisClient: {} }));
vi.mock('../services/authLimiter.js', () => ({ reloadAuthSettings: vi.fn() }));
vi.mock('../services/carddavSync.js', () => ({ stopCardavUser: vi.fn() }));
vi.mock('../services/imapManager.js', () => ({ testAccountImapConnection: vi.fn().mockResolvedValue() }));
vi.mock('../services/smtpTransport.js', () => ({ createSmtpTransport: vi.fn(), createAccountSmtpTransport: vi.fn() }));
import express from 'express';
import adminRoutes from './admin.js';
import accountRoutes from './accounts.js';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';
import { testAccountImapConnection } from '../services/imapManager.js';
import { createAccountSmtpTransport } from '../services/smtpTransport.js';

const id = '44444444-4444-4444-4444-444444444444';
let server, base, settings, admin, found;
const verify = vi.fn();
beforeAll(async () => {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.session = { userId: 'user-1' }; next(); });
  app.use('/admin', adminRoutes); app.use('/accounts', accountRoutes);
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise(resolve => server.close(resolve)));
beforeEach(() => {
  vi.clearAllMocks(); process.env.ENCRYPTION_KEY = '12'.repeat(32);
  settings = { enabled: true, type: 'http', host: '127.0.0.1', port: 8080, allowPrivate: true, username: '', password: '' };
  admin = true; found = true;
  verify.mockResolvedValue(true);
  createAccountSmtpTransport.mockResolvedValue({ transport: { verify } });
  query.mockImplementation(async (sql, params) => {
    if (sql.startsWith('SELECT is_admin FROM users')) return { rows: [{ is_admin: admin }] };
    if (sql.startsWith('SELECT id FROM users')) return { rows: [{ id: 'user-1' }] };
    if (sql.startsWith('SELECT key, value FROM system_settings')) return { rows: [{ key: 'outbound_mail_proxy', value: JSON.stringify(settings) }, { key: 'registration_open', value: 'false' }] };
    if (sql.startsWith('SELECT value FROM system_settings')) return { rows: [{ value: JSON.stringify(settings) }] };
    if (sql.includes('INSERT INTO system_settings')) { settings = JSON.parse(params[1]); return { rows: [] }; }
    if (sql.startsWith('SELECT id FROM email_accounts')) return { rows: [{ id }] };
    if (sql.startsWith('SELECT * FROM email_accounts')) return { rows: found ? [{ id, user_id: 'user-1', imap_use_proxy: true, smtp_use_proxy: false }] : [] };
    if (sql.startsWith('UPDATE email_accounts')) return { rows: [{ id, protocol: 'imap', enabled: true, imap_use_proxy: true }] };
    throw new Error(`Unexpected query ${sql}`);
  });
});
const request = (path, method = 'GET', body) => fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });

describe('mail proxy access and connection tests', () => {
  it('rejects endpoint and credential access by non-admins but allows a boolean status', async () => {
    admin = false;
    expect((await request('/admin/mail-proxy')).status).toBe(403);
    expect((await request('/admin/mail-proxy', 'PUT', { enabled: false })).status).toBe(403);
    expect(await (await request('/accounts/proxy-status')).json()).toEqual({ enabled: true });
  });
  it('never exposes proxy secrets in either settings endpoint', async () => {
    await request('/admin/mail-proxy', 'PUT', { username: 'private-user', password: 'private-secret' });
    const response = await (await request('/admin/mail-proxy')).json();
    expect(response).toMatchObject({ hasUsername: true, hasPassword: true });
    expect(JSON.stringify(response)).not.toContain('private-');
    expect(await (await request('/admin/settings')).json()).toEqual({ settings: { registration_open: 'false' } });
    expect(settings.password).toMatch(/^enc:v1:/);
    expect(imapManager.reconnectAccount).toHaveBeenCalledWith(id);
  });
  it('uses the effective saved configuration without sending SMTP mail', async () => {
    expect(await (await request(`/accounts/${id}/test-connection`, 'POST', { protocol: 'imap' })).json()).toEqual({ ok: true, mode: 'proxy' });
    expect(testAccountImapConnection).toHaveBeenCalledWith(expect.objectContaining({ imap_use_proxy: true }));
    expect(await (await request(`/accounts/${id}/test-connection`, 'POST', { protocol: 'smtp' })).json()).toEqual({ ok: true, mode: 'direct' });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('AND user_id = $2'), [id, 'user-1']);
  });
  it('rejects another user’s account and invalid protocols before opening sockets', async () => {
    found = false;
    expect((await request(`/accounts/${id}/test-connection`, 'POST', { protocol: 'imap' })).status).toBe(404);
    expect((await request(`/accounts/${id}/test-connection`, 'POST', { protocol: 'http' })).status).toBe(400);
    expect(testAccountImapConnection).not.toHaveBeenCalled();
    expect(createAccountSmtpTransport).not.toHaveBeenCalled();
  });
  it('reports a redacted proxy error separately from provider errors', async () => {
    testAccountImapConnection.mockRejectedValueOnce(Object.assign(new Error('Proxy rejected secret'), { stage: 'proxy' }));
    const response = await request(`/accounts/${id}/test-connection`, 'POST', { protocol: 'imap' });
    expect(response.status).toBe(502);
    const body = await response.json(); expect(body.stage).toBe('proxy'); expect(body.error).not.toContain('secret');
  });
  it('validates selections and reconnects after a per-account proxy change', async () => {
    expect((await request(`/accounts/${id}`, 'PUT', { imap_use_proxy: 'true' })).status).toBe(400);
    const response = await request(`/accounts/${id}`, 'PUT', { imap_use_proxy: true });
    expect(response.status).toBe(200);
    expect(imapManager.reconnectAccount).toHaveBeenCalledWith(id);
  });
});
