import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from './logger.js';
import {
  JMAP_CORE,
  JMAP_MASKED_EMAIL,
  JMAP_SUBMISSION,
  createFastmailIdentities,
  fetchFastmailSnapshot,
  loadFastmailSession,
} from './fastmailClient.js';

const TOKEN = 'token-value';
const ALIAS = 'private-alias@fastmail.example';

const session = {
  apiUrl: 'https://api.fastmail.com/jmap/api/',
  capabilities: {
    [JMAP_CORE]: {},
    [JMAP_SUBMISSION]: {},
    [JMAP_MASKED_EMAIL]: {},
  },
  accounts: {
    'acc-1': {
      name: 'Example account',
      isPersonal: true,
      isReadOnly: false,
      accountCapabilities: {
        [JMAP_SUBMISSION]: {},
        [JMAP_MASKED_EMAIL]: {},
      },
    },
  },
  primaryAccounts: {
    [JMAP_SUBMISSION]: 'acc-1',
    [JMAP_MASKED_EMAIL]: 'acc-1',
  },
  username: 'owner@fastmail.example',
};

const identityList = [{
  id: 'identity-1',
  name: 'Private sender',
  email: ALIAS,
  replyTo: null,
  bcc: null,
  textSignature: '',
  htmlSignature: '',
}];

const maskList = [{
  id: 'mask-1',
  email: ALIAS,
  state: 'enabled',
  forDomain: 'fastmail.example',
  description: 'Private address',
  createdBy: 'user',
  createdAt: '2026-07-12T12:00:00Z',
  lastMessageAt: null,
}];

function response(payload, { status = 200, ok = status >= 200 && status < 300 } = {}) {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: vi.fn().mockResolvedValue(payload),
  };
}

function capturedText(spies) {
  return spies.flatMap(spy => spy.mock.calls.flat()).map(value => {
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value); } catch { return String(value); }
  }).join('\n');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('loadFastmailSession', () => {
  it('discovers a validated session from Fastmail fixed endpoint', async () => {
    const fetchFn = vi.fn().mockResolvedValue(response(session));

    await expect(loadFastmailSession(TOKEN, fetchFn)).resolves.toEqual(session);

    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, options] = fetchFn.mock.calls[0];
    expect(url).toBe('https://api.fastmail.com/jmap/session');
    expect(options).toMatchObject({
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: 'application/json',
      },
    });
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    [JMAP_SUBMISSION, 'Email submission'],
    [JMAP_MASKED_EMAIL, 'Masked Email'],
  ])('rejects a session missing the %s capability', async (capability, safeName) => {
    const capabilities = { ...session.capabilities };
    delete capabilities[capability];
    const fetchFn = vi.fn().mockResolvedValue(response({ ...session, capabilities }));

    const result = loadFastmailSession(TOKEN, fetchFn);

    await expect(result).rejects.toMatchObject({ code: 'FASTMAIL_CONFIG', status: 422 });
    await expect(result).rejects.toThrow(safeName);
  });

  it('rejects a session without a primary Email submission account', async () => {
    const fetchFn = vi.fn().mockResolvedValue(response({
      ...session,
      primaryAccounts: { [JMAP_MASKED_EMAIL]: 'acc-1' },
    }));

    await expect(loadFastmailSession(TOKEN, fetchFn))
      .rejects.toThrow('Email submission');
  });

  it('rejects a session without a primary Masked Email account', async () => {
    const fetchFn = vi.fn().mockResolvedValue(response({
      ...session,
      primaryAccounts: { [JMAP_SUBMISSION]: 'acc-1' },
    }));

    await expect(loadFastmailSession(TOKEN, fetchFn))
      .rejects.toThrow('Masked Email');
  });

  it('rejects a primary account without Masked Email access', async () => {
    const accountCapabilities = { ...session.accounts['acc-1'].accountCapabilities };
    delete accountCapabilities[JMAP_MASKED_EMAIL];
    const fetchFn = vi.fn().mockResolvedValue(response({
      ...session,
      accounts: {
        'acc-1': { ...session.accounts['acc-1'], accountCapabilities },
      },
    }));

    await expect(loadFastmailSession(TOKEN, fetchFn))
      .rejects.toThrow('Masked Email');
  });

  it('rejects submission and Masked Email capabilities from different accounts', async () => {
    const fetchFn = vi.fn().mockResolvedValue(response({
      ...session,
      accounts: {
        ...session.accounts,
        'acc-2': {
          ...session.accounts['acc-1'],
          accountCapabilities: { [JMAP_MASKED_EMAIL]: {} },
        },
      },
      primaryAccounts: {
        [JMAP_SUBMISSION]: 'acc-1',
        [JMAP_MASKED_EMAIL]: 'acc-2',
      },
    }));

    await expect(loadFastmailSession(TOKEN, fetchFn))
      .rejects.toThrow('same Fastmail account');
  });

  it('rejects a discovered non-Fastmail API URL', async () => {
    const fetchFn = vi.fn().mockResolvedValue(response({
      ...session,
      apiUrl: 'https://evil.example/jmap',
    }));

    await expect(loadFastmailSession(TOKEN, fetchFn))
      .rejects.toThrow('Fastmail returned an unexpected API URL');
    expect(fetchFn).toHaveBeenCalledOnce();
  });
});

describe('fetchFastmailSnapshot', () => {
  it('fetches identities and masks in one JMAP request', async () => {
    const fetchFn = vi.fn().mockResolvedValue(response({
      methodResponses: [
        ['Identity/get', { accountId: 'acc-1', state: 'identity-state', list: identityList, notFound: [] }, 'identities'],
        ['MaskedEmail/get', { accountId: 'acc-1', state: 'mask-state', list: maskList, notFound: [] }, 'masked-emails'],
      ],
      sessionState: 'session-state',
    }));

    const result = await fetchFastmailSnapshot(session, TOKEN, fetchFn);

    const [url, options] = fetchFn.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(url).toBe(session.apiUrl);
    expect(options.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(options.redirect).toBe('error');
    expect(body.using).toEqual([JMAP_CORE, JMAP_SUBMISSION, JMAP_MASKED_EMAIL]);
    expect(body.methodCalls.map(call => call[0])).toEqual(['Identity/get', 'MaskedEmail/get']);
    expect(result).toEqual({ identities: identityList, maskedEmails: maskList });
  });

  it('refuses an attacker-controlled API URL before sending the token', async () => {
    const fetchFn = vi.fn();

    await expect(fetchFastmailSnapshot({
      ...session,
      apiUrl: 'https://evil.example/jmap',
    }, TOKEN, fetchFn)).rejects.toThrow('Fastmail returned an unexpected API URL');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('rejects method-level errors without returning partial data', async () => {
    const fetchFn = vi.fn().mockResolvedValue(response({
      methodResponses: [
        ['Identity/get', { accountId: 'acc-1', state: 'identity-state', list: identityList, notFound: [] }, 'identities'],
        ['error', { type: 'serverFail', description: `Failed for ${ALIAS}` }, 'masked-emails'],
      ],
      sessionState: 'session-state',
    }));

    const result = fetchFastmailSnapshot(session, TOKEN, fetchFn);

    await expect(result).rejects.toMatchObject({ code: 'FASTMAIL_SYNC' });
    await expect(result).rejects.toThrow('Fastmail rejected a synchronization method');
  });

  it('rejects a response method that does not match its requested tag', async () => {
    const fetchFn = vi.fn().mockResolvedValue(response({
      methodResponses: [
        ['MaskedEmail/get', { accountId: 'acc-1', state: 'identity-state', list: identityList, notFound: [] }, 'identities'],
        ['MaskedEmail/get', { accountId: 'acc-1', state: 'mask-state', list: maskList, notFound: [] }, 'masked-emails'],
      ],
      sessionState: 'session-state',
    }));

    await expect(fetchFastmailSnapshot(session, TOKEN, fetchFn))
      .rejects.toThrow('Fastmail returned an invalid response');
  });

  it('rejects a duplicate response for a requested tag', async () => {
    const fetchFn = vi.fn().mockResolvedValue(response({
      methodResponses: [
        ['Identity/get', { accountId: 'acc-1', state: 'identity-state', list: identityList, notFound: [] }, 'identities'],
        ['Identity/get', { accountId: 'acc-1', state: 'identity-state', list: identityList, notFound: [] }, 'identities'],
        ['MaskedEmail/get', { accountId: 'acc-1', state: 'mask-state', list: maskList, notFound: [] }, 'masked-emails'],
      ],
      sessionState: 'session-state',
    }));

    await expect(fetchFastmailSnapshot(session, TOKEN, fetchFn))
      .rejects.toThrow('Fastmail returned an invalid response');
  });

  it.each([
    ['Identity/get', null, maskList],
    ['MaskedEmail/get', identityList, { [ALIAS]: maskList[0] }],
  ])('rejects a malformed %s list result', async (methodName, identities, maskedEmails) => {
    const fetchFn = vi.fn().mockResolvedValue(response({
      methodResponses: [
        ['Identity/get', { accountId: 'acc-1', state: 'identity-state', list: identities, notFound: [] }, 'identities'],
        ['MaskedEmail/get', { accountId: 'acc-1', state: 'mask-state', list: maskedEmails, notFound: [] }, 'masked-emails'],
      ],
      sessionState: 'session-state',
    }));

    await expect(fetchFastmailSnapshot(session, TOKEN, fetchFn))
      .rejects.toThrow('Fastmail returned an invalid response');
  });

  it('does not expose tokens or aliases through errors or logging', async () => {
    const spies = [
      vi.spyOn(console, 'error').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(logger, 'error').mockImplementation(() => {}),
      vi.spyOn(logger, 'warn').mockImplementation(() => {}),
      vi.spyOn(logger, 'info').mockImplementation(() => {}),
      vi.spyOn(logger, 'debug').mockImplementation(() => {}),
    ];
    const fetchFn = vi.fn().mockResolvedValue(response({
      methodResponses: [
        ['error', { type: TOKEN, description: ALIAS }, 'identities'],
        ['MaskedEmail/get', { accountId: 'acc-1', state: 'mask-state', list: maskList, notFound: [] }, 'masked-emails'],
      ],
      sessionState: 'session-state',
    }));

    let error;
    try {
      await fetchFastmailSnapshot(session, TOKEN, fetchFn);
    } catch (caught) {
      error = caught;
    }

    expect(error.code).toBe('FASTMAIL_SYNC');
    expect(error.message).not.toContain(TOKEN);
    expect(error.message).not.toContain(ALIAS);
    const logs = capturedText(spies);
    expect(logs).not.toContain(TOKEN);
    expect(logs).not.toContain(ALIAS);
  });
});

describe('createFastmailIdentities', () => {
  it('creates all identities in one batched Identity/set request', async () => {
    const fetchFn = vi.fn().mockResolvedValue(response({
      methodResponses: [[
        'Identity/set',
        {
          accountId: 'acc-1',
          oldState: 'old-state',
          newState: 'new-state',
          created: {
            'mask-0': { id: 'identity-1' },
            'mask-1': { id: 'identity-2' },
          },
          notCreated: null,
        },
        'create-identities',
      ]],
      sessionState: 'session-state',
    }));
    const identities = [
      { name: 'First sender', email: 'first@fastmail.example' },
      { name: 'Second sender', email: 'second@fastmail.example' },
    ];

    await expect(createFastmailIdentities(session, TOKEN, identities, fetchFn))
      .resolves.toEqual({ createdIds: ['mask-0', 'mask-1'], notCreatedIds: [] });

    expect(fetchFn).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchFn.mock.calls[0][1].body);
    expect(body.methodCalls).toEqual([[
      'Identity/set',
      {
        accountId: 'acc-1',
        create: {
          'mask-0': {
            name: 'First sender',
            email: 'first@fastmail.example',
            replyTo: null,
            bcc: null,
            textSignature: '',
            htmlSignature: '',
          },
          'mask-1': {
            name: 'Second sender',
            email: 'second@fastmail.example',
            replyTo: null,
            bcc: null,
            textSignature: '',
            htmlSignature: '',
          },
        },
      },
      'create-identities',
    ]]);
  });

  it('skips the request when no identities need creation', async () => {
    const fetchFn = vi.fn();

    await expect(createFastmailIdentities(session, TOKEN, [], fetchFn))
      .resolves.toEqual({ createdIds: [], notCreatedIds: [] });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('returns rejected identity accounting without exposing provider details', async () => {
    const fetchFn = vi.fn().mockResolvedValue(response({
      methodResponses: [[
        'Identity/set',
        {
          accountId: 'acc-1',
          oldState: 'old-state',
          newState: 'new-state',
          created: {},
          notCreated: { 'mask-0': { type: 'forbidden', description: ALIAS } },
        },
        'create-identities',
      ]],
      sessionState: 'session-state',
    }));

    await expect(createFastmailIdentities(
      session,
      TOKEN,
      [{ name: 'Private sender', email: ALIAS }],
      fetchFn,
    )).resolves.toEqual({ createdIds: [], notCreatedIds: ['mask-0'] });
  });

  it('returns valid mixed Identity/set accounting for authoritative re-fetch', async () => {
    const accounting = {
      created: { 'mask-0': { id: 'identity-1' } },
      notCreated: { 'mask-1': { type: 'forbiddenFrom', description: ALIAS } },
    };
    const fetchFn = vi.fn().mockResolvedValue(response({
      methodResponses: [[
        'Identity/set',
        {
          accountId: 'acc-1',
          oldState: 'old-state',
          newState: 'new-state',
          ...accounting,
        },
        'create-identities',
      ]],
      sessionState: 'session-state',
    }));

    await expect(createFastmailIdentities(session, TOKEN, [
      { name: 'First sender', email: 'first@fastmail.example' },
      { name: 'Second sender', email: 'second@fastmail.example' },
    ], fetchFn)).resolves.toEqual({ createdIds: ['mask-0'], notCreatedIds: ['mask-1'] });
  });

  it.each([
    ['a missing notCreated map', {
      accountId: 'acc-1',
      oldState: 'old-state',
      newState: 'new-state',
      created: { 'mask-0': { id: 'identity-1' } },
    }],
    ['a non-object notCreated value', {
      accountId: 'acc-1',
      oldState: 'old-state',
      newState: 'new-state',
      created: { 'mask-0': { id: 'identity-1' } },
      notCreated: [],
    }],
    ['an incomplete creation-ID accounting', {
      accountId: 'acc-1',
      oldState: 'old-state',
      newState: 'new-state',
      created: { 'mask-0': { id: 'identity-1' } },
      notCreated: {},
    }],
  ])('rejects an Identity/set result with %s', async (_case, setResult) => {
    const fetchFn = vi.fn().mockResolvedValue(response({
      methodResponses: [['Identity/set', setResult, 'create-identities']],
      sessionState: 'session-state',
    }));

    await expect(createFastmailIdentities(session, TOKEN, [
      { name: 'First sender', email: 'first@fastmail.example' },
      { name: 'Second sender', email: 'second@fastmail.example' },
    ], fetchFn)).rejects.toThrow('Fastmail returned an invalid response');
  });

  it.each([
    ['a created entry without an id', {
      created: { 'mask-0': {} },
      notCreated: {},
    }],
    ['a notCreated entry without an error type', {
      created: {},
      notCreated: { 'mask-0': { description: 'Denied' } },
    }],
  ])('rejects an Identity/set result with %s', async (_case, accounting) => {
    const fetchFn = vi.fn().mockResolvedValue(response({
      methodResponses: [[
        'Identity/set',
        {
          accountId: 'acc-1',
          oldState: 'old-state',
          newState: 'new-state',
          ...accounting,
        },
        'create-identities',
      ]],
      sessionState: 'session-state',
    }));

    await expect(createFastmailIdentities(
      session,
      TOKEN,
      [{ name: 'Private sender', email: ALIAS }],
      fetchFn,
    )).rejects.toThrow('Fastmail returned an invalid response');
  });
});
