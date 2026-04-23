import pg from 'pg';

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
    `);
  } finally {
    client.release();
  }
}

export async function query(text, params) {
  return pool.query(text, params);
}
