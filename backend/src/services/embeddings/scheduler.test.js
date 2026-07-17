import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./config.js', () => ({ resolveEmbedConfig: vi.fn(), generationFingerprint: vi.fn(() => 'fp') }));
vi.mock('./vectorStore.js', () => ({ isVectorAvailable: vi.fn(() => true) }));
vi.mock('./generations.js', () => ({ buildingGeneration: vi.fn(), activeGeneration: vi.fn(), retireGeneration: vi.fn() }));
const runOnce = vi.fn().mockResolvedValue({ claimed: 0 });
const runBackstop = vi.fn().mockResolvedValue({ claimed: 0 });
// Regular (constructable) function impls — arrow-function impls throw
// "is not a constructor" when the module under test does `new EmbeddingWorker(...)`.
vi.mock('./worker.js', () => ({ EmbeddingWorker: vi.fn(function () { return { runOnce, runBackstop }; }) }));
vi.mock('./client.js', () => ({ EmbeddingClient: vi.fn(function () {}) }));

const { resolveEmbedConfig } = await import('./config.js');
const { isVectorAvailable } = await import('./vectorStore.js');
const { buildingGeneration, activeGeneration, retireGeneration } = await import('./generations.js');
const { runSchedulerTick } = await import('./scheduler.js');
// Real single-flight lock (not mocked) — the scheduler tick must respect it.
const { tryAcquireEmbedRun, releaseEmbedRun, isEmbedRunActive } = await import('./embedRunLock.js');

const enabledCfg = { enabled: true, endpoint: 'http://h/v1', model: 'm', dimension: 4, maxInputChars: 32768, batchSize: 32, preprocess: {} };

beforeEach(() => {
  releaseEmbedRun(); // ensure the shared single-flight lock starts free each test
  // Reset the once-queues so an early-returning test can't leave an unconsumed
  // mockResolvedValueOnce that poisons a later test's expectations.
  resolveEmbedConfig.mockReset();
  buildingGeneration.mockReset();
  activeGeneration.mockReset();
  retireGeneration.mockReset();
  isVectorAvailable.mockReset().mockReturnValue(true);
  runOnce.mockClear();
  runBackstop.mockClear();
});

describe('runSchedulerTick', () => {
  it('no-ops when vector is unavailable', async () => {
    isVectorAvailable.mockReturnValueOnce(false);
    resolveEmbedConfig.mockResolvedValueOnce(enabledCfg);
    await runSchedulerTick(1000);
    expect(runOnce).not.toHaveBeenCalled();
  });

  it('no-ops when embeddings config is disabled', async () => {
    resolveEmbedConfig.mockResolvedValueOnce({ ...enabledCfg, enabled: false });
    await runSchedulerTick(1000);
    expect(runOnce).not.toHaveBeenCalled();
  });

  it('no-ops when there is no building or active generation', async () => {
    resolveEmbedConfig.mockResolvedValueOnce(enabledCfg);
    buildingGeneration.mockResolvedValueOnce(null);
    activeGeneration.mockResolvedValueOnce(null);
    await runSchedulerTick(1000);
    expect(runOnce).not.toHaveBeenCalled();
  });

  it('runs the worker against the building generation', async () => {
    resolveEmbedConfig.mockResolvedValueOnce(enabledCfg);
    buildingGeneration.mockResolvedValueOnce({ id: '9', dimension: 4, fingerprint: 'fp' });
    await runSchedulerTick(1000);
    expect(runOnce).toHaveBeenCalledWith('9');
  });

  it('skips when a run is already active (manual build in flight) — C1', async () => {
    resolveEmbedConfig.mockResolvedValueOnce(enabledCfg);
    buildingGeneration.mockResolvedValueOnce({ id: '9', dimension: 4, fingerprint: 'fp' });
    expect(tryAcquireEmbedRun()).toBe(true); // simulate a manual build holding the lock
    await runSchedulerTick(1000);
    expect(runOnce).not.toHaveBeenCalled();
    releaseEmbedRun();
  });

  it('releases the single-flight lock after running (does not starve later runs)', async () => {
    resolveEmbedConfig.mockResolvedValueOnce(enabledCfg);
    buildingGeneration.mockResolvedValueOnce({ id: '9', dimension: 4, fingerprint: 'fp' });
    await runSchedulerTick(1000);
    expect(runOnce).toHaveBeenCalledWith('9');
    expect(isEmbedRunActive()).toBe(false);
  });

  // Fingerprint guard: the config's fingerprint must match the generation the worker
  // would drive, or a model/dimension change mid-build embeds with the new client into
  // the old generation and wedges forever.
  it('retires a building generation whose fingerprint no longer matches the config', async () => {
    resolveEmbedConfig.mockResolvedValue(enabledCfg);
    buildingGeneration.mockResolvedValue({ id: '9', dimension: 4, fingerprint: 'old-fp' });
    await runSchedulerTick(1000);
    expect(retireGeneration).toHaveBeenCalledWith('9');
    expect(runOnce).not.toHaveBeenCalled();
    expect(isEmbedRunActive()).toBe(false); // lock released on the retire-and-return path
  });

  it('skips a mismatched active generation and logs once per fingerprint (no retire)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      resolveEmbedConfig.mockResolvedValue(enabledCfg);
      buildingGeneration.mockResolvedValue(null);
      // A matching active run first clears the once-per-fingerprint latch so this test
      // is independent of whatever ran before it.
      activeGeneration.mockResolvedValueOnce({ id: '7', dimension: 4, fingerprint: 'fp' });
      await runSchedulerTick(1000);
      runOnce.mockClear();

      // Two mismatched ticks: skip both, never retire an active gen, log exactly once.
      activeGeneration.mockResolvedValue({ id: '7', dimension: 4, fingerprint: 'old-fp' });
      await runSchedulerTick(2000);
      await runSchedulerTick(3000);

      expect(runOnce).not.toHaveBeenCalled();
      expect(retireGeneration).not.toHaveBeenCalled();
      expect(isEmbedRunActive()).toBe(false);
      const pauseLogs = logSpy.mock.calls.filter(([m]) => /pausing incremental/i.test(String(m)));
      expect(pauseLogs).toHaveLength(1);
    } finally {
      logSpy.mockRestore();
    }
  });
});
