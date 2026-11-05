-- CalDAV client (#437): calendars pulled from, and written back to, remote servers. A user may
-- connect several servers. calendar_events holds one row per calendar resource (one .ics at one
-- href), so a recurring series and its overrides stay together; occurrences are expanded when read.
-- range_end NULL means the series never ends.
CREATE TABLE IF NOT EXISTS caldav_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  server_url TEXT NOT NULL,
  username TEXT NOT NULL,
  password TEXT NOT NULL,
  interval_min INTEGER NOT NULL DEFAULT 15,
  last_sync_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, server_url, username)
);
CREATE INDEX IF NOT EXISTS idx_caldav_accounts_user ON caldav_accounts(user_id);

CREATE TABLE IF NOT EXISTS calendars (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES caldav_accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  name TEXT NOT NULL,
  server_color TEXT,
  color TEXT,
  visible BOOLEAN NOT NULL DEFAULT TRUE,
  read_only BOOLEAN NOT NULL DEFAULT FALSE,
  ctag TEXT,
  UNIQUE (account_id, url)
);
CREATE INDEX IF NOT EXISTS idx_calendars_user ON calendars(user_id);

CREATE TABLE IF NOT EXISTS calendar_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  calendar_id UUID NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  href TEXT NOT NULL,
  etag TEXT,
  uid TEXT,
  ical TEXT NOT NULL,
  range_start TIMESTAMPTZ NOT NULL,
  range_end TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (calendar_id, href)
);
CREATE INDEX IF NOT EXISTS idx_calendar_events_user_range ON calendar_events(user_id, range_start, range_end);
