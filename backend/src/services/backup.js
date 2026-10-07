// Backup and restore of a MailFlow installation from the admin UI (#452).
//
// A backup is a gzipped file of JSON lines: a manifest, then the rows of each table in an
// order that satisfies the foreign keys, then a footer with the row counts. A restore hands
// each line back to PostgreSQL with json_populate_recordset, so the column types do the parsing.
import { once } from 'events';
import { StringDecoder } from 'string_decoder';
import { finished } from 'stream/promises';
import { createGunzip, createGzip } from 'zlib';
import pg from 'pg';
import { decrypt, encrypt, isEncrypted } from './encryption.js';

// Format 1, written before json and jsonb travelled as text, could not tell a JSON null from
// SQL NULL, so it is not read.
export const BACKUP_FORMAT = 2;
export const BACKUP_SCOPES = ['setup', 'full'];

// Every table in the schema belongs to exactly one of these groups. backup.test.js checks
// the groups against the migrations, so a new table cannot be left out of backups by accident.
//
// The setup: what it takes to bring this installation up again somewhere else.
export const SETUP_TABLES = [
  'account_aliases',
  'address_books',
  'ai_codex_credentials',
  'auth_events',
  'block_list',
  'category_list_sources',
  'contacts',
  'email_accounts',
  'inbox_rule_forwards',
  'inbox_rules',
  'integration_config',
  'invites',
  'oidc_providers',
  'plugin_account_config',
  'plugin_data',
  'push_subscriptions',
  'snoozed_messages',
  'spam_models',
  'spam_training_deletions',
  'spam_training_log',
  'system_settings',
  'trusted_devices',
  'user_identities',
  'user_integrations',
  'users',
];
// The local copy of the mail on the IMAP servers. Synced again after a restore that leaves it out.
export const MAIL_CACHE_TABLES = ['folders', 'messages', 'unfetchable_uids'];
// Short-lived tokens that are worthless minutes later.
export const TRANSIENT_TABLES = ['ai_codex_device_flows', 'email_otp_tokens', 'password_reset_tokens'];
// The record of which migrations shaped the schema the rows are written back into.
export const SCHEMA_TABLES = ['schema_migrations'];

const KNOWN_TABLES = new Set([...SETUP_TABLES, ...MAIL_CACHE_TABLES, ...TRANSIENT_TABLES, ...SCHEMA_TABLES]);
const RESTORABLE_TABLES = new Set([...SETUP_TABLES, ...MAIL_CACHE_TABLES]);

// Encrypted with the installation's ENCRYPTION_KEY and stored in the manifest, so a restore can
// tell before it writes anything whether the credentials in the file will decrypt here.
const KEY_CHECK_PLAINTEXT = 'mailflow-backup-key-check';

const FETCH_ROWS = 500;
const LINE_BYTES = 2 * 1024 * 1024;
// A line holds a batch of rows up to LINE_BYTES, or one larger row on its own. A restore refuses
// longer lines before holding them in memory, and a backup refuses rows that would need one.
const MAX_LINE_CHARS = 64 * 1024 * 1024;
const MAX_ROW_CHARS = MAX_LINE_CHARS - 4096;

// These types, and arrays of them, are read as PostgreSQL's own text rather than through a
// JavaScript Date or number, which would drop microseconds and turn infinity or NaN into null.
// json and jsonb are read as text too: JSON.parse would make a JSON null indistinguishable from
// SQL NULL, and turn 2.50 into 2.5 and long numbers into doubles.
const TEXT_TYPE_OIDS = new Set([
  17, 1001, // bytea
  20, 1016, // int8
  700, 1021, 701, 1022, // float4, float8
  790, 791, // money
  1082, 1182, 1083, 1183, 1114, 1115, 1184, 1185, // date, time, timestamp, timestamptz
  1186, 1187, 1266, 1270, // interval, timetz
  1700, 1231, // numeric
  114, 199, 3802, 3807, // json, jsonb
]);
const JSON_TYPES = new Set(['json', 'jsonb']);
const textTypes = {
  getTypeParser: (oid, format) => (TEXT_TYPE_OIDS.has(oid) ? value => value : pg.types.getTypeParser(oid, format)),
};

// A problem with the file or with restoring it here, worded for the admin who uploaded it.
export class BackupFileError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BackupFileError';
    this.status = 400;
  }
}

// Identifiers are only ever quoted after they were matched against the live schema.
const ident = name => `"${name.replace(/"/g, '""')}"`;

async function listTables(client) {
  const { rows } = await client.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'",
  );
  return rows.map(r => r.table_name);
}

// Tables a backup would have to leave out because nobody decided which group they belong to.
export async function unclassifiedTables(client) {
  return (await listTables(client)).filter(t => !KNOWN_TABLES.has(t));
}

// table -> its columns in order, plus the sequence behind each serial column. Generated columns
// are left out: PostgreSQL computes them, and refuses a value for them on the way back in.
async function listColumns(client) {
  const { rows } = await client.query(
    `SELECT table_name, column_name, udt_name,
            pg_get_serial_sequence(quote_ident(table_name), column_name) AS sequence
       FROM information_schema.columns WHERE table_schema = 'public' AND is_generated = 'NEVER'
       ORDER BY table_name, ordinal_position`,
  );
  const columns = new Map();
  const sequences = [];
  for (const r of rows) {
    if (!columns.has(r.table_name)) columns.set(r.table_name, []);
    columns.get(r.table_name).push({ name: r.column_name, type: r.udt_name });
    if (r.sequence) sequences.push({ table: r.table_name, column: r.column_name, sequence: r.sequence });
  }
  return { columns, sequences };
}

// Sequences no column owns, such as folder_status_revision, which TRUNCATE ... RESTART IDENTITY
// does not touch.
async function standaloneSequenceNames(client) {
  const { rows } = await client.query(
    `SELECT c.relname AS name
       FROM pg_class c
      WHERE c.relkind = 'S' AND c.relnamespace = 'public'::regnamespace
        AND NOT EXISTS (SELECT 1 FROM pg_depend d
                         WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype IN ('a', 'i'))`,
  );
  return rows.map(r => r.name);
}

// last_value rather than pg_sequence_last_value(), which is null until nextval() runs again after
// a RESTART, the state every restore leaves the sequence in.
async function sequencePosition(client, name) {
  const { rows } = await client.query(`SELECT last_value::text AS value FROM ${ident(name)}`);
  return BigInt(rows[0].value);
}

async function listForeignKeys(client) {
  const { rows } = await client.query(
    `SELECT conrelid::regclass::text AS child, confrelid::regclass::text AS parent
       FROM pg_constraint WHERE contype = 'f' AND connamespace = 'public'::regnamespace`,
  );
  return rows.map(r => ({ child: r.child.replace(/^"|"$/g, ''), parent: r.parent.replace(/^"|"$/g, '') }));
}

async function schemaVersion(client) {
  const { rows } = await client.query('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1');
  return rows[0]?.version || '';
}

// Parents before children, and alphabetical where the foreign keys leave a choice.
export function orderByForeignKeys(tables, foreignKeys) {
  const chosen = new Set(tables);
  const parents = new Map(tables.map(t => [t, new Set()]));
  for (const { child, parent } of foreignKeys) {
    if (child !== parent && chosen.has(child) && chosen.has(parent)) parents.get(child).add(parent);
  }
  const ordered = [];
  const done = new Set();
  while (ordered.length < tables.length) {
    const ready = [...chosen].filter(t => !done.has(t) && [...parents.get(t)].every(p => done.has(p))).sort();
    if (!ready.length) throw new Error(`Foreign keys form a cycle among: ${[...chosen].filter(t => !done.has(t)).join(', ')}`);
    for (const t of ready) { ordered.push(t); done.add(t); }
  }
  return ordered;
}

// pg's own parsers still apply to the types not read as text, where bytea would come back as a
// Buffer and a timestamp as a Date; both need a JSON form the column's input function accepts.
export function encodeValue(value) {
  if (Buffer.isBuffer(value)) return '\\x' + value.toString('hex');
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (Array.isArray(value)) return value.map(encodeValue);
  return value;
}

function encodeRow(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) out[k] = encodeValue(v);
  return out;
}

// Streams a backup into `out` (an HTTP response or any writable). The rows are read inside one
// REPEATABLE READ transaction, so every table comes from the same moment.
export async function writeBackup(client, { scope, appVersion, out }) {
  if (!BACKUP_SCOPES.includes(scope)) throw new Error(`Unknown backup scope: ${scope}`);
  const present = await listTables(client);
  const unclassified = present.filter(t => !KNOWN_TABLES.has(t));
  if (unclassified.length) throw new Error(`Tables not classified for backup: ${unclassified.join(', ')}`);
  const wanted = scope === 'full' ? [...SETUP_TABLES, ...MAIL_CACHE_TABLES] : SETUP_TABLES;
  const tables = orderByForeignKeys(wanted.filter(t => present.includes(t)), await listForeignKeys(client));
  const { columns } = await listColumns(client);

  const gzip = createGzip();
  gzip.pipe(out);
  // A download the browser cancelled must stop the transaction instead of filling memory:
  // once the response is gone the gzip buffer never drains, so the wait is raced against it.
  let gone = null;
  let rejectGone = () => {};
  const goneRejection = new Promise((_, reject) => { rejectGone = reject; });
  goneRejection.catch(() => {});
  const fail = err => {
    if (gone) return;
    gone = err || new Error('The download was interrupted');
    rejectGone(gone);
  };
  out.on('error', fail);
  out.on('close', () => { if (!out.writableFinished) fail(); });
  const writeLine = async obj => {
    if (out.destroyed) fail();
    if (gone) throw gone;
    if (!gzip.write(JSON.stringify(obj) + '\n')) await Promise.race([once(gzip, 'drain'), goneRejection]);
  };

  const rowCounts = {};
  let inTransaction = false;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    inTransaction = true;
    // The position of every sequence no column owns, so a restore can keep it ahead of the rows
    // that carry its values.
    const sequences = {};
    for (const name of await standaloneSequenceNames(client)) sequences[name] = String(await sequencePosition(client, name));
    await writeLine({
      mailflow: 'backup',
      format: BACKUP_FORMAT,
      app: appVersion,
      scope,
      createdAt: new Date().toISOString(),
      schemaVersion: await schemaVersion(client),
      tables,
      sequences,
      keyCheck: encrypt(KEY_CHECK_PLAINTEXT),
    });
    for (const table of tables) {
      rowCounts[table] = 0;
      const cols = columns.get(table);
      if (!cols?.length) throw new Error(`No columns found for ${table}`);
      await client.query(`DECLARE backup_rows NO SCROLL CURSOR FOR SELECT ${cols.map(c => ident(c.name)).join(', ')} FROM ${ident(table)}`);
      let rows = [];
      let bytes = 0;
      const flush = async () => {
        if (!rows.length) return;
        await writeLine({ table, rows });
        rows = [];
        bytes = 0;
      };
      for (;;) {
        const fetched = await client.query({ text: `FETCH ${FETCH_ROWS} FROM backup_rows`, types: textTypes });
        if (!fetched.rows.length) break;
        rowCounts[table] += fetched.rows.length;
        for (const row of fetched.rows) {
          const encoded = encodeRow(row);
          const size = JSON.stringify(encoded).length;
          if (size > MAX_ROW_CHARS) throw new Error(`A row of ${table} is too large for a backup (${size} characters)`);
          if (rows.length && bytes + size > LINE_BYTES) await flush();
          rows.push(encoded);
          bytes += size;
        }
      }
      await flush();
      await client.query('CLOSE backup_rows');
    }
    await client.query('COMMIT');
    inTransaction = false;
    await writeLine({ end: true, rowCounts });
    gzip.end();
    await finished(out, { readable: false });
  } catch (err) {
    if (inTransaction) await client.query('ROLLBACK').catch(() => {});
    gzip.destroy();
    throw err;
  }
  return { tables: tables.length, rows: Object.values(rowCounts).reduce((a, b) => a + b, 0) };
}

// Decodes across chunk boundaries, since zlib cuts its output wherever its buffer fills,
// in the middle of a multi-byte character as often as not. Each chunk is searched once, so a
// long line costs time in proportion to its length.
async function* lines(stream) {
  const decoder = new StringDecoder('utf8');
  let parts = [];
  let size = 0;
  for await (const chunk of stream) {
    let text = decoder.write(chunk);
    let at;
    while ((at = text.indexOf('\n')) >= 0) {
      parts.push(text.slice(0, at));
      const line = parts.join('');
      parts = [];
      size = 0;
      text = text.slice(at + 1);
      if (/\S/.test(line)) yield line;
    }
    if (text) {
      parts.push(text);
      size += text.length;
      if (size > MAX_LINE_CHARS) throw new BackupFileError('The backup file has a line longer than any backup writes.');
    }
  }
  const last = parts.join('') + decoder.end();
  if (/\S/.test(last)) yield last;
}

function parseLine(line) {
  try {
    const value = JSON.parse(line);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch { /* fall through */ }
  throw new BackupFileError('This is not a MailFlow backup file.');
}

function checkManifest(manifest, currentVersion) {
  if (manifest.mailflow !== 'backup' || !Number.isInteger(manifest.format)) {
    throw new BackupFileError('This is not a MailFlow backup file.');
  }
  if (manifest.format > BACKUP_FORMAT) {
    throw new BackupFileError('This backup was made by a newer version of MailFlow. Update MailFlow, then restore it.');
  }
  if (manifest.format < BACKUP_FORMAT) {
    throw new BackupFileError('This backup uses an earlier file format, which this version of MailFlow does not read. Update MailFlow on the server it came from, make a new backup there, and restore that.');
  }
  const sequences = manifest.sequences ?? {};
  if (!BACKUP_SCOPES.includes(manifest.scope) || typeof manifest.schemaVersion !== 'string'
    || !Array.isArray(manifest.tables) || !manifest.tables.every(t => typeof t === 'string')
    || typeof manifest.keyCheck !== 'string' || !sequences || typeof sequences !== 'object' || Array.isArray(sequences)
    || !Object.values(sequences).every(v => typeof v === 'string' && /^\d+$/.test(v))) {
    throw new BackupFileError('This is not a MailFlow backup file.');
  }
  const madeBy = typeof manifest.app === 'string' && /^[\w.+-]{1,40}$/.test(manifest.app) ? ` (${manifest.app})` : '';
  // Migration versions are zero-padded ("0061_..."), so they order as strings.
  if (manifest.schemaVersion > currentVersion) {
    throw new BackupFileError(`This backup was made by a newer version of MailFlow${madeBy}. Update MailFlow, then restore it.`);
  }
  // An update converts existing data as it migrates; rows restored into a newer schema would
  // skip that, so an older backup goes back onto its own version and is updated from there.
  if (manifest.schemaVersion < currentVersion) {
    throw new BackupFileError(`This backup was made by an older version of MailFlow${madeBy}. Restore it on that version, then update MailFlow.`);
  }
  // decrypt() passes a value without the enc: prefix through unchanged, so a key check that was
  // never encrypted would otherwise match under any key.
  if (!isEncrypted(manifest.keyCheck) || decrypt(manifest.keyCheck) !== KEY_CHECK_PLAINTEXT) {
    throw new BackupFileError('This backup was made on a server with a different ENCRYPTION_KEY. Set that key in .env and restart MailFlow before restoring it.');
  }
}

// Replaces this installation's data with the contents of `input`, a gzipped backup stream. The
// manifest is checked before anything is touched; the rows then go in inside one transaction,
// so a bad file leaves the database as it was. `beforeWrite` runs once the file is accepted
// and before the first write, `onProgress` after every batch of rows. `input` is unpiped when
// this returns, so the caller can read off whatever is left of it.
export async function restoreBackup(client, input, { beforeWrite, onProgress } = {}) {
  const gunzip = createGunzip();
  // pipe() passes on neither an error nor an upload that stopped half way, and a reader waiting
  // on gunzip would then wait for ever with every table locked.
  const onInputError = err => gunzip.destroy(err);
  const onInputClose = () => { if (input.complete === false) gunzip.destroy(new Error('the upload was interrupted')); };
  input.on('error', onInputError);
  input.on('close', onInputClose);
  try {
    // An upload that ended before these listeners were attached has already had its last event.
    if (input.destroyed || input.readableAborted || input.errored) throw new BackupFileError('The upload was interrupted.');
    input.pipe(gunzip);
    return await restoreLines(client, lines(gunzip), { beforeWrite, onProgress });
  } finally {
    input.unpipe(gunzip);
    input.off('error', onInputError);
    input.off('close', onInputClose);
    gunzip.destroy();
  }
}

async function restoreLines(client, reader, { beforeWrite, onProgress }) {
  const nextLine = async () => {
    try {
      const { value, done } = await reader.next();
      return done ? null : value;
    } catch (err) {
      if (err instanceof BackupFileError) throw err;
      throw new BackupFileError(`The file could not be read as a MailFlow backup (${err.message}).`);
    }
  };

  const first = await nextLine();
  if (first === null) throw new BackupFileError('The file is empty.');
  const manifest = parseLine(first);
  checkManifest(manifest, await schemaVersion(client));

  const present = new Set(await listTables(client));
  for (const table of manifest.tables) {
    if (!RESTORABLE_TABLES.has(table) || !present.has(table)) {
      throw new BackupFileError(`The backup contains a table this installation does not have: ${table}.`);
    }
  }
  const { columns, sequences } = await listColumns(client);
  const standalone = new Set(await standaloneSequenceNames(client));
  const manifestTables = new Set(manifest.tables);
  const restoreSet = [...SETUP_TABLES, ...MAIL_CACHE_TABLES].filter(t => present.has(t));
  const inserted = Object.fromEntries(manifest.tables.map(t => [t, 0]));

  if (beforeWrite) await beforeWrite();
  await client.query('BEGIN');
  try {
    // A restore is one bulk operation, so the pool's per-statement limit does not apply; a lock
    // that stays busy for long is a real conflict, and reported instead of waited out.
    await client.query('SET LOCAL statement_timeout = 0');
    await client.query("SET LOCAL lock_timeout = '30s'");
    await client.query(`TRUNCATE ${restoreSet.map(ident).join(', ')} RESTART IDENTITY CASCADE`);

    let footer = null;
    for (let line = await nextLine(); line !== null; line = await nextLine()) {
      const entry = parseLine(line);
      if (footer) throw new BackupFileError('The backup file has data after its end marker.');
      if (entry.end === true) {
        footer = entry;
        continue;
      }
      if (typeof entry.table !== 'string' || !Array.isArray(entry.rows)) throw new BackupFileError('This is not a MailFlow backup file.');
      if (!manifestTables.has(entry.table)) throw new BackupFileError(`The backup file has rows for a table its manifest does not list: ${entry.table}.`);
      if (!entry.rows.length) continue;
      const rowColumns = Object.keys(entry.rows[0]);
      const shape = rowColumns.join('\n');
      for (const row of entry.rows) {
        if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).join('\n') !== shape) {
          throw new BackupFileError(`The backup file has malformed rows for ${entry.table}.`);
        }
      }
      // The schema versions matched, so a column this installation lacks means the file or the
      // database was changed by hand, and restoring around it would drop data unannounced.
      const known = new Map(columns.get(entry.table).map(c => [c.name, c]));
      const unknown = rowColumns.filter(c => !known.has(c));
      if (unknown.length) throw new BackupFileError(`The backup's ${entry.table} rows have columns this installation does not: ${unknown.join(', ')}.`);
      const cols = rowColumns.map(c => known.get(c));
      // A json or jsonb value travels as PostgreSQL's text for it, in a JSON string, and SQL NULL
      // as JSON null. json_populate_recordset hands such a column the JSON string itself, and
      // #>> '{}' unwraps the text inside, which the cast then reads exactly as it was written.
      const values = cols.map(c => (JSON_TYPES.has(c.type) ? `(${ident(c.name)} #>> '{}')::${c.type}` : ident(c.name)));
      // The rows keep their ids, so an identity column takes the file's value rather than a new one.
      const result = await client.query(
        `INSERT INTO ${ident(entry.table)} (${cols.map(c => ident(c.name)).join(', ')}) OVERRIDING SYSTEM VALUE
         SELECT ${values.join(', ')} FROM json_populate_recordset(NULL::${ident(entry.table)}, $1::json)`,
        [JSON.stringify(entry.rows)],
      );
      inserted[entry.table] += result.rowCount;
      if (onProgress) onProgress({ table: entry.table, rows: Object.values(inserted).reduce((a, b) => a + b, 0) });
    }
    if (!footer) throw new BackupFileError('The backup file ends early. Its download was probably interrupted.');
    if (!footer.rowCounts || typeof footer.rowCounts !== 'object') throw new BackupFileError('This is not a MailFlow backup file.');
    for (const [table, count] of Object.entries(footer.rowCounts)) {
      if (!manifestTables.has(table) || inserted[table] !== count) {
        throw new BackupFileError(`The backup file is inconsistent: ${table} should have ${count} rows, the file holds ${inserted[table] ?? 0}.`);
      }
    }
    for (const table of manifest.tables) {
      if (!(table in footer.rowCounts)) throw new BackupFileError(`The backup file has no row count for ${table}.`);
    }
    // ALTER SEQUENCE is undone by a rollback; setval would not be, and could leave a sequence
    // behind rows the rollback kept.
    for (const { table, column, sequence } of sequences) {
      if (!manifestTables.has(table)) continue;
      const { rows: [{ statement }] } = await client.query(
        `SELECT format('ALTER SEQUENCE %s RESTART WITH %s', $1::regclass, COALESCE(MAX(${ident(column)}), 0) + 1) AS statement FROM ${ident(table)}`,
        [sequence],
      );
      await client.query(statement);
    }
    // A standalone sequence only ever moves forward: rows restored from another server may carry
    // values from its sequence, and a value handed out here must still come after them.
    for (const [name, value] of Object.entries(manifest.sequences ?? {})) {
      if (!standalone.has(name)) continue;
      const here = await sequencePosition(client, name);
      const next = (BigInt(value) > here ? BigInt(value) : here) + 1n;
      await client.query(`ALTER SEQUENCE ${ident(name)} RESTART WITH ${next}`);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }

  return {
    scope: manifest.scope,
    tables: manifest.tables.length,
    rows: Object.values(inserted).reduce((a, b) => a + b, 0),
  };
}
