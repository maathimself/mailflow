import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
import { query } from '../services/db.js';
import {
  ALL_SCOPES,
  expandScopes,
  generateToken,
  hasScope,
  hashToken,
  resolveScope,
  mcpBearerAuth,
} from './auth.js';

function mockRes() {
  return { statusCode: 200, body: null, status(c){this.statusCode=c;return this;}, json(b){this.body=b;return this;} };
}

describe('token helpers', () => {
  it('exports the complete set of supported scopes', () => {
    expect(ALL_SCOPES).toEqual(['read', 'write', 'send', 'settings']);
  });

  it('adds implied read access to elevated scopes', () => {
    expect(expandScopes(['write'])).toEqual(['write', 'read']);
    expect(expandScopes(['send'])).toEqual(['send', 'read']);
    expect(expandScopes(['settings'])).toEqual(['settings', 'read']);
  });

  it('defaults empty or non-array scope values to read', () => {
    expect(expandScopes([])).toEqual(['read']);
    expect(expandScopes()).toEqual(['read']);
    expect(expandScopes('send')).toEqual(['read']);
  });

  it('checks a single required scope', () => {
    const scope = { scopes: ['read', 'write'] };
    expect(hasScope(scope, 'write')).toBe(true);
    expect(hasScope(scope, 'send')).toBe(false);
    expect(hasScope(scope)).toBe(true);
  });

  it('requires every scope when given an array', () => {
    const scope = { scopes: ['read', 'write', 'settings'] };
    expect(hasScope(scope, ['settings', 'write'])).toBe(true);
    expect(hasScope(scope, ['settings', 'send'])).toBe(false);
  });

  it('generateToken is prefixed and unique', () => {
    const a = generateToken(); const b = generateToken();
    expect(a).toMatch(/^mcp_[A-Za-z0-9_-]{20,}$/);
    expect(a).not.toEqual(b);
  });
  it('hashToken is deterministic hex SHA-256 and hides the plaintext', () => {
    const h = hashToken('mcp_secret');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).toEqual(hashToken('mcp_secret'));
    expect(h).not.toContain('secret');
  });
});

describe('resolveScope', () => {
  it("returns only the token owner's enabled account ids and expanded scopes", async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'acc-1' }, { id: 'acc-2' }] });
    const scope = await resolveScope('user-1', ['send']);
    expect(scope).toEqual({
      userId: 'user-1',
      accountIds: ['acc-1', 'acc-2'],
      scopes: ['send', 'read'],
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringMatching(/FROM email_accounts WHERE user_id = \$1 AND enabled = true/),
      ['user-1'],
    );
  });
});

describe('mcpBearerAuth', () => {
  beforeEach(() => query.mockReset());

  it('rejects a request with no Authorization header', async () => {
    const req = { get: () => undefined }; const res = mockRes(); const next = vi.fn();
    await mcpBearerAuth(req, res, next);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'invalid_token' });
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a malformed (non-Bearer) header', async () => {
    const req = { get: () => 'Basic abc' }; const res = mockRes(); const next = vi.fn();
    await mcpBearerAuth(req, res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects an unknown / revoked token', async () => {
    query.mockResolvedValueOnce({ rows: [] }); // no api_tokens row
    const req = { get: () => 'Bearer mcp_revoked' }; const res = mockRes(); const next = vi.fn();
    await mcpBearerAuth(req, res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('accepts a valid token and attaches the user-scoped account ids', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'tok-1', user_id: 'user-1', scopes: ['write'] }] }) // token lookup
      .mockResolvedValueOnce({ rows: [] })                                   // last_used_at UPDATE
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1' }] });                   // resolveScope
    const req = { get: (h) => (h === 'Authorization' ? 'Bearer mcp_good' : undefined) };
    const res = mockRes(); const next = vi.fn();
    await mcpBearerAuth(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.mcpScope).toEqual({
      userId: 'user-1',
      accountIds: ['acc-1'],
      scopes: ['write', 'read'],
    });
    // token lookup must be by HASH, never the plaintext
    expect(query.mock.calls[0][0]).toMatch(/SELECT id, user_id, scopes FROM api_tokens/);
    expect(query.mock.calls[0][1]).toEqual([hashToken('mcp_good')]);
  });

  it('isolates users: the scope carries only the resolved owner', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'tok-2', user_id: 'user-2' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'acc-9' }] });
    const req = { get: () => 'Bearer mcp_u2' }; const res = mockRes(); const next = vi.fn();
    await mcpBearerAuth(req, res, next);
    expect(req.mcpScope.userId).toBe('user-2');
    expect(req.mcpScope.accountIds).toEqual(['acc-9']);
  });
});
