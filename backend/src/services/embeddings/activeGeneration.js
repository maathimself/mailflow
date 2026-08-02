import { VectorUnavailableError } from './vectorErrors.js';
import * as generations from './generations.js';
import { resolveEmbedConfig, generationFingerprint } from './config.js';

const DEFAULTS = {
  activeGeneration: generations.activeGeneration,
  buildingGeneration: generations.buildingGeneration,
};

// Port of internal/vector/generations.go ResolveActiveForFingerprint.
// Throws VectorUnavailableError('index_stale') on a fingerprint mismatch
// (a rebuild superseded the caller's config), ('index_building') when only
// a build is in progress, ('no_active_generation') when neither exists.
export async function resolveActiveGeneration(fingerprint, overrides = {}) {
  const d = { ...DEFAULTS, ...overrides };
  const active = await d.activeGeneration();
  if (active) {
    if (fingerprint && active.fingerprint !== fingerprint) throw new VectorUnavailableError('index_stale');
    return { id: active.id, model: active.model, dimension: active.dimension, fingerprint: active.fingerprint, state: active.state };
  }
  if (await d.buildingGeneration()) throw new VectorUnavailableError('index_building');
  throw new VectorUnavailableError('no_active_generation');
}

const PREAMBLE_DEFAULTS = {
  resolveEmbedConfig,
  generationFingerprint,
  resolveActiveGeneration,
};

// The full vector-availability gate shared by every caller that needs an active
// generation from the stored embed config: resolve the config, reject an absent or
// disabled one as vector_not_enabled, then resolve the active generation by
// fingerprint (which throws index_stale/index_building/no_active_generation on a
// degraded index). Returns the resolved cfg alongside the generation — callers need
// both (the embed client + preprocess config, and the generation id/dimension). The
// collaborators are injectable so hybridSearch can thread its own fakes through.
export async function resolveActiveGenerationFromConfig(overrides = {}) {
  const d = { ...PREAMBLE_DEFAULTS, ...overrides };
  const cfg = await d.resolveEmbedConfig();
  if (!cfg || cfg.enabled === false) throw new VectorUnavailableError('vector_not_enabled');
  const generation = await d.resolveActiveGeneration(d.generationFingerprint(cfg));
  return { cfg, generation };
}
