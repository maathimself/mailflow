import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => {
  const query = vi.fn();
  return { query, pool: {}, withTransaction: vi.fn(async fn => fn({ query })) };
});
vi.mock('../index.js', () => ({ imapManager: {} }));
vi.mock('../services/encryption.js', () => ({ decrypt: v => v, encrypt: v => v }));
vi.mock('../services/hostValidation.js', () => ({ validateHost: vi.fn(), resolveForConnection: vi.fn() }));
vi.mock('../services/smtpTransport.js', () => ({ createSmtpTransport: vi.fn() }));
vi.mock('../services/connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn(), invalidateConnectionPolicyCache: vi.fn() }));
vi.mock('../services/authLimiter.js', () => ({ reloadAuthSettings: vi.fn() }));
vi.mock('../services/carddavSync.js', () => ({ stopCardavUser: vi.fn() }));
vi.mock('../plugins/registry.js', () => ({ pluginRegistry: { runHook: vi.fn() } }));
vi.mock('../services/userSessions.js', () => ({ destroyUserSessions: vi.fn() }));
vi.mock('../services/kvStore.js', () => ({ kv: {} }));
vi.mock('../services/authEvents.js', () => ({ logAuthEvent: vi.fn() }));
vi.mock('../services/userIdentities.js', () => ({
  listUserIdentities: vi.fn(), removeIdentitiesForPasswordReset: vi.fn(), unlinkUserIdentity: vi.fn(),
}));

import { query } from '../services/db.js';
import { destroyUserSessions } from '../services/userSessions.js';
import { logAuthEvent } from '../services/authEvents.js';
import { listUserIdentities, removeIdentitiesForPasswordReset, unlinkUserIdentity } from '../services/userIdentities.js';
import { listIdentities, unlinkIdentity, setUserPassword } from './admin.js';

// #714: an admin can see a user's linked single sign-on accounts and unlink one, and every link
// removed shows in the security log with the admin who removed it.
const ADMIN = 'aaaaaaaa-0000-4000-8000-000000000001';
const USER = 'bbbbbbbb-0000-4000-8000-000000000002';
const IDENTITY = 'cccccccc-0000-4000-8000-000000000003';
const reply = () => ({ status: vi.fn().mockReturnThis(), json: vi.fn() });
const request = (params, body) => ({ params, body, query: {}, ip: '203.0.113.7', session: { userId: ADMIN, username: 'admin' }, sessionID: 'current-session' });
const unlinkEvents = () => logAuthEvent.mock.calls.filter(([type]) => type === 'identity_unlinked').map(([, e]) => e);

beforeEach(() => {
  vi.clearAllMocks();
  query.mockImplementation(async sql => ({ rows: sql.includes('FROM users WHERE id') ? [{ username: 'maria' }] : [] }));
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('GET /admin/users/:id/identities', () => {
  it("lists the user's identities", async () => {
    listUserIdentities.mockResolvedValue([{ id: IDENTITY, provider_name: 'Pocket ID' }]);
    const res = reply();
    await listIdentities(request({ id: USER }), res);
    expect(listUserIdentities.mock.calls[0][1]).toBe(USER);
    expect(res.json).toHaveBeenCalledWith({ identities: [{ id: IDENTITY, provider_name: 'Pocket ID' }] });
  });

  it('answers 404 for a user that does not exist', async () => {
    query.mockResolvedValue({ rows: [] });
    const res = reply();
    await listIdentities(request({ id: USER }), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });
});

describe('DELETE /admin/users/:id/identities/:identityId', () => {
  it('unlinks it, signs the user out and logs who did it', async () => {
    unlinkUserIdentity.mockResolvedValue({ identity: { id: IDENTITY, provider_name: 'Pocket ID' } });
    const res = reply();
    await unlinkIdentity(request({ id: USER, identityId: IDENTITY }), res);
    expect(unlinkUserIdentity.mock.calls[0].slice(1)).toEqual([USER, IDENTITY]);
    expect(destroyUserSessions).toHaveBeenCalledWith(USER, { exceptSessionId: undefined });
    expect(unlinkEvents()).toEqual([expect.objectContaining({ userId: USER, username: 'maria', actorUsername: 'maria', success: true })]);
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });

  it("refuses to take the user's last way to sign in", async () => {
    unlinkUserIdentity.mockResolvedValue({ lastSignIn: true });
    const res = reply();
    await unlinkIdentity(request({ id: USER, identityId: IDENTITY }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(destroyUserSessions).not.toHaveBeenCalled();
    expect(unlinkEvents()).toEqual([]);
  });

  it("answers 404 for another user's identity", async () => {
    unlinkUserIdentity.mockResolvedValue({ notFound: true });
    const res = reply();
    await unlinkIdentity(request({ id: USER, identityId: IDENTITY }), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });
});

describe('POST /admin/users/:id/password', () => {
  it('removes the linked identities in the same transaction and logs each one', async () => {
    removeIdentitiesForPasswordReset.mockResolvedValue([{ provider_name: 'Pocket ID' }, { provider_name: 'Google' }]);
    await setUserPassword(request({ id: USER }, { password: 'nova-senha-123' }), reply());
    expect(removeIdentitiesForPasswordReset.mock.calls[0][1]).toBe(USER);
    expect(unlinkEvents()).toHaveLength(2);
  });
});
