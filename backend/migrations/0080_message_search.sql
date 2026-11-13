-- Full-body search for HTML-only mail (D#320).
--
-- Search reads a message's whole body from messages.body_text, but a message sent only as HTML
-- has no body_text, so only its subject, sender and 200-character snippet could be found. This
-- keeps the text of such a body in message_search, one row per HTML-only message.
--
-- A trigger fills it on every write of body_html, body_text or id, so every path that stores a
-- body (sync, backfill, on-demand fetch, relocation) is covered without changes there. Rows that
-- existed before this migration are filled by a throttled background job at startup
-- (services/messageSearchBackfill.js), so the migration itself does not scan the mail cache.
--
-- A side table rather than a column on messages: adding a stored column would rewrite the whole
-- table at startup, and the text would travel with every SELECT m.* and every relocation copy.

-- The searchable text of an HTML body: no head, style, script or comment content, tags turned
-- into spaces, common entities decoded and the rest dropped, whitespace collapsed. Capped like
-- search's own body cap (routes/search.js FTS_BODY_CHAR_CAP), so to_tsvector never overflows.
--
-- One pass per pattern, each unable to run past the first close of its block: a block's body is
-- any character but '<', or a '<' that does not start its closing tag. Tags are '<[^<>]*>', so an
-- unclosed '<' ends at the next '<' instead of every '<' scanning to the end of the body. An
-- unterminated block is left as text. (messageSearch.postgres.test.js times these on hostile input.)
CREATE OR REPLACE FUNCTION mf_html_to_text(html TEXT) RETURNS TEXT
  LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  t TEXT := html;
BEGIN
  IF t IS NULL THEN RETURN NULL; END IF;
  t := regexp_replace(t, '<!--([^-]|-(?!->))*-->', ' ', 'g');
  t := regexp_replace(t, '<head\M([^<]|<(?!/head))*</head\s*>', ' ', 'gi');
  t := regexp_replace(t, '<style\M([^<]|<(?!/style))*</style\s*>', ' ', 'gi');
  t := regexp_replace(t, '<script\M([^<]|<(?!/script))*</script\s*>', ' ', 'gi');
  t := regexp_replace(t, '<[^<>]*>', ' ', 'g');
  t := replace(replace(replace(replace(replace(replace(replace(t,
         '&nbsp;', ' '), '&lt;', '<'), '&gt;', '>'), '&quot;', '"'), '&#39;', ''''), '&apos;', ''''), '&amp;', '&');
  t := regexp_replace(t, '&#?[0-9A-Za-z]{1,10};', ' ', 'g');
  t := btrim(regexp_replace(t, '\s+', ' ', 'g'));
  RETURN left(t, 600000);
END $$;

CREATE TABLE IF NOT EXISTS message_search (
  -- ON UPDATE CASCADE: a delete to Trash gives the row a new id in place (routes/mail.js).
  message_id UUID PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE ON UPDATE CASCADE,
  body_text  TEXT NOT NULL
);

CREATE OR REPLACE FUNCTION mf_message_search_sync() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.id = OLD.id
     AND NEW.body_html IS NOT DISTINCT FROM OLD.body_html
     AND NEW.body_text IS NOT DISTINCT FROM OLD.body_text THEN
    RETURN NULL;
  END IF;
  IF NEW.body_text IS NULL AND NEW.body_html IS NOT NULL THEN
    INSERT INTO message_search (message_id, body_text) VALUES (NEW.id, mf_html_to_text(NEW.body_html))
    ON CONFLICT (message_id) DO UPDATE SET body_text = EXCLUDED.body_text;
  ELSIF TG_OP = 'UPDATE' THEN
    DELETE FROM message_search WHERE message_id = NEW.id;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS messages_search_sync ON messages;
CREATE TRIGGER messages_search_sync
  AFTER INSERT OR UPDATE OF body_html, body_text, id ON messages
  FOR EACH ROW EXECUTE FUNCTION mf_message_search_sync();
