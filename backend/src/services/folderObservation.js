import { query, withTransaction } from './db.js';

function tokenFromRow(row) {
  return {
    folder: row.path,
    uidValidity: row.uid_validity == null ? null : String(row.uid_validity),
    generation: String(row.observation_generation),
    ...(row.topology_identity == null ? {} : {
      topologyIdentity: String(row.topology_identity),
    }),
    isPresent: row.is_present === true,
  };
}

function tokenList(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function throwSuperseded(folder) {
  const err = new Error(`Newer folder observation superseded ${folder}`);
  err.code = 'FOLDER_OBSERVATION_SUPERSEDED';
  throw err;
}

function assertExpectedRow(row, token) {
  if (!row || String(row.observation_generation) !== String(token.generation)) {
    throwSuperseded(token.folder);
  }
  const actualValidity = row.uid_validity == null ? null : String(row.uid_validity);
  const expectedValidity = token.uidValidity == null ? null : String(token.uidValidity);
  if (actualValidity !== expectedValidity) {
    const err = new Error(`UIDVALIDITY changed during ${token.folder} observation`);
    err.code = 'FOLDER_OBSERVATION_UIDVALIDITY_CHANGED';
    throw err;
  }
  if (token.topologyIdentity != null && (
    row.topology_identity == null ||
    String(row.topology_identity) !== String(token.topologyIdentity)
  )) {
    const err = new Error(`Folder topology changed during ${token.folder} observation`);
    err.code = 'FOLDER_OBSERVATION_TOPOLOGY_CHANGED';
    throw err;
  }
}

export async function claimFolderObservations(accountId, paths, { context = [], expected = [] } = {}) {
  const contextTokens = tokenList(context);
  const expectedTokens = tokenList(expected);
  const owned = new Set(contextTokens.map(token => token.folder));
  const requested = [...new Set((paths || []).filter(Boolean))].sort();
  const ordered = [...new Set([
    ...requested,
    ...contextTokens.map(token => token.folder),
    ...expectedTokens.map(token => token.folder),
  ])].sort();
  if (ordered.length === 0) return [];
  return withTransaction(async (tx) => {
    const locked = await tx.query(
      `SELECT path, uid_validity, observation_generation, topology_identity, is_present
         FROM folders
        WHERE account_id = $1 AND path = ANY($2::text[])
        ORDER BY path
        FOR UPDATE`,
      [accountId, ordered],
    );
    if (locked.rows.length !== ordered.length) {
      throw new Error('Cannot observe one or more missing folders');
    }
    const byPath = new Map(locked.rows.map(row => [row.path, row]));
    for (const token of [...contextTokens, ...expectedTokens]) {
      assertExpectedRow(byPath.get(token.folder), token);
    }

    const newlyOwned = requested.filter(folder => !owned.has(folder));
    if (newlyOwned.length > 0) {
      const result = await tx.query(
        `UPDATE folders
            SET observation_generation = observation_generation + 1
          WHERE account_id = $1 AND path = ANY($2::text[])
          RETURNING path, uid_validity, observation_generation, topology_identity, is_present`,
        [accountId, newlyOwned],
      );
      for (const row of result.rows) byPath.set(row.path, row);
    }
    return ordered.map(folder => tokenFromRow(byPath.get(folder)));
  });
}

export async function claimFolderObservation(accountId, folder, options) {
  return (await claimFolderObservations(accountId, [folder], options))
    .find(token => token.folder === folder);
}

export async function claimMailboxTopology(accountId) {
  return withTransaction(async (tx) => {
    const result = await tx.query(
      `UPDATE email_accounts
          SET mailbox_topology_generation = mailbox_topology_generation + 1
        WHERE id = $1
        RETURNING mailbox_topology_generation`,
      [accountId],
    );
    const row = result.rows[0];
    if (!row) throw new Error(`Cannot claim mailbox topology for missing account ${accountId}`);
    return { accountId, generation: String(row.mailbox_topology_generation) };
  });
}

export async function assertMailboxTopology(tx, accountId, token) {
  const result = await tx.query(
    `SELECT mailbox_topology_generation
       FROM email_accounts
      WHERE id = $1
      FOR UPDATE`,
    [accountId],
  );
  const generation = result.rows[0]?.mailbox_topology_generation;
  if (generation == null || String(generation) !== String(token?.generation)) {
    const err = new Error(`Newer mailbox topology superseded account ${accountId}`);
    err.code = 'MAILBOX_TOPOLOGY_SUPERSEDED';
    throw err;
  }
  return result.rows[0];
}

export async function commitMailboxTopology(accountId, token, mailboxes) {
  const ordered = [...(mailboxes || [])]
    .filter(mailbox => mailbox?.path)
    .sort((a, b) => a.path.localeCompare(b.path));
  const paths = ordered.map(mailbox => mailbox.path);
  return withTransaction(async (tx) => {
    await assertMailboxTopology(tx, accountId, token);
    await tx.query(
      `WITH candidate_paths AS (
         SELECT unnest($2::text[]) AS path
         UNION
         SELECT path
           FROM folders
          WHERE account_id = $1
       )
       SELECT f.path
         FROM folders f
         JOIN candidate_paths candidate ON candidate.path = f.path
        WHERE f.account_id = $1
        ORDER BY f.path
        FOR UPDATE OF f`,
      [accountId, paths],
    );
    await tx.query(
      `WITH incoming AS (
         SELECT *
           FROM jsonb_to_recordset($2::jsonb) AS mb(
             path text, name text, delimiter text, special_use text, no_select boolean
           )
       )
       INSERT INTO folders (
         account_id, path, name, delimiter, special_use, no_select, is_present
       )
       SELECT $1, path, name, delimiter, special_use, no_select, true
         FROM incoming
        ORDER BY path
       ON CONFLICT (account_id, path) DO UPDATE
       SET name = EXCLUDED.name,
           delimiter = EXCLUDED.delimiter,
           special_use = EXCLUDED.special_use,
           no_select = EXCLUDED.no_select,
           uid_validity = CASE WHEN folders.is_present = false THEN NULL
                               ELSE folders.uid_validity END,
           highest_modseq = CASE WHEN folders.is_present = false THEN NULL
                                 ELSE folders.highest_modseq END,
           observation_generation = folders.observation_generation +
             CASE WHEN folders.is_present = false THEN 1 ELSE 0 END,
           topology_identity = CASE WHEN folders.is_present = false THEN gen_random_uuid()
                                    ELSE folders.topology_identity END,
           is_present = true,
           updated_at = NOW()`,
      [accountId, JSON.stringify(ordered.map(mailbox => ({
        path: mailbox.path,
        name: mailbox.name || mailbox.path,
        delimiter: mailbox.delimiter ?? null,
        special_use: mailbox.specialUse ?? mailbox.special_use ?? null,
        no_select: mailbox.noSelect === true || mailbox.no_select === true,
      })))],
    );
    const tombstoned = await tx.query(
      `UPDATE folders
          SET is_present = false,
              uid_validity = NULL,
              highest_modseq = NULL,
              observation_generation = observation_generation + 1,
              updated_at = NOW()
        WHERE account_id = $1
          AND is_present = true
          AND path <> ALL($2::text[])
        RETURNING path`,
      [accountId, paths],
    );
    await tx.query(
      `UPDATE messages m
          SET metadata_complete = false
        WHERE m.account_id = $1
          AND m.metadata_complete = true
          AND NOT EXISTS (
            SELECT 1
              FROM folders f
             WHERE f.account_id = m.account_id
               AND f.path = m.folder
               AND f.is_present = true
               AND f.uid_validity IS NOT NULL
          )`,
      [accountId],
    );
    return { tombstoned: tombstoned.rows.map(row => row.path).sort() };
  });
}

export async function readFolderObservation(accountId, folder) {
  const result = await query(
    `SELECT uid_validity, observation_generation, topology_identity, is_present
       FROM folders
      WHERE account_id = $1 AND path = $2`,
    [accountId, folder],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`Cannot observe missing folder ${folder}`);
  return tokenFromRow({ ...row, path: folder });
}

export async function assertFolderObservation(tx, accountId, token, { checkUidValidity = true } = {}) {
  const result = await tx.query(
    `SELECT uid_validity, observation_generation, topology_identity, is_present
       FROM folders
      WHERE account_id = $1 AND path = $2
      FOR UPDATE`,
    [accountId, token.folder],
  );
  const row = result.rows[0];
  if (!row || (token.generation != null &&
      String(row.observation_generation) !== String(token.generation))) throwSuperseded(token.folder);
  if (checkUidValidity) assertExpectedRow(row, token);
  return row;
}

export async function seedFolderUidValidity(tx, accountId, token, uidValidity) {
  if (uidValidity == null) throw new Error('Authoritative UIDVALIDITY is required');
  const row = await assertFolderObservation(tx, accountId, token);
  if (row.is_present !== true) {
    const err = new Error(`Cannot seed absent folder ${token.folder}`);
    err.code = 'FOLDER_NOT_PRESENT';
    throw err;
  }
  if (row.uid_validity != null) return tokenFromRow({ ...row, path: token.folder });

  await tx.query(
    `DELETE FROM messages
      WHERE account_id = $1 AND folder = $2
        AND metadata_complete = false`,
    [accountId, token.folder],
  );
  const seeded = await tx.query(
    `UPDATE folders
        SET uid_validity = $3,
            highest_modseq = NULL,
            updated_at = NOW()
      WHERE account_id = $1 AND path = $2
        AND is_present = true
        AND uid_validity IS NULL
        AND observation_generation = $4
      RETURNING path, uid_validity, observation_generation, topology_identity, is_present`,
    [accountId, token.folder, uidValidity, token.generation],
  );
  if (!seeded.rows[0]) throwSuperseded(token.folder);
  return tokenFromRow(seeded.rows[0]);
}
