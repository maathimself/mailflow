-- Split threads that subject-matching merged without a shared correspondent (#468).
--
-- Before 3.5.3 the subject fallback joined any two messages sharing a normalized subject
-- within 90 days, without regard to who they were from or to, so unrelated automated
-- notifications using the same subject became one conversation. The fix applies when a
-- message is threaded, so rows already stored keep the grouping they were given and every
-- existing install still shows the merged threads.
--
-- This partitions each affected thread into groups that genuinely correspond. Two messages
-- correspond when they share a sender, or when one wrote to the other's sender. A shared
-- RECIPIENT deliberately does not count: two unrelated senders writing to the same third
-- party share that address, which happens with forwarded mail, catch-all domains, mailing
-- lists and anything BCC'd.
--
-- Split only. A thread's members are partitioned; nothing is ever merged with anything
-- outside it. The worst case is a conversation that fragments, which is a far smaller
-- problem than unrelated mail shown as one thread, and it cannot invent a grouping that did
-- not already exist.
--
-- Threads containing any message with References or In-Reply-To are skipped entirely: that
-- threading came from headers and was always correct.
--
-- Runs in a transaction like the other bulk backfills (0002, 0017), and must: a migration
-- marked to skip its transaction is executed statement by statement, split on semicolons,
-- which would shred the dollar-quoted blocks below. The runner detects that marker with a
-- multiline regex, so no line here may begin with it. The runner also disables
-- statement_timeout for migrations, so the duration is not a problem.
--
-- Idempotent: a second run finds every thread already correctly partitioned and changes
-- nothing.

-- The sender of a message, lowercased, or '' when it is one of the account's own addresses.
CREATE OR REPLACE FUNCTION mf_split_sender(p_account UUID, p_from TEXT)
RETURNS TEXT AS $$
  SELECT CASE
    WHEN lower(trim(COALESCE(p_from, ''))) = '' THEN ''
    WHEN lower(trim(p_from)) IN (
      SELECT lower(email_address) FROM email_accounts WHERE id = p_account
      UNION ALL SELECT lower(email) FROM account_aliases WHERE account_id = p_account
    ) THEN ''
    ELSE lower(trim(p_from))
  END;
$$ LANGUAGE sql STABLE;

-- Everyone a message was addressed to, minus the account's own addresses.
CREATE OR REPLACE FUNCTION mf_split_recipients(p_account UUID, p_to JSONB, p_cc JSONB)
RETURNS TEXT[] AS $$
  SELECT COALESCE(array_agg(DISTINCT addr), ARRAY[]::TEXT[])
  FROM (
    SELECT lower(trim(x->>'email')) AS addr FROM jsonb_array_elements(COALESCE(p_to, '[]'::jsonb)) x
    UNION ALL
    SELECT lower(trim(x->>'email')) FROM jsonb_array_elements(COALESCE(p_cc, '[]'::jsonb)) x
  ) s
  WHERE addr IS NOT NULL AND addr <> ''
    AND addr NOT IN (
      SELECT lower(email_address) FROM email_accounts WHERE id = p_account
      UNION ALL SELECT lower(email) FROM account_aliases WHERE account_id = p_account
    );
$$ LANGUAGE sql STABLE;

DO $$
DECLARE
  t RECORD;
  members JSONB;
  n INT;
  i INT;
  j INT;
  comp INT[];
  a_from INT;
  b_from INT;
  k INT;
  changed_rows BIGINT := 0;
  split_threads BIGINT := 0;
  root_id TEXT;
  moved INT;
  thread_moved INT;
BEGIN
  FOR t IN
    SELECT account_id, thread_id
    FROM messages
    WHERE is_deleted = false AND thread_id IS NOT NULL AND message_id IS NOT NULL
    GROUP BY account_id, thread_id
    HAVING count(*) > 1
       -- header-threaded conversations are never touched
       AND count(*) FILTER (
         WHERE (in_reply_to IS NOT NULL AND in_reply_to <> '')
            OR (thread_references IS NOT NULL AND thread_references <> '')
       ) = 0
  LOOP
    SELECT jsonb_agg(jsonb_build_object(
             'id', m.id, 'mid', m.message_id, 'date', m.date,
             'sender', mf_split_sender(m.account_id, m.from_email),
             'rcpt', to_jsonb(mf_split_recipients(m.account_id, m.to_addresses, m.cc_addresses))
           ) ORDER BY m.date ASC, m.id ASC)
      INTO members
      FROM messages m
     WHERE m.account_id = t.account_id AND m.thread_id = t.thread_id
       AND m.is_deleted = false AND m.message_id IS NOT NULL;

    n := jsonb_array_length(members);
    CONTINUE WHEN n < 2;

    -- Union-find over the thread's members. Small threads, so a simple O(n^2) pass with
    -- relabelling is fine and far clearer than a recursive CTE.
    comp := ARRAY(SELECT generate_series(1, n));
    FOR i IN 1..n LOOP
      FOR j IN (i + 1)..n LOOP
        IF  (members->(i-1)->>'sender' <> '' AND members->(i-1)->>'sender' = members->(j-1)->>'sender')
         OR (members->(i-1)->>'sender' <> '' AND (members->(j-1)->'rcpt') ? (members->(i-1)->>'sender'))
         OR (members->(j-1)->>'sender' <> '' AND (members->(i-1)->'rcpt') ? (members->(j-1)->>'sender'))
        THEN
          a_from := comp[i];
          b_from := comp[j];
          IF a_from <> b_from THEN
            FOR k IN 1..n LOOP
              IF comp[k] = b_from THEN comp[k] := a_from; END IF;
            END LOOP;
          END IF;
        END IF;
      END LOOP;
    END LOOP;

    CONTINUE WHEN (SELECT count(DISTINCT c) FROM unnest(comp) c) < 2;
    thread_moved := 0;

    -- Every component is rooted at its own earliest member, including the first. Letting one
    -- component keep the existing thread_id looks tidier but is wrong: when that thread_id
    -- belongs to a message in another component, both end up holding it and the thread does
    -- not split at all, which also makes the migration re-run forever.
    FOR k IN 1..n LOOP
      SELECT members->(x-1)->>'mid' INTO root_id
        FROM generate_series(1, n) x WHERE comp[x] = comp[k] ORDER BY x LIMIT 1;
      UPDATE messages SET thread_id = root_id
       WHERE id = (members->(k-1)->>'id')::uuid AND thread_id IS DISTINCT FROM root_id;
      GET DIAGNOSTICS moved = ROW_COUNT;
      thread_moved := thread_moved + moved;
    END LOOP;

    -- Counted only when something actually moved. A thread whose members already sit on
    -- their component roots needs no change, and reporting it as partitioned would make a
    -- re-run look as though it had done work.
    IF thread_moved > 0 THEN
      split_threads := split_threads + 1;
      changed_rows := changed_rows + thread_moved;
    END IF;
  END LOOP;

  RAISE NOTICE 'Thread split (#468): % threads partitioned, % messages moved', split_threads, changed_rows;
END $$;

DROP FUNCTION IF EXISTS mf_split_sender(UUID, TEXT);
DROP FUNCTION IF EXISTS mf_split_recipients(UUID, JSONB, JSONB);
