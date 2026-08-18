import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./spamModelStore.js', () => ({
  retrainUser: vi.fn(),
  getAllUsersWithTrainingLog: vi.fn(),
}));

import { retrainUser, getAllUsersWithTrainingLog } from './spamModelStore.js';
import { offsetHoursForUser, runBucket, runFullRetrain, stop, start } from './spamScheduler.js';

beforeEach(() => {
  vi.useFakeTimers();
  retrainUser.mockReset().mockResolvedValue({ ok: true, recordsUsed: 1, duration_ms: 1 });
  getAllUsersWithTrainingLog.mockReset();
});

afterEach(() => {
  stop();
  vi.useRealTimers();
});

describe('offsetHoursForUser', () => {
  it('is stable for the same user', () => {
    expect(offsetHoursForUser('a3f1c2e4-0000-4000-8000-000000000000'))
      .toBe(offsetHoursForUser('a3f1c2e4-0000-4000-8000-000000000000'));
  });

  it('returns a value in [0, 23]', () => {
    for (const id of ['00000000-0000-4000-8000-000000000001', 'ffffffff-ffff-4fff-8fff-ffffffffffff']) {
      const offset = offsetHoursForUser(id);
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset).toBeLessThanOrEqual(23);
    }
  });

  it('distributes across the 24-hour window (uniform-ish)', () => {
    const seen = new Set();
    for (let i = 0; i < 240; i += 1) {
      const id = `${i.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
      seen.add(offsetHoursForUser(id));
    }
    // 240 synthetic UUIDs should hit most of the 24 buckets.
    expect(seen.size).toBeGreaterThanOrEqual(20);
  });
});

describe('runBucket', () => {
  it('retrains only users whose offset matches the hour', async () => {
    getAllUsersWithTrainingLog.mockResolvedValue([
      'a3f1c2e4-0000-4000-8000-000000000000', // offset = 0xa3f1c2e4 % 24 = 4
      '00000001-0000-4000-8000-000000000000', // offset = 1
    ]);
    const a3 = parseInt('a3f1c2e4', 16) % 24; // 4
    const result = await runBucket(1);
    expect(result.usersProcessed).toBe(1);
    expect(retrainUser).toHaveBeenCalledWith('00000001-0000-4000-8000-000000000000');
    expect(retrainUser).not.toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001');
    void a3;
  });

  it('continues on retrain errors (one bad user does not stop the bucket)', async () => {
    getAllUsersWithTrainingLog.mockResolvedValue([
      '00000001-0000-4000-8000-000000000000', // offset 1
      '0000000d-0000-4000-8000-000000000000', // offset ((0x0d)=13)%24=13 → not in bucket 1
      '00000019-0000-4000-8000-000000000000', // offset (25)%24=1 → in bucket 1
    ]);
    retrainUser.mockRejectedValueOnce(new Error('db down')).mockResolvedValueOnce({ ok: true });
    const ret = await runBucket(1);
    expect(ret.usersProcessed).toBe(1); // the failing one is skipped, the other succeeds
  });
});

describe('runFullRetrain', () => {
  it('retrains every user and reports the count', async () => {
    getAllUsersWithTrainingLog.mockResolvedValue(['u1', 'u2', 'u3']);
    const ret = await runFullRetrain();
    expect(ret.usersProcessed).toBe(3);
    expect(retrainUser).toHaveBeenCalledTimes(3);
    expect(ret).toHaveProperty('totalDuration_ms');
  });
});

describe('start/stop', () => {
  it('start() schedules an interval and is idempotent', async () => {
    const spy = vi.spyOn(globalThis, 'setInterval');
    getAllUsersWithTrainingLog.mockResolvedValue([]);
    start();
    start();
    expect(spy).toHaveBeenCalledTimes(1); // second call is a no-op
    stop();
    expect(vi.getTimerCount()).toBe(0);
    spy.mockRestore();
  });

  it('stop() clears the interval', () => {
    start();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});