-- Scope MCP bearer tokens. Existing tokens were minted when the MCP surface was
-- read-only, so 'read' is both the default and the safe upgrade backfill.
ALTER TABLE api_tokens
  ADD COLUMN IF NOT EXISTS scopes TEXT[] NOT NULL DEFAULT ARRAY['read']::TEXT[];

-- Keep every storage writer constrained to the scopes the server can enforce.
ALTER TABLE api_tokens
  DROP CONSTRAINT IF EXISTS api_tokens_scopes_valid;
ALTER TABLE api_tokens
  ADD CONSTRAINT api_tokens_scopes_valid CHECK (
    scopes <@ ARRAY['read','write','send','settings']::TEXT[]
    AND COALESCE(array_length(scopes, 1), 0) >= 1
  );
