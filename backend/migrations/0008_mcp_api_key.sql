ALTER TABLE users ADD COLUMN IF NOT EXISTS mcp_api_key VARCHAR(64);
CREATE INDEX IF NOT EXISTS idx_users_mcp_api_key ON users(mcp_api_key) WHERE mcp_api_key IS NOT NULL;
