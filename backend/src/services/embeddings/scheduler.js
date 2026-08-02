import { resolveEmbedConfig, generationFingerprint } from './config.js';
import { isVectorAvailable } from './vectorStore.js';
import * as store from './vectorStore.js';
import * as generations from './generations.js';
const { buildingGeneration, activeGeneration, retireGeneration } = generations;
import { EmbeddingClient } from './client.js';
import { EmbeddingWorker } from './worker.js';
import { tryAcquireEmbedRun, releaseEmbedRun } from './embedRunLock.js';

let _timer = null;
let _running = false;
let _lastBackstop = 0;
let _backstopIntervalMs = 86_400_000;
// Latch for the once-per-fingerprint "paused" log below — holds the config
// fingerprint we last warned about so a mismatched active generation does not
// spam the log every tick. Cleared whenever a matching run proceeds.
let _pausedForFingerprint = null;

// One scheduler pass: drive an existing building-or-active generation. No-ops when
// vector is unavailable, embeddings are disabled, or no generation exists. Exported
// for unit testing.
export async function runSchedulerTick(nowMs) {
  if (!isVectorAvailable()) return;
  let cfg;
  try { cfg = await resolveEmbedConfig(); } catch { return; }
  if (!cfg || !cfg.enabled || !cfg.endpoint || !cfg.model || !(cfg.dimension > 0)) return;

  const building = await buildingGeneration();
  const gen = building || await activeGeneration();
  if (!gen) return;

  // Single-flight: skip this tick if a manual build — or another run — already
  // holds the shared lock, so the scheduler never double-drives a generation.
  if (!tryAcquireEmbedRun()) return;
  try {
    // Fingerprint guard: the worker embeds with a client built from the *current*
    // config, so it must only drive a generation whose fingerprint matches that
    // config. If the admin changed model/dimension/preprocess mid-build, the
    // resolved generation is stale — driving it would embed with the new client
    // into the old generation and fail the dimension check forever.
    const cfgFingerprint = generationFingerprint(cfg);
    if (gen.fingerprint !== cfgFingerprint) {
      if (building) {
        // A building gen is superseded by the config change — retire it (deletes its
        // rows; generations never mix) so a fresh, correctly-fingerprinted build can
        // start. Done under the single-flight lock so it can't race an embed run.
        await retireGeneration(gen.id);
        console.log(`[embed-scheduler] retired building generation ${gen.id}: fingerprint '${gen.fingerprint}' superseded by config '${cfgFingerprint}'`);
      } else if (_pausedForFingerprint !== cfgFingerprint) {
        // An active gen can't be retired from under live search — pause incremental
        // embedding until a rebuild lands. Log once per config fingerprint, not every tick.
        _pausedForFingerprint = cfgFingerprint;
        console.log(`[embed-scheduler] active generation ${gen.id} fingerprint '${gen.fingerprint}' != config '${cfgFingerprint}' — pausing incremental embedding until a rebuild`);
      }
      return;
    }
    _pausedForFingerprint = null; // a matching run clears the paused-log latch

    const client = new EmbeddingClient({ endpoint: cfg.endpoint, apiKey: cfg.apiKey, model: cfg.model, dimension: cfg.dimension });
    // Pass `generations` so the worker can promote a fully-covered building
    // generation to active at its shared run-completion seam (worker.js).
    const worker = new EmbeddingWorker({ store, client, generations, preprocessCfg: cfg.preprocess, maxInputChars: cfg.maxInputChars, batchSize: cfg.batchSize });

    if (nowMs - _lastBackstop >= _backstopIntervalMs) {
      _lastBackstop = nowMs;
      await worker.runBackstop(gen.id);
    } else {
      await worker.runOnce(gen.id);
    }
  } finally {
    releaseEmbedRun();
  }
}

export function startEmbeddingScheduler({ intervalMs = 60000, backstopIntervalMs = 86_400_000 } = {}) {
  if (_timer) return;
  _backstopIntervalMs = backstopIntervalMs;
  _lastBackstop = Date.now(); // first backstop one interval out, not on boot
  _timer = setInterval(async () => {
    if (_running) return; // never overlap ticks
    _running = true;
    try { await runSchedulerTick(Date.now()); }
    catch (err) { console.error(`Embedding scheduler tick error: ${err.message}`); }
    finally { _running = false; }
  }, intervalMs);
  _timer.unref?.();
}

export function stopEmbeddingScheduler() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}
