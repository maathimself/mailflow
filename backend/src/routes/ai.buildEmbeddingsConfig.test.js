import { describe, it, expect, vi } from 'vitest';
vi.mock('../services/encryption.js', () => ({
  encrypt: (v) => `enc:${v}`,
  decrypt: (v) => (v ? String(v).replace(/^enc:/, '') : v),
}));
import { buildEmbeddingsConfig } from './ai.js';

describe('buildEmbeddingsConfig', () => {
  it('encrypts a freshly supplied apiKey', () => {
    const out = buildEmbeddingsConfig(
      { enabled: true, endpoint: 'http://h/v1', apiKey: 'sk-1', model: 'm', dimension: 768 },
      null,
    );
    expect(out.apiKey).toBe('enc:sk-1');
    expect(out.dimension).toBe(768);
    expect(out.preprocess.stripHTML).toBe(true);
  });
  it('keeps the existing key when the masked sentinel is sent back', () => {
    const out = buildEmbeddingsConfig(
      { apiKey: '••••••••', model: 'm', dimension: 4 },
      { apiKey: 'enc:old' },
    );
    expect(out.apiKey).toBe('enc:old');
  });
  it('preserves an explicit-false preprocess flag', () => {
    const out = buildEmbeddingsConfig(
      { model: 'm', dimension: 4, preprocess: { stripQuotes: false } },
      null,
    );
    expect(out.preprocess.stripQuotes).toBe(false);
  });
});
