CREATE TABLE inbox_rules (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id       UUID REFERENCES email_accounts(id) ON DELETE CASCADE,
  name             VARCHAR(255) NOT NULL DEFAULT '',
  enabled          BOOLEAN NOT NULL DEFAULT true,
  stop_processing  BOOLEAN NOT NULL DEFAULT false,
  priority         INTEGER NOT NULL DEFAULT 0,
  condition_logic  VARCHAR(3) NOT NULL DEFAULT 'AND',
  conditions       JSONB NOT NULL DEFAULT '[]',
  actions          JSONB NOT NULL DEFAULT '[]',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_inbox_rules_user    ON inbox_rules(user_id, enabled, priority);
CREATE INDEX idx_inbox_rules_account ON inbox_rules(account_id) WHERE account_id IS NOT NULL;
