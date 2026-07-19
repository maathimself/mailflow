import { describe, it, expect, vi, afterEach } from 'vitest';
vi.mock('../services/embeddings/vectorStore.js', () => ({ isVectorAvailable: vi.fn(() => true) }));
import { validateBuildConfig, probeEmbeddings, buildProbeClient, startEmbeddingBuild } from './aiEmbeddings.js';
import { isVectorAvailable } from '../services/embeddings/vectorStore.js';
import { BuildingInProgressError } from '../services/embeddings/generations.js';

const full = { enabled: true, endpoint: 'http://h/v1', model: 'm', dimension: 768, maxInputChars: 32768, batchSize: 32, preprocess: {} };

describe('validateBuildConfig', () => {
  it('accepts a complete config when vector is available', () => {
    expect(validateBuildConfig(full)).toBeNull();
  });
  it('rejects when vector is unavailable', () => {
    isVectorAvailable.mockReturnValueOnce(false);
    expect(validateBuildConfig(full)).toMatch(/vector/i);
  });
  it('rejects an incomplete config', () => {
    expect(validateBuildConfig({ ...full, dimension: 0 })).toMatch(/dimension/i);
    expect(validateBuildConfig(null)).toMatch(/not configured/i);
  });
});

describe('probeEmbeddings', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('echoes the returned dimension', async () => {
    const fakeClient = { embed: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]) };
    const out = await probeEmbeddings(fakeClient);
    expect(out).toEqual({ ok: true, dimension: 3 });
  });
  it('surfaces an embed error', async () => {
    const fakeClient = { embed: vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED')) };
    await expect(probeEmbeddings(fakeClient)).rejects.toThrow(/ECONNREFUSED/);
  });
  it('returns the endpoint\'s ACTUAL dimension even when the saved config disagrees', async () => {
    // Regression pin: with the probe client asserting cfg.dimension, a mismatch threw
    // before Test could return the probed value, so the UI's reconcileDimension
    // auto-fill was unreachable. The probe client must skip the assertion.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 200,
      headers: { get: () => null },
      json: async () => ({ data: [{ index: 0, embedding: Array(768).fill(0.1) }] }),
      text: async () => '',
    }));
    const out = await probeEmbeddings(buildProbeClient({ ...full, dimension: 1536 }));
    expect(out).toEqual({ ok: true, dimension: 768 });
  });
});

// Let the fire-and-forget worker chain (.then/.catch/.finally) settle.
const flush = () => new Promise((r) => setTimeout(r, 0));

function makeDeps(overrides = {}) {
  return {
    tryAcquireEmbedRun: vi.fn(() => true),
    releaseEmbedRun: vi.fn(),
    createGeneration: vi.fn().mockResolvedValue('gen-1'),
    buildingGeneration: vi.fn().mockResolvedValue(null),
    retireGeneration: vi.fn().mockResolvedValue(undefined),
    generationFingerprint: vi.fn(() => 'fp'),
    countPending: vi.fn().mockResolvedValue(5),
    upsertJob: vi.fn().mockResolvedValue(undefined),
    runWorker: vi.fn().mockResolvedValue({ succeeded: 5 }),
    log: vi.fn(),
    ...overrides,
  };
}

describe('startEmbeddingBuild', () => {
  it('returns a retryable 409 and never resets stamps when an embed run is active (Fix 1)', async () => {
    const deps = makeDeps({ tryAcquireEmbedRun: vi.fn(() => false) });
    const res = await startEmbeddingBuild(full, 'admin', deps);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/in progress/i);
    expect(deps.createGeneration).not.toHaveBeenCalled(); // stamp-reset never runs
    expect(deps.releaseEmbedRun).not.toHaveBeenCalled(); // never acquired ⇒ nothing to release
  });

  it('acquires the single-flight lock before createGeneration (Fix 1)', async () => {
    const deps = makeDeps();
    await startEmbeddingBuild(full, 'admin', deps);
    expect(deps.tryAcquireEmbedRun).toHaveBeenCalled();
    expect(deps.createGeneration).toHaveBeenCalledWith('m', 768, 'fp');
    expect(deps.tryAcquireEmbedRun.mock.invocationCallOrder[0])
      .toBeLessThan(deps.createGeneration.mock.invocationCallOrder[0]);
    await flush();
  });

  it('on success fires the worker and releases the lock exactly once (Fix 1)', async () => {
    const deps = makeDeps();
    const res = await startEmbeddingBuild(full, 'admin', deps);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, generationId: 'gen-1', total: 5 });
    expect(deps.runWorker).toHaveBeenCalledWith('gen-1', 5, full);
    await flush();
    expect(deps.releaseEmbedRun).toHaveBeenCalledTimes(1);
  });

  it('releases the lock and returns 409 when createGeneration fails outright (Fix 1)', async () => {
    const deps = makeDeps({ createGeneration: vi.fn().mockRejectedValue(new Error('boom')) });
    const res = await startEmbeddingBuild(full, 'admin', deps);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('boom');
    expect(deps.releaseEmbedRun).toHaveBeenCalledTimes(1);
    expect(deps.retireGeneration).not.toHaveBeenCalled();
  });

  it('releases the lock if the build fails after createGeneration but before the worker starts (Fix 1)', async () => {
    // A failing countPending would otherwise leave the lock held forever (it is taken
    // before createGeneration now), wedging every future build.
    const deps = makeDeps({ countPending: vi.fn().mockRejectedValue(new Error('db down')) });
    const res = await startEmbeddingBuild(full, 'admin', deps);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('db down');
    expect(deps.createGeneration).toHaveBeenCalledTimes(1);
    expect(deps.runWorker).not.toHaveBeenCalled();
    expect(deps.releaseEmbedRun).toHaveBeenCalledTimes(1);
  });

  it('retires a stale different-fingerprint building gen and retries createGeneration once (Fix 2b)', async () => {
    const createGeneration = vi.fn()
      .mockRejectedValueOnce(new BuildingInProgressError('building fingerprint=old-fp, requested=fp'))
      .mockResolvedValueOnce('gen-2');
    const deps = makeDeps({
      createGeneration,
      buildingGeneration: vi.fn().mockResolvedValue({ id: 'stale-1', fingerprint: 'old-fp' }),
    });
    const res = await startEmbeddingBuild(full, 'admin', deps);
    expect(deps.retireGeneration).toHaveBeenCalledWith('stale-1');
    expect(createGeneration).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(200);
    expect(res.body.generationId).toBe('gen-2');
    await flush();
    expect(deps.releaseEmbedRun).toHaveBeenCalledTimes(1);
  });

  it('surfaces a same-fingerprint BuildingInProgressError as 409 without retiring (Fix 2b)', async () => {
    const createGeneration = vi.fn().mockRejectedValue(new BuildingInProgressError('already building'));
    const deps = makeDeps({
      createGeneration,
      buildingGeneration: vi.fn().mockResolvedValue({ id: 'x', fingerprint: 'fp' }),
    });
    const res = await startEmbeddingBuild(full, 'admin', deps);
    expect(deps.retireGeneration).not.toHaveBeenCalled();
    expect(createGeneration).toHaveBeenCalledTimes(1); // no infinite retry
    expect(res.status).toBe(409);
    expect(deps.releaseEmbedRun).toHaveBeenCalledTimes(1);
  });
});
