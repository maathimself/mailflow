import { describe, expect, it, vi } from 'vitest';
import { PassThrough, Readable } from 'stream';
import { gunzipSync, gzipSync } from 'zlib';
import { once } from 'events';
import { randomBytes } from 'crypto';
import { readdirSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import pg from 'pg';

// Like the real module: a value without the enc: prefix passes through decrypt() unchanged.
vi.mock('./encryption.js', () => ({
  encrypt: value => 'enc:' + value,
  decrypt: value => (typeof value === 'string' && value.startsWith('enc:') ? value.slice(4) : value),
  isEncrypted: value => typeof value === 'string' && value.startsWith('enc:'),
}));

import {
  BACKUP_FORMAT, BackupFileError, MAIL_CACHE_TABLES, SCHEMA_TABLES, SETUP_TABLES, TRANSIENT_TABLES,
  encodeValue, orderByForeignKeys, restoreBackup, writeBackup,
} from './backup.js';

const VERSION = '0061_message_bcc_addresses';
const KEY_CHECK = 'enc:mailflow-backup-key-check';

// The type OIDs PostgreSQL reports for the column types these tests use.
const OIDS = { text: 25, int8: 20, json: 114, jsonb: 3802, _jsonb: 3807 };

// Answers the catalog queries the service makes and serves cursor reads from `data`, which holds
// PostgreSQL's text for each value; like pg, a read hands it to the query's type parsers. Every
// statement is kept, with its parameters and per-query type parsers, so tests can assert on it.
function fakeClient({ tables, columns = {}, foreignKeys = [], version = VERSION, data = {}, standalone = [], failOn = null, onQuery = null } = {}) {
  const log = [];
  let cursor = null;
  return {
    log,
    statements: () => log.map(l => l.text),
    async query(q, params) {
      const text = typeof q === 'string' ? q : q.text;
      log.push({ text, params, types: typeof q === 'string' ? undefined : q.types });
      if (onQuery) onQuery(text);
      if (failOn && failOn.test(text)) throw new Error('boom');
      if (text.startsWith('SELECT table_name FROM information_schema.tables')) return { rows: tables.map(t => ({ table_name: t })) };
      if (text.includes('FROM information_schema.columns')) {
        return { rows: Object.entries(columns).flatMap(([table, cols]) => cols.map(c => {
          const col = typeof c === 'string' ? { name: c } : c;
          return { table_name: table, column_name: col.name, udt_name: col.type || 'text', sequence: col.sequence || null };
        })) };
      }
      if (text.includes("relkind = 'S'")) return { rows: standalone.map(q => ({ name: q.name })) };
      if (text.startsWith('SELECT last_value::text AS value FROM')) return { rows: [{ value: standalone.find(q => text.endsWith(`"${q.name}"`)).value }] };
      if (text.includes('FROM pg_constraint')) return { rows: foreignKeys };
      if (text.startsWith('SELECT version FROM schema_migrations')) return { rows: version ? [{ version }] : [] };
      if (text.startsWith("SELECT format('ALTER SEQUENCE")) return { rows: [{ statement: `ALTER SEQUENCE ${params[0]} RESTART WITH next` }] };
      if (text.startsWith('DECLARE backup_rows')) {
        const table = /FROM "([^"]+)"$/.exec(text)[1];
        const types = Object.fromEntries((columns[table] || []).map(c => (typeof c === 'string' ? [c, 'text'] : [c.name, c.type || 'text'])));
        cursor = { rows: data[table] || [], at: 0, types };
        return { rows: [] };
      }
      if (text.startsWith('FETCH ')) {
        const n = parseInt(text.split(' ')[1], 10);
        const rows = cursor.rows.slice(cursor.at, cursor.at + n);
        cursor.at += rows.length;
        const parsers = (typeof q === 'string' ? null : q.types) || pg.types;
        const parse = (column, value) => {
          if (value === null) return null;
          const oid = OIDS[cursor.types[column]];
          if (!oid) throw new Error(`No OID for the type of ${column}`);
          return parsers.getTypeParser(oid, 'text')(value);
        };
        return { rows: rows.map(row => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, parse(k, v)]))) };
      }
      if (text === 'CLOSE backup_rows') { cursor = null; return { rows: [] }; }
      if (text.startsWith('INSERT INTO')) return { rows: [], rowCount: JSON.parse(params[0]).length };
      return { rows: [], rowCount: 0 };
    },
  };
}

async function backupBytes(client, scope = 'setup') {
  const out = new PassThrough();
  const chunks = [];
  out.on('data', c => chunks.push(c));
  const result = await writeBackup(client, { scope, appVersion: '3.6.0', out });
  return { result, gz: Buffer.concat(chunks) };
}
async function backupLines(client, scope = 'setup') {
  const { result, gz } = await backupBytes(client, scope);
  return { result, gz, lines: gunzipSync(gz).toString('utf8').trim().split('\n').map(l => JSON.parse(l)) };
}

const manifest = (over = {}) => ({
  mailflow: 'backup', format: BACKUP_FORMAT, app: '3.6.0', scope: 'setup', createdAt: '2026-09-29T00:00:00.000Z',
  schemaVersion: VERSION, tables: ['users', 'email_accounts'], sequences: {}, keyCheck: KEY_CHECK, ...over,
});
const gz = entries => gzipSync(entries.map(e => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n') + '\n');
const file = entries => Readable.from([gz(entries)]);

const PRESENT = ['users', 'email_accounts', 'auth_events', 'messages', 'folders', 'plugin_data', 'schema_migrations', 'email_otp_tokens'];
const COLUMNS = {
  users: ['id', 'username', { name: 'preferences', type: 'jsonb' }, 'created_at'],
  email_accounts: ['id', 'user_id', 'name', { name: 'folder_mappings', type: 'jsonb' }],
  auth_events: [{ name: 'id', type: 'int8', sequence: 'public.auth_events_id_seq' }, 'event_type', 'blob'],
  messages: ['id', 'account_id', 'subject'],
  folders: ['id', 'account_id', 'path'],
  plugin_data: ['plugin_id', 'key', 'value'],
};
const fk = (child, parent) => ({ child, parent });
const FKS = [fk('email_accounts', 'users'), fk('messages', 'email_accounts'), fk('folders', 'email_accounts')];
const restoreClient = over => fakeClient({ tables: PRESENT, columns: COLUMNS, foreignKeys: FKS, ...over });
const inserts = client => client.log.filter(l => l.text.startsWith('INSERT INTO'));

describe('table classification', () => {
  it('covers every table the migrations leave behind, and nothing else', () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), '../../migrations');
    const live = new Set(SCHEMA_TABLES); // schema_migrations is created by migrations.js, not by SQL
    for (const name of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
      const sql = readFileSync(join(dir, name), 'utf8').replace(/--[^\n]*/g, '');
      const re = /\b(CREATE TABLE(?: IF NOT EXISTS)?|DROP TABLE(?: IF EXISTS)?|ALTER TABLE)\s+"?([a-z_]+)"?(?:\s+RENAME TO\s+"?([a-z_]+)"?)?/gi;
      for (const [, verb, table, renamedTo] of sql.matchAll(re)) {
        if (verb.startsWith('CREATE')) live.add(table.toLowerCase());
        else if (verb.startsWith('DROP')) live.delete(table.toLowerCase());
        else if (renamedTo) { live.delete(table.toLowerCase()); live.add(renamedTo.toLowerCase()); }
      }
    }
    const classified = [...SETUP_TABLES, ...MAIL_CACHE_TABLES, ...TRANSIENT_TABLES, ...SCHEMA_TABLES];
    expect(new Set(classified).size).toBe(classified.length);
    expect([...live].sort()).toEqual([...classified].sort());
  });
});

describe('orderByForeignKeys', () => {
  it('puts parents before children and is otherwise alphabetical', () => {
    expect(orderByForeignKeys(['messages', 'users', 'email_accounts', 'block_list'], FKS))
      .toEqual(['block_list', 'users', 'email_accounts', 'messages']);
  });
  it('ignores foreign keys to tables outside the set and self references', () => {
    expect(orderByForeignKeys(['folders', 'messages'], [...FKS, fk('folders', 'folders')])).toEqual(['folders', 'messages']);
  });
  it('refuses a cycle instead of guessing', () => {
    expect(() => orderByForeignKeys(['a', 'b'], [fk('a', 'b'), fk('b', 'a')])).toThrow(/cycle/);
  });
});

describe('encodeValue', () => {
  it('turns bytea and timestamps into text PostgreSQL reads back, and leaves the rest alone', () => {
    expect(encodeValue(Buffer.from([0, 255, 16]))).toBe('\\x00ff10');
    expect(encodeValue(new Date('2026-09-29T10:00:00.000Z'))).toBe('2026-09-29T10:00:00.000Z');
    expect(encodeValue(new Date(NaN))).toBeNull();
    expect(encodeValue([new Date('2026-01-01T00:00:00.000Z'), 'x'])).toEqual(['2026-01-01T00:00:00.000Z', 'x']);
    expect(encodeValue({ a: [1, null] })).toEqual({ a: [1, null] });
    expect(encodeValue('9007199254740993')).toBe('9007199254740993');
    expect(encodeValue(null)).toBeNull();
  });
});

describe('writeBackup', () => {
  const data = {
    users: [{ id: 'u1', username: 'ann', preferences: '{"theme": "dark"}', created_at: '2026-01-02 03:04:05.123456+00' }],
    email_accounts: [{ id: 'a1', user_id: 'u1', name: 'Work', folder_mappings: '{}' }, { id: 'a2', user_id: 'u1', name: 'Home', folder_mappings: null }],
    auth_events: [{ id: '7', event_type: 'login', blob: '\\x6869' }],
    messages: [{ id: 'm1', account_id: 'a1', subject: 'Hi' }],
    folders: [],
  };

  it('writes a manifest, the setup tables in foreign-key order, and a footer with the counts', async () => {
    // A sequence restarted by an earlier restore has not handed out a value yet; its position still counts.
    const client = restoreClient({ data, standalone: [{ name: 'folder_status_revision', value: '80123' }, { name: 'restarted_seq', value: '42' }] });
    const { result, lines } = await backupLines(client);
    expect(result).toEqual({ tables: 4, rows: 4 });
    const [head, ...rest] = lines;
    expect(head).toMatchObject({ mailflow: 'backup', format: BACKUP_FORMAT, app: '3.6.0', scope: 'setup', schemaVersion: VERSION, keyCheck: KEY_CHECK });
    expect(head.tables).toEqual(['auth_events', 'plugin_data', 'users', 'email_accounts']);
    expect(head.sequences).toEqual({ folder_status_revision: '80123', restarted_seq: '42' });
    expect(client.statements().filter(s => s.startsWith('SELECT last_value'))).toEqual([
      'SELECT last_value::text AS value FROM "folder_status_revision"',
      'SELECT last_value::text AS value FROM "restarted_seq"',
    ]);
    expect(rest.at(-1)).toEqual({ end: true, rowCounts: { auth_events: 1, plugin_data: 0, users: 1, email_accounts: 2 } });
    expect(rest.slice(0, -1)).toEqual([
      { table: 'auth_events', rows: data.auth_events },
      { table: 'users', rows: data.users },
      { table: 'email_accounts', rows: data.email_accounts },
    ]);
    const sql = client.statements();
    // Tables, foreign keys and columns are looked up first; every row is then read in one snapshot.
    expect(sql.indexOf('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')).toBe(3);
    expect(sql.find(s => s.includes('information_schema.columns'))).toContain("is_generated = 'NEVER'");
    expect(sql.filter(s => s.startsWith('DECLARE'))).toEqual([
      'DECLARE backup_rows NO SCROLL CURSOR FOR SELECT "id", "event_type", "blob" FROM "auth_events"',
      'DECLARE backup_rows NO SCROLL CURSOR FOR SELECT "plugin_id", "key", "value" FROM "plugin_data"',
      'DECLARE backup_rows NO SCROLL CURSOR FOR SELECT "id", "username", "preferences", "created_at" FROM "users"',
      'DECLARE backup_rows NO SCROLL CURSOR FOR SELECT "id", "user_id", "name", "folder_mappings" FROM "email_accounts"',
    ]);
    expect(sql.at(-1)).toBe('COMMIT');
    expect(sql).not.toContain('ROLLBACK');
  });

  it('reads timestamps, numbers, bytea and JSON as PostgreSQL text', async () => {
    const client = restoreClient({ data });
    await backupLines(client);
    const { types } = client.log.find(l => l.text.startsWith('FETCH'));
    for (const oid of [17, 20, 700, 701, 1082, 1114, 1184, 1700, 1185, 1231, 114, 199, 3802, 3807]) {
      expect(types.getTypeParser(oid, 'text')('text as is')).toBe('text as is');
    }
    expect(types.getTypeParser(1009, 'text')('{a,b}')).toEqual(['a', 'b']);
  });

  it('keeps a JSON null apart from SQL NULL, and JSON exactly as PostgreSQL wrote it, through a backup and a restore', async () => {
    // As reported on #526: token_counts = 'null'::jsonb came back as SQL NULL, and 2.50 as 2.5.
    const columns = { ...COLUMNS, email_accounts: ['id', 'user_id', 'name', { name: 'folder_mappings', type: 'jsonb' }, { name: 'raw', type: 'json' }, { name: 'history', type: '_jsonb' }] };
    const accounts = [
      { id: 'a1', user_id: 'u1', name: 'JSON null', folder_mappings: 'null', raw: '{"a":1,  "a":2}', history: '{"null",NULL}' },
      { id: 'a2', user_id: 'u1', name: 'SQL NULL', folder_mappings: null, raw: null, history: null },
      { id: 'a3', user_id: 'u1', name: 'Exact', folder_mappings: '{"big": 123456789012345678901234567890, "price": 2.50}', raw: '"text"', history: '{}' },
    ];
    const { gz: backup, lines } = await backupLines(restoreClient({ columns, data: { ...data, email_accounts: accounts } }));
    expect(lines.find(l => l.table === 'email_accounts').rows).toEqual(accounts);

    const target = restoreClient({ columns });
    await restoreBackup(target, Readable.from([backup]));
    const insert = inserts(target).find(l => l.text.startsWith('INSERT INTO "email_accounts"'));
    // json and jsonb come out of the JSON string as the text PostgreSQL wrote; an array of jsonb is
    // array text the column's own input function reads.
    expect(insert.text.replace(/\s+/g, ' ')).toBe('INSERT INTO "email_accounts" ("id", "user_id", "name", "folder_mappings", "raw", "history") OVERRIDING SYSTEM VALUE'
      + ' SELECT "id", "user_id", "name", ("folder_mappings" #>> \'{}\')::jsonb, ("raw" #>> \'{}\')::json, "history" FROM json_populate_recordset(NULL::"email_accounts", $1::json)');
    expect(JSON.parse(insert.params[0])).toEqual(accounts);
  });

  it('adds the mail cache to a full backup, after the tables it references', async () => {
    const { lines } = await backupLines(restoreClient({ data }), 'full');
    expect(lines[0].scope).toBe('full');
    expect(lines[0].tables).toEqual(['auth_events', 'plugin_data', 'users', 'email_accounts', 'folders', 'messages']);
    expect(lines.at(-1).rowCounts).toEqual({ auth_events: 1, plugin_data: 0, users: 1, email_accounts: 2, folders: 0, messages: 1 });
  });

  it('reads a large table in several fetches and splits its rows over several lines', async () => {
    const big = 'x'.repeat(900 * 1024);
    const many = { ...data, users: Array.from({ length: 1200 }, (_, i) => ({ id: `u${i}`, username: `user${i}`, preferences: '{}', created_at: null })),
      plugin_data: [0, 1, 2].map(i => ({ plugin_id: 'gtd', key: `k${i}`, value: big })) };
    const client = restoreClient({ data: many });
    const { lines } = await backupLines(client);
    expect(client.statements().filter(s => s.startsWith('FETCH'))).toHaveLength(4 + 2 + 2 + 2);
    expect(lines.filter(l => l.table === 'users').map(l => l.rows.length)).toEqual([1200]);
    // A line closes before the row that would take it past 2 MiB, so a large row stands alone.
    expect(lines.filter(l => l.table === 'plugin_data').map(l => l.rows.length)).toEqual([2, 1]);
    const huge = { ...many, plugin_data: [0, 1, 2].map(i => ({ plugin_id: 'gtd', key: `k${i}`, value: 'y'.repeat(1500 * 1024) })) };
    const split = await backupLines(restoreClient({ data: huge }));
    expect(split.lines.filter(l => l.table === 'plugin_data').map(l => l.rows.length)).toEqual([1, 1, 1]);
    for (const line of gunzipSync(split.gz).toString('utf8').split('\n')) expect(line.length).toBeLessThan(1600 * 1024);

    // And the restore takes it all back in, line by line.
    const target = restoreClient();
    const result = await restoreBackup(target, Readable.from([split.gz]));
    expect(result.rows).toBe(1200 + 3 + 1 + 2);
    expect(inserts(target).filter(l => l.text.startsWith('INSERT INTO "plugin_data"'))).toHaveLength(3);
  });

  it('refuses to run when a table the migrations created has no classification', async () => {
    const client = restoreClient({ tables: [...PRESENT, 'brand_new_table'], data });
    await expect(writeBackup(client, { scope: 'setup', appVersion: '3.6.0', out: new PassThrough() })).rejects.toThrow(/brand_new_table/);
    expect(client.statements()).not.toContain('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  });

  it('rolls the read transaction back and stops when the download goes away', async () => {
    const out = new PassThrough();
    out.on('data', () => {});
    // The browser cancels while the users table is being read.
    const client = restoreClient({ data, onQuery: text => { if (text.startsWith('DECLARE') && text.includes('"users"')) out.destroy(); } });
    await expect(writeBackup(client, { scope: 'setup', appVersion: '3.6.0', out })).rejects.toThrow(/interrupted/);
    const sql = client.statements();
    expect(sql).toContain('ROLLBACK');
    expect(sql).not.toContain('COMMIT');
    expect(sql.some(s => s.includes('"email_accounts"'))).toBe(false);
  });
});

describe('restoreBackup', () => {
  const rows = [
    manifest(),
    { table: 'users', rows: [{ id: 'u1', username: 'ann', preferences: '{"a": 1}' }] },
    { table: 'email_accounts', rows: [{ id: 'a1', user_id: 'u1', name: 'Work', folder_mappings: null }, { id: 'a2', user_id: 'u1', name: 'Home', folder_mappings: 'null' }] },
    { end: true, rowCounts: { users: 1, email_accounts: 2 } },
  ];

  it('checks the file, truncates every restorable table, inserts each batch through json_populate_recordset and commits', async () => {
    const client = restoreClient();
    const order = [];
    const result = await restoreBackup(client, file(rows), {
      beforeWrite: async () => order.push('beforeWrite:' + client.statements().length),
      onProgress: p => order.push(`progress:${p.table}:${p.rows}`),
    });
    expect(result).toEqual({ scope: 'setup', tables: 2, rows: 3 });
    // The version, table, column and sequence lookups run before the file is accepted; nothing else does.
    expect(order).toEqual(['beforeWrite:4', 'progress:users:1', 'progress:email_accounts:3']);
    const sql = client.statements();
    const begin = sql.indexOf('BEGIN');
    expect(begin).toBe(4);
    expect(sql.slice(begin).map(s => s.replace(/\s+/g, ' '))).toEqual([
      'BEGIN',
      'SET LOCAL statement_timeout = 0',
      "SET LOCAL lock_timeout = '30s'",
      'TRUNCATE "auth_events", "email_accounts", "plugin_data", "users", "folders", "messages" RESTART IDENTITY CASCADE',
      // A jsonb value is the text inside its JSON string, so a JSON null ('null') and SQL NULL
      // (null) each go back as what they were.
      'INSERT INTO "users" ("id", "username", "preferences") OVERRIDING SYSTEM VALUE SELECT "id", "username", ("preferences" #>> \'{}\')::jsonb FROM json_populate_recordset(NULL::"users", $1::json)',
      'INSERT INTO "email_accounts" ("id", "user_id", "name", "folder_mappings") OVERRIDING SYSTEM VALUE SELECT "id", "user_id", "name", ("folder_mappings" #>> \'{}\')::jsonb FROM json_populate_recordset(NULL::"email_accounts", $1::json)',
      'COMMIT',
    ]);
    expect(inserts(client)[0].params).toEqual([JSON.stringify(rows[1].rows)]);
  });

  it('keeps text intact when a multi-byte character straddles two gunzip chunks', async () => {
    const name = '€'.repeat(20000); // 60 KB of three-byte characters: several 16 KiB chunk boundaries fall inside one
    const client = restoreClient();
    await restoreBackup(client, file([
      manifest({ tables: ['users'] }),
      { table: 'users', rows: [{ id: 'u1', username: name, preferences: '{}' }] },
      { end: true, rowCounts: { users: 1 } },
    ]));
    expect(JSON.parse(inserts(client)[0].params[0])[0].username).toBe(name);
  });

  it('restarts the sequence of a restored table after its highest id, in a way a rollback undoes', async () => {
    const client = restoreClient();
    await restoreBackup(client, file([
      manifest({ tables: ['auth_events'] }),
      { table: 'auth_events', rows: [{ id: 7, event_type: 'login' }] },
      { end: true, rowCounts: { auth_events: 1 } },
    ]));
    const at = client.log.findIndex(l => l.text.startsWith("SELECT format('ALTER SEQUENCE"));
    expect(client.log[at].text).toMatch(/COALESCE\(MAX\("id"\), 0\) \+ 1\) AS statement FROM "auth_events"$/);
    expect(client.log[at].params).toEqual(['public.auth_events_id_seq']);
    expect(client.log[at + 1].text).toBe('ALTER SEQUENCE public.auth_events_id_seq RESTART WITH next');
    expect(client.statements().some(s => s.includes('setval'))).toBe(false);
    expect(client.statements().at(-1)).toBe('COMMIT');
  });

  it('moves a standalone sequence forward past the position in the file, never back', async () => {
    const behind = restoreClient({ standalone: [{ name: 'folder_status_revision', value: '12' }] });
    await restoreBackup(behind, file([manifest({ sequences: { folder_status_revision: '80123', gone_seq: '5' } }), rows[1], rows[2], rows[3]]));
    expect(behind.statements().filter(s => s.startsWith('ALTER SEQUENCE "'))).toEqual(['ALTER SEQUENCE "folder_status_revision" RESTART WITH 80124']);
    const ahead = restoreClient({ standalone: [{ name: 'folder_status_revision', value: '90000' }] });
    await restoreBackup(ahead, file([manifest({ sequences: { folder_status_revision: '80123' } }), rows[1], rows[2], rows[3]]));
    expect(ahead.statements().filter(s => s.startsWith('ALTER SEQUENCE "'))).toEqual(['ALTER SEQUENCE "folder_status_revision" RESTART WITH 90001']);
  });

  it('leaves the sequences of tables the file does not carry alone', async () => {
    const client = restoreClient();
    await restoreBackup(client, file(rows));
    expect(client.statements().some(s => s.includes('ALTER SEQUENCE'))).toBe(false);
  });

  it('restores the mail cache from a full backup', async () => {
    const client = restoreClient();
    await restoreBackup(client, file([
      manifest({ scope: 'full', tables: ['users', 'email_accounts', 'folders', 'messages'] }),
      rows[1], rows[2],
      { table: 'folders', rows: [{ id: 'f1', account_id: 'a1', path: 'INBOX' }] },
      { table: 'messages', rows: [{ id: 'm1', account_id: 'a1', subject: 'Hi' }, { id: 'm2', account_id: 'a1', subject: 'Yo' }] },
      { end: true, rowCounts: { users: 1, email_accounts: 2, folders: 1, messages: 2 } },
    ]));
    expect(inserts(client).map(l => /^INSERT INTO "([^"]+)"/.exec(l.text)[1])).toEqual(['users', 'email_accounts', 'folders', 'messages']);
  });

  it('gives up at once on an upload that ended before it began reading', async () => {
    const input = new PassThrough();
    input.destroy();
    const client = restoreClient();
    await expect(restoreBackup(client, input)).rejects.toThrow(/interrupted/);
    expect(client.statements()).toEqual([]);
  });

  it.each([
    ['a file that is not gzip', () => Readable.from([Buffer.from('plain text')]), /could not be read/],
    ['a gzip that is not JSON lines', () => file(['not json']), /not a MailFlow backup/],
    ['an empty file', () => file([]), /empty/],
    ['a newer file format', () => file([manifest({ format: BACKUP_FORMAT + 1 })]), /newer version/],
    // Format 1 carried json and jsonb parsed, where a JSON null had already become SQL NULL.
    ['the first file format', () => file([manifest({ format: 1 })]), /earlier file format/],
    ['a newer schema', () => file([manifest({ schemaVersion: '0999_future' })]), /newer version of MailFlow \(3\.6\.0\)\. Update MailFlow/],
    // An update converts existing data as it migrates, so an older backup belongs on its own version.
    ['an older schema', () => file([manifest({ schemaVersion: '0040_older' })]), /older version of MailFlow \(3\.6\.0\)\. Restore it on that version, then update/],
    ['an older schema from an unnamed version', () => file([manifest({ schemaVersion: '0040_older', app: '<b>odd</b>' })]), /older version of MailFlow\. Restore/],
    ['a different ENCRYPTION_KEY', () => file([manifest({ keyCheck: 'enc:something-else' })]), /different ENCRYPTION_KEY/],
    ['a key check that was never encrypted', () => file([manifest({ keyCheck: 'mailflow-backup-key-check' })]), /different ENCRYPTION_KEY/],
    ['a manifest without a key check', () => file([manifest({ keyCheck: undefined })]), /not a MailFlow backup/],
    ['malformed sequence positions', () => file([manifest({ sequences: { folder_status_revision: 'abc' } })]), /not a MailFlow backup/],
    ['a table this installation does not have', () => file([manifest({ tables: ['users', 'old_table'] })]), /does not have: old_table/],
    ['a table that is never restored', () => file([manifest({ tables: ['schema_migrations'] })]), /does not have: schema_migrations/],
    ['a manifest without a table list', () => file([manifest({ tables: 'users' })]), /not a MailFlow backup/],
  ])('rejects %s before touching the database', async (_label, input, message) => {
    const client = restoreClient();
    const beforeWrite = vi.fn();
    await expect(restoreBackup(client, input(), { beforeWrite })).rejects.toThrow(BackupFileError);
    await expect(restoreBackup(restoreClient(), input())).rejects.toThrow(message);
    expect(beforeWrite).not.toHaveBeenCalled();
    expect(client.statements()).not.toContain('BEGIN');
  });

  it('lets the caller read off the rest of an upload it refused, instead of leaving it stuck behind gunzip', async () => {
    const input = new PassThrough();
    // Random text barely compresses, so most of the upload is still unread when the manifest is refused.
    const filler = Array.from({ length: 60 }, (_, i) => ({ table: 'users', rows: [{ id: `u${i}`, username: randomBytes(30000).toString('base64'), preferences: '{}' }] }));
    // Written in socket-sized pieces, so backpressure can hold the rest back.
    const body = gz([manifest({ schemaVersion: '0999_future' }), ...filler, { end: true, rowCounts: { users: 60 } }]);
    for (let at = 0; at < body.length; at += 16384) input.write(body.subarray(at, at + 16384));
    input.end();
    await expect(restoreBackup(restoreClient(), input)).rejects.toThrow(/newer version/);
    expect(input.readableEnded).toBe(false);
    input.resume();
    await once(input, 'end');
  });

  it('gives up with a rollback when the upload stops half way, instead of waiting on it for ever', async () => {
    const whole = gz([manifest({ tables: ['users'] }),
      ...Array.from({ length: 40 }, (_, i) => ({ table: 'users', rows: [{ id: `u${i}`, username: `${i} ${'w'.repeat(3000)}`, preferences: '{}' }] })),
      { end: true, rowCounts: { users: 40 } }]);
    const input = new PassThrough();
    input.complete = false; // as on an http.IncomingMessage whose client went away
    const client = restoreClient({ onQuery: text => { if (text.startsWith('INSERT')) setImmediate(() => input.destroy()); } });
    input.write(whole.subarray(0, Math.floor(whole.length / 2)));
    await expect(restoreBackup(client, input)).rejects.toThrow(/interrupted/);
    expect(client.statements()).toContain('ROLLBACK');
    expect(client.statements()).not.toContain('COMMIT');
  });

  it.each([
    ['rows for a table the manifest does not list', [manifest(), { table: 'auth_events', rows: [{ id: 1 }] }, { end: true, rowCounts: { users: 0, email_accounts: 0 } }], /manifest does not list: auth_events/],
    ['no end marker', [manifest(), rows[1]], /ends early/],
    ['a row count that does not match', [manifest(), rows[1], rows[2], { end: true, rowCounts: { users: 2, email_accounts: 2 } }], /users should have 2 rows, the file holds 1/],
    ['a count for an unlisted table', [manifest(), rows[1], rows[2], { end: true, rowCounts: { users: 1, email_accounts: 2, folders: 0 } }], /inconsistent/],
    ['a table with no count', [manifest(), rows[1], rows[2], { end: true, rowCounts: { users: 1 } }], /no row count for email_accounts/],
    ['data after the end marker', [...rows, rows[1]], /after its end marker/],
    ['rows of different shapes in one batch', [manifest({ tables: ['users'] }), { table: 'users', rows: [{ id: 'u1', username: 'a' }, { username: 'b' }] }, { end: true, rowCounts: { users: 2 } }], /malformed rows for users/],
    // With the schema versions equal, a column the database lacks means one of the two was changed by hand.
    ['a column this installation does not have', [manifest({ tables: ['users'] }), { table: 'users', rows: [{ id: 'u1', username: 'a', gone: 1, preferences: '{}' }] }, { end: true, rowCounts: { users: 1 } }], /users rows have columns this installation does not: gone/],
    ['a stream cut off in the middle', null, /could not be read/],
  ])('rolls back on %s', async (_label, entries, message) => {
    const client = restoreClient();
    // The cut file is a large one: it ends after the manifest and part of the rows went in.
    const big = [manifest({ tables: ['users'] }), ...Array.from({ length: 40 }, (_, i) => ({ table: 'users', rows: Array.from({ length: 50 }, (_, j) => ({ id: `u${i}-${j}`, username: `user ${i} ${j} ${'x'.repeat(40)}`, preferences: '{}' })) })), { end: true, rowCounts: { users: 2000 } }];
    const cut = gz(big);
    const input = entries ? file(entries) : Readable.from([cut.subarray(0, Math.floor(cut.length / 2))]);
    await expect(restoreBackup(client, input)).rejects.toThrow(message);
    const sql = client.statements();
    expect(sql).toContain('BEGIN');
    expect(sql).toContain('ROLLBACK');
    expect(sql).not.toContain('COMMIT');
  });

  it('rolls back and passes a database error through as a plain error', async () => {
    const client = restoreClient({ failOn: /^INSERT INTO "email_accounts"/ });
    await expect(restoreBackup(client, file(rows))).rejects.toThrow('boom');
    await expect(restoreBackup(restoreClient({ failOn: /^INSERT/ }), file(rows))).rejects.not.toBeInstanceOf(BackupFileError);
    const sql = client.statements();
    expect(sql.filter(s => s.startsWith('INSERT'))).toHaveLength(2);
    expect(sql.at(-1)).toBe('ROLLBACK');
  });
});
