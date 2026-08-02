import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EMBEDDINGS_KEY_SENTINEL,
  emptyEmbeddingsForm,
  embeddingsFormFromConfig,
  buildEmbeddingsPayload,
  embeddingsDirty,
  isSameAsChatProvider,
  reconcileDimension,
  embeddingsJob,
  canSaveAiConfig,
} from './embeddingsSettings.js';

test('emptyEmbeddingsForm is disabled with blank fields', () => {
  assert.deepEqual(emptyEmbeddingsForm(), { enabled: false, endpoint: '', apiKey: '', model: '', dimension: '' });
});

test('embeddingsFormFromConfig maps the masked sub-config, dimension as a string', () => {
  const cfg = { baseUrl: 'x', embeddings: { enabled: true, endpoint: 'https://api.openai.com/v1', apiKey: EMBEDDINGS_KEY_SENTINEL, model: 'text-embedding-3-small', dimension: 1536 } };
  assert.deepEqual(embeddingsFormFromConfig(cfg), {
    enabled: true, endpoint: 'https://api.openai.com/v1', apiKey: EMBEDDINGS_KEY_SENTINEL, model: 'text-embedding-3-small', dimension: '1536',
  });
});

test('embeddingsFormFromConfig falls back to an empty form when embeddings absent', () => {
  assert.deepEqual(embeddingsFormFromConfig(null), emptyEmbeddingsForm());
  assert.deepEqual(embeddingsFormFromConfig({ baseUrl: 'x' }), emptyEmbeddingsForm());
});

test('buildEmbeddingsPayload trims, coerces dimension to a number, passes the key through', () => {
  const payload = buildEmbeddingsPayload({ enabled: true, endpoint: ' https://h/v1/ ', apiKey: EMBEDDINGS_KEY_SENTINEL, model: ' m ', dimension: '768' });
  assert.deepEqual(payload, { enabled: true, endpoint: 'https://h/v1/', apiKey: EMBEDDINGS_KEY_SENTINEL, model: 'm', dimension: 768 });
  // The masked sentinel is passed untouched so the backend keeps the stored key.
  assert.equal(buildEmbeddingsPayload(emptyEmbeddingsForm()).dimension, 0);
  // A freshly typed key is sent verbatim (the backend encrypts it on save).
  assert.equal(buildEmbeddingsPayload({ ...emptyEmbeddingsForm(), apiKey: 'sk-new-123' }).apiKey, 'sk-new-123');
});

test('embeddingsDirty is false when the form matches the saved masked config', () => {
  const cfg = { embeddings: { enabled: true, endpoint: 'https://h/v1', apiKey: EMBEDDINGS_KEY_SENTINEL, model: 'm', dimension: 768 } };
  const form = embeddingsFormFromConfig(cfg);
  assert.equal(embeddingsDirty(form, cfg), false);
  assert.equal(embeddingsDirty({ ...form, endpoint: 'https://other/v1' }, cfg), true);
  assert.equal(embeddingsDirty({ ...form, apiKey: 'sk-new' }, cfg), true);
  assert.equal(embeddingsDirty({ ...form, dimension: '384' }, cfg), true);
  assert.equal(embeddingsDirty({ ...form, enabled: false }, cfg), true);
});

test('embeddingsDirty treats enabling against no saved config as dirty', () => {
  assert.equal(embeddingsDirty(emptyEmbeddingsForm(), null), false);
  assert.equal(embeddingsDirty({ ...emptyEmbeddingsForm(), enabled: true, endpoint: 'https://h/v1' }, null), true);
});

test('isSameAsChatProvider ignores trailing slashes and empty baseUrls', () => {
  assert.equal(isSameAsChatProvider('https://h/v1', 'https://h/v1/'), true);
  assert.equal(isSameAsChatProvider('https://h/v1', 'https://other/v1'), false);
  assert.equal(isSameAsChatProvider('', ''), false);
  assert.equal(isSameAsChatProvider('https://h/v1', ''), false);
});

test('reconcileDimension adopts a differing probed dimension', () => {
  assert.deepEqual(reconcileDimension('1536', 768), { dimension: 768, changed: true });
  assert.deepEqual(reconcileDimension('768', 768), { dimension: 768, changed: false });
  assert.deepEqual(reconcileDimension('', 384), { dimension: 384, changed: true });
  assert.deepEqual(reconcileDimension('768', 0), { dimension: 768, changed: false });
});

test('embeddingsJob extracts the embeddings row and computes percent', () => {
  const jobs = [
    { kind: 'fts', state: 'done', processed: 5, total: 5 },
    { kind: 'embeddings', state: 'running', processed: 25, total: 100, last_error: null },
  ];
  assert.deepEqual(embeddingsJob(jobs), { state: 'running', processed: 25, total: 100, lastError: null, percent: 25, active: true });
  assert.equal(embeddingsJob([{ kind: 'fts', state: 'done' }]), null);
  assert.equal(embeddingsJob(null), null);
});

test('embeddingsJob surfaces error state and a zero-total percent', () => {
  const jobs = [{ kind: 'embeddings', state: 'error', processed: 0, total: 0, last_error: 'connect ECONNREFUSED' }];
  const j = embeddingsJob(jobs);
  assert.equal(j.state, 'error');
  assert.equal(j.percent, 0);
  assert.equal(j.active, false);
  assert.equal(j.lastError, 'connect ECONNREFUSED');
});

test('canSaveAiConfig allows a complete chat config, an enabled block, or turning a saved block off', () => {
  assert.equal(canSaveAiConfig({ baseUrl: 'https://h/v1', model: 'm' }, { enabled: false }), true);
  assert.equal(canSaveAiConfig({ baseUrl: '', model: '' }, { enabled: true }), true);
  // Nothing configured, nothing saved → nothing to persist.
  assert.equal(canSaveAiConfig({ baseUrl: '', model: '' }, { enabled: false }), false);
  assert.equal(canSaveAiConfig({ baseUrl: 'https://h/v1', model: '' }, { enabled: false }), false);
  // Embeddings-only install: the saved config had embeddings on, so toggling it off
  // must stay persistable (otherwise stopping the hosted data path is a dead end).
  assert.equal(canSaveAiConfig({ baseUrl: '', model: '' }, { enabled: false }, { embeddings: { enabled: true } }), true);
  // A saved-but-disabled block does not by itself unlock Save.
  assert.equal(canSaveAiConfig({ baseUrl: '', model: '' }, { enabled: false }, { embeddings: { enabled: false } }), false);
});
