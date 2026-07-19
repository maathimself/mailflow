import { describe, it, expect } from 'vitest';
import { resolveActiveGeneration } from './activeGeneration.js';
import { VectorUnavailableError } from './vectorErrors.js';

const gen = { id: 3, model: 'm', dimension: 4, fingerprint: 'm:4:fp', state: 'active', messageCount: 10 };

describe('resolveActiveGeneration', () => {
  it('returns the rich active generation when the fingerprint matches', async () => {
    const g = await resolveActiveGeneration('m:4:fp',
      { activeGeneration: async () => gen, buildingGeneration: async () => null });
    expect(g).toEqual({ id: 3, model: 'm', dimension: 4, fingerprint: 'm:4:fp', state: 'active' });
  });
  it('throws index_stale on a fingerprint mismatch', async () => {
    const err = await resolveActiveGeneration('OTHER',
      { activeGeneration: async () => gen, buildingGeneration: async () => null }).catch(e => e);
    expect(err).toBeInstanceOf(VectorUnavailableError);
    expect(err.reason).toBe('index_stale');
  });
  it('throws index_building when a build is in progress and none active', async () => {
    const err = await resolveActiveGeneration('x',
      { activeGeneration: async () => null, buildingGeneration: async () => ({ id: 9 }) }).catch(e => e);
    expect(err.reason).toBe('index_building');
  });
  it('throws no_active_generation when nothing exists', async () => {
    const err = await resolveActiveGeneration('x',
      { activeGeneration: async () => null, buildingGeneration: async () => null }).catch(e => e);
    expect(err.reason).toBe('no_active_generation');
  });
});
