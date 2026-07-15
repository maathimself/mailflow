import { beforeEach, describe, expect, it, vi } from 'vitest';

class StaleCarddavPlanError extends Error {
  constructor(details) {
    super(details?.reason === 'not-connected' ? 'not connected' : 'CardDAV sync plan is stale');
    this.name = 'StaleCarddavPlanError';
    Object.assign(this, details);
  }
}

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  discoverAddressBooks: vi.fn(),
  encrypt: vi.fn(value => `encrypted:${value}`),
  getCardavConfig: vi.fn(),
  getCarddavBookSummaries: vi.fn(),
  patchCarddavBookRoles: vi.fn(),
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
  getCarddavBookSummaries: mocks.getCarddavBookSummaries,
  patchCarddavBookRoles: mocks.patchCarddavBookRoles,
  replaceCarddavConnection: mocks.replaceCarddavConnection,
  patchCarddavConnection: mocks.patchCarddavConnection,
  requestCarddavSync: mocks.requestCarddavSync,
  scheduleCardavUser: mocks.scheduleCardavUser,
  syncUser: mocks.syncUser,
  disconnectCarddavAccount: mocks.disconnectCarddavAccount,
  StaleCarddavPlanError,
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
const patchBookHandler = router.stack
  .find(layer => layer.route?.path === '/books/:id' && layer.route.methods.patch)
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
    mocks.getCarddavBookSummaries.mockResolvedValue([]);
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
    expect(mocks.getCarddavBookSummaries).toHaveBeenCalledWith('user-1');
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      connected: true,
      books: [],
    }));
    expect(res.json.mock.calls[0][0]).not.toHaveProperty('dupMode');
    expect(res.json.mock.calls[0][0]).not.toHaveProperty('connectionGeneration');
  });

  it('surfaces the per-book summary returned by the sync layer', async () => {
    const books = [{
      id: 'book-1',
      name: 'Personal',
      externalUrl: 'https://dav.example.test/books/personal',
      isWriteTarget: true,
      isSubscribed: true,
      isLookupSource: true,
      capabilities: { create: 'allowed', update: 'allowed', delete: 'allowed' },
      materializedCount: 3,
      lookupCount: 0,
      lastSyncAt: '2026-07-12T00:00:00.000Z',
    }];
    mocks.getCarddavBookSummaries.mockResolvedValueOnce(books);
    const res = response();

    await connectHandler({
      session: { userId: 'user-1' },
      body: {
        serverUrl: 'https://dav.example.test/',
        username: 'user',
        password: 'secret',
        intervalMin: 30,
      },
    }, res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ books }));
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
    mocks.getCarddavBookSummaries.mockResolvedValue([]);
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
    mocks.getCarddavBookSummaries.mockResolvedValue([]);
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

describe('PATCH /api/carddav/books/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCardavConfig.mockResolvedValue({
      serverUrl: 'https://dav.example.test/',
      username: 'user',
      connectionGeneration: 'generation-a',
    });
    mocks.patchCarddavBookRoles.mockResolvedValue('book-1');
    mocks.requestCarddavSync.mockReturnValue(true);
    mocks.getCarddavBookSummaries.mockResolvedValue([]);
  });

  it('delegates the role change fenced by generation, then syncs and returns the summary', async () => {
    const books = [{ id: 'book-1', name: 'Primary', isWriteTarget: true }];
    mocks.getCarddavBookSummaries.mockResolvedValueOnce(books);
    const res = response();

    await patchBookHandler({
      session: { userId: 'user-1' },
      params: { id: 'book-1' },
      body: { makeWriteTarget: true },
    }, res);

    expect(mocks.patchCarddavBookRoles).toHaveBeenCalledWith(
      'user-1',
      'book-1',
      { isSubscribed: undefined, isLookupSource: undefined, makeWriteTarget: true },
      'generation-a',
    );
    // A role change carries no new generation, so a sync already in flight for that
    // generation may be past the patched book: request one that cannot be coalesced away.
    expect(mocks.requestCarddavSync)
      .toHaveBeenCalledWith('user-1', 'generation-a', { coalesce: false });
    expect(mocks.patchCarddavBookRoles.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.requestCarddavSync.mock.invocationCallOrder[0]);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ connected: true, books }));
  });

  it('rejects with 409 when CardDAV is not connected and never mutates or syncs', async () => {
    mocks.getCardavConfig.mockResolvedValueOnce(null);
    const res = response();

    await patchBookHandler({
      session: { userId: 'user-1' },
      params: { id: 'book-1' },
      body: { isSubscribed: true },
    }, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(mocks.patchCarddavBookRoles).not.toHaveBeenCalled();
    expect(mocks.requestCarddavSync).not.toHaveBeenCalled();
  });

  it.each([
    ['ERR_CARDDAV_READ_ONLY', 403],
    ['ERR_CARDDAV_WRITE_TARGET_SUBSCRIBED', 409],
    ['ERR_ADDRESS_BOOK_NOT_FOUND', 404],
    ['ERR_CARDDAV_BOOK_PATCH_EMPTY', 400],
  ])('maps %s to HTTP %i without triggering a sync', async (code, status) => {
    mocks.patchCarddavBookRoles.mockRejectedValueOnce(Object.assign(new Error('nope'), { code }));
    const res = response();

    await patchBookHandler({
      session: { userId: 'user-1' },
      params: { id: 'book-1' },
      body: { makeWriteTarget: true },
    }, res);

    expect(res.status).toHaveBeenCalledWith(status);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code }));
    expect(mocks.requestCarddavSync).not.toHaveBeenCalled();
  });

  it('maps a stale-generation fence to HTTP 409', async () => {
    mocks.patchCarddavBookRoles.mockRejectedValueOnce(
      new StaleCarddavPlanError({ reason: 'connection-generation-changed' }),
    );
    const res = response();

    await patchBookHandler({
      session: { userId: 'user-1' },
      params: { id: 'book-1' },
      body: { isSubscribed: false },
    }, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'connection-generation-changed' }),
    );
    expect(mocks.requestCarddavSync).not.toHaveBeenCalled();
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
