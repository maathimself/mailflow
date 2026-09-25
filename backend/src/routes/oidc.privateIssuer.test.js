import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// #494: a LAN issuer with a valid publicly-trusted certificate was rejected even with the
// admin's "Allow private / local hosts" policy ON — the OIDC paths called validateHost
// without the policy, unlike every other validateHost caller, and the only escape hatch
// (allow_insecure) also disables TLS verification. These pin that the runtime discovery
// path threads the policy through to BOTH the issuer host check and the endpoint host
// checks, so a private issuer works with full TLS verification.
vi.mock('../services/db.js', () => ({ query: vi.fn(), pool: {} }));
vi.mock('../services/encryption.js', () => ({ decrypt: (v) => v, isEncrypted: () => false }));
vi.mock('../index.js', () => ({ imapManager: {} }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (_req, _res, next) => next() }));
vi.mock('../services/authEvents.js', () => ({ logAuthEvent: vi.fn() }));
vi.mock('../services/hostValidation.js', () => ({ validateHost: vi.fn(async () => null) }));
vi.mock('../services/connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn(async () => ({ allowPrivateHosts: true })) }));

import { query } from '../services/db.js';
import { validateHost } from '../services/hostValidation.js';
import { getConnectionPolicy } from '../services/connectionPolicy.js';
import { buildEndSessionUrl } from './oidc.js';

const realFetch = global.fetch;
const issuer = 'https://auth.lan.example.org';
const discoveryDoc = {
  issuer,
  authorization_endpoint: `${issuer}/authorize`,
  token_endpoint: `${issuer}/token`,
  jwks_uri: `${issuer}/jwks`,
  end_session_endpoint: `${issuer}/end-session`,
};

beforeAll(() => {
  process.env.APP_URL = 'https://mail.example.com';
  global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => discoveryDoc }));
});
afterAll(() => {
  global.fetch = realFetch;
  delete process.env.APP_URL;
});
beforeEach(() => {
  query.mockReset();
  validateHost.mockClear();
  getConnectionPolicy.mockClear();
});

describe('OIDC discovery honors the allow-private-hosts policy (#494)', () => {
  it('passes the policy to every runtime host check, with TLS verification untouched', async () => {
    query.mockResolvedValue({ rows: [{ issuer_url: issuer, client_id: 'cid', allow_insecure: false, rp_initiated_logout: true }] });

    // buildEndSessionUrl drives the real getDiscovery, which is where the runtime checks live.
    const url = await buildEndSessionUrl({ providerId: 'p1', idToken: 'tok' });

    expect(url).toBeTruthy(); // discovery succeeded with the policy allowing the host
    expect(getConnectionPolicy).toHaveBeenCalled();
    // Issuer host plus the three endpoint hosts — every check carries the policy. A call
    // WITHOUT the options object is exactly the #494 bug (defaults to allowPrivate false).
    expect(validateHost.mock.calls.length).toBeGreaterThanOrEqual(4);
    for (const call of validateHost.mock.calls) {
      expect(call[1]).toEqual({ allowPrivate: true });
    }
  });

  it('a rejected issuer host still blocks discovery (the policy is consulted, not bypassed)', async () => {
    query.mockResolvedValue({ rows: [{ issuer_url: issuer, client_id: 'cid', allow_insecure: false, rp_initiated_logout: true }] });
    validateHost.mockResolvedValueOnce('Host cannot be a private or reserved IP address');

    // buildEndSessionUrl never throws (logout must succeed locally), so a rejected host
    // surfaces as null — and discovery must not have been fetched.
    global.fetch.mockClear();
    expect(await buildEndSessionUrl({ providerId: 'p1', idToken: 'tok' })).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
