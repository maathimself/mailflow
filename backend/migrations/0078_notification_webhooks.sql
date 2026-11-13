CREATE TABLE IF NOT EXISTS notification_webhooks (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT false,
  format TEXT NOT NULL DEFAULT 'generic' CHECK (format IN ('generic', 'ntfy', 'gotify')),
  url TEXT,
  token TEXT,
  include_sender BOOLEAN NOT NULL DEFAULT false,
  include_subject BOOLEAN NOT NULL DEFAULT false,
  failures INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  revision UUID NOT NULL DEFAULT gen_random_uuid()
);
INSERT INTO system_settings (key, value) VALUES
  ('notification_webhooks', '{"enabled":false,"allowedOrigins":[]}')
ON CONFLICT (key) DO NOTHING;
