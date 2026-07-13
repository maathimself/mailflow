-- Mark user-imported pets, which are private to their importer (the meta/sheet
-- read gate rejects other users; see gtdPet + routes/gtd.js petRowReadable).
-- Privacy is recorded explicitly at write time rather than inferred from the
-- custom- slug prefix, so the prefix itself never has to be load-bearing.
ALTER TABLE gtd_pets ADD COLUMN IF NOT EXISTS is_custom BOOLEAN NOT NULL DEFAULT FALSE;
-- Backfill is exact: importPet is the only writer of custom-* slugs, so the
-- prefix implies provenance for rows that predate this column.
UPDATE gtd_pets SET is_custom = TRUE WHERE slug LIKE 'custom-%';
