-- Addresses a message was delivered to (Delivered-To / X-Delivered-To /
-- X-Original-To / Envelope-To), captured at ingest. Reply alias selection
-- matches these in addition to To/Cc, so a message delivered to an alias
-- via BCC or a catch-all still replies from that alias.
-- Nullable like list_unsubscribe: NULL marks rows ingested before capture
-- existed, so the sync upsert's COALESCE backfills them on a later re-sync.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS delivery_addresses JSONB;
