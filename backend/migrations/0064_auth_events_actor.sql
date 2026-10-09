-- The admin who made a change to a user (a new password, a recovery email, turning off 2FA), so
-- the security log shows who did it. NULL for the sign-in events, which have no separate actor.
ALTER TABLE auth_events ADD COLUMN IF NOT EXISTS actor_username VARCHAR(120);
