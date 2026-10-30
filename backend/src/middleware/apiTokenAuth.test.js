import { describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../services/redis.js', () => ({ redisClient: {} }));

import { attachTokenIdentity } from './apiTokenAuth.js';
import { matchApiTokenRoute } from '../services/apiTokenAllowlist.js';

const TOKEN = {
  id: 't1', user_id: 'u1', username: 'maria', name: 'Claude', scopes: ['read'],
  created_at: new Date('2026-10-01T00:00:00Z'), expires_at: null,
};

function tokenRequest() {
  const req = {};
  attachTokenIdentity(req, TOKEN, matchApiTokenRoute('GET', '/api/mail/messages'));
  return req;
}

describe('the identity a token request carries', () => {
  it('names the user and the token, never as an admin, for this request only', () => {
    const req = tokenRequest();
    expect({ ...req.session }).toEqual({ userId: 'u1', username: 'maria', apiTokenId: 't1', isAdmin: false });
    expect(req.apiToken).toMatchObject({ id: 't1', userId: 'u1', username: 'maria', name: 'Claude', scopes: ['read'] });
    expect(req.apiToken.route.path).toBe('/api/mail/messages');
    // Nothing that writes it out finds the session's methods.
    expect(JSON.parse(JSON.stringify(req.session))).toEqual({ userId: 'u1', username: 'maria', apiTokenId: 't1', isAdmin: false });
  });

  it('ends for the rest of the request when destroyed, as a session does', () => {
    const req = tokenRequest();
    const callback = vi.fn();
    req.session.destroy(callback);
    expect(callback).toHaveBeenCalledWith();
    expect(req.session).toBeUndefined();
    expect(req.apiToken).toBeUndefined();
    // Without a callback too.
    const other = tokenRequest();
    other.session.destroy();
    expect(other.session).toBeUndefined();
  });

  it.each(['save', 'regenerate', 'reload'])('fails loudly on %s, which a token request has no session for', (operation) => {
    const req = tokenRequest();
    const callback = vi.fn();
    req.session[operation](callback);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(callback.mock.calls[0][0].message).toBe(`API token requests have no session to ${operation}`);
    expect(() => req.session[operation]()).toThrow(`API token requests have no session to ${operation}`);
    // The identity is left as it was.
    expect(req.session.userId).toBe('u1');
  });

  it('takes touch as a no-op', () => {
    const req = tokenRequest();
    expect(req.session.touch()).toBe(req.session);
    expect({ ...req.session }).toEqual({ userId: 'u1', username: 'maria', apiTokenId: 't1', isAdmin: false });
  });
});
