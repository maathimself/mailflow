import { describe, expect, it, vi } from 'vitest';

const store = new Map();
vi.mock('./redis.js', () => ({
  redisClient: {
    scan: async () => ({ cursor: 0, keys: [...store.keys()] }),
    get: async key => store.get(key) ?? null,
    del: async key => store.delete(key),
  },
}));

import { destroyUserSessions } from './userSessions.js';

describe('destroyUserSessions', () => {
  it("removes every session of the user, keeps other users' and an excepted one", async () => {
    store.clear();
    store.set('sess:a', JSON.stringify({ userId: 'u1' }));
    store.set('sess:b', JSON.stringify({ userId: 'u1' }));
    store.set('sess:c', JSON.stringify({ userId: 'u2' }));
    store.set('sess:d', 'not json');
    await destroyUserSessions('u1', { exceptSessionId: 'b' });
    expect([...store.keys()].sort()).toEqual(['sess:b', 'sess:c', 'sess:d']);
    await destroyUserSessions('u1');
    expect([...store.keys()].sort()).toEqual(['sess:c', 'sess:d']);
  });
});
