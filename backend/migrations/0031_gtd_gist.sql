-- AI-condensed one-line gist for GTD "waiting" (Watch / Delegated) rail rows.
-- The gist summarises a waiting thread's head message ("what they said / what
-- happens next"); it replaces the raw snippet on the rail when present.
--
-- Generated lazily, never at ingest (cost control): after a sections fetch finds
-- waiting heads that lack a cached gist AND an AI provider is configured. Cached
-- here on the message row.
--
-- Cache invalidation is implicit: the gist lives on the head message row, so when
-- newer mail arrives it becomes the thread's new head with a NULL gist and the rail
-- falls back to the raw snippet until the gist is regenerated for that new head.
-- No index is added: the section query joins the head by primary key and the
-- generation candidate query filters `id = ANY($ids) AND gtd_gist IS NULL`, both of
-- which already ride the messages primary key.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS gtd_gist TEXT;
