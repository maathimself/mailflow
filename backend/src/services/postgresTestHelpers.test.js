import { describe, expect, it } from 'vitest';
import { waitForPostgresState } from './postgresTestHelpers.js';

describe('waitForPostgresState', () => {
  it('reports the bounded wait and final safe state when the probe never succeeds', async () => {
    await expect(waitForPostgresState({
      description: 'mapping transaction to block',
      timeoutMs: 50,
      probe: async () => ({ done: false, state: { wait_event_type: null } }),
    })).rejects.toThrow(/mapping transaction to block.*50 ms.*wait_event_type/);
  });

  it('rejects within the bound when a probe never resolves', async () => {
    // Generous wall bound: the 30 ms internal deadline must win the race, but a
    // heavily loaded host can stall the event loop for a while — keep the margin
    // wide enough that a stall cannot let the wall timer fire first and flip the
    // asserted rejection message. This only guards against a genuine hang.
    const wallBoundMs = 2000;
    let wallTimer;
    const startedAt = performance.now();

    try {
      await expect(Promise.race([
        waitForPostgresState({
          description: 'stalled PostgreSQL probe',
          timeoutMs: 30,
          probe: () => new Promise(() => {}),
        }),
        new Promise((_, reject) => {
          wallTimer = setTimeout(
            () => reject(new Error(`Exceeded ${wallBoundMs} ms wall bound`)),
            wallBoundMs,
          );
        }),
      ])).rejects.toThrow(
        'Timed out waiting for stalled PostgreSQL probe within 30 ms; last observed state: null',
      );
      expect(performance.now() - startedAt).toBeLessThan(wallBoundMs);
    } finally {
      clearTimeout(wallTimer);
    }
  });

  it('rejects a successful probe result that completes after the deadline', async () => {
    let probeTimer;
    let markProbeSettled;
    const probeSettled = new Promise(resolve => { markProbeSettled = resolve; });
    const probeResult = new Promise(resolve => {
      probeTimer = setTimeout(() => {
        resolve({ done: true, state: { status: 'ready' } });
        markProbeSettled();
      }, 75);
    });

    try {
      await expect(waitForPostgresState({
        description: 'late successful PostgreSQL probe',
        timeoutMs: 20,
        probe: () => probeResult,
      })).rejects.toThrow(
        'Timed out waiting for late successful PostgreSQL probe within 20 ms; '
        + 'last observed state: null',
      );
      await probeSettled;
    } finally {
      clearTimeout(probeTimer);
    }
  });
});
