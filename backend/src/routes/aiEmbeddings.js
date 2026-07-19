import { Router } from 'express';
import { requireAdmin } from '../middleware/auth.js';
import { resolveEmbedConfig, generationFingerprint } from '../services/embeddings/config.js';
import { isVectorAvailable } from '../services/embeddings/vectorStore.js';
import * as store from '../services/embeddings/vectorStore.js';
import * as generations from '../services/embeddings/generations.js';
const { createGeneration, buildingGeneration, retireGeneration, BuildingInProgressError } = generations;
import { EmbeddingClient } from '../services/embeddings/client.js';
import { EmbeddingWorker } from '../services/embeddings/worker.js';
import { tryAcquireEmbedRun, releaseEmbedRun } from '../services/embeddings/embedRunLock.js';
import { upsertJob } from '../services/backgroundJobs.js';
import { query } from '../services/db.js';

const router = Router();

// Returns an error string when the config cannot start a build, else null. Pure helper.
export function validateBuildConfig(cfg) {
  if (!isVectorAvailable()) return 'Vector extension unavailable — semantic search is disabled on this database';
  if (!cfg) return 'Embeddings not configured';
  if (!cfg.enabled) return 'Embeddings are disabled';
  if (!cfg.endpoint) return 'Embeddings endpoint is required';
  if (!cfg.model) return 'Embeddings model is required';
  if (!(cfg.dimension > 0)) return 'Embeddings dimension must be a positive integer';
  return null;
}

// Probe the embedding endpoint with one input and echo the returned dimension. Pure helper.
export async function probeEmbeddings(client) {
  const vecs = await client.embed(['mailflow embeddings connectivity probe']);
  return { ok: true, dimension: vecs[0].length };
}

// The probe client intentionally omits the dimension expectation (dimension: null
// skips the client's per-vector assertion): Test's whole job is to DISCOVER the
// endpoint's real dimension so the UI can reconcile a wrong saved value
// (reconcileDimension auto-fill). With the assertion in place, a mismatch threw
// before the probed dimension ever reached the response, making that UI path
// unreachable. Worker/query paths keep the strict assertion — they construct
// their clients with cfg.dimension.
export function buildProbeClient(cfg) {
  return new EmbeddingClient({ endpoint: cfg.endpoint, apiKey: cfg.apiKey, model: cfg.model, dimension: null });
}

router.post('/admin/ai/embeddings/test-embeddings', requireAdmin, async (req, res) => {
  const cfg = await resolveEmbedConfig();
  if (!cfg || !cfg.endpoint || !cfg.model || !(cfg.dimension > 0)) {
    return res.status(400).json({ error: 'Embeddings endpoint, model, and dimension are required' });
  }
  try {
    res.json(await probeEmbeddings(buildProbeClient(cfg)));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Count live messages still needing embedding under generation `gen` (the build's
// initial "total"). Default collaborator for startEmbeddingBuild.
async function countPending(gen) {
  const r = await query(
    'SELECT COUNT(*)::int n FROM messages WHERE (embed_gen IS NULL OR embed_gen <> $1) AND is_deleted = false', [gen],
  );
  return r.rows[0].n;
}

// Fire-and-forget worker run toward coverage. Returns worker.runOnce's promise so the
// caller can chain job-state updates and the single-flight release onto its settlement.
function runWorker(gen, total, cfg) {
  const client = new EmbeddingClient({ endpoint: cfg.endpoint, apiKey: cfg.apiKey, model: cfg.model, dimension: cfg.dimension });
  const worker = new EmbeddingWorker({
    // `generations` lets the worker activate this building generation once its
    // scan drains to full coverage (the shared activation seam in worker.js).
    store, client, generations, preprocessCfg: cfg.preprocess, maxInputChars: cfg.maxInputChars, batchSize: cfg.batchSize,
    onProgress: (p) => { upsertJob({ kind: 'embeddings', state: 'running', processed: p.done, total }).catch(() => {}); },
  });
  return worker.runOnce(gen);
}

// Collaborators for startEmbeddingBuild, bound to the real modules by default and
// overridable in tests (the injection pattern used across the embeddings services).
export const BUILD_DEPS = {
  tryAcquireEmbedRun, releaseEmbedRun,
  createGeneration, buildingGeneration, retireGeneration, generationFingerprint,
  countPending, upsertJob, runWorker, log: console.log,
};

// Orchestrates an embeddings (re)build. Returns { status, body } for the route to send.
//
// Ordering matters: createGeneration atomically NULLs every live embed_gen stamp. If an
// embed run were mid-flight when that reset lands, it could re-stamp rows with the OLD
// generation id afterward — and the new generation's scan (embed_gen IS NULL only) would
// never see them, so activation's coverage gate blocks forever. So we take the single-
// flight lock BEFORE createGeneration, making the stamp-reset mutually exclusive with any
// embed run. If the lock is busy we return an honest, retryable 409 and never touch the
// stamps. On every non-success exit the lock is released exactly once; on success the
// fire-and-forget worker chain owns the single release when the run settles.
export async function startEmbeddingBuild(cfg, username, deps = {}) {
  const d = { ...BUILD_DEPS, ...deps };
  const fingerprint = d.generationFingerprint(cfg);

  if (!d.tryAcquireEmbedRun()) {
    return { status: 409, body: { error: 'An embedding run is in progress — retry in a moment' } };
  }

  let gen, total;
  try {
    try {
      gen = await d.createGeneration(cfg.model, cfg.dimension, fingerprint);
    } catch (err) {
      // A building generation with a DIFFERENT fingerprint blocks this build. A
      // new-fingerprint build supersedes an incomplete old-fingerprint one, so retire
      // the stale gen (deletes its rows — generations never mix) and retry once.
      if (!(err instanceof BuildingInProgressError)) throw err;
      const stale = await d.buildingGeneration();
      if (!stale || stale.fingerprint === fingerprint) throw err;
      await d.retireGeneration(stale.id);
      d.log(`[admin] ${username} retired stale building gen ${stale.id} (fingerprint ${stale.fingerprint}); superseded by ${fingerprint}`);
      gen = await d.createGeneration(cfg.model, cfg.dimension, fingerprint);
    }
    total = await d.countPending(gen);
    await d.upsertJob({ kind: 'embeddings', state: 'running', processed: 0, total });
  } catch (err) {
    // Any failure before the worker chain is attached below leaves the lock ours to
    // free — release it so a failed start never wedges every future build.
    d.releaseEmbedRun();
    return { status: 409, body: { error: err.message } };
  }

  // We already hold the single-flight lock; fire the worker and release exactly once
  // when it settles, on every outcome. The request returns immediately.
  d.runWorker(gen, total, cfg)
    .then((r) => d.upsertJob({ kind: 'embeddings', state: 'done', processed: r.succeeded, total }))
    .catch((err) => d.upsertJob({ kind: 'embeddings', state: 'error', processed: 0, total, lastError: err.message }))
    .finally(() => d.releaseEmbedRun())
    .catch(() => {});
  d.log(`[admin] ${username} started embeddings build gen ${gen} (${total} pending)`);
  return { status: 200, body: { ok: true, generationId: gen, total } };
}

router.post('/admin/ai/embeddings/build', requireAdmin, async (req, res) => {
  const cfg = await resolveEmbedConfig();
  const invalid = validateBuildConfig(cfg);
  if (invalid) return res.status(400).json({ error: invalid });

  const { status, body } = await startEmbeddingBuild(cfg, req.session.username);
  res.status(status).json(body);
});

export default router;
