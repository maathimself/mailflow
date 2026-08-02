CREATE TABLE gtd_delegations (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  thread_key TEXT NOT NULL,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  contact_display_name_snapshot TEXT NOT NULL,
  contact_primary_email_snapshot TEXT,
  delegated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, account_id, thread_key)
);

CREATE INDEX idx_gtd_delegations_contact_id
  ON gtd_delegations(contact_id)
  WHERE contact_id IS NOT NULL;
