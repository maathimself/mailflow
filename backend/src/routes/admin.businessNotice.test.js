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
import { businessNoticeDue, getBusinessNotice, setBusinessNotice } from './admin.js';

const reply = () => ({ status: vi.fn().mockReturnThis(), json: vi.fn() });
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = n => new Date(Date.now() - n * DAY).toISOString();

// Queries run in this order: stored answer, user count + first user, enabled SSO providers
function mockState({ state = null, users = 1, firstDaysAgo = 30, oidc = 0 } = {}) {
  query
    .mockResolvedValueOnce({ rows: state === null ? [] : [{ value: state }] })
    .mockResolvedValueOnce({ rows: [{ total: String(users), first: users ? daysAgo(firstDaysAgo) : null }] })
    .mockResolvedValueOnce({ rows: [{ count: String(oidc) }] });
}

async function shown(opts) {
  mockState(opts);
  const res = reply();
  await getBusinessNotice({}, res);
  return res.json.mock.calls[0][0].show;
}

beforeEach(() => query.mockReset());

describe('GET /admin/business-notice', () => {
  it('shows on an instance with 3 or more users in use for 14 days', async () => {
    expect(await shown({ users: 3 })).toBe(true);
  });

  it('shows on a small instance with single sign-on configured', async () => {
    expect(await shown({ users: 1, oidc: 1 })).toBe(true);
  });

  it('stays hidden on a personal instance', async () => {
    expect(await shown({ users: 2 })).toBe(false);
  });

  it('waits until the instance has been in use for 14 days', async () => {
    expect(await shown({ users: 5, firstDaysAgo: 3 })).toBe(false);
  });

  it('stays hidden for good once an admin answered', async () => {
    expect(await shown({ users: 5, state: 'licensed' })).toBe(false);
    expect(await shown({ users: 5, state: 'not_business' })).toBe(false);
  });

  it('comes back after a reminder date passes', async () => {
    expect(await shown({ users: 5, state: `later:${new Date(Date.now() + DAY).toISOString()}` })).toBe(false);
    expect(await shown({ users: 5, state: `later:${new Date(Date.now() - DAY).toISOString()}` })).toBe(true);
  });
});

describe('businessNoticeDue', () => {
  it('treats an unreadable reminder as due rather than hiding the notice forever', () => {
    expect(businessNoticeDue('later:not-a-date')).toBe(true);
    expect(businessNoticeDue('something-else')).toBe(true);
  });
});

describe('POST /admin/business-notice', () => {
  it('stores a final answer as is', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const res = reply();
    await setBusinessNotice({ body: { choice: 'licensed' } }, res);
    expect(query.mock.calls[0][1]).toEqual(['business_notice', 'licensed']);
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });

  it('stores a reminder 30 days out', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await setBusinessNotice({ body: { choice: 'later' } }, reply());
    const [, value] = query.mock.calls[0][1];
    const until = new Date(value.replace(/^later:/, '')).getTime();
    expect(Math.round((until - Date.now()) / DAY)).toBe(30);
  });

  it('rejects anything else without writing', async () => {
    for (const body of [{ choice: 'nope' }, {}, undefined]) {
      const res = reply();
      await setBusinessNotice({ body }, res);
      expect(res.status).toHaveBeenCalledWith(400);
    }
    expect(query).not.toHaveBeenCalled();
  });
});
