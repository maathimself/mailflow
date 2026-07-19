-- Generic progress substrate for observable background drainers (first consumer:
-- the FTS backfill). Plain table, fast DDL. One row per (kind, account); global
-- jobs use a NULL account_id, COALESCE'd to '' in the unique index so the upsert
-- has a single conflict target for both cases.

CREATE TABLE IF NOT EXISTS background_jobs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        VARCHAR(64) NOT NULL,
  account_id  UUID REFERENCES email_accounts(id) ON DELETE CASCADE,
  state       VARCHAR(20) NOT NULL DEFAULT 'idle',
  processed   BIGINT NOT NULL DEFAULT 0,
  total       BIGINT NOT NULL DEFAULT 0,
  last_error  TEXT,
  started_at  TIMESTAMPTZ,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_background_jobs_kind_account
  ON background_jobs (kind, COALESCE(account_id::text, ''));
