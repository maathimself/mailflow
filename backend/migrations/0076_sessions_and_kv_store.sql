-- Sessions and short-lived values that Redis held before 4.4, so a MailFlow install needs no
-- Redis. Neither table is backed up (backup.js TRANSIENT_TABLES): a restore signs everyone out
-- and forgets rate limits, as replacing Redis did.

-- express-session's store (services/sessionStore.js). user_id is copied out of sess.userId so
-- signing a user out everywhere is one indexed DELETE.
CREATE TABLE IF NOT EXISTS sessions (
  sid        text PRIMARY KEY,
  sess       jsonb NOT NULL,
  user_id    text,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions (expires_at);

-- Keys with an optional expiry (services/kvStore.js): rate limit counters, one-time code and
-- nonce replay guards, send idempotency, held send status, sender favicons. A row past
-- expires_at reads as absent; the sweep deletes it later.
CREATE TABLE IF NOT EXISTS kv_store (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  expires_at timestamptz
);
CREATE INDEX IF NOT EXISTS kv_store_expires_at_idx ON kv_store (expires_at) WHERE expires_at IS NOT NULL;
