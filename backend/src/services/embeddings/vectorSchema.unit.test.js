import { describe, it, expect, vi } from 'vitest';

// Mock the module graph so ensureVectorSchema runs without a real DB. The dedicated
// client (withDedicatedClient → new pg.Client) and the pool both resolve; the only
// variable is whether ensureVectorIndex(dim) throws (a non-integer dimension throws
// synchronously), which is exactly the "flag vs return" disagreement path.
const clientMock = { connect: vi.fn().mockResolvedValue(), query: vi.fn().mockResolvedValue({}), end: vi.fn().mockResolvedValue() };
// Regular (constructable) function impl — `new pg.Client(...)` needs a constructor.
vi.mock('pg', () => ({ default: { Client: vi.fn(function () { return clientMock; }) } }));
vi.mock('../db.js', () => ({ pool: { query: vi.fn().mockResolvedValue({}) }, withTransaction: vi.fn() }));
vi.mock('./config.js', () => ({ resolveEmbedConfig: vi.fn() }));

const { resolveEmbedConfig } = await import('./config.js');
const { ensureVectorSchema, isVectorAvailable } = await import('./vectorStore.js');

describe('ensureVectorSchema flag/return agreement', () => {
  it('reports available and sets the flag when the whole bring-up succeeds', async () => {
    resolveEmbedConfig.mockResolvedValueOnce({ dimension: 4, skipExtensionCreate: false });
    const r = await ensureVectorSchema();
    expect(r.vectorAvailable).toBe(true);
    expect(isVectorAvailable()).toBe(true);
  });

  it('leaves isVectorAvailable() false when ensureVectorIndex throws after the schema builds', async () => {
    // dimension 2.5 passes the `> 0` guard but ensureVectorIndex throws on the
    // non-integer, AFTER the extension + schema succeed — the disagreement window.
    resolveEmbedConfig.mockResolvedValueOnce({ dimension: 2.5, skipExtensionCreate: false });
    const r = await ensureVectorSchema();
    expect(r.vectorAvailable).toBe(false);
    expect(isVectorAvailable()).toBe(false);
  });
});
