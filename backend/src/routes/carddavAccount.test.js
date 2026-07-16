import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  discoverAddressBooks: vi.fn(),
  encrypt: vi.fn(value => `encrypted:${value}`),
  getCardavConfig: vi.fn(),
  replaceCarddavConnection: vi.fn(),
  patchCarddavConnection: vi.fn(),
  requestCarddavSync: vi.fn(),
  scheduleCardavUser: vi.fn(),
  syncUser: vi.fn(),
  disconnectCarddavAccount: vi.fn(),
}));

vi.mock('../services/db.js', () => ({ query: mocks.query }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: vi.fn((req, res, next) => next()) }));
vi.mock('../services/encryption.js', () => ({ encrypt: mocks.encrypt }));
vi.mock('../services/hostValidation.js', () => ({ validateHost: vi.fn() }));
vi.mock('../services/connectionPolicy.js', () => ({
  getConnectionPolicy: vi.fn(async () => ({ allowPrivateHosts: false })),
}));
vi.mock('../services/carddavClient.js', () => ({
  discoverAddressBooks: mocks.discoverAddressBooks,
}));
vi.mock('../services/carddavSync.js', () => ({
  getCardavConfig: mocks.getCardavConfig,
  replaceCarddavConnection: mocks.replaceCarddavConnection,
  patchCarddavConnection: mocks.patchCarddavConnection,
  requestCarddavSync: mocks.requestCarddavSync,
  scheduleCardavUser: mocks.scheduleCardavUser,
  syncUser: mocks.syncUser,
  disconnectCarddavAccount: mocks.disconnectCarddavAccount,
}));

const { default: router } = await import('./carddavAccount.js');
const connectHandler = router.stack
  .find(layer => layer.route?.path === '/connect' && layer.route.methods.post)
  .route.stack.at(-1).handle;
const patchHandler = router.stack
  .find(layer => layer.route?.path === '/' && layer.route.methods.patch)
  .route.stack.at(-1).handle;
const syncHandler = router.stack
  .find(layer => layer.route?.path === '/sync' && layer.route.methods.post)
  .route.stack.at(-1).handle;
const deleteHandler = router.stack
  .find(layer => layer.route?.path === '/' && layer.route.methods.delete)
  .route.stack.at(-1).handle;

function response() {
  return {
    json: vi.fn(),
    status: vi.fn().mockReturnThis(),
  };
}

describe('POST /api/carddav/connect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.discoverAddressBooks.mockResolvedValue([]);
    mocks.replaceCarddavConnection.mockResolvedValue({
      serverUrl: 'https://dav.example.test/',
      username: 'user',
      intervalMin: 30,
      connectionGeneration: 'generation-b',
      lastError: null,
    });
    mocks.requestCarddavSync.mockReturnValue(true);
  });

  it('delegates replacement atomically and requests its committed generation', async () => {
    const res = response();

    await connectHandler({
      session: { userId: 'user-1' },
      body: {
        serverUrl: 'https://dav.example.test/',
        username: 'user',
        password: 'secret',
        dupMode: 'merge',
        intervalMin: 30,
      },
    }, res);

    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.replaceCarddavConnection).toHaveBeenCalledWith('user-1', {
      serverUrl: 'https://dav.example.test/',
      username: 'user',
      password: 'encrypted:secret',
      intervalMin: 30,
    });
    expect(mocks.requestCarddavSync).toHaveBeenCalledWith('user-1', 'generation-b');
    expect(mocks.replaceCarddavConnection.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.requestCarddavSync.mock.invocationCallOrder[0]);
    expect(mocks.scheduleCardavUser).toHaveBeenCalledWith('user-1', 30);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      connected: true,
    }));
    expect(res.json.mock.calls[0][0]).not.toHaveProperty('dupMode');
    expect(res.json.mock.calls[0][0]).not.toHaveProperty('connectionGeneration');
  });

  it('does not request a sync when replacement persistence fails', async () => {
    mocks.replaceCarddavConnection.mockRejectedValueOnce(new Error('replace failed'));
    const res = response();

    await expect(connectHandler({
      session: { userId: 'user-1' },
      body: {
        serverUrl: 'https://dav.example.test/',
        username: 'user',
        password: 'secret',
        dupMode: 'merge',
      },
    }, res)).rejects.toThrow('replace failed');

    expect(mocks.requestCarddavSync).not.toHaveBeenCalled();
    expect(mocks.scheduleCardavUser).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/carddav', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCardavConfig.mockResolvedValue({
      serverUrl: 'https://dav.example.test/',
      username: 'user',
      intervalMin: 60,
      connectionGeneration: 'generation-a',
    });
    mocks.discoverAddressBooks.mockResolvedValue([]);
    mocks.patchCarddavConnection.mockResolvedValue({
      serverUrl: 'https://dav.example.test/',
      username: 'user',
      intervalMin: 60,
      connectionGeneration: 'generation-a',
    });
    mocks.requestCarddavSync.mockReturnValue(true);
  });

  it('ignores obsolete duplicate-mode input while delegating the interval', async () => {
    const req = {
      session: { userId: 'user-1' },
      body: { dupMode: 'merge', intervalMin: 30 },
    };
    const res = response();
    mocks.patchCarddavConnection.mockResolvedValueOnce({
      serverUrl: 'https://dav.example.test/',
      username: 'user',
      intervalMin: 30,
      connectionGeneration: 'generation-a',
    });

    await patchHandler(req, res);

    expect(mocks.patchCarddavConnection).toHaveBeenCalledWith('user-1', {
      intervalMin: 30,
    });
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.requestCarddavSync).not.toHaveBeenCalled();
    expect(mocks.scheduleCardavUser).toHaveBeenCalledWith('user-1', 30);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      connected: true,
    }));
    expect(res.json.mock.calls[0][0]).not.toHaveProperty('dupMode');
  });

  it('preflights a password replacement before persisting and queues its generation', async () => {
    const res = response();
    mocks.patchCarddavConnection.mockResolvedValueOnce({
      serverUrl: 'https://dav.example.test/',
      username: 'user',
      intervalMin: 60,
      connectionGeneration: 'generation-b',
    });

    await patchHandler({
      session: { userId: 'user-1' },
      body: { password: 'new-secret' },
    }, res);

    expect(mocks.discoverAddressBooks).toHaveBeenCalledWith({
      serverUrl: 'https://dav.example.test/',
      username: 'user',
      password: 'new-secret',
      allowPrivate: false,
    });
    expect(mocks.patchCarddavConnection).toHaveBeenCalledWith(
      'user-1',
      { password: 'encrypted:new-secret' },
      'generation-a',
    );
    expect(mocks.requestCarddavSync).toHaveBeenCalledWith('user-1', 'generation-b');
    expect(mocks.discoverAddressBooks.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.patchCarddavConnection.mock.invocationCallOrder[0]);
    expect(mocks.patchCarddavConnection.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.requestCarddavSync.mock.invocationCallOrder[0]);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('changes and queues nothing when password preflight fails', async () => {
    mocks.discoverAddressBooks.mockRejectedValueOnce(new Error('bad credentials'));
    const res = response();

    await patchHandler({
      session: { userId: 'user-1' },
      body: { password: 'bad-secret' },
    }, res);

    expect(mocks.patchCarddavConnection).not.toHaveBeenCalled();
    expect(mocks.requestCarddavSync).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'bad credentials' });
  });
});

describe('POST /api/carddav/sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCardavConfig
      .mockResolvedValueOnce({ serverUrl: 'https://dav.example.test/' })
      .mockResolvedValueOnce({
        serverUrl: 'https://dav.example.test/',
        username: 'user',
        bookCount: 1,
        contactCount: 2,
      });
  });

  it('preserves the result-plus-status envelope while exposing counters', async () => {
    const result = {
      ok: true,
      bookCount: 1,
      contactCount: 2,
      remote: 3,
      fetched: 1,
      updated: 1,
      removed: 0,
      fallback: 0,
    };
    mocks.syncUser.mockResolvedValue(result);
    const res = response();

    await syncHandler({ session: { userId: 'user-1' } }, res);

    expect(res.json).toHaveBeenCalledWith({
      ...result,
      status: expect.objectContaining({
        connected: true,
        bookCount: 1,
        contactCount: 2,
      }),
    });
  });
});

describe('DELETE /api/carddav', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.disconnectCarddavAccount.mockResolvedValue(true);
  });

  it('delegates disconnect once without route lifecycle SQL', async () => {
    const res = response();

    await deleteHandler({ session: { userId: 'user-1' } }, res);

    expect(mocks.disconnectCarddavAccount).toHaveBeenCalledTimes(1);
    expect(mocks.disconnectCarddavAccount).toHaveBeenCalledWith('user-1');
    expect(mocks.query).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });
});
