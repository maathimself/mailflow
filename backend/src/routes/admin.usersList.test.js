import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn(), pool: {} }));
vi.mock('../index.js', () => ({ imapManager: { disconnectUser: vi.fn() } }));
vi.mock('../services/encryption.js', () => ({ decrypt: v => v, encrypt: v => v }));
vi.mock('../services/hostValidation.js', () => ({ validateHost: vi.fn(), resolveForConnection: vi.fn() }));
vi.mock('../services/smtpTransport.js', () => ({ createSmtpTransport: vi.fn() }));
vi.mock('../services/connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn(), invalidateConnectionPolicyCache: vi.fn() }));
vi.mock('../services/authLimiter.js', () => ({ reloadAuthSettings: vi.fn() }));
vi.mock('../services/carddavSync.js', () => ({ stopCardavUser: vi.fn() }));
vi.mock('../plugins/registry.js', () => ({ pluginRegistry: { runHook: vi.fn() } }));
vi.mock('../services/redis.js', () => ({ redisClient: {} }));

import { query } from '../services/db.js';
import { listUsers } from './admin.js';

const reply = () => ({ status: vi.fn().mockReturnThis(), json: vi.fn() });

beforeEach(() => query.mockReset());

describe('GET /admin/users', () => {
  it('passes on a profile photo only when it is a raster image data URL', async () => {
    const photo = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';
    const rows = [
      { id: 'a', username: 'foto', is_admin: false, totp_enabled: false, avatar: photo },
      { id: 'b', username: 'sem', is_admin: false, totp_enabled: false, avatar: null },
      { id: 'c', username: 'html', is_admin: false, totp_enabled: false, avatar: 'data:text/html;base64,PHNjcmlwdD4=' },
      { id: 'd', username: 'svg', is_admin: false, totp_enabled: false, avatar: 'data:image/svg+xml;base64,PHN2Zz4=' },
      { id: 'e', username: 'url', is_admin: false, totp_enabled: false, avatar: 'https://tracker.example/pixel.png' },
      { id: 'f', username: 'png', is_admin: true, totp_enabled: true, avatar: 'data:image/png;base64,iVBORw0KGgo=' },
    ];
    query.mockResolvedValueOnce({ rows }).mockResolvedValueOnce({ rows: [{ total: String(rows.length) }] });
    const res = reply();
    await listUsers({ query: {} }, res);
    const { users, total } = res.json.mock.calls[0][0];
    expect(Object.fromEntries(users.map(u => [u.username, u.avatar]))).toEqual({
      foto: photo, sem: null, html: null, svg: null, url: null, png: 'data:image/png;base64,iVBORw0KGgo=',
    });
    expect(users.find(u => u.username === 'png')).toMatchObject({ isAdmin: true, totpEnabled: true });
    expect(total).toBe(6);
  });
});
