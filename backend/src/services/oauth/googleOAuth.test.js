import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

// The id-token tests sign real JWTs with a locally generated key; only the remote
// JWKS fetch is replaced by a local key set so no network access is needed while the
// real jose issuer/audience/expiry validation still runs.
const joseState = vi.hoisted(() => ({ localJwks: null, remoteUrls: [] }));
vi.mock('jose', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createRemoteJWKSet: vi.fn((url) => {
      joseState.remoteUrls.push(String(url));
      return (...args) => joseState.localJwks(...args);
    }),
  };
});
vi.mock('../db.js', () => ({ query: vi.fn() }));
vi.mock('../encryption.js', () => ({
  encrypt: (v) => (v ? `enc(${v})` : v),
  decrypt: (v) => (typeof v === 'string' && v.startsWith('enc(') ? v.slice(4, -1) : v),
}));

const { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet } = await import('jose');
const { query } = await import('../db.js');
const {
  buildGoogleAuthorizationUrl,
  exchangeGoogleCode,
  verifyGoogleIdToken,
  refreshGoogleToken,
  hasGoogleMailScope,
  isGoogleConfigured,
  GOOGLE_MAIL_SCOPE,
} = await import('./googleOAuth.js');

const CLIENT_ID = 'client-id.apps.googleusercontent.com';
const CLIENT_SECRET = 'very-secret-client-secret';
const REDIRECT_URI = 'https://mail.example.com/oauth/google/callback';
const jsonRes = (ok, body, status = ok ? 200 : 400) => ({ ok, status, json: async () => body });

function setConfig() {
  process.env.GOOGLE_CLIENT_ID = CLIENT_ID;
  process.env.GOOGLE_CLIENT_SECRET = CLIENT_SECRET;
  process.env.GOOGLE_REDIRECT_URI = REDIRECT_URI;
}
function clearConfig() {
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.GOOGLE_REDIRECT_URI;
}

beforeEach(() => {
  setConfig();
  query.mockReset();
  query.mockResolvedValue({ rows: [] });
});
afterEach(() => {
  vi.unstubAllGlobals();
  clearConfig();
});

describe('isGoogleConfigured', () => {
  it('requires client id, secret and redirect uri', () => {
    expect(isGoogleConfigured()).toBe(true);
    delete process.env.GOOGLE_CLIENT_SECRET;
    expect(isGoogleConfigured()).toBe(false);
    setConfig();
    delete process.env.GOOGLE_REDIRECT_URI;
    expect(isGoogleConfigured()).toBe(false);
  });
});

describe('buildGoogleAuthorizationUrl', () => {
  it('includes every mandatory authorization parameter and only the PKCE challenge', () => {
    const url = new URL(buildGoogleAuthorizationUrl({
      state: 'state-123', codeChallenge: 'challenge-abc', redirectUri: REDIRECT_URI,
    }));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    const p = url.searchParams;
    expect(p.get('client_id')).toBe(CLIENT_ID);
    expect(p.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(p.get('response_type')).toBe('code');
    expect(p.get('scope')).toBe('openid email profile https://mail.google.com/');
    expect(p.get('access_type')).toBe('offline');
    expect(p.get('prompt')).toBe('consent');
    expect(p.get('include_granted_scopes')).toBe('true');
    expect(p.get('code_challenge')).toBe('challenge-abc');
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('state')).toBe('state-123');
    expect(p.has('login_hint')).toBe(false);
    expect(p.has('client_secret')).toBe(false);
    expect(p.has('code_verifier')).toBe(false);
    expect(url.toString()).not.toContain(CLIENT_SECRET);
  });

  it('adds login_hint when provided', () => {
    const url = new URL(buildGoogleAuthorizationUrl({
      state: 's', codeChallenge: 'c', redirectUri: REDIRECT_URI, loginHint: 'user@gmail.com',
    }));
    expect(url.searchParams.get('login_hint')).toBe('user@gmail.com');
  });
});

describe('hasGoogleMailScope', () => {
  it('requires the full Gmail scope as a whole token', () => {
    expect(hasGoogleMailScope(`openid ${GOOGLE_MAIL_SCOPE} email`)).toBe(true);
    expect(hasGoogleMailScope('openid email https://www.googleapis.com/auth/gmail.readonly')).toBe(false);
    expect(hasGoogleMailScope('https://mail.google.com/extra')).toBe(false);
    expect(hasGoogleMailScope(undefined)).toBe(false);
  });
});

describe('exchangeGoogleCode', () => {
  it('posts the code with the PKCE verifier and client secret in the body, and normalizes tokens', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRes(true, {
      access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3599,
      scope: `openid ${GOOGLE_MAIL_SCOPE}`, id_token: 'idt', token_type: 'Bearer',
    }));
    vi.stubGlobal('fetch', fetchMock);

    const before = Date.now();
    const tokens = await exchangeGoogleCode({ code: 'auth-code', codeVerifier: 'verifier', redirectUri: REDIRECT_URI });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://oauth2.googleapis.com/token');
    expect(url).not.toContain('auth-code');
    expect(init.method).toBe('POST');
    const body = init.body;
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('auth-code');
    expect(body.get('code_verifier')).toBe('verifier');
    expect(body.get('client_id')).toBe(CLIENT_ID);
    expect(body.get('client_secret')).toBe(CLIENT_SECRET);
    expect(body.get('redirect_uri')).toBe(REDIRECT_URI);

    expect(tokens.accessToken).toBe('at-1');
    expect(tokens.refreshToken).toBe('rt-1');
    expect(tokens.idToken).toBe('idt');
    expect(tokens.scope).toBe(`openid ${GOOGLE_MAIL_SCOPE}`);
    expect(tokens.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 3599 * 1000);
  });

  it('throws a stable error without the provider body on failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRes(false, {
      error: 'invalid_grant', error_description: 'Bad Request code=auth-code secret leaked',
    })));
    const err = await exchangeGoogleCode({ code: 'auth-code', codeVerifier: 'v', redirectUri: REDIRECT_URI }).catch(e => e);
    expect(err.code).toBe('authentication_failed');
    expect(err.oauthError).toBe('invalid_grant');
    expect(err.message).not.toMatch(/auth-code|secret|Bad Request/);
  });

  it('throws authentication_failed when no access token is returned', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRes(true, { id_token: 'x' })));
    const err = await exchangeGoogleCode({ code: 'c', codeVerifier: 'v', redirectUri: REDIRECT_URI }).catch(e => e);
    expect(err.code).toBe('authentication_failed');
  });
});

describe('verifyGoogleIdToken', () => {
  let privateKey;
  beforeAll(async () => {
    const pair = await generateKeyPair('RS256');
    privateKey = pair.privateKey;
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256' };
    joseState.localJwks = createLocalJWKSet({ keys: [jwk] });
  });

  const sign = (claims, { iss = 'https://accounts.google.com', aud = CLIENT_ID, exp = '1h' } = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(iss)
      .setAudience(aud)
      .setSubject('sub-1')
      .setIssuedAt()
      .setExpirationTime(exp)
      .sign(privateKey);

  it('verifies against Google JWKS and returns the identity', async () => {
    const idToken = await sign({ email: 'User@Gmail.com', email_verified: true, name: 'User' });
    const identity = await verifyGoogleIdToken({ idToken, clientId: CLIENT_ID });
    expect(identity).toEqual({ email: 'User@Gmail.com', name: 'User', sub: 'sub-1' });
    expect(joseState.remoteUrls).toContain('https://www.googleapis.com/oauth2/v3/certs');
  });

  it('accepts the bare accounts.google.com issuer', async () => {
    const idToken = await sign({ email: 'u@gmail.com', email_verified: true }, { iss: 'accounts.google.com' });
    await expect(verifyGoogleIdToken({ idToken, clientId: CLIENT_ID })).resolves.toMatchObject({ email: 'u@gmail.com' });
  });

  it.each([
    ['wrong issuer', { iss: 'https://evil.example.com' }],
    ['wrong audience', { aud: 'other-client' }],
    ['expired token', { exp: Math.floor(Date.now() / 1000) - 3600 }],
  ])('rejects a token with %s', async (_label, opts) => {
    const idToken = await sign({ email: 'u@gmail.com', email_verified: true }, opts);
    const err = await verifyGoogleIdToken({ idToken, clientId: CLIENT_ID }).catch(e => e);
    expect(err.code).toBe('authentication_failed');
  });

  it('rejects a token signed by an unknown key', async () => {
    const other = await generateKeyPair('RS256');
    const idToken = await new SignJWT({ email: 'u@gmail.com', email_verified: true })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer('https://accounts.google.com').setAudience(CLIENT_ID).setExpirationTime('1h')
      .sign(other.privateKey);
    const err = await verifyGoogleIdToken({ idToken, clientId: CLIENT_ID }).catch(e => e);
    expect(err.code).toBe('authentication_failed');
  });

  it.each([
    ['false', false],
    ['the string "true"', 'true'],
    ['missing', undefined],
  ])('rejects email_verified %s with email_not_verified', async (_label, value) => {
    const idToken = await sign({ email: 'u@gmail.com', email_verified: value });
    const err = await verifyGoogleIdToken({ idToken, clientId: CLIENT_ID }).catch(e => e);
    expect(err.code).toBe('email_not_verified');
  });

  it('rejects a token without an email', async () => {
    const idToken = await sign({ email_verified: true });
    const err = await verifyGoogleIdToken({ idToken, clientId: CLIENT_ID }).catch(e => e);
    expect(err.code).toBe('authentication_failed');
  });
});

describe('refreshGoogleToken', () => {
  const account = { id: 'acc-1', oauth_provider: 'google', oauth_refresh_token: 'enc(stored-rt)' };

  it('refreshes with the decrypted refresh token and persists encrypted tokens atomically', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRes(true, {
      access_token: 'new-at', expires_in: 3600, scope: GOOGLE_MAIL_SCOPE,
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await refreshGoogleToken(account);

    const body = fetchMock.mock.calls[0][1].body;
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('stored-rt');
    expect(body.get('client_secret')).toBe(CLIENT_SECRET);

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/UPDATE email_accounts/);
    expect(sql).toMatch(/COALESCE\(\$2, oauth_refresh_token\)/);
    expect(params[0]).toBe('enc(new-at)');
    // No new refresh token from Google: the stored one must be kept.
    expect(params[1]).toBeNull();
    expect(params[3]).toBe('acc-1');

    expect(result.oauth_access_token).toBe('new-at');
    expect(result.oauth_token_expiry).toBeInstanceOf(Date);
  });

  it('stores a rotated refresh token encrypted', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRes(true, {
      access_token: 'new-at', refresh_token: 'new-rt', expires_in: 3600,
    })));
    await refreshGoogleToken(account);
    expect(query.mock.calls[0][1][1]).toBe('enc(new-rt)');
  });

  it('surfaces invalid_grant as a machine code without the provider body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRes(false, {
      error: 'invalid_grant', error_description: 'Token has been expired or revoked. stored-rt',
    })));
    const err = await refreshGoogleToken(account).catch(e => e);
    expect(err.oauthError).toBe('invalid_grant');
    expect(err.message).not.toMatch(/stored-rt|revoked/);
    expect(query).not.toHaveBeenCalled();
  });

  it('marks a missing refresh token without calling Google', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const err = await refreshGoogleToken({ ...account, oauth_refresh_token: null }).catch(e => e);
    expect(err.oauthError).toBe('missing_refresh_token');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails with not_configured when the integration is missing', async () => {
    clearConfig();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const err = await refreshGoogleToken(account).catch(e => e);
    expect(err.code).toBe('not_configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
