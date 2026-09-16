import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./spamModelStore.js', () => ({
  retrainUser: vi.fn(),
  getAllUsersWithTrainingLog: vi.fn(),
}));

import { retrainUser, getAllUsersWithTrainingLog } from './spamModelStore.js';
import {
  offsetHoursForUser, runBucket, runFullRetrain, stop, start,
  CHECK_INTERVAL_MS, BOOT_DELAY_MS, RETRAIN_USER_TIMEOUT_MS,
} from './spamScheduler.js';

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

  it('skips the hour instead of queueing when a run is already in flight', async () => {
    getAllUsersWithTrainingLog.mockResolvedValue(['00000001-0000-4000-8000-000000000000']);
    let release;
    retrainUser.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));

    const running = runBucket(1);
    await vi.advanceTimersByTimeAsync(0); // let the (mocked) user list resolve
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const second = await runBucket(1);

    expect(second).toEqual({
      usersProcessed: 0, usersTimedOut: 0, totalDuration_ms: 0, skipped: 'already_running',
    });
    expect(retrainUser).toHaveBeenCalledTimes(1); // no interleaved second pass
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();

    release({ ok: true });
    await running;
  });

  it('bounds one user with a timeout and carries on with the rest', async () => {
    vi.useFakeTimers();
    try {
      getAllUsersWithTrainingLog.mockResolvedValue([
        '00000001-0000-4000-8000-000000000000',
        '00000019-0000-4000-8000-000000000000', // both in bucket 1
      ]);
      retrainUser.mockImplementationOnce(() => new Promise(() => {})) // never settles
        .mockResolvedValueOnce({ ok: true });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const running = runBucket(1);
      await vi.advanceTimersByTimeAsync(RETRAIN_USER_TIMEOUT_MS + 1);
      const ret = await running;

      expect(ret.usersTimedOut).toBe(1);
      expect(ret.usersProcessed).toBe(1); // the second user still ran
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('runFullRetrain', () => {
  it('retrains every user and reports the count', async () => {
    getAllUsersWithTrainingLog.mockResolvedValue(['u1', 'u2', 'u3']);
    const ret = await runFullRetrain();
    expect(ret.ok).toBe(true);
    expect(ret.usersProcessed).toBe(3);
    expect(retrainUser).toHaveBeenCalledTimes(3);
    expect(ret).toHaveProperty('totalDuration_ms');
  });

  it('refuses to start while the hourly bucket is running', async () => {
    getAllUsersWithTrainingLog.mockResolvedValue(['00000001-0000-4000-8000-000000000000']);
    let release;
    retrainUser.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));

    const bucket = runBucket(1);
    await vi.advanceTimersByTimeAsync(0);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ret = await runFullRetrain();
    expect(ret.ok).toBe(false);
    expect(ret.reason).toBe('already_running');
    expect(ret.runningKind).toBe('bucket');
    expect(retrainUser).toHaveBeenCalledTimes(1); // no second, concurrent pass
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();

    release({ ok: true });
    await bucket;
  });
});

describe('start/stop', () => {
  it('start() arms a single tick and is idempotent', async () => {
    getAllUsersWithTrainingLog.mockResolvedValue([]);
    start();
    start();
    expect(vi.getTimerCount()).toBe(1); // the second call is a no-op
    stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stop() clears the pending tick', async () => {
    getAllUsersWithTrainingLog.mockResolvedValue([]);
    start();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(BOOT_DELAY_MS); // boot tick runs, next one armed
    expect(vi.getTimerCount()).toBe(1);
    stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('arms the next bucket only after the current one settles (never overlaps)', async () => {
    // Deterministic clock: hour 0 matches the offset of the synthetic user ids below,
    // so the boot tick really starts a retrain.
    vi.setSystemTime(new Date('2026-09-15T00:00:00Z'));
    const USERS = 70; // each bounded at RETRAIN_USER_TIMEOUT_MS → the run lasts ~70 min
    const userIds = Array.from({ length: USERS },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    getAllUsersWithTrainingLog.mockResolvedValue(userIds);
    retrainUser.mockImplementation(() => new Promise(() => {})); // every user hits the timeout
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    start();
    await vi.advanceTimersByTimeAsync(BOOT_DELAY_MS);
    expect(getAllUsersWithTrainingLog).toHaveBeenCalledTimes(1);
    expect(retrainUser).toHaveBeenCalledTimes(1); // the run is in flight

    // Past the first hourly boundary with the run still going: an interval-driven
    // scheduler would have fired here and started a SECOND, overlapping run.
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS + 300000);
    expect(getAllUsersWithTrainingLog).toHaveBeenCalledTimes(1);

    // Let the boot run drain: 70 users × one capped slice ends at ~t=70 min, and no
    // tick may fire before the interval measured from that settle.
    await vi.advanceTimersByTimeAsync(300000);
    expect(getAllUsersWithTrainingLog).toHaveBeenCalledTimes(1);

    // One interval later the delayed tick finally runs — it was delayed, not lost.
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS + 100000);
    expect(getAllUsersWithTrainingLog).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});