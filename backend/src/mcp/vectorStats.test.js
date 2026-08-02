import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../services/embeddings/generations.js', () => ({
  activeGeneration: vi.fn(), buildingGeneration: vi.fn(), chunkCount: vi.fn(),
}));
import { query } from '../services/db.js';
import * as generations from '../services/embeddings/generations.js';
import { collectStats } from './vectorStats.js';
import { mockSurfaceDrift } from '../testSupport/mockSurface.js';

beforeEach(() => { query.mockReset(); generations.activeGeneration.mockReset(); generations.buildingGeneration.mockReset(); generations.chunkCount.mockReset(); });

describe('mock-drift guard', () => {
  it('every mocked generations key exists as a function on the real module', async () => {
    // Regression guard: chunkCount was mocked here (and in goldenParity) while the
    // real generations.js never implemented it — collectStats threw live.
    const real = await vi.importActual('../services/embeddings/generations.js');
    expect(mockSurfaceDrift(generations, real)).toEqual([]);
  });
});

describe('collectStats', () => {
  it('returns null when vector search is disabled', async () => {
    generations.activeGeneration.mockRejectedValue(new Error('disabled'));
    expect(await collectStats(['a'])).toBeNull();
  });

  it('reports the active generation and a scoped missing count', async () => {
    // activatedAt is epoch SECONDS (bigint) as generationByState now returns it;
    // the wire field is RFC3339 UTC WITHOUT sub-second digits (msgvault
    // vector/stats.go:146-153 formatTime uses time.RFC3339, never millis).
    // 1704067200 = 2024-01-01T00:00:00Z.
    generations.activeGeneration.mockResolvedValue({ id: 2, model: 'm', dimension: 1536, fingerprint: 'fp', state: 'active', activatedAt: 1704067200 });
    generations.buildingGeneration.mockResolvedValue(null);
    generations.chunkCount.mockResolvedValue(1000);
    query.mockResolvedValueOnce({ rows: [{ n: '7' }] }); // missing count
    const vs = await collectStats(['acc-1']);
    expect(vs.enabled).toBe(true);
    expect(vs.active_generation).toEqual({ id: 2, model: 'm', dimension: 1536, fingerprint: 'fp', state: 'active', activated_at: '2024-01-01T00:00:00Z', message_count: 1000 });
    expect(vs.missing_embeddings_total).toBe(7);
    // chunkCount is keyed by generation id (real signature). The missing count is scoped to
    // accountIds and keys off `embed_gen IS NULL` only (frozen invariant — no dead OR arm).
    expect(generations.chunkCount).toHaveBeenCalledWith(2);
    expect(query.mock.calls[0][1]).toEqual([['acc-1']]);
    const sql = query.mock.calls[0][0];
    expect(sql).toMatch(/embed_gen IS NULL/);
    expect(sql).not.toMatch(/embed_gen\s*<>/);
  });

  it('enabled with no active generation yet (first build) reports a null active_generation', async () => {
    generations.activeGeneration.mockResolvedValue(null);
    generations.buildingGeneration.mockResolvedValue(null);
    const vs = await collectStats([]);
    expect(vs).toEqual({ enabled: true, active_generation: null, missing_embeddings_total: 0 });
    expect(query).not.toHaveBeenCalled(); // empty scope skips the count query
  });

  it('OMITS activated_at when the epoch is absent or zero (msgvault omitempty, stats.go:47)', async () => {
    generations.activeGeneration.mockResolvedValue({ id: 2, model: 'm', dimension: 8, fingerprint: 'fp', state: 'active' }); // no activatedAt
    generations.buildingGeneration.mockResolvedValue(null);
    generations.chunkCount.mockResolvedValue(3);
    query.mockResolvedValueOnce({ rows: [{ n: '0' }] });
    const vs = await collectStats(['acc-1']);
    expect(vs.active_generation).not.toHaveProperty('activated_at');
  });

  it('reports a building generation with scoped progress and freezes missing on the build target', async () => {
    // startedAt is epoch SECONDS → RFC3339 (no millis) wire. 1706745600 = 2024-02-01T00:00:00Z.
    generations.activeGeneration.mockResolvedValue({ id: 2, model: 'm', dimension: 8, fingerprint: 'fp', state: 'active' });
    generations.buildingGeneration.mockResolvedValue({ id: 3, model: 'm2', dimension: 8, startedAt: 1706745600 });
    generations.chunkCount.mockImplementation(async (id) => (id === 2 ? 100 : 40)); // active done, building done
    query.mockResolvedValueOnce({ rows: [{ n: '10' }] }); // missing for building gen 3
    const vs = await collectStats(['acc-1']);
    expect(vs.building_generation).toEqual({ id: 3, model: 'm2', dimension: 8, started_at: '2024-02-01T00:00:00Z', progress: { done: 40, total: 50 } });
    expect(vs.missing_embeddings_total).toBe(10); // building coverage is the actionable target
    expect(query.mock.calls[0][1]).toEqual([['acc-1']]); // generation-agnostic (embed_gen IS NULL)
  });

  it('OMITS started_at when the building epoch is absent (msgvault omitempty, stats.go:56)', async () => {
    generations.activeGeneration.mockResolvedValue(null);
    generations.buildingGeneration.mockResolvedValue({ id: 3, model: 'm2', dimension: 8 }); // no startedAt
    generations.chunkCount.mockResolvedValue(40);
    query.mockResolvedValueOnce({ rows: [{ n: '10' }] });
    const vs = await collectStats(['acc-1']);
    expect(vs.building_generation).not.toHaveProperty('started_at');
  });

  it('degrades to partial data when the missing-count sub-query fails (msgvault stats.go:69-78 best-effort)', async () => {
    generations.activeGeneration.mockResolvedValue({ id: 2, model: 'm', dimension: 8, fingerprint: 'fp', state: 'active', activatedAt: 1704067200 });
    generations.buildingGeneration.mockResolvedValue(null);
    generations.chunkCount.mockResolvedValue(3);
    query.mockRejectedValueOnce(new Error('relation vanished')); // missingCount blows up
    const vs = await collectStats(['acc-1']);
    expect(vs).not.toBeNull(); // one broken sub-query must not blank the whole block
    expect(vs.active_generation.id).toBe(2);
    expect(vs.missing_embeddings_total).toBe(0);
  });
});
