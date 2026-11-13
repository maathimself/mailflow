import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ connect: vi.fn(), lookup: vi.fn() }));
vi.mock('node:dns', () => ({ default: { lookup: mocks.lookup } }));
vi.mock('undici', () => ({
  buildConnector: () => mocks.connect,
  Agent: class { constructor({ connect }) { this.connect = connect; } },
}));
import { safeFetch } from './safeFetch.js';

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn(async (_url, options) => options));
});

afterEach(() => vi.unstubAllGlobals());

async function connector(policy = { allowPrivateNetworks: true, requireHttps: false }) {
  const { dispatcher } = await safeFetch('https://notify.example/topic', { redirect: 'error' }, policy);
  return dispatcher.connect;
}

describe('restricted connector DNS checks', () => {
  it('validates every answer and pins the socket to the checked LAN address', async () => {
    mocks.lookup.mockImplementation((_host, _opts, cb) => cb(null, [{ address: '192.168.1.12' }, { address: 'fd00::12' }]));
    const callback = vi.fn();
    (await connector())({ hostname: 'notify.example', protocol: 'http:', port: '80' }, callback);
    expect(mocks.lookup).toHaveBeenCalledTimes(1);
    expect(mocks.connect).toHaveBeenCalledWith({ hostname: '192.168.1.12', servername: 'notify.example', protocol: 'http:', port: '80' }, callback);
  });
  it('rejects a mixed public/private answer containing link-local', async () => {
    mocks.lookup.mockImplementation((_host, _opts, cb) => cb(null, [{ address: '8.8.8.8' }, { address: '169.254.169.254' }]));
    const callback = vi.fn();
    (await connector())({ hostname: 'notify.example', protocol: 'http:' }, callback);
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ code: 'ERR_BLOCKED_PRIVATE_IP' }));
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it('checks DNS again for each new connection', async () => {
    mocks.lookup.mockImplementationOnce((_h, _o, cb) => cb(null, [{ address: '192.168.1.12' }]))
      .mockImplementationOnce((_h, _o, cb) => cb(null, [{ address: '127.0.0.1' }]));
    const connect = await connector();
    const callback = vi.fn();
    connect({ hostname: 'notify.example', protocol: 'http:' }, callback);
    connect({ hostname: 'notify.example', protocol: 'http:' }, callback);
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ code: 'ERR_BLOCKED_PRIVATE_IP' }));
  });
  it('keeps the default public policy separate from the LAN pool', async () => {
    const lan = await connector();
    const publicOnly = await connector({ requireHttps: false });
    expect(lan).not.toBe(publicOnly);
    mocks.lookup.mockImplementation((_h, _o, cb) => cb(null, [{ address: '192.168.1.12' }]));
    const callback = vi.fn();
    publicOnly({ hostname: 'notify.example', protocol: 'http:' }, callback);
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ code: 'ERR_BLOCKED_PRIVATE_IP' }));
  });
});

describe('public HTTPS even for allowlisted origins', () => {
  const policy = { blockReserved: true, allowPrivateNetworks: true, requireHttps: false, requirePublicHttps: true };
  it.each([
    ['8.8.8.8'], ['192.168.1.1', '8.8.8.8'], ['::ffff:8.8.8.8'],
  ])('rejects HTTP DNS answers %j', async (...addresses) => {
    mocks.lookup.mockImplementation((_h, _o, cb) => cb(null, addresses.map(address => ({ address }))));
    const callback = vi.fn();
    (await connector(policy))({ hostname: 'notify.example', protocol: 'http:' }, callback);
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ code: 'ERR_INSECURE_TRANSPORT' }));
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it.each(['8.8.8.8', '::ffff:8.8.8.8'])('rejects literal public HTTP %s', async hostname => {
    const callback = vi.fn();
    (await connector(policy))({ hostname, protocol: 'http:' }, callback);
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ code: 'ERR_INSECURE_TRANSPORT' }));
  });
  it('allows private HTTP and public HTTPS', async () => {
    const connect = await connector(policy);
    connect({ hostname: '192.168.1.1', protocol: 'http:' }, vi.fn());
    connect({ hostname: '8.8.8.8', protocol: 'https:' }, vi.fn());
    expect(mocks.connect).toHaveBeenCalledTimes(2);
  });
  it('blocks reserved answers even with no private exception', async () => {
    mocks.lookup.mockImplementation((_h, _o, cb) => cb(null, [{ address: '224.0.0.1' }]));
    const callback = vi.fn();
    (await connector({ blockReserved: true }))({ hostname: 'notify.example', protocol: 'https:' }, callback);
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ code: 'ERR_BLOCKED_PRIVATE_IP' }));
    expect(mocks.connect).not.toHaveBeenCalled();
  });
});
