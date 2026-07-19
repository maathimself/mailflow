// Code prefixes are verbatim from msgvault (handlers.go translateVectorErr).
// Remediation hints are Mailflow-specific (msgvault references a CLI we don't
// ship) — a documented divergence; golden diffing asserts the prefix only.
const MESSAGES = {
  vector_not_enabled: 'vector_not_enabled: vector search is not configured on this server',
  index_stale: 'index_stale: the vector index does not match the configured model; reconfigure embeddings to rebuild',
  index_building: 'index_building: the initial vector index is still being built',
  no_active_generation: 'no_active_generation: vector search has no active index yet; wait for the embedding worker to finish an initial build',
  // msgvault handlers.go:225-229; remediation names Mailflow's knob (the
  // embedding client timeout) instead of msgvault's [vector.embeddings].timeout TOML.
  embedding_timeout: 'embedding_timeout: the embedding endpoint did not respond in time; retry, or raise the embedding client timeout in settings',
};

export const VECTOR_ERROR_CODES = Object.keys(MESSAGES);

export function translateVectorError(reason) {
  return MESSAGES[reason] || MESSAGES.vector_not_enabled;
}
