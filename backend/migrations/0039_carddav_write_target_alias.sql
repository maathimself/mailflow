-- Multi-address-book CardDAV follow-up: write-target routing
-- resolves the stored is_write_target book against a fresh CardDAV discovery
-- snapshot by URL. Some servers advertise a stable "alias" href in PROPFIND
-- discovery that 3xx-redirects (REPORT/PUT/DELETE) to a different canonical
-- collection URL; carddavSync.js already detects and reconciles this by
-- rewriting address_books.external_url to the canonical URL, but discovery
-- keeps returning the alias forever afterward. Record the alias alongside the
-- canonical URL so write-target resolution (and the export sweep) can match
-- either, instead of a fresh discovery snapshot falsely reporting the
-- write-target missing. Additive only — no existing column or row changes.
ALTER TABLE address_books
  ADD COLUMN IF NOT EXISTS discovery_alias_url TEXT;
