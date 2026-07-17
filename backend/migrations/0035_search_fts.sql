-- Weighted full-text search column (search_fts) + version stamp, kept fresh by
-- a BEFORE trigger. Fast, metadata-only DDL only (README D1): the nullable
-- columns force no table rewrite on PG16, and the function/trigger are instant.
-- Pre-existing rows are populated by the resumable drainer (ftsBackfill.js);
-- the GIN index is built CONCURRENTLY in the separate no-transaction migration
-- 0037 (a $$-quoted plpgsql body cannot survive the no-transaction ; splitter,
-- so the trigger and the CONCURRENTLY index MUST live in different files).
--
-- The setweight(...) expression MUST stay identical to
-- lexicalRepo.searchFtsExpr('NEW'); fts_version = 1 matches lexicalRepo.FTS_VERSION.
-- Idempotent (IF NOT EXISTS / CREATE OR REPLACE / DROP IF EXISTS) because a
-- crash before the schema_migrations INSERT retries this migration.

ALTER TABLE messages ADD COLUMN IF NOT EXISTS search_fts tsvector;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS fts_version int;

CREATE OR REPLACE FUNCTION messages_search_fts_refresh() RETURNS trigger AS $$
BEGIN
  -- Skip recompute on an UPDATE that changes none of the indexed source
  -- columns (read/star flag flips, snippet-only writes), so the trigger does
  -- not tax hot sync UPSERTs; this also lets the backfill's explicit SET win.
  IF TG_OP = 'UPDATE'
     AND NEW.subject      IS NOT DISTINCT FROM OLD.subject
     AND NEW.from_name    IS NOT DISTINCT FROM OLD.from_name
     AND NEW.from_email   IS NOT DISTINCT FROM OLD.from_email
     AND NEW.to_addresses IS NOT DISTINCT FROM OLD.to_addresses
     AND NEW.cc_addresses IS NOT DISTINCT FROM OLD.cc_addresses
     AND NEW.body_text    IS NOT DISTINCT FROM OLD.body_text
  THEN
     RETURN NEW;
  END IF;

  BEGIN
    NEW.search_fts := setweight(to_tsvector('english', coalesce(NEW.subject,'')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.from_name,'') || ' ' || coalesce(NEW.from_email,'')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW.to_addresses::text,'') || ' ' || coalesce(NEW.cc_addresses::text,'')), 'C') ||
    setweight(to_tsvector('english', LEFT(coalesce(NEW.body_text,''), 600000)), 'D');
    NEW.fts_version := 1;
  EXCEPTION WHEN program_limit_exceeded THEN
    -- Even with the 600k LEFT cap, a pathologically dense/multibyte body can
    -- exceed Postgres's ~1MB tsvector limit (SQLSTATE 54000). Never fail the
    -- row write: leave search_fts NULL so the message still persists and stays
    -- findable via the ILIKE fallback; the backfill's row-by-row skip stamps it.
    NEW.search_fts := NULL;
    NEW.fts_version := NULL;
  END;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_messages_search_fts ON messages;
CREATE TRIGGER trg_messages_search_fts
  BEFORE INSERT OR UPDATE ON messages
  FOR EACH ROW EXECUTE FUNCTION messages_search_fts_refresh();
