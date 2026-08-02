import { describe, it, expect } from 'vitest';
import { translateVectorError } from './vectorErrors.js';

describe('translateVectorError', () => {
  it('maps each reason to its verbatim code prefix', () => {
    expect(translateVectorError('vector_not_enabled')).toMatch(/^vector_not_enabled: /);
    expect(translateVectorError('index_stale')).toMatch(/^index_stale: /);
    expect(translateVectorError('index_building')).toMatch(/^index_building: /);
    expect(translateVectorError('no_active_generation')).toMatch(/^no_active_generation: /);
    expect(translateVectorError('embedding_timeout')).toMatch(/^embedding_timeout: /);
  });
  it('index_stale matches msgvault prefix-verbatim (handlers.go:206-210 — no inserted "embedding")', () => {
    expect(translateVectorError('index_stale'))
      .toMatch(/^index_stale: the vector index does not match the configured model; /);
  });
  it('embedding_timeout ports msgvault wording (handlers.go:225-229)', () => {
    expect(translateVectorError('embedding_timeout'))
      .toMatch(/^embedding_timeout: the embedding endpoint did not respond in time; retry, /);
  });
  it('falls back to vector_not_enabled for an unknown reason', () => {
    expect(translateVectorError('mystery')).toMatch(/^vector_not_enabled: /);
  });
});
