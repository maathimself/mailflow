import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./imapManager.js', () => ({ providerProfile: vi.fn() }));

import { query } from './db.js';
import { providerProfile } from './imapManager.js';
import { startBodyBackfill, startAccountBodyBackfill, resetBodyBackfillState } from './bodyBackfill.js';

const account = { id: 'acct-1', imap_host: 'imap.icloud.com' };
const enabledProfile = { bodyBackfill: true, batchDelay: 2000, errorDelay: 100 };

// Instant, assertable deps so the drainer runs with no wall-clock waits.
function baseDeps(overrides = {}) {
  return {
    fetchBodies: vi.fn().mockResolvedValue({ fetched: 0 }),
    getLastActivityMs: () => 0,
    isSnippetIndexerRunning: () => false,
    upsertJobProgress: vi.fn().mockResolvedValue(),
    sleep: vi.fn().mockResolvedValue(),
    now: () => 1_000_000,
    ...overrides,
  };
}

// Route the mocked query by SQL shape. `batches` is an array of id-arrays returned in order;
// once exhausted it returns an empty batch (drained).
function mockQuery({ total = 0, haveBody = 0, batches = [], alive = true } = {}) {
  let i = 0;
  query.mockImplementation((sql) => {
    if (/AS total/.test(sql)) return Promise.resolve({ rows: [{ total, have_body: haveBody }] });
    if (/FROM email_accounts/.test(sql)) return Promise.resolve({ rows: alive ? [{ id: 'acct-1' }] : [] });
    if (/body_text IS NULL/.test(sql)) {
      const rows = (batches[i++] || []).map((id) => ({ id }));
      return Promise.resolve({ rows });
    }
    return Promise.resolve({ rows: [] });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetBodyBackfillState();
});

describe('startBodyBackfill — provider gate', () => {
  it('no-ops for a provider with bodyBackfill:false and never queries', async () => {
    providerProfile.mockReturnValue({ bodyBackfill: false });
    const deps = baseDeps();
    await startBodyBackfill(account, deps);
    expect(deps.fetchBodies).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });
});

describe('startBodyBackfill — nothing to do', () => {
  it('reports complete and fetches nothing when coverage is already full', async () => {
    providerProfile.mockReturnValue(enabledProfile);
    mockQuery({ total: 100, haveBody: 100 });
    const deps = baseDeps();
    await startBodyBackfill(account, deps);
    expect(deps.fetchBodies).not.toHaveBeenCalled();
    expect(deps.upsertJobProgress).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'body_backfill', state: 'done', processed: 100, total: 100 })
    );
  });
});

describe('startBodyBackfill — batching + keyset + progress', () => {
  it('drains 120 messages in batches of 50/50/20 and advances the cursor', async () => {
    providerProfile.mockReturnValue(enabledProfile);
    const b1 = Array.from({ length: 50 }, (_, k) => `a${k}`);
    const b2 = Array.from({ length: 50 }, (_, k) => `b${k}`);
    const b3 = Array.from({ length: 20 }, (_, k) => `c${k}`);
    mockQuery({ total: 120, haveBody: 0, batches: [b1, b2, b3] });
    const deps = baseDeps({ fetchBodies: vi.fn().mockImplementation((_id, ids) => Promise.resolve({ fetched: ids.length })) });

    await startBodyBackfill(account, deps);

    expect(deps.fetchBodies).toHaveBeenCalledTimes(3);
    expect(deps.fetchBodies).toHaveBeenNthCalledWith(1, 'acct-1', b1);
    expect(deps.fetchBodies).toHaveBeenNthCalledWith(2, 'acct-1', b2);
    expect(deps.fetchBodies).toHaveBeenNthCalledWith(3, 'acct-1', b3);
    // Cursor advances to the last id of the previous batch (keyset param $2).
    const scanCalls = query.mock.calls.filter(([sql]) => /body_text IS NULL/.test(sql));
    expect(scanCalls[0][1][1]).toBeNull();      // first scan: cursor null
    expect(scanCalls[1][1][1]).toBe('a49');     // second scan: last id of batch 1
    expect(scanCalls[2][1][1]).toBe('b49');     // third scan: last id of batch 2
    expect(deps.upsertJobProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: 'done', processed: 120, total: 120 })
    );
  });
});

describe('startBodyBackfill — session cap + resume', () => {
  it('pauses after MAX_BATCHES_PER_RUN batches, then resumes on the next call', async () => {
    providerProfile.mockReturnValue(enabledProfile);
    // Never drains: every scan returns 50 fresh ids so the run hits the batch cap.
    let n = 0;
    query.mockImplementation((sql) => {
      if (/AS total/.test(sql)) return Promise.resolve({ rows: [{ total: 100000, have_body: 0 }] });
      if (/FROM email_accounts/.test(sql)) return Promise.resolve({ rows: [{ id: 'acct-1' }] });
      if (/body_text IS NULL/.test(sql)) return Promise.resolve({ rows: Array.from({ length: 50 }, () => ({ id: `id-${n++}` })) });
      return Promise.resolve({ rows: [] });
    });
    const deps = baseDeps({ fetchBodies: vi.fn().mockResolvedValue({ fetched: 50 }) });

    await startBodyBackfill(account, deps);
    expect(deps.fetchBodies).toHaveBeenCalledTimes(200); // MAX_BATCHES_PER_RUN
    expect(deps.upsertJobProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: 'paused' })
    );

    // Resume: the run guard was released in finally, so a second call proceeds (not gated).
    await startBodyBackfill(account, deps);
    expect(deps.fetchBodies).toHaveBeenCalledTimes(400);
  });
});

describe('startBodyBackfill — single drainer per account', () => {
  it('a second concurrent call for the same account is a no-op', async () => {
    providerProfile.mockReturnValue(enabledProfile);
    mockQuery({ total: 50, haveBody: 0, batches: [['x1']] });
    const deps = baseDeps({ fetchBodies: vi.fn().mockResolvedValue({ fetched: 1 }) });

    // Both are invoked synchronously in the same tick: the first adds the account to the
    // run guard before its first await, so the second sees it and returns immediately.
    const p1 = startBodyBackfill(account, deps);
    const p2 = startBodyBackfill(account, deps);
    await Promise.all([p1, p2]);

    expect(deps.fetchBodies).toHaveBeenCalledTimes(1); // only p1 did work
  });
});

describe('startBodyBackfill — circuit breaker trip + recovery', () => {
  it('trips after 3 consecutive batch errors, blocks retries in the window, recovers after it', async () => {
    providerProfile.mockReturnValue(enabledProfile);
    mockQuery({ total: 100, haveBody: 0, batches: [['x1'], ['x1'], ['x1']] });
    let clock = 1_000_000;
    const failing = baseDeps({
      fetchBodies: vi.fn().mockRejectedValue(new Error('Command failed')),
      now: () => clock,
    });

    // Trip: 3 consecutive rejections abort the run and open the breaker.
    await startBodyBackfill(account, failing);
    expect(failing.fetchBodies).toHaveBeenCalledTimes(3);
    // A terminal 'error' progress row is written so background_jobs doesn't keep showing a
    // stale 'running' state for an account that's actually stalled.
    expect(failing.upsertJobProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'body_backfill', state: 'error' })
    );

    // Blocked: a call inside the back-off window no-ops (breaker open).
    const blocked = baseDeps({ fetchBodies: vi.fn(), now: () => clock });
    await startBodyBackfill(account, blocked);
    expect(blocked.fetchBodies).not.toHaveBeenCalled();

    // Recover: advance past the back-off window; a fresh call runs again.
    clock += 3 * 60 * 60 * 1000; // beyond BACKOFF_MAX_MS (2h)
    mockQuery({ total: 100, haveBody: 0, batches: [['y1']] });
    const recovered = baseDeps({ fetchBodies: vi.fn().mockResolvedValue({ fetched: 1 }), now: () => clock });
    await startBodyBackfill(account, recovered);
    expect(recovered.fetchBodies).toHaveBeenCalledTimes(1);
  });
});

describe('startBodyBackfill — quiet-window backpressure', () => {
  it('adds the remaining quiet window to the post-batch delay when the user is active', async () => {
    providerProfile.mockReturnValue(enabledProfile);
    mockQuery({ total: 1, haveBody: 0, batches: [['m1']] });
    const NOW = 5_000_000;
    const deps = baseDeps({
      fetchBodies: vi.fn().mockResolvedValue({ fetched: 1 }),
      now: () => NOW,
      getLastActivityMs: () => NOW - 2000, // user opened a message 2s ago
    });

    await startBodyBackfill(account, deps);

    // batchDelay = max(2000, 2000) = 2000; quiet window 8000 - 2000 elapsed = 6000 extra.
    expect(deps.sleep).toHaveBeenCalledWith(8000);
  });
});

describe('startBodyBackfill — defers to the snippet indexer', () => {
  it('gates the kick: never fetches when the indexer is already running', async () => {
    providerProfile.mockReturnValue(enabledProfile);
    mockQuery({ total: 100, haveBody: 0, batches: [['x1']] });
    const deps = baseDeps({ isSnippetIndexerRunning: () => true });

    await startBodyBackfill(account, deps);

    expect(deps.fetchBodies).not.toHaveBeenCalled();
    expect(deps.upsertJobProgress).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'body_backfill', state: 'deferred' })
    );
  });

  it('re-checks every iteration: defers mid-session once the indexer starts, without tripping the breaker', async () => {
    providerProfile.mockReturnValue(enabledProfile);
    const b1 = ['a1'];
    const b2 = ['b1'];
    mockQuery({ total: 100, haveBody: 0, batches: [b1, b2] });
    let indexerRunning = false;
    const deps = baseDeps({
      fetchBodies: vi.fn().mockImplementation(() => {
        indexerRunning = true; // simulate the snippet indexer kicking in right after batch 1
        return Promise.resolve({ fetched: 1 });
      }),
      isSnippetIndexerRunning: () => indexerRunning,
    });

    await startBodyBackfill(account, deps);

    // Batch 1 runs (indexer not yet running); batch 2's scan never happens because the
    // re-check at the top of the next iteration sees the indexer is now running and bails.
    expect(deps.fetchBodies).toHaveBeenCalledTimes(1);
    expect(deps.upsertJobProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: 'deferred' })
    );

    // Deferring is not a failure: the circuit breaker must not be armed by it.
    const resumed = baseDeps({ fetchBodies: vi.fn().mockResolvedValue({ fetched: 1 }) });
    mockQuery({ total: 100, haveBody: 1, batches: [['c1']] });
    await startBodyBackfill(account, resumed);
    expect(resumed.fetchBodies).toHaveBeenCalledTimes(1);
  });
});

describe('startBodyBackfill — forward progress', () => {
  it('drains to completion even when every batch reports {fetched:0} (resolved, not rejected)', async () => {
    providerProfile.mockReturnValue(enabledProfile);
    const b1 = Array.from({ length: 50 }, (_, k) => `a${k}`);
    const b2 = Array.from({ length: 10 }, (_, k) => `b${k}`);
    mockQuery({ total: 60, haveBody: 0, batches: [b1, b2] });
    const deps = baseDeps({ fetchBodies: vi.fn().mockResolvedValue({ fetched: 0 }) });

    await startBodyBackfill(account, deps);

    // The cursor still advances on a resolved (non-throwing) call even when it wrote nothing —
    // e.g. every message in the batch legitimately has no fetchable body — so the run still
    // reaches completion instead of looping forever or being mistaken for a failure.
    expect(deps.fetchBodies).toHaveBeenCalledTimes(2);
    expect(deps.upsertJobProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: 'done', processed: 0, total: 60 })
    );
  });
});

describe('startAccountBodyBackfill — adapter wiring', () => {
  it('wires imapManager.fetchBodiesForMessages and lastUserActivity into the core drainer', async () => {
    vi.useFakeTimers();
    providerProfile.mockReturnValue(enabledProfile);
    mockQuery({ total: 1, haveBody: 0, batches: [['m1']] });
    const fakeImap = {
      fetchBodiesForMessages: vi.fn().mockResolvedValue({ fetched: 1 }),
      lastUserActivity: new Map([['acct-1', Date.now()]]),
      snippetIndexerRunning: new Set(),
    };
    const upsert = vi.fn().mockResolvedValue();

    const p = startAccountBodyBackfill(account, fakeImap, upsert);
    await vi.runAllTimersAsync(); // flush the real setTimeout used by the default sleep
    await p;

    expect(fakeImap.fetchBodiesForMessages).toHaveBeenCalledWith('acct-1', ['m1']);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'body_backfill', accountId: 'acct-1' })
    );
    vi.useRealTimers();
  });

  it('wires imapManager.snippetIndexerRunning so an already-running indexer defers the kick', async () => {
    providerProfile.mockReturnValue(enabledProfile);
    mockQuery({ total: 1, haveBody: 0, batches: [['m1']] });
    const fakeImap = {
      fetchBodiesForMessages: vi.fn().mockResolvedValue({ fetched: 1 }),
      lastUserActivity: new Map(),
      snippetIndexerRunning: new Set(['acct-1']),
    };
    const upsert = vi.fn().mockResolvedValue();

    await startAccountBodyBackfill(account, fakeImap, upsert);

    expect(fakeImap.fetchBodiesForMessages).not.toHaveBeenCalled();
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ state: 'deferred' }));
  });
});
