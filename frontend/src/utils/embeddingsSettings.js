// Pure helpers for the AI-settings embeddings block. The React component
// (AdminPanel.jsx → AISection) owns the rendering; everything testable lives
// here, mirroring the phase-4 searchMode.js split.

// The backend masks a stored key as this sentinel on read and, on save, treats it
// as "keep the existing key" — identical handling to the chat apiKey field.
export const EMBEDDINGS_KEY_SENTINEL = '••••••••';

// Known model → returned dimension, surfaced as a hint next to the model field.
export const EMBEDDING_MODEL_HINTS = [
  { model: 'text-embedding-3-small', dimension: 1536 },
  { model: 'text-embedding-3-large', dimension: 3072 },
  { model: 'nomic-embed-text', dimension: 768 },
  { model: 'all-minilm', dimension: 384 },
];

export function emptyEmbeddingsForm() {
  return { enabled: false, endpoint: '', apiKey: '', model: '', dimension: '' };
}

// Map the masked embeddings sub-config from GET /admin/ai to editable form state.
// dimension becomes a string so the numeric <input> stays controlled and empty-able.
export function embeddingsFormFromConfig(cfg) {
  const e = cfg?.embeddings;
  if (!e) return emptyEmbeddingsForm();
  return {
    enabled: e.enabled === true,
    endpoint: e.endpoint || '',
    apiKey: e.apiKey || '', // already the sentinel when a key is stored
    model: e.model || '',
    dimension: e.dimension ? String(e.dimension) : '',
  };
}

// Build the `embeddings` sub-object for the PATCH body. dimension is coerced to a
// number; the masked sentinel is passed through untouched so the backend keeps the
// stored key. Endpoint/model are trimmed (the backend trims again — belt and braces).
export function buildEmbeddingsPayload(form) {
  return {
    enabled: form.enabled === true,
    endpoint: (form.endpoint || '').trim(),
    apiKey: form.apiKey || '',
    model: (form.model || '').trim(),
    dimension: Number(form.dimension) || 0,
  };
}

// Test and Build probe the SAVED config (resolveEmbedConfig), never request-body
// values — so they must stay gated until the form is persisted. A masked apiKey on
// both sides compares equal (no change); a typed or cleared key reads as dirty.
export function embeddingsDirty(form, savedCfg) {
  const saved = embeddingsFormFromConfig(savedCfg);
  return form.enabled !== saved.enabled
    || (form.endpoint || '') !== (saved.endpoint || '')
    || (form.model || '') !== (saved.model || '')
    || String(form.dimension || '') !== String(saved.dimension || '')
    || (form.apiKey || '') !== (saved.apiKey || '');
}

// "Same as chat provider": the stored endpoint mirrors the chat baseUrl exactly
// (trailing slashes ignored, matching the backend's normalization).
export function isSameAsChatProvider(endpoint, chatBaseUrl) {
  const norm = (s) => (s || '').trim().replace(/\/+$/, '');
  const c = norm(chatBaseUrl);
  return !!c && norm(endpoint) === c;
}

// After a successful Test probe the endpoint is the source of truth for the real
// dimension, so adopt the probed value when it differs from what was entered.
export function reconcileDimension(current, probed) {
  const c = Number(current) || 0;
  const changed = probed > 0 && probed !== c;
  return { dimension: changed ? probed : c, changed };
}

// Extract the embeddings build job from GET /admin/indexing/status → { jobs }.
export function embeddingsJob(jobs) {
  const job = (jobs || []).find(j => j.kind === 'embeddings');
  if (!job) return null;
  const processed = Number(job.processed) || 0;
  const total = Number(job.total) || 0;
  return {
    state: job.state, // running | done | error
    processed,
    total,
    lastError: job.last_error || null,
    percent: total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0,
    active: job.state === 'running',
  };
}

// The single PATCH /admin/ai save writes chat + embeddings together, so allow it
// when a complete chat config or an enabled embeddings block is present (an
// embeddings-only install should not need to fill in chat fields). Also allow it
// when the SAVED config already had embeddings on — otherwise toggling embeddings
// off could never be persisted, leaving no way to stop a hosted data path short of
// removing the whole config.
export function canSaveAiConfig(form, emb, savedCfg) {
  const savedEmbEnabled = savedCfg?.embeddings?.enabled === true;
  return !!(form.baseUrl && form.model) || !!(emb && emb.enabled) || savedEmbEnabled;
}
