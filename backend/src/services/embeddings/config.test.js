import { describe, it, expect, vi } from 'vitest';
vi.mock('../db.js', () => ({ query: vi.fn() }));
vi.mock('../encryption.js', () => ({ decrypt: (v) => (v ? v.replace(/^enc:/, '') : v) }));
const { query } = await import('../db.js');
import { preprocessFingerprint, generationFingerprint, applyEmbedDefaults, resolveEmbedConfig } from './config.js';

const allOn = { stripQuotes: true, stripSignatures: true, stripHTML: true, stripBase64: true, stripURLTracking: true, collapseWhitespace: true };

describe('preprocessFingerprint', () => {
  it('is p1-111111 when all flags on', () => {
    expect(preprocessFingerprint(allOn)).toBe('p1-111111');
  });
  it('flips the 3rd bit (strip_html) off in field-declaration order', () => {
    expect(preprocessFingerprint({ ...allOn, stripHTML: false })).toBe('p1-110111');
  });
});

describe('generationFingerprint', () => {
  it('joins model:dim:preprocess:c<chars>:e<policy>', () => {
    const cfg = { model: 'nomic-embed-text', dimension: 768, maxInputChars: 32768, preprocess: allOn };
    expect(generationFingerprint(cfg)).toBe('nomic-embed-text:768:p1-111111:c32768:e1');
  });
});

describe('applyEmbedDefaults', () => {
  it('fills batchSize 32, maxInputChars 32768, all preprocess flags on', () => {
    const out = applyEmbedDefaults({ model: 'm', dimension: 4 });
    expect(out.batchSize).toBe(32);
    expect(out.maxInputChars).toBe(32768);
    expect(out.preprocess).toEqual(allOn);
  });
  it('preserves an explicit false preprocess flag', () => {
    const out = applyEmbedDefaults({ model: 'm', dimension: 4, preprocess: { stripQuotes: false } });
    expect(out.preprocess.stripQuotes).toBe(false);
    expect(out.preprocess.stripHTML).toBe(true);
  });
});

describe('resolveEmbedConfig', () => {
  it('returns null when ai_config has no embeddings block', async () => {
    query.mockResolvedValueOnce({ rows: [{ value: JSON.stringify({ baseUrl: 'x' }) }] });
    expect(await resolveEmbedConfig()).toBeNull();
  });
  it('decrypts the apiKey and applies defaults', async () => {
    query.mockResolvedValueOnce({ rows: [{ value: JSON.stringify({
      embeddings: { enabled: true, endpoint: 'http://h:8080/v1', apiKey: 'enc:secret', model: 'm', dimension: 4 },
    }) }] });
    const cfg = await resolveEmbedConfig();
    expect(cfg.apiKey).toBe('secret');
    expect(cfg.batchSize).toBe(32);
    expect(cfg.model).toBe('m');
  });
});
