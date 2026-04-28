import pg from 'pg';
import { encrypt, isEncrypted } from './encryption.js';

const { Pool } = pg;

export const pool = new Pool({
  host: process.env.DB_HOST || 'postgres',
  port: 5432,
  database: process.env.DB_NAME || 'mailflow',
  user: process.env.DB_USER || 'mailflow',
  password: process.env.DB_PASSWORD,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// Set a per-query statement timeout so a slow or runaway query
// can't hold a connection indefinitely.
pool.on('connect', client => {
  client.query('SET statement_timeout = 30000').catch(err =>
    console.error('Failed to set statement_timeout:', err.message)
  );
});

export async function initDb() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        username VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS email_accounts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        email_address VARCHAR(255) NOT NULL,
        color VARCHAR(7) NOT NULL DEFAULT '#6366f1',
        protocol VARCHAR(20) NOT NULL DEFAULT 'imap',
        -- IMAP/SMTP settings
        imap_host VARCHAR(255),
        imap_port INTEGER DEFAULT 993,
        imap_tls BOOLEAN DEFAULT true,
        smtp_host VARCHAR(255),
        smtp_port INTEGER DEFAULT 587,
        smtp_tls VARCHAR(20) DEFAULT 'STARTTLS',
        auth_user VARCHAR(255),
        auth_pass TEXT, -- encrypted
        -- OAuth settings
        oauth_provider VARCHAR(50),
        oauth_access_token TEXT,
        oauth_refresh_token TEXT,
        oauth_token_expiry TIMESTAMPTZ,
        -- JMAP settings
        jmap_session_url VARCHAR(255),
        -- State
        enabled BOOLEAN DEFAULT true,
        last_sync TIMESTAMPTZ,
        sync_error TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        sort_order INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
        uid BIGINT NOT NULL,
        folder VARCHAR(500) NOT NULL DEFAULT 'INBOX',
        message_id VARCHAR(500),
        thread_id VARCHAR(500),
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
        UNIQUE(account_id, path)
      );
    `);
    // Migrations — safe to run on every startup (IF NOT EXISTS / idempotent)
    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS preferences JSONB NOT NULL DEFAULT '{}';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT false;

      ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS folder_mappings JSONB NOT NULL DEFAULT '{}'::jsonb;
      ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS imap_skip_tls_verify BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS signature TEXT;

      ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to JSONB DEFAULT '[]';
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS in_reply_to TEXT;

      CREATE TABLE IF NOT EXISTS integration_config (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider VARCHAR(50) NOT NULL,
        config JSONB NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id, provider)
      );

      -- Migrate integration_config to a global, per-provider table (no per-user scoping).
      -- All four statements are idempotent: safe on fresh installs and repeated restarts.
      ALTER TABLE integration_config ALTER COLUMN user_id DROP NOT NULL;
      ALTER TABLE integration_config DROP CONSTRAINT IF EXISTS integration_config_user_id_provider_key;
      DELETE FROM integration_config WHERE id NOT IN (
        SELECT DISTINCT ON (provider) id
        FROM integration_config
        ORDER BY provider, updated_at DESC NULLS LAST
      );
      CREATE UNIQUE INDEX IF NOT EXISTS integration_config_provider_idx
        ON integration_config (provider);
      UPDATE integration_config SET user_id = NULL WHERE user_id IS NOT NULL;

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

      ALTER TABLE folders ADD COLUMN IF NOT EXISTS uid_validity BIGINT;

      CREATE INDEX IF NOT EXISTS idx_messages_list
        ON messages(account_id, folder, date DESC)
        WHERE is_deleted = false;

      CREATE INDEX IF NOT EXISTS idx_messages_list_unread
        ON messages(account_id, folder, date DESC)
        WHERE is_deleted = false AND is_read = false;
    `);
  } finally {
    client.release();
  }
}

export async function query(text, params) {
  return pool.query(text, params);
}

// One-time startup migration: encrypt any plaintext credentials still in the DB.
// Safe to run on every startup — already-encrypted values are skipped by isEncrypted().
export async function encryptExistingCredentials() {
  if (!process.env.ENCRYPTION_KEY) {
    console.warn('ENCRYPTION_KEY not set — stored credentials are NOT encrypted. Set ENCRYPTION_KEY in .env to enable at-rest encryption.');
    return;
  }

  const result = await pool.query(
    'SELECT id, auth_pass, oauth_access_token, oauth_refresh_token FROM email_accounts'
  );

  let count = 0;
  for (const row of result.rows) {
    const updates = {};
    if (row.auth_pass && !isEncrypted(row.auth_pass))
      updates.auth_pass = encrypt(row.auth_pass);
    if (row.oauth_access_token && !isEncrypted(row.oauth_access_token))
      updates.oauth_access_token = encrypt(row.oauth_access_token);
    if (row.oauth_refresh_token && !isEncrypted(row.oauth_refresh_token))
      updates.oauth_refresh_token = encrypt(row.oauth_refresh_token);

    if (Object.keys(updates).length) {
      const keys = Object.keys(updates);
      const sets = keys.map((k, i) => `${k} = $${i + 1}`);
      await pool.query(
        `UPDATE email_accounts SET ${sets.join(', ')} WHERE id = $${keys.length + 1}`,
        [...Object.values(updates), row.id]
      );
      count++;
    }
  }
  if (count > 0) console.log(`Encrypted credentials for ${count} account(s)`);
}
