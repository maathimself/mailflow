-- Per-account GTD (Getting Things Done) configuration.
-- GTD states (Todo / Watch / Delegated / Someday / Reference) are Gmail labels =
-- IMAP folders; a message intentionally lives in several at once. Designated GTD
-- folders are exempted from the move-detector relocate guard so those sibling
-- rows are not collapsed. Behavior is unchanged while gtd_enabled is false.

-- Per-account opt-in toggle. Off by default (precedent: categorization_enabled, 0023).
ALTER TABLE email_accounts
  ADD COLUMN IF NOT EXISTS gtd_enabled BOOLEAN NOT NULL DEFAULT false;

-- Map of GTD state → folder path, e.g.
--   {"todo":"Todo","watch":"Watch","delegated":"Delegated","someday":"Someday","reference":"Reference"}
-- An empty object means "use the built-in defaults"; individual keys override.
ALTER TABLE email_accounts
  ADD COLUMN IF NOT EXISTS gtd_folders JSONB NOT NULL DEFAULT '{}';
