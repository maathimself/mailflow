-- Per-(account, folder) CONDSTORE HIGHESTMODSEQ watermark for delta sync.
-- NUMERIC(20,0) — a modseq is a 64-bit UNSIGNED value (RFC 7162) that can exceed both
-- BIGINT's signed max and JS Number.MAX_SAFE_INTEGER, so it is stored and compared as a
-- string/BigInt, never coerced to a JS Number. NULL means "no baseline yet" (first sync,
-- or reset after a UIDVALIDITY change), which forces a full sync that re-seeds it.
ALTER TABLE folders ADD COLUMN IF NOT EXISTS highest_modseq NUMERIC(20,0);
