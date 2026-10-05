-- When each user last used the app, for the admin's Users list. Sessions roll for days after
-- their last request, so the last login cannot tell an account in daily use from an abandoned
-- one; requireAuth records the last request instead (see services/lastSeen.js).
--
-- IF NOT EXISTS so the migration stays harmless if the column ever arrives by another route, and
-- an install that ran it as 0062_user_last_seen (before main took 0062) runs it again unchanged:
-- the seed below only fills users that have no value yet.
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;

-- Start from the login history that is still kept (auth_events keeps 90 days), so existing
-- accounts do not all read "never" until their next request.
UPDATE users u
   SET last_seen_at = e.last_login
  FROM (SELECT user_id, MAX(created_at) AS last_login
          FROM auth_events
         WHERE success AND user_id IS NOT NULL
         GROUP BY user_id) e
 WHERE e.user_id = u.id AND u.last_seen_at IS NULL;
