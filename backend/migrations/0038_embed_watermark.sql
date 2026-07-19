-- Vector-substrate CAS columns + last_modified trigger (slice 04).
-- Extension-independent, fast DDL only. NO vector-typed DDL here — the
-- embeddings/index_generations/embed_watermark/embed_runs tables and the HNSW
-- index are created by ensureVectorSchema() at startup (README invariant).
-- Transactional migration (NOT -- no-transaction): the no-transaction runner
-- splits on ';' and would break the dollar-quoted function below.

-- last_modified: content-change CAS token the embed worker compares to detect a
-- late-arriving body invalidating a stale subject-only embedding. NOT NULL DEFAULT
-- now() is metadata-only on PG16 (now() is STABLE → one stored missing-value, no
-- table rewrite).
ALTER TABLE messages ADD COLUMN IF NOT EXISTS last_modified TIMESTAMPTZ NOT NULL DEFAULT now();

-- embed_gen: the index generation this row is embedded under. NULL = needs embedding.
-- Plain BIGINT soft-stamp (no FK): a generation can be retired/deleted while stamps linger.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS embed_gen BIGINT;

-- Bump last_modified AND clear embed_gen when an embedding-input column changes. The
-- WHEN clause filters at the C level so unchanged-content UPDATEs (the hot re-sync path)
-- and stamp-only UPDATEs (the worker setting embed_gen) skip the function entirely.
-- Clearing embed_gen is what re-surfaces a late-arriving body: a row embedded
-- subject-only and stamped, whose body later lands (phase-2 drainer / on-open fetch),
-- has its stamp cleared here so the NULL-only embed scan re-finds it and the idempotent
-- upsert replaces the stale chunks. The CAS only guards the read→stamp window; this
-- trigger covers the post-stamp case (Mailflow's late-arriving bodies — msgvault's rows
-- are immutable after ingest, so it never needed this). Together with createGeneration's
-- stamp-reset (which handles generation rebuilds: unchanged content, new fingerprint),
-- the invariant is exact: embed_gen IS NULL ⟺ the row needs embedding.
CREATE OR REPLACE FUNCTION messages_bump_last_modified() RETURNS trigger AS $$
BEGIN
  NEW.last_modified := now();
  NEW.embed_gen := NULL;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_messages_last_modified ON messages;
CREATE TRIGGER trg_messages_last_modified
  BEFORE UPDATE ON messages
  FOR EACH ROW
  WHEN (NEW.subject IS DISTINCT FROM OLD.subject
        OR NEW.body_text IS DISTINCT FROM OLD.body_text
        OR NEW.body_html IS DISTINCT FROM OLD.body_html)
  EXECUTE FUNCTION messages_bump_last_modified();
