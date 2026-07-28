import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';

// buildEndSessionUrl is the core of RP-initiated (end-session) logout (#310). It must:
//  - return null unless a provider is on the session AND its rp_initiated_logout toggle is on
//  - return null when discovery advertises no end_session_endpoint
//  - otherwise return the IdP end-session URL carrying id_token_hint, client_id, and
//    post_logout_redirect_uri
//  - never throw (logout must always succeed locally)
// db, discovery (fetch), and the modules oidc.js imports are stubbed to isolate the logic.
vi.mock('../services/db.js', () => ({ query: vi.fn(), pool: {} }));
vi.mock('../services/encryption.js', () => ({ decrypt: (v) => v, isEncrypted: () => false }));
vi.mock('../index.js', () => ({ imapManager: {} }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (_req, _res, next) => next() }));
vi.mock('../services/authEvents.js', () => ({ logAuthEvent: vi.fn() }));
vi.mock('../services/hostValidation.js', () => ({ validateHost: vi.fn(async () => null) }));

import { query } from '../services/db.js';
import { buildEndSessionUrl } from './oidc.js';

const realFetch = global.fetch;
let discoveryDoc = null;

function discoveryFor(issuer, { endSession = true } = {}) {
  const doc = {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/jwks`,
  };
  if (endSession) doc.end_session_endpoint = `${issuer}/end-session`;
  return doc;
}

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
  global.fetch.mockClear();
});

afterEach(() => { discoveryDoc = null; });

describe('buildEndSessionUrl', () => {
  it('returns null when no provider id is on the session (e.g. password login)', async () => {
    expect(await buildEndSessionUrl({ providerId: null, idToken: 'x' })).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it('returns null when the provider has rp_initiated_logout disabled', async () => {
    query.mockResolvedValue({ rows: [{ issuer_url: 'https://idp.example.com', client_id: 'cid', allow_insecure: false, rp_initiated_logout: false }] });
    expect(await buildEndSessionUrl({ providerId: 'p1', idToken: 'tok' })).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled(); // never reaches discovery
  });

  it('returns null when the provider no longer exists', async () => {
    query.mockResolvedValue({ rows: [] });
    expect(await buildEndSessionUrl({ providerId: 'gone', idToken: 'tok' })).toBeNull();
  });

  it('returns null when discovery advertises no end_session_endpoint', async () => {
    const issuer = 'https://no-endsession.example.com';
    query.mockResolvedValue({ rows: [{ issuer_url: issuer, client_id: 'cid', allow_insecure: false, rp_initiated_logout: true }] });
    discoveryDoc = discoveryFor(issuer, { endSession: false });
    expect(await buildEndSessionUrl({ providerId: 'p1', idToken: 'tok' })).toBeNull();
  });

  it('builds the end-session URL with id_token_hint, client_id and post_logout_redirect_uri when enabled', async () => {
    const issuer = 'https://authentik.example.com';
    query.mockResolvedValue({ rows: [{ issuer_url: issuer, client_id: 'my-client', allow_insecure: false, rp_initiated_logout: true }] });
    discoveryDoc = discoveryFor(issuer);

    const url = await buildEndSessionUrl({ providerId: 'p1', idToken: 'the-id-token' });
    expect(url).toBeTruthy();
    const parsed = new URL(url);
    expect(`${parsed.origin}${parsed.pathname}`).toBe(`${issuer}/end-session`);
    expect(parsed.searchParams.get('id_token_hint')).toBe('the-id-token');
    expect(parsed.searchParams.get('client_id')).toBe('my-client');
    expect(parsed.searchParams.get('post_logout_redirect_uri')).toBe('https://mail.example.com/login');
  });

  it('omits id_token_hint when no id_token was stored', async () => {
    const issuer = 'https://no-token.example.com';
    query.mockResolvedValue({ rows: [{ issuer_url: issuer, client_id: 'my-client', allow_insecure: false, rp_initiated_logout: true }] });
    discoveryDoc = discoveryFor(issuer);

    const url = await buildEndSessionUrl({ providerId: 'p1' });
    const parsed = new URL(url);
    expect(parsed.searchParams.has('id_token_hint')).toBe(false);
    expect(parsed.searchParams.get('client_id')).toBe('my-client');
  });

  it('never throws — returns null if discovery fails', async () => {
    const issuer = 'https://broken.example.com';
    query.mockResolvedValue({ rows: [{ issuer_url: issuer, client_id: 'cid', allow_insecure: false, rp_initiated_logout: true }] });
    global.fetch.mockImplementationOnce(async () => { throw new Error('network down'); });
    expect(await buildEndSessionUrl({ providerId: 'p1', idToken: 'tok' })).toBeNull();
  });
});
