-- Whether a user may use the instance's AI provider (#644). The admin sets it per user in
-- Admin > Users; accounts created later take the "Allow AI for new users" setting. Existing
-- accounts start with access, so nothing changes on upgrade until an admin turns it off.
ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_enabled BOOLEAN NOT NULL DEFAULT TRUE;
