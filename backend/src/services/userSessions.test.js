import { describe, expect, it, vi } from 'vitest';

const { closeSockets, query } = vi.hoisted(() => ({ closeSockets: vi.fn(), query: vi.fn(async () => ({ rowCount: 0 })) }));
vi.mock('../index.js', () => ({ imapManager: { closeSockets } }));
vi.mock('./db.js', () => ({ query }));

import { destroyUserSessions } from './userSessions.js';

// The DELETE itself runs against PostgreSQL in kvStore.postgres.test.js.
describe('destroyUserSessions', () => {
  it("deletes the user's sessions, sparing an excepted one", async () => {
    query.mockClear();
    await destroyUserSessions('u1', { exceptSessionId: 'b' });
    await destroyUserSessions('u1');
    expect(query.mock.calls.map(([sql, params]) => [sql.includes('DELETE FROM sessions'), params]))
      .toEqual([[true, ['u1', 'b']], [true, ['u1', null]]]);
  });

  it("closes the user's sockets too, sparing an excepted session's", async () => {
    closeSockets.mockClear();
    await destroyUserSessions('u1', { exceptSessionId: 'b' });
    await destroyUserSessions('u1');
    // A socket outlives the session it was opened with, and would keep receiving new mail.
    expect(closeSockets.mock.calls).toEqual([['u1', { exceptSessionId: 'b' }], ['u1']]);
  });

  it('still closes the sockets when the delete fails', async () => {
    closeSockets.mockClear();
    query.mockRejectedValueOnce(new Error('database down'));
    await destroyUserSessions('u1');
    expect(closeSockets.mock.calls).toEqual([['u1']]);
  });
});
