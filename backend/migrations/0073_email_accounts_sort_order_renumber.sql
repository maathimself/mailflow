-- Every account started at sort_order 0, and moving one in the sidebar rewrote only the two it
-- swapped, so a user's accounts could share positions and reshuffle on the next load (#695).
-- Renumbers each user's accounts 0, 1, 2, ... in the order the sidebar shows them now.
UPDATE email_accounts a
   SET sort_order = o.pos
  FROM (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY sort_order, created_at) - 1 AS pos
      FROM email_accounts
  ) o
 WHERE a.id = o.id
   AND a.sort_order IS DISTINCT FROM o.pos;
