// Port of internal/vector/embed/worker.go RunOnce/RunBackstop (scan-and-fill).
import { preprocess } from './preprocess.js';
import { chunkText, chunkOverlapFor, MAX_SPANS } from './chunk.js';
import { isPermanent4xx } from './client.js';

export const RAW_BODY_MULT = 16;

export class EmbeddingWorker {
  constructor(deps) {
    this.deps = { batchSize: 32, maxConsecutiveFailures: 5, log: console, ...deps };
  }

  runOnce(gen) { return this._run(gen, false); }
  runBackstop(gen) { return this._run(gen, true); }

  async _run(gen, backstop) {
    const { store } = this.deps;
    const res = { claimed: 0, succeeded: 0, failed: 0, truncated: 0 };
    let runId;
    let runErr = null;
    try { runId = (await store.startEmbedRun?.(gen)) || 0; } catch { runId = 0; }
    try {
      let consecutiveFailures = 0;
      let afterId = backstop ? store.ZERO_UUID : await store.getWatermark(gen);
      for (;;) {
        const ids = await store.scanForEmbedding(gen, afterId, this.deps.batchSize);
        if (!ids.length) {
          if (!backstop) await store.resetWatermark(gen); // re-scan from start next tick
          // Coverage reached: the shared driver seam (build route + scheduler) that
          // promotes a fully-embedded 'building' generation to 'active'.
          await this._activateIfBuildingCovered(gen);
          return res;
        }
        res.claimed += ids.length;
        const batchMax = ids[ids.length - 1];

        let eb;
        try {
          eb = await this._embedBatch(gen, ids);
        } catch (err) {
          consecutiveFailures++;
          this.deps.log.warn?.(`embed batch failed (gen ${gen}): ${err.message}`);

          if (isPermanent4xx(err)) {
            // Downshift to size=1 and drain (worker.go RunOnce ErrPermanent4xx branch):
            // embed what succeeds, stamp-drop confirmed per-message 4xx offenders, and
            // leave rows unstamped only on an all-drop where the endpoint embedded nothing.
            this.deps.log.info?.(`embed: downshifting to size=1 to drain failing batch (gen ${gen}, ${ids.length})`);
            const dr = await this._downshiftDrain(gen, ids, res);
            res.succeeded += dr.embedded;
            // Reset the cap on embeddedOK (endpoint embedded+upserted something) — a
            // CAS-missed stamp still proves the endpoint is healthy.
            if (dr.embeddedOK > 0) consecutiveFailures = 0;
            // Advance ONLY past the contiguously-stamped prefix so an unstamped
            // straggler is never skipped (safeAdvanceID == batchMax on a clean drain).
            if (dr.safeAdvanceID && dr.safeAdvanceID > afterId) {
              afterId = dr.safeAdvanceID;
              if (!backstop) await store.setWatermark(gen, dr.safeAdvanceID);
            }
            if (dr.drainErr) {
              if (dr.drainErr.code === 'GEN_RETIRED') { this.deps.log.info?.(`generation ${gen} retired mid-drain; stopping`); return res; }
              // A transient (non-4xx) error during the drain is a hard abort (an earlier
              // singleton may have stamped, so the watermark stopped at the contiguous
              // prefix and the next run re-finds the rest).
              if (!isPermanent4xx(dr.drainErr)) {
                throw new Error(`embed worker aborting after ${consecutiveFailures} consecutive failures: ${dr.drainErr.message}`, { cause: err });
              }
              // All-drop 4xx: the rows stay unstamped; let the failure cap trip.
              if (consecutiveFailures >= this.deps.maxConsecutiveFailures) {
                throw new Error(`embed worker aborting after ${consecutiveFailures} consecutive failures: ${dr.drainErr.message}`, { cause: err });
              }
            }
            continue;
          }

          // Non-4xx (transient) error: leave the batch unstamped, do not advance the
          // cursor, so the failure cap short-circuits a persistent fault.
          res.failed += ids.length;
          if (consecutiveFailures >= this.deps.maxConsecutiveFailures) {
            throw new Error(`embed worker aborting after ${consecutiveFailures} consecutive failures: ${err.message}`, { cause: err });
          }
          continue; // do not advance cursor; next scan re-finds the batch
        }
        res.truncated += eb.truncated;
        const skipIds = [...eb.missing, ...eb.empty];

        if (!eb.chunks.length) {
          if (skipIds.length) await this._stampSkipped(gen, skipIds, eb.lastModified);
          consecutiveFailures = 0;
          afterId = batchMax;
          if (!backstop) await store.setWatermark(gen, batchMax);
          continue;
        }

        // Step 1: upsert embeddings FIRST (idempotent; crash-safe ordering).
        try {
          await store.upsert(gen, eb.chunks);
        } catch (err) {
          if (err.code === 'GEN_RETIRED') { this.deps.log.info?.(`generation ${gen} retired mid-run; stopping`); return res; }
          consecutiveFailures++;
          res.failed += eb.embeddedIds.length;
          if (consecutiveFailures >= this.deps.maxConsecutiveFailures) {
            throw new Error(`embed worker aborting after ${consecutiveFailures} consecutive failures: ${err.message}`, { cause: err });
          }
          continue;
        }

        // Step 2: skip-mark empty/missing, then CAS-stamp embedded rows.
        if (skipIds.length) await this._stampSkipped(gen, skipIds, eb.lastModified);
        const missed = await store.setEmbedGenIfUnchanged(
          eb.embeddedIds.map((id) => ({ id, lastModified: eb.lastModified.get(id) })), gen,
        );
        if (missed.length) this.deps.log.info?.(`embed_gen CAS misses (concurrent edit): ${missed.length} — backstop recovers`);
        res.succeeded += eb.embeddedIds.length - missed.length;
        consecutiveFailures = 0;
        // Advance the watermark even on a whole-batch CAS miss (backstop recovers misses).
        afterId = batchMax;
        if (!backstop) await store.setWatermark(gen, batchMax);
        this.deps.onProgress?.({ done: res.succeeded, claimed: res.claimed, truncated: res.truncated });
      }
    } catch (err) {
      runErr = err;
      throw err;
    } finally {
      try { await store.finalizeEmbedRun?.(runId, res, runErr); } catch { /* observability only */ }
    }
  }

  // Activation-on-coverage seam (worker.go parity — see divergence note below).
  // A run reaches here only after scanForEmbedding drains, i.e. no live message
  // still needs embedding for `gen` (poison messages count as covered — they are
  // stamped, not skipped). When `gen` is the CURRENT building generation, promote
  // it to 'active'. This is the sole production caller of activateGeneration:
  // without it a completed build stays 'building' forever and hybrid search never
  // leaves its index_building fallback.
  //
  // No-ops when:
  //   - no generations collaborator is wired (a bare worker with nothing to promote), or
  //   - `gen` is not the building generation — an active generation's incremental
  //     or backstop run must never re-activate (README: generations never mix).
  //
  // Tolerates the two lifecycle races activateGeneration encodes, so a completed
  // build is never lost and activation never fails the embed run:
  //   - "still has messages needing embedding": a late content edit re-NULLed a row
  //     between the drain and the activate (the coverage gate re-asserted inside the
  //     activate tx caught it) — leave it building; the next scheduler tick re-drains
  //     and retries.
  //   - "not in 'building' state": a concurrent activate/retire already moved it — no-op.
  // Any other error is logged, not thrown: activation is a post-coverage promotion,
  // not part of the run result.
  //
  // Divergence from msgvault worker.go: there activation lives in the DRIVERS
  // (scheduler embed_job.go + the CLI embed_vector.go each re-check coverage and
  // call ActivateGeneration). We fold it into this shared worker seam instead so
  // BOTH Mailflow drivers (the fire-and-forget build route and the scheduler tick)
  // get it from one place and cannot drift out of sync — the exact failure that
  // left the live build wedged in 'building'. The coverage precondition (scan
  // drained) and the no-force, gate-re-asserted activate call match worker.go.
  async _activateIfBuildingCovered(gen) {
    const gens = this.deps.generations;
    if (!gens?.activateGeneration || !gens?.buildingGeneration) return;
    let building;
    try {
      building = await gens.buildingGeneration();
    } catch (err) {
      this.deps.log.warn?.(`embed: could not read building generation to activate ${gen}: ${err.message}`);
      return;
    }
    if (!building || building.id !== gen) return; // active/incremental run — nothing to promote
    try {
      await gens.activateGeneration(gen); // no force — activateGeneration re-asserts the coverage gate atomically
      this.deps.log.info?.(`embed: generation ${gen} fully covered — activated`);
    } catch (err) {
      this.deps.log.warn?.(`embed: generation ${gen} not activated (${err.message}); scheduler will retry next tick if still building`);
    }
  }

  async _embedBatch(gen, ids) {
    const { store } = this.deps;
    const rows = await store.fetchForEmbedding(ids);
    const fetched = new Set();
    const lastModified = new Map();
    const msgs = [];
    const empty = [];
    for (const r of rows) {
      fetched.add(r.id);
      lastModified.set(r.id, r.lastModified);
      const body = r.bodyText && r.bodyText.trim() !== '' ? r.bodyText : (r.bodyHtml || '');
      const ppCfg = { ...this.deps.preprocessCfg };
      if (!ppCfg.maxBodyRunes && this.deps.maxInputChars > 0) {
        ppCfg.maxBodyRunes = this.deps.maxInputChars * MAX_SPANS * RAW_BODY_MULT;
      }
      const { text, truncated } = preprocess(r.subject || '', body, 0, ppCfg);
      if (text.trim() === '') { empty.push(r.id); continue; }
      msgs.push({ id: r.id, text, bodyTruncated: truncated });
    }
    const missing = ids.filter((id) => !fetched.has(id));
    if (!msgs.length) return { chunks: [], embeddedIds: [], missing, empty, truncated: 0, lastModified };

    const window = this.deps.maxInputChars;
    const overlap = chunkOverlapFor(window);
    const pieces = [];
    const inputs = [];
    const truncatedMsg = new Set();
    for (const m of msgs) {
      const { spans, tailDropped } = chunkText(m.text, window, overlap, MAX_SPANS);
      const msgTrunc = m.bodyTruncated || tailDropped;
      spans.forEach((sp, j) => {
        const hardCut = window > 0 && (sp.charEnd - sp.charStart) === window && j < spans.length - 1;
        const trunc = msgTrunc || hardCut;
        if (trunc) truncatedMsg.add(m.id);
        pieces.push({ id: m.id, chunkIndex: j, text: sp.text, chars: sp.charEnd - sp.charStart, charStart: sp.charStart, charEnd: sp.charEnd, trunc });
        inputs.push(sp.text);
      });
    }

    const vecs = [];
    try {
      for (let i = 0; i < inputs.length; i += this.deps.batchSize) {
        const got = await this.deps.client.embed(inputs.slice(i, i + this.deps.batchSize));
        vecs.push(...got);
      }
    } catch (err) {
      // Attach the CAS tokens fetched before the embed call so a downshift drain can
      // CAS-drop a per-message 4xx offender with the last_modified read at fetch time.
      err.lastModified = lastModified;
      throw err;
    }
    if (vecs.length !== pieces.length) throw new Error(`embedder returned ${vecs.length} vectors for ${pieces.length} chunk inputs`);

    const chunks = [];
    const embeddedIds = [];
    const seen = new Set();
    for (let i = 0; i < pieces.length; i++) {
      const p = pieces[i];
      chunks.push({ messageId: p.id, chunkIndex: p.chunkIndex, vector: vecs[i], sourceCharLen: p.chars, chunkCharStart: p.charStart, chunkCharEnd: p.charEnd, truncated: p.trunc });
      if (!seen.has(p.id)) { seen.add(p.id); embeddedIds.push(p.id); }
    }
    return { chunks, embeddedIds, missing, empty, truncated: truncatedMsg.size, lastModified };
  }

  // Port of worker.go downshiftDrain: walk a 4xx-failing batch one message at a time.
  // Embed + upsert + CAS-stamp what succeeds; skip-mark empty/missing; and DEFER
  // per-message 4xx offenders — stamp-dropping them only when some sibling embedded
  // (proving the endpoint is healthy, so the 4xx is message-specific). On an all-drop
  // (endpoint embedded nothing) the deferred ids are left UNSTAMPED and a permanent-4xx
  // error is returned so a misconfigured endpoint never silently loses work. Returns
  // { embedded, embeddedOK, stamped, safeAdvanceID, drainErr }; safeAdvanceID is the
  // highest CONTIGUOUSLY-stamped id (batchMax on a clean drain) so the caller never
  // advances the watermark past an unstamped straggler.
  async _downshiftDrain(gen, ids, res) {
    const { store } = this.deps;
    let embedded = 0;
    let embeddedOK = 0;
    let stamped = 0;
    let contiguousStampedID = null;
    let brokeContiguity = false;
    const deferredDrops = [];
    let lastDeferredErr = null;
    const lm = new Map();
    const advance = (id, didStamp) => {
      if (didStamp) { if (!brokeContiguity) contiguousStampedID = id; }
      else brokeContiguity = true;
    };

    for (const id of ids) {
      let eb;
      try {
        eb = await this._embedBatch(gen, [id]);
      } catch (e) {
        if (isPermanent4xx(e)) {
          if (e.lastModified) for (const [k, v] of e.lastModified) lm.set(k, v);
          deferredDrops.push(id);
          lastDeferredErr = e;
          brokeContiguity = true; // a deferred id breaks the stamped-from-start prefix
          continue;
        }
        // Transient error: leave this id unstamped and abort the drain; the watermark
        // stays at the contiguous stamped prefix so the next run re-finds it.
        return { embedded, embeddedOK, stamped, safeAdvanceID: contiguousStampedID, drainErr: e };
      }
      for (const [k, v] of eb.lastModified) lm.set(k, v);

      if (!eb.chunks.length) {
        // Missing/empty singleton — skip-mark it.
        const skip = [...eb.missing, ...eb.empty];
        let didStamp = true;
        if (skip.length) {
          const missed = await this._stampSkipped(gen, skip, eb.lastModified);
          const stampedSkip = skip.length - missed.length;
          stamped += stampedSkip;
          didStamp = stampedSkip > 0; // a CAS-missed skip leaves the row unstamped
        }
        advance(id, didStamp);
        continue;
      }

      try {
        await store.upsert(gen, eb.chunks);
      } catch (uerr) {
        return { embedded, embeddedOK, stamped, safeAdvanceID: contiguousStampedID, drainErr: uerr };
      }
      embeddedOK++; // endpoint demonstrably embedded + upserted this singleton
      const missed = await store.setEmbedGenIfUnchanged(
        eb.embeddedIds.map((mid) => ({ id: mid, lastModified: eb.lastModified.get(mid) })), gen,
      );
      const stampedHere = eb.embeddedIds.length - missed.length;
      res.truncated += eb.truncated;
      embedded += stampedHere;
      stamped += stampedHere;
      advance(id, stampedHere > 0);
    }

    // Clean drain: every id is resolved (stamped, skip-marked, or a deferred 4xx below).
    const safeAdvanceID = ids[ids.length - 1];

    if (!deferredDrops.length) return { embedded, embeddedOK, stamped, safeAdvanceID, drainErr: null };

    if (embeddedOK > 0) {
      // The endpoint embedded something, so the 4xxs are message-specific — stamp-drop them.
      for (const id of deferredDrops) {
        this.deps.log.warn?.(`stamping (dropping) message after singleton 4xx (gen ${gen}, id ${id}): ${lastDeferredErr?.message}`);
      }
      const missed = await this._stampSkipped(gen, deferredDrops, lm);
      stamped += deferredDrops.length - missed.length;
      return { embedded, embeddedOK, stamped, safeAdvanceID, drainErr: null };
    }

    // embeddedOK === 0: endpoint embedded nothing — can't distinguish an endpoint-wide
    // failure from a batch where every message is unembeddable. Leave the deferred ids
    // UNSTAMPED and surface the 4xx (marked permanent so the caller's cap, not a hard
    // abort, governs) so a misconfigured endpoint does not silently drop work.
    const err = new Error(`downshift all-drop: every singleton returned non-retryable 4xx (left ${deferredDrops.length} row(s) unstamped): ${lastDeferredErr?.message}`);
    err.permanent4xx = true;
    return { embedded, embeddedOK, stamped, safeAdvanceID: contiguousStampedID, drainErr: err };
  }

  // Skip-mark empty/missing rows (drops them from the next scan) and remove any stale
  // vectors for the rows that were actually stamped — the stamp + prune happen in ONE
  // transaction inside store.stampSkipped (msgvault worker.go parity). CAS-protected
  // for rows with a last_modified token; unconditional for missing rows.
  async _stampSkipped(gen, ids, lastModified) {
    const { store } = this.deps;
    const cas = [];
    const plain = [];
    for (const id of ids) {
      if (lastModified.has(id)) cas.push({ id, lastModified: lastModified.get(id) });
      else plain.push(id);
    }
    return store.stampSkipped(gen, cas, plain);
  }
}
