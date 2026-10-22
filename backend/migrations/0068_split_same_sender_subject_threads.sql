-- Split subject-grouped threads whose members are not replies (#649).
--
-- The subject fallback in computeThreadId threads a message that has no References and no
-- In-Reply-To into an earlier one with the same normalized subject. Since #468 that needs a
-- shared correspondent, but the same sender counted as one, so a shop's receipts ("Order
-- Confirmation for ... from ...") or a provider's sign-in alerts, all from one address with
-- one subject, chained into a single thread that grew with every new message. The fallback
-- now joins the same sender only when the subject carries a reply or forward prefix, joins an
-- exchange between two different senders with or without one, is never used by bulk mail or
-- a no-reply sender, and lets bulk or no-reply mail hold a thread together only for a message
-- addressed to its sender. Rows already stored keep the grouping they were given, so this
-- applies the same rules to them.
--
-- A suspect is a member with no References and no In-Reply-To that is not the thread's root
-- (thread_id is not its own Message-ID): the subject fallback is the only way it got there.
-- A suspect stays when its subject has a reply or forward prefix, or when it has an exchange
-- with a member that stays (one's sender is among the other's recipients, and the two senders
-- differ). A bulk or no-reply suspect never stays, and a bulk or no-reply member counts as an
-- exchange partner only for a suspect addressed to its sender. Every other suspect leaves for
-- a thread rooted at its own Message-ID.
--
-- Header replies follow the message they were threaded through, picked as computeThreadId
-- picks it: the first References id if that message exists in the account, otherwise the
-- last References id (or the In-Reply-To after them) that exists. A reply whose pick is a
-- suspect that leaves goes with it, as do replies to that reply, so the result is what
-- threading the same mail today would give. Every other message with headers stays.
--
-- A header-less Outlook "RE:" chain therefore stays together, as does an exchange between two
-- people that kept the subject unchanged. The account's own addresses and aliases do not
-- count as a sender or a recipient, as in computeThreadId.
--
-- The kept set starts from the members that are not suspects (and the header replies that
-- follow them) plus the prefixed suspects, and grows through exchanges until nothing more
-- joins. Two suspects that only wrote to each other therefore cannot keep each other in.
-- Growing never undoes a decision, so it ends. A second run starts from the same members and
-- reaches the same set, which is what makes it change nothing.
--
-- It does not reproduce threading the mail afresh exactly. It ignores the 90-day window and
-- the order the mail arrived in, which can only keep more together. And it only sees live
-- rows: when the member that held an exchange together is gone (a root that was expunged,
-- say), the replies to it no longer share a correspondent with what is left and each becomes
-- its own thread, where threading them afresh would have kept them together. Accepted: such
-- threads are rare, and a split conversation is a much smaller problem than a hundred
-- receipts shown as one.
--
-- Almost split only. Moved messages only ever leave a thread, for one keyed by the
-- Message-ID of the suspect they followed, and every copy (other folders, soft-deleted rows,
-- which still feed the header lookup in computeThreadId) moves too. The one way two groups
-- can meet is when rows already use that Message-ID as their thread_id: the suspect's own
-- header replies that were filed under it provisionally, or a copy of it that was already
-- self-rooted. Those are the same conversation, so they join it, which is correct.
--
-- Cost. messages is scanned twice, and the header picks are index lookups. The growth runs
-- in passes, but each pass only follows what the previous one added: every sender and every
-- recipient of a thread is looked up once over the whole run, through indexes or hash joins
-- chosen per pass against fresh statistics, so a thread of thousands of members or a chain
-- that needs thousands of passes stays roughly linear. JIT is off because its compile time
-- dominates passes this small. Only threads with at least two live messages and at least one
-- suspect are examined.
--
-- Runs in a transaction like 0057, and must: a migration marked to skip its transaction is
-- executed statement by statement, split on semicolons, which would shred the dollar-quoted
-- block below. The runner detects that marker with a multiline regex, so no line here may
-- begin with it. The runner also disables statement_timeout for migrations.

SET LOCAL jit = off;

-- The account's own addresses: the login address and every alias.
CREATE TEMP TABLE mf649_own AS
  SELECT id AS account_id, lower(trim(email_address)) AS addr
    FROM email_accounts WHERE COALESCE(trim(email_address), '') <> ''
  UNION
  SELECT account_id, lower(trim(email)) FROM account_aliases WHERE COALESCE(trim(email), '') <> '';

-- One row per message (not per copy) in each thread worth examining, with what the steps
-- below need to know about it:
--   sender: lowercased, or '' when it is one of the account's own addresses;
--   automated: bulk or from a no-reply sender (isNoReplySender in imapManager.js);
--   suspect: header-less and not the root; its unit starts as itself;
--   prefixed: the subject has a reply or forward prefix (SUBJECT_PREFIX_RE in imapManager.js).
-- Both patterns are anchored and free of nested quantifiers, so they stay linear.
CREATE TEMP TABLE mf649_members AS
  WITH examined AS (
    SELECT account_id, thread_id
      FROM messages
     WHERE is_deleted = false AND message_id IS NOT NULL AND thread_id IS NOT NULL
     GROUP BY account_id, thread_id
    HAVING count(DISTINCT message_id) > 1
       AND bool_or(thread_id <> message_id
                   AND COALESCE(in_reply_to, '') = '' AND COALESCE(thread_references, '') = '')
  ), copies AS (
    SELECT DISTINCT ON (m.account_id, m.thread_id, m.message_id)
           m.account_id, m.thread_id, m.message_id::text AS message_id, m.subject,
           lower(trim(COALESCE(m.from_email, ''))) AS from_addr,
           m.to_addresses, m.cc_addresses, COALESCE(m.is_bulk, false) AS is_bulk,
           NULLIF(m.in_reply_to, '') AS in_reply_to, NULLIF(m.thread_references, '') AS thread_references
      FROM messages m
      JOIN examined e ON e.account_id = m.account_id AND e.thread_id = m.thread_id
     WHERE m.is_deleted = false AND m.message_id IS NOT NULL
     ORDER BY m.account_id, m.thread_id, m.message_id, m.date ASC, m.id ASC
  )
  SELECT c.account_id, c.thread_id, c.message_id, c.to_addresses, c.cc_addresses,
         c.in_reply_to, c.thread_references,
         CASE WHEN EXISTS (SELECT 1 FROM mf649_own o WHERE o.account_id = c.account_id AND o.addr = c.from_addr)
              THEN '' ELSE c.from_addr END AS sender,
         c.is_bulk OR c.from_addr ~ '^(no|do[-_.]?not)[-_.]?reply([-_.+][^@]*)?@' AS automated,
         s.suspect,
         CASE WHEN s.suspect THEN c.message_id END AS unit,
         COALESCE(c.subject, '') ~* '^[[:space:]]*(re|fw|fwd|aw|sv|vs|tr|wg|ant|antw|ref|rif|ynt|odp|vb|atb)[[:space:]]*:' AS prefixed,
         NULL::text AS anchor,
         false AS kept
    FROM copies c
   CROSS JOIN LATERAL (
     SELECT c.thread_id <> c.message_id AND c.in_reply_to IS NULL AND c.thread_references IS NULL AS suspect
   ) s;

-- Indexes before any update. An index built after this transaction has HOT-updated its rows
-- can be unusable until the transaction ends, which is to say not by this migration at all.
CREATE INDEX ON mf649_members (account_id, thread_id, message_id);
CREATE INDEX ON mf649_members (account_id, thread_id, anchor);
CREATE INDEX ON mf649_members (account_id, thread_id, unit);
CREATE INDEX ON mf649_members (account_id, thread_id, sender);

-- The message each header reply was threaded through. computeThreadId's candidates are the
-- References ids in order, then the In-Reply-To unless it is already among them. It takes the
-- first candidate when a row with that Message-ID and a thread exists in the account, deleted
-- or not, and otherwise the last one that exists. With none, the reply keeps its thread.
CREATE TEMP TABLE mf649_cand AS
  SELECT h.account_id, h.thread_id, h.message_id, c.id, c.pos
    FROM mf649_members h
   CROSS JOIN LATERAL (
     SELECT r.m[1] AS id, r.n AS pos
       FROM regexp_matches(COALESCE(h.thread_references, ''), '<[^>]+>', 'g') WITH ORDINALITY AS r(m, n)
     UNION ALL
     SELECT h.in_reply_to, 2147483647
      WHERE h.in_reply_to IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM regexp_matches(COALESCE(h.thread_references, ''), '<[^>]+>', 'g') q
                         WHERE q[1] = h.in_reply_to)
   ) c
   WHERE h.thread_id <> h.message_id AND (h.in_reply_to IS NOT NULL OR h.thread_references IS NOT NULL);

UPDATE mf649_members h
   SET anchor = a.id
  FROM (
    SELECT DISTINCT ON (account_id, thread_id, message_id) account_id, thread_id, message_id, id
      FROM (
        SELECT c.*, c.pos = min(c.pos) OVER (PARTITION BY c.account_id, c.thread_id, c.message_id) AS first
          FROM mf649_cand c
      ) c
     WHERE EXISTS (SELECT 1 FROM messages x
                    WHERE x.account_id = c.account_id AND x.message_id = c.id AND x.thread_id IS NOT NULL)
     ORDER BY account_id, thread_id, message_id, first DESC, pos DESC
  ) a
 WHERE h.account_id = a.account_id AND h.thread_id = a.thread_id AND h.message_id = a.message_id;

-- Everyone each message was addressed to, minus the account's own addresses and minus its own
-- sender. An exchange needs two different senders, so a message addressed to its own sender
-- (bulk mail often is) can never be one, and leaving those rows out is what lets the exchange
-- test below work on whole threads at once.
CREATE TEMP TABLE mf649_rcpt AS
  SELECT DISTINCT mb.account_id, mb.thread_id, mb.message_id, r.addr
    FROM mf649_members mb
   CROSS JOIN LATERAL (
     SELECT lower(trim(x ->> 'email')) AS addr
       FROM jsonb_array_elements(CASE jsonb_typeof(mb.to_addresses) WHEN 'array' THEN mb.to_addresses ELSE '[]'::jsonb END) x
     UNION ALL
     SELECT lower(trim(x ->> 'email'))
       FROM jsonb_array_elements(CASE jsonb_typeof(mb.cc_addresses) WHEN 'array' THEN mb.cc_addresses ELSE '[]'::jsonb END) x
   ) r
   WHERE COALESCE(r.addr, '') <> ''
     AND r.addr <> mb.sender
     AND NOT EXISTS (SELECT 1 FROM mf649_own o WHERE o.account_id = mb.account_id AND o.addr = r.addr);

CREATE INDEX ON mf649_rcpt (account_id, thread_id, message_id);
CREATE INDEX ON mf649_rcpt (account_id, thread_id, addr);

-- Per-pass working sets. delta holds the members a pass added; the seen tables the senders and
-- recipients already followed, so that nothing is looked up twice.
CREATE TEMP TABLE mf649_delta (account_id uuid, thread_id text, message_id text, sender text, automated boolean, unit text);
CREATE TEMP TABLE mf649_new_senders (account_id uuid, thread_id text, sender text);
CREATE TEMP TABLE mf649_new_rcpts (account_id uuid, thread_id text, addr text);
CREATE TEMP TABLE mf649_seen_senders (account_id uuid, thread_id text, sender text, PRIMARY KEY (account_id, thread_id, sender));
CREATE TEMP TABLE mf649_seen_rcpts (account_id uuid, thread_id text, addr text, PRIMARY KEY (account_id, thread_id, addr));
CREATE TEMP TABLE mf649_joining (account_id uuid, thread_id text, message_id text);

DO $$
DECLARE
  changed BIGINT;
  passes INT := 0;
  split_threads BIGINT;
  moved_messages BIGINT;
  changed_rows BIGINT;
BEGIN
  -- Statements below run through EXECUTE so that each pass is planned against the sizes it
  -- actually has: a cached plan from a large first pass would be wrong for the small ones
  -- after it, and the other way around.
  ANALYZE mf649_members;
  ANALYZE mf649_rcpt;

  -- Header replies join the unit of the suspect they were threaded through, and replies to
  -- those replies after them. Each pass starts only from what the previous one assigned.
  INSERT INTO mf649_delta SELECT account_id, thread_id, message_id, sender, automated, unit
    FROM mf649_members WHERE unit IS NOT NULL;
  LOOP
    EXECUTE 'ANALYZE mf649_delta';
    EXECUTE $q$
      WITH assigned AS (
        UPDATE mf649_members h
           SET unit = d.unit
          FROM mf649_delta d
         WHERE h.account_id = d.account_id AND h.thread_id = d.thread_id AND h.anchor = d.message_id
           AND h.unit IS NULL AND h.thread_id <> h.message_id
        RETURNING h.account_id, h.thread_id, h.message_id, h.sender, h.automated, h.unit
      ), cleared AS (DELETE FROM mf649_delta)
      INSERT INTO mf649_delta SELECT * FROM assigned
    $q$;
    GET DIAGNOSTICS changed = ROW_COUNT;
    EXIT WHEN changed = 0;
  END LOOP;

  -- The seed: everything outside a suspect's unit, and every unit whose suspect has a prefix.
  UPDATE mf649_members SET kept = true WHERE unit IS NULL;
  UPDATE mf649_members m
     SET kept = true
    FROM mf649_members s
   WHERE s.suspect AND s.prefixed AND NOT s.automated
     AND m.account_id = s.account_id AND m.thread_id = s.thread_id AND m.unit = s.message_id;
  TRUNCATE mf649_delta;
  INSERT INTO mf649_delta SELECT account_id, thread_id, message_id, sender, automated, unit
    FROM mf649_members WHERE kept;
  ANALYZE mf649_members;

  -- Grow. A suspect m joins when a kept member o is an exchange partner: o's sender is among
  -- m's recipients, or (when o is not bulk or no-reply) m's sender is among o's recipients.
  -- Recipient rows never hold their own message's sender, so either way the two senders
  -- differ. Each pass takes the senders and recipients the previous pass added and have not
  -- been followed yet, finds the suspects they link to with two plain joins, and keeps those
  -- suspects with their units.
  LOOP
    EXECUTE 'ANALYZE mf649_delta';
    EXECUTE $q$
      WITH fresh AS (
        SELECT DISTINCT d.account_id, d.thread_id, d.sender
          FROM mf649_delta d
         WHERE d.sender <> ''
           AND NOT EXISTS (SELECT 1 FROM mf649_seen_senders s
                            WHERE s.account_id = d.account_id AND s.thread_id = d.thread_id AND s.sender = d.sender)
      ), cleared AS (DELETE FROM mf649_new_senders), seen AS (
        INSERT INTO mf649_seen_senders SELECT * FROM fresh
      )
      INSERT INTO mf649_new_senders SELECT * FROM fresh
    $q$;
    EXECUTE $q$
      WITH fresh AS (
        SELECT DISTINCT r.account_id, r.thread_id, r.addr
          FROM mf649_delta d
          JOIN mf649_rcpt r
            ON r.account_id = d.account_id AND r.thread_id = d.thread_id AND r.message_id = d.message_id
         WHERE NOT d.automated
           AND NOT EXISTS (SELECT 1 FROM mf649_seen_rcpts s
                            WHERE s.account_id = r.account_id AND s.thread_id = r.thread_id AND s.addr = r.addr)
      ), cleared AS (DELETE FROM mf649_new_rcpts), seen AS (
        INSERT INTO mf649_seen_rcpts SELECT * FROM fresh
      )
      INSERT INTO mf649_new_rcpts SELECT * FROM fresh
    $q$;
    EXECUTE 'ANALYZE mf649_new_senders';
    EXECUTE 'ANALYZE mf649_new_rcpts';
    EXECUTE $q$
      WITH linked AS (
        SELECT r.account_id, r.thread_id, r.message_id
          FROM mf649_new_senders s
          JOIN mf649_rcpt r ON r.account_id = s.account_id AND r.thread_id = s.thread_id AND r.addr = s.sender
        UNION
        SELECT m.account_id, m.thread_id, m.message_id
          FROM mf649_new_rcpts p
          JOIN mf649_members m ON m.account_id = p.account_id AND m.thread_id = p.thread_id AND m.sender = p.addr
      ), cleared AS (DELETE FROM mf649_joining)
      INSERT INTO mf649_joining
      SELECT m.account_id, m.thread_id, m.message_id
        FROM linked l
        JOIN mf649_members m ON m.account_id = l.account_id AND m.thread_id = l.thread_id AND m.message_id = l.message_id
       WHERE m.suspect AND NOT m.kept AND NOT m.automated
    $q$;
    GET DIAGNOSTICS changed = ROW_COUNT;
    EXIT WHEN changed = 0;
    passes := passes + 1;
    EXECUTE 'ANALYZE mf649_joining';
    EXECUTE $q$
      WITH added AS (
        UPDATE mf649_members m
           SET kept = true
          FROM mf649_joining j
         WHERE m.account_id = j.account_id AND m.thread_id = j.thread_id AND m.unit = j.message_id
           AND NOT m.kept
        RETURNING m.account_id, m.thread_id, m.message_id, m.sender, m.automated, m.unit
      ), cleared AS (DELETE FROM mf649_delta)
      INSERT INTO mf649_delta SELECT * FROM added
    $q$;
  END LOOP;

  SELECT count(DISTINCT (account_id, thread_id)), count(*)
    INTO split_threads, moved_messages
    FROM mf649_members WHERE NOT kept;

  UPDATE messages m
     SET thread_id = mv.unit
    FROM mf649_members mv
   WHERE NOT mv.kept
     AND m.account_id = mv.account_id
     AND m.thread_id = mv.thread_id
     AND m.message_id = mv.message_id;
  GET DIAGNOSTICS changed_rows = ROW_COUNT;

  RAISE NOTICE 'Thread split (#649): % threads split, % messages (% rows) moved to the thread of the message they followed, % growth passes',
    split_threads, moved_messages, changed_rows, passes;
END $$;

DROP TABLE mf649_own, mf649_members, mf649_cand, mf649_rcpt, mf649_delta, mf649_new_senders,
  mf649_new_rcpts, mf649_seen_senders, mf649_seen_rcpts, mf649_joining;
