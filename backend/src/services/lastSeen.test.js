import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));

import { touchLastSeen, resetLastSeenForTests, WRITE_EVERY_MS } from './lastSeen.js';

const flush = () => new Promise(r => setTimeout(r, 0));

beforeEach(() => resetLastSeenForTests());

describe('touchLastSeen', () => {
  it('writes once, then skips requests inside the interval', async () => {
    const write = vi.fn().mockResolvedValue({});
    touchLastSeen('u1', { now: 1000, write });
    touchLastSeen('u1', { now: 1000 + WRITE_EVERY_MS - 1, write });
    await flush();
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith('UPDATE users SET last_seen_at = NOW() WHERE id = $1', ['u1']);
  });

  it('writes again once the interval has passed', async () => {
    const write = vi.fn().mockResolvedValue({});
    touchLastSeen('u1', { now: 1000, write });
    touchLastSeen('u1', { now: 1000 + WRITE_EVERY_MS, write });
    await flush();
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('keeps users apart', async () => {
    const write = vi.fn().mockResolvedValue({});
    touchLastSeen('u1', { now: 1000, write });
    touchLastSeen('u2', { now: 1000, write });
    await flush();
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('retries on the next request when a write fails, without throwing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const write = vi.fn().mockRejectedValueOnce(new Error('db down')).mockResolvedValue({});
    touchLastSeen('u1', { now: 1000, write });
    await flush();
    touchLastSeen('u1', { now: 1001, write });
    await flush();
    expect(write).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
