import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./hostValidation.js', () => ({ validateHost: vi.fn() }));

import { validateHost } from './hostValidation.js';
import {
  JMAP_CORE,
  JMAP_SUBMISSION,
  fetchIdentities,
  loadJmapSession,
} from './jmapClient.js';

const TOKEN = 'token-value';
const SESSION_URL = 'https://mail.example.com/.well-known/jmap';
const IDENTITY_EMAIL = 'alias@example.com';

const rawSession = {
  apiUrl: 'https://mail.example.com/jmap/api/',
  capabilities: {
    [JMAP_CORE]: {},
    [JMAP_SUBMISSION]: {},
  },
  accounts: {
    'acc-1': {
      name: 'Example account',
      isPersonal: true,
      isReadOnly: false,
      accountCapabilities: {
        [JMAP_SUBMISSION]: {},
      },
    },
  },
  primaryAccounts: {
    [JMAP_SUBMISSION]: 'acc-1',
  },
  username: 'owner@example.com',
};

const identityList = [{
  id: 'identity-1',
  name: 'Private sender',
  email: IDENTITY_EMAIL,
  replyTo: null,
  bcc: null,
  textSignature: '',
  htmlSignature: '',
}];

function response(payload, { status = 200, ok = status >= 200 && status < 300 } = {}) {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: vi.fn().mockResolvedValue(payload),
  };
}

beforeEach(() => {
  // validateHost is real (DNS-resolving) in production; mock it to approve by default so
  // every test here stays network-free, and let SSRF-specific tests override it.
  validateHost.mockReset().mockResolvedValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('loadJmapSession', () => {
  it('discovers a validated session at the configured (host-configurable) session URL', async () => {
    const fetchFn = vi.fn().mockResolvedValue(response(rawSession));

    const session = await loadJmapSession(SESSION_URL, TOKEN, { fetchFn });

    expect(session).toMatchObject(rawSession);
    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, options, sfOptions] = fetchFn.mock.calls[0];
    expect(url).toBe(SESSION_URL);
    expect(options).toMatchObject({
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: 'application/json',
      },
    });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(sfOptions).toEqual({ allowPrivate: false });
  });

  it('accepts a custom self-hosted (Stalwart-style) session URL, not just Fastmail', async () => {
    const stalwartUrl = 'https://mail.mycompany.example/.well-known/jmap';
    const fetchFn = vi.fn().mockResolvedValue(response({
      ...rawSession,
      apiUrl: 'https://mail.mycompany.example/jmap/api/',
    }));

    await expect(loadJmapSession(stalwartUrl, TOKEN, { fetchFn })).resolves.toBeTruthy();
  });

  it('rejects a non-https session URL before ever making a request', async () => {
    const fetchFn = vi.fn();

    await expect(loadJmapSession('http://mail.example.com/jmap/session', TOKEN, { fetchFn }))
      .rejects.toMatchObject({ code: 'JMAP_CONFIG', status: 422 });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('rejects a session missing the core capability', async () => {
    const capabilities = { ...rawSession.capabilities };
    delete capabilities[JMAP_CORE];
    const fetchFn = vi.fn().mockResolvedValue(response({ ...rawSession, capabilities }));

    await expect(loadJmapSession(SESSION_URL, TOKEN, { fetchFn }))
      .rejects.toMatchObject({ code: 'JMAP_CONFIG', status: 422 });
  });

  it('rejects a session missing the submission capability', async () => {
    const capabilities = { ...rawSession.capabilities };
    delete capabilities[JMAP_SUBMISSION];
    const fetchFn = vi.fn().mockResolvedValue(response({ ...rawSession, capabilities }));

    await expect(loadJmapSession(SESSION_URL, TOKEN, { fetchFn }))
      .rejects.toThrow('Email submission');
  });

  it('ignores an advertised Masked Email (or any other vendor) capability — never required', async () => {
    const fetchFn = vi.fn().mockResolvedValue(response({
      ...rawSession,
      capabilities: {
        ...rawSession.capabilities,
        'https://www.fastmail.com/dev/maskedemail': {},
      },
    }));

    await expect(loadJmapSession(SESSION_URL, TOKEN, { fetchFn })).resolves.toBeTruthy();
  });

  it('rejects a session without a primary Email submission account', async () => {
    const fetchFn = vi.fn().mockResolvedValue(response({
      ...rawSession,
      primaryAccounts: {},
    }));

    await expect(loadJmapSession(SESSION_URL, TOKEN, { fetchFn }))
      .rejects.toThrow('Email submission');
  });

  it('rejects a primary account without submission access', async () => {
    const accountCapabilities = {};
    const fetchFn = vi.fn().mockResolvedValue(response({
      ...rawSession,
      accounts: { 'acc-1': { ...rawSession.accounts['acc-1'], accountCapabilities } },
    }));

    await expect(loadJmapSession(SESSION_URL, TOKEN, { fetchFn }))
      .rejects.toThrow('Email submission');
  });

  it('rejects a discovered API URL on a different host than the session URL (no hardcoded Fastmail origin)', async () => {
    const fetchFn = vi.fn().mockResolvedValue(response({
      ...rawSession,
      apiUrl: 'https://evil.example/jmap',
    }));

    await expect(loadJmapSession(SESSION_URL, TOKEN, { fetchFn }))
      .rejects.toThrow('different host');
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it('rejects a non-https API URL even when the host matches (origin includes scheme)', async () => {
    const fetchFn = vi.fn().mockResolvedValue(response({
      ...rawSession,
      apiUrl: 'http://mail.example.com/jmap/api/',
    }));

    await expect(loadJmapSession(SESSION_URL, TOKEN, { fetchFn }))
      .rejects.toThrow('different host');
  });

  it.each([
    ['a 401', 401],
    ['a 403', 403],
  ])('maps %s response to JMAP_CONFIG (bad token)', async (_label, status) => {
    const fetchFn = vi.fn().mockResolvedValue(response({}, { status, ok: false }));

    await expect(loadJmapSession(SESSION_URL, TOKEN, { fetchFn }))
      .rejects.toMatchObject({ code: 'JMAP_CONFIG', status: 422 });
  });

  it('maps a fetch timeout to JMAP_SYNC (transient)', async () => {
    const fetchFn = vi.fn().mockRejectedValue(Object.assign(new Error('timed out'), { name: 'TimeoutError' }));

    await expect(loadJmapSession(SESSION_URL, TOKEN, { fetchFn }))
      .rejects.toMatchObject({ code: 'JMAP_SYNC' });
  });

  it('maps an unreachable server to JMAP_SYNC (transient)', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(loadJmapSession(SESSION_URL, TOKEN, { fetchFn }))
      .rejects.toMatchObject({ code: 'JMAP_SYNC' });
  });

  it('maps an invalid JSON body to JMAP_SYNC', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true, status: 200, json: vi.fn().mockRejectedValue(new Error('bad json')),
    });

    await expect(loadJmapSession(SESSION_URL, TOKEN, { fetchFn }))
      .rejects.toMatchObject({ code: 'JMAP_SYNC' });
  });
});

describe('loadJmapSession — SSRF host policy', () => {
  it('rejects a session URL whose host resolves to a private/reserved address when allowPrivate=false', async () => {
    validateHost.mockResolvedValue('Host resolves to a private or reserved IP address');
    const fetchFn = vi.fn();

    await expect(loadJmapSession(SESSION_URL, TOKEN, { fetchFn }))
      .rejects.toMatchObject({ code: 'JMAP_CONFIG', status: 422 });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('rejects a plaintext http session URL to a public host, even when allowPrivate=true', async () => {
    // The allowPrivate:false probe (is this host genuinely public?) reports no error, i.e.
    // the host resolves publicly — plaintext must not carry the Bearer token there.
    validateHost.mockResolvedValue(null);
    const fetchFn = vi.fn();

    await expect(loadJmapSession('http://mail.example.com/jmap/session', TOKEN, { fetchFn, allowPrivate: true }))
      .rejects.toMatchObject({ code: 'JMAP_CONFIG', status: 422 });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('allows a plaintext http session URL to a genuinely private host when allowPrivate=true', async () => {
    // The allowPrivate:false probe reports private (rejected under a strict check) — so the
    // real allowPrivate:true check further down is what actually admits it.
    validateHost.mockImplementation(async (_host, { allowPrivate }) =>
      (allowPrivate ? null : 'Host resolves to a private or reserved IP address'));
    const fetchFn = vi.fn().mockResolvedValue(response({
      ...rawSession,
      apiUrl: 'http://internal.example/jmap/api/',
    }));

    const session = await loadJmapSession('http://internal.example/jmap/session', TOKEN, { fetchFn, allowPrivate: true });

    expect(session).toMatchObject({ ...rawSession, apiUrl: 'http://internal.example/jmap/api/' });
    const [, , sfOptions] = fetchFn.mock.calls[0];
    expect(sfOptions).toEqual({ allowPrivate: true });
  });

  it('passes allowPrivate through to validateHost for an https session URL', async () => {
    const fetchFn = vi.fn().mockResolvedValue(response(rawSession));

    await loadJmapSession(SESSION_URL, TOKEN, { fetchFn, allowPrivate: true });

    expect(validateHost).toHaveBeenCalledWith('mail.example.com', { allowPrivate: true });
  });
});

describe('fetchIdentities', () => {
  it('fetches the identity list for the primary submission account', async () => {
    const session = await loadJmapSession(SESSION_URL, TOKEN, { fetchFn: vi.fn().mockResolvedValue(response(rawSession)) });
    const fetchFn = vi.fn().mockResolvedValue(response({
      methodResponses: [
        ['Identity/get', { accountId: 'acc-1', state: 'identity-state', list: identityList, notFound: [] }, 'identities'],
      ],
      sessionState: 'session-state',
    }));

    const result = await fetchIdentities(session, TOKEN, { fetchFn });

    const [url, options, sfOptions] = fetchFn.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(url).toBe(session.apiUrl);
    expect(options.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(options.redirect).toBe('error');
    expect(body.using).toEqual([JMAP_CORE, JMAP_SUBMISSION]);
    expect(body.methodCalls).toEqual([['Identity/get', { accountId: 'acc-1', ids: null }, 'identities']]);
    expect(result).toEqual(identityList);
    expect(sfOptions).toEqual({ allowPrivate: false });
  });

  it('threads allowPrivate through to the API request', async () => {
    const session = await loadJmapSession(SESSION_URL, TOKEN, { fetchFn: vi.fn().mockResolvedValue(response(rawSession)) });
    const fetchFn = vi.fn().mockResolvedValue(response({
      methodResponses: [
        ['Identity/get', { accountId: 'acc-1', state: 'identity-state', list: identityList, notFound: [] }, 'identities'],
      ],
      sessionState: 'session-state',
    }));

    await fetchIdentities(session, TOKEN, { fetchFn, allowPrivate: true });

    const [, , sfOptions] = fetchFn.mock.calls[0];
    expect(sfOptions).toEqual({ allowPrivate: true });
  });

  it('refuses to send the token when the session apiUrl no longer matches the session URL origin', async () => {
    const session = await loadJmapSession(SESSION_URL, TOKEN, { fetchFn: vi.fn().mockResolvedValue(response(rawSession)) });
    const tampered = { ...session, apiUrl: 'https://evil.example/jmap' };
    const fetchFn = vi.fn();

    await expect(fetchIdentities(tampered, TOKEN, { fetchFn })).rejects.toThrow('different host');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('rejects method-level errors without returning partial data', async () => {
    const session = await loadJmapSession(SESSION_URL, TOKEN, { fetchFn: vi.fn().mockResolvedValue(response(rawSession)) });
    const fetchFn = vi.fn().mockResolvedValue(response({
      methodResponses: [['error', { type: 'serverFail', description: `Failed for ${IDENTITY_EMAIL}` }, 'identities']],
      sessionState: 'session-state',
    }));

    const result = fetchIdentities(session, TOKEN, { fetchFn });

    await expect(result).rejects.toMatchObject({ code: 'JMAP_SYNC' });
  });

  it('rejects a response method that does not match its requested tag', async () => {
    const session = await loadJmapSession(SESSION_URL, TOKEN, { fetchFn: vi.fn().mockResolvedValue(response(rawSession)) });
    const fetchFn = vi.fn().mockResolvedValue(response({
      methodResponses: [['PushSubscription/get', { accountId: 'acc-1', list: [], notFound: [] }, 'identities']],
      sessionState: 'session-state',
    }));

    await expect(fetchIdentities(session, TOKEN, { fetchFn })).rejects.toThrow('invalid response');
  });

  it('rejects a malformed Identity/get list result', async () => {
    const session = await loadJmapSession(SESSION_URL, TOKEN, { fetchFn: vi.fn().mockResolvedValue(response(rawSession)) });
    const fetchFn = vi.fn().mockResolvedValue(response({
      methodResponses: [['Identity/get', { accountId: 'acc-1', state: 's', list: null, notFound: [] }, 'identities']],
      sessionState: 'session-state',
    }));

    await expect(fetchIdentities(session, TOKEN, { fetchFn })).rejects.toThrow('invalid response');
  });

  it('does not expose the token or identity addresses through errors', async () => {
    const session = await loadJmapSession(SESSION_URL, TOKEN, { fetchFn: vi.fn().mockResolvedValue(response(rawSession)) });
    const fetchFn = vi.fn().mockResolvedValue(response({
      methodResponses: [['error', { type: TOKEN, description: IDENTITY_EMAIL }, 'identities']],
      sessionState: 'session-state',
    }));

    let error;
    try {
      await fetchIdentities(session, TOKEN, { fetchFn });
    } catch (caught) {
      error = caught;
    }

    expect(error.code).toBe('JMAP_SYNC');
    expect(error.message).not.toContain(TOKEN);
    expect(error.message).not.toContain(IDENTITY_EMAIL);
  });
});
