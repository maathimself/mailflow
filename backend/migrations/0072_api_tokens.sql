-- Personal API tokens (#617): a bearer credential for scripts and tools such as an MCP server.
-- Only the SHA-256 of the token is stored, as for trusted devices and reset links. Revoking a
-- token deletes its row, so no lookup can forget to check a revoked flag; the auth events keep
-- the history. Scopes are a JSONB list, as the schema's other lists are. Every token expires.
-- confirmed_with says how creating it was confirmed, so that a change to the server's sign-in
-- policy can delete the tokens it no longer allows. A token confirmed through single sign-on
-- names its provider, and goes when the provider is deleted.
CREATE TABLE IF NOT EXISTS api_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(60) NOT NULL,
  token_hash VARCHAR(64) NOT NULL,
  scopes JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  last_used_at TIMESTAMPTZ,
  last_used_ip VARCHAR(45),
  confirmed_with VARCHAR(10) NOT NULL CHECK (confirmed_with IN ('password', 'totp', 'oidc')),
  oidc_provider_id UUID REFERENCES oidc_providers(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_tokens_token_hash ON api_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_api_tokens_user_id ON api_tokens(user_id);

-- Off until an admin turns tokens on (Settings → Security).
INSERT INTO system_settings (key, value) VALUES ('api_tokens_enabled', 'false') ON CONFLICT (key) DO NOTHING;
