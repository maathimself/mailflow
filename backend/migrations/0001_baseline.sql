-- Baseline schema: all tables, indexes, and incremental changes that were
-- previously applied inline by initDb() on every startup.

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  preferences JSONB NOT NULL DEFAULT '{}',
  is_admin BOOLEAN NOT NULL DEFAULT false,
  totp_secret TEXT,
  totp_enabled BOOLEAN NOT NULL DEFAULT false,
  display_name VARCHAR(100),
  avatar TEXT
);

CREATE TABLE IF NOT EXISTS email_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  email_address VARCHAR(255) NOT NULL,
  color VARCHAR(7) NOT NULL DEFAULT '#6366f1',
  protocol VARCHAR(20) NOT NULL DEFAULT 'imap',
  imap_host VARCHAR(255),
  imap_port INTEGER DEFAULT 993,
  imap_tls BOOLEAN DEFAULT true,
  smtp_host VARCHAR(255),
  smtp_port INTEGER DEFAULT 587,
  smtp_tls VARCHAR(20) DEFAULT 'STARTTLS',
  auth_user VARCHAR(255),
  auth_pass TEXT,
  oauth_provider VARCHAR(50),
  oauth_access_token TEXT,
  oauth_refresh_token TEXT,
  oauth_token_expiry TIMESTAMPTZ,
  enabled BOOLEAN DEFAULT true,
  last_sync TIMESTAMPTZ,
  sync_error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  sort_order INTEGER DEFAULT 0,
  folder_mappings JSONB NOT NULL DEFAULT '{}'::jsonb,
  imap_skip_tls_verify BOOLEAN NOT NULL DEFAULT false,
  signature TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  uid BIGINT NOT NULL,
  folder VARCHAR(500) NOT NULL DEFAULT 'INBOX',
  message_id VARCHAR(500),
  subject TEXT,
  from_name VARCHAR(500),
  from_email VARCHAR(500),
  to_addresses JSONB DEFAULT '[]',
  cc_addresses JSONB DEFAULT '[]',
  date TIMESTAMPTZ,
  snippet TEXT,
  body_text TEXT,
  body_html TEXT,
  is_read BOOLEAN DEFAULT false,
  is_starred BOOLEAN DEFAULT false,
  is_deleted BOOLEAN DEFAULT false,
  has_attachments BOOLEAN DEFAULT false,
  attachments JSONB DEFAULT '[]',
  flags JSONB DEFAULT '[]',
  synced_at TIMESTAMPTZ DEFAULT NOW(),
  reply_to JSONB DEFAULT '[]',
  in_reply_to TEXT,
  thread_references TEXT,
  thread_id TEXT,
  read_changed_at TIMESTAMPTZ,
  star_changed_at TIMESTAMPTZ,
  UNIQUE(account_id, uid, folder)
);

CREATE INDEX IF NOT EXISTS idx_messages_account_folder ON messages(account_id, folder);
CREATE INDEX IF NOT EXISTS idx_messages_date ON messages(date DESC);
CREATE INDEX IF NOT EXISTS idx_messages_read ON messages(is_read);
CREATE INDEX IF NOT EXISTS idx_messages_search ON messages USING gin(
  to_tsvector('english', coalesce(subject,'') || ' ' || coalesce(from_name,'') || ' ' || coalesce(from_email,'') || ' ' || coalesce(snippet,''))
);
CREATE INDEX IF NOT EXISTS idx_messages_body ON messages USING gin(
  to_tsvector('english', coalesce(body_text,''))
);
CREATE INDEX IF NOT EXISTS idx_messages_list
  ON messages(account_id, folder, date DESC)
  WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS idx_messages_list_unread
  ON messages(account_id, folder, date DESC)
  WHERE is_deleted = false AND is_read = false;
CREATE INDEX IF NOT EXISTS idx_messages_thread_id
  ON messages(account_id, thread_id)
  WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS idx_messages_msg_id
  ON messages(message_id)
  WHERE message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS folders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  path VARCHAR(500) NOT NULL,
  name VARCHAR(255) NOT NULL,
  delimiter VARCHAR(10),
  total_count INTEGER DEFAULT 0,
  unread_count INTEGER DEFAULT 0,
  special_use VARCHAR(50),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  uid_validity BIGINT,
  UNIQUE(account_id, path)
);

CREATE TABLE IF NOT EXISTS integration_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  provider VARCHAR(50) NOT NULL,
  config JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS integration_config_provider_idx
  ON integration_config (provider);

CREATE TABLE IF NOT EXISTS system_settings (
  key VARCHAR(100) PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
INSERT INTO system_settings (key, value) VALUES ('registration_open', 'true')
  ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) NOT NULL,
  token VARCHAR(64) UNIQUE NOT NULL,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  used_by UUID REFERENCES users(id) ON DELETE SET NULL,
  used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS account_aliases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL,
  reply_to VARCHAR(255),
  signature TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS oidc_providers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(100) UNIQUE NOT NULL,
  issuer_url VARCHAR(500) NOT NULL,
  client_id VARCHAR(500) NOT NULL,
  client_secret TEXT NOT NULL,
  scopes VARCHAR(500) NOT NULL DEFAULT 'openid email profile',
  provisioning_mode VARCHAR(50) NOT NULL DEFAULT 'login_existing_only',
  allowed_domains TEXT,
  enabled BOOLEAN NOT NULL DEFAULT true,
  require_email_verified BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_id UUID NOT NULL REFERENCES oidc_providers(id) ON DELETE CASCADE,
  issuer VARCHAR(500) NOT NULL,
  subject VARCHAR(500) NOT NULL,
  email VARCHAR(255),
  email_verified BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  UNIQUE(issuer, subject)
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, endpoint)
);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id
  ON push_subscriptions(user_id);

CREATE TABLE IF NOT EXISTS snoozed_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  message_id_header TEXT NOT NULL,
  original_folder VARCHAR(500) NOT NULL,
  snooze_until TIMESTAMPTZ NOT NULL,
  snoozed_folder VARCHAR(500) NOT NULL DEFAULT 'Snoozed',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_snoozed_messages_until ON snoozed_messages(snooze_until);
CREATE INDEX IF NOT EXISTS idx_snoozed_messages_account ON snoozed_messages(account_id);
