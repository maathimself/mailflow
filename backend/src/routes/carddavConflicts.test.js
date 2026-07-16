import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getConflict: vi.fn(),
  listConflicts: vi.fn(),
  requireAuth: vi.fn((req, res, next) => next()),
  resolveConflict: vi.fn(),
}));

vi.mock('../middleware/auth.js', () => ({ requireAuth: mocks.requireAuth }));
vi.mock('../services/carddavConflictService.js', () => ({
  getConflict: mocks.getConflict,
  listConflicts: mocks.listConflicts,
  resolveConflict: mocks.resolveConflict,
}));

const { default: router } = await import('./carddavConflicts.js');

function handler(method, path) {
  return router.stack
    .find(layer => layer.route?.path === path && layer.route.methods[method])
    .route.stack.at(-1).handle;
}

const listHandler = handler('get', '/');
const detailHandler = handler('get', '/:id');
const resolveHandler = handler('post', '/:id/resolve');

function response() {
  return {
    json: vi.fn(),
    status: vi.fn().mockReturnThis(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('CardDAV conflict routes', () => {
  it('gates every route through the shared authentication middleware', () => {
    expect(router.stack[0].handle).toBe(mocks.requireAuth);
  });

  it('lists the current user conflict comparison envelope', async () => {
    const conflicts = [{ id: 'conflict-1', local: {}, remote: {} }];
    mocks.listConflicts.mockResolvedValueOnce(conflicts);
    const res = response();

    await listHandler({ session: { userId: 'user-1' } }, res);

    expect(mocks.listConflicts).toHaveBeenCalledWith('user-1');
    expect(res.json).toHaveBeenCalledWith({ conflicts });
  });

  it('returns 404 when an owned conflict detail does not exist', async () => {
    mocks.getConflict.mockResolvedValueOnce(null);
    const res = response();

    await detailHandler({
      session: { userId: 'user-1' },
      params: { id: 'conflict-1' },
    }, res);

    expect(mocks.getConflict).toHaveBeenCalledWith('user-1', 'conflict-1');
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'CardDAV conflict not found' });
  });

  it('delegates only the authenticated user, conflict ID, and exact resolution', async () => {
    const conflict = { id: 'conflict-1', status: 'resolved', resolution: 'keep-mailflow' };
    mocks.resolveConflict.mockResolvedValueOnce(conflict);
    const res = response();

    await resolveHandler({
      session: { userId: 'user-1' },
      params: { id: 'conflict-1' },
      body: {
        resolution: 'keep-mailflow',
        contactId: 'attacker-supplied-contact',
        addressBookId: 'attacker-supplied-book',
      },
    }, res);

    expect(mocks.resolveConflict).toHaveBeenCalledWith(
      'user-1',
      'conflict-1',
      'keep-mailflow',
    );
    expect(res.json).toHaveBeenCalledWith(conflict);
  });

  it('maps invalid resolutions to 400 and stale or resolved transitions to 409', async () => {
    const invalid = Object.assign(new Error('Invalid CardDAV conflict resolution'), {
      code: 'ERR_CARDDAV_CONFLICT_RESOLUTION',
    });
    const stale = Object.assign(new Error('CardDAV conflict is stale'), {
      code: 'ERR_CARDDAV_CONFLICT_STALE',
    });

    for (const [error, status] of [[invalid, 400], [stale, 409]]) {
      mocks.resolveConflict.mockRejectedValueOnce(error);
      const res = response();
      await resolveHandler({
        session: { userId: 'user-1' },
        params: { id: 'conflict-1' },
        body: { resolution: 'bad' },
      }, res);
      expect(res.status).toHaveBeenCalledWith(status);
      expect(res.json).toHaveBeenCalledWith({ error: error.message });
    }
  });
});
