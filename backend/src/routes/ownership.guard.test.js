import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join, relative } from 'path';
import { fileURLToPath } from 'url';
// ESLint's own parser (eslint is a dev dependency), so the check reads SQL from real string
// literals rather than guessing where a string starts in the source text.
import * as espree from 'espree';

// Routes look up an account, message, alias, contact or address book of the signed-in user
// through services/ownership.js, where each of those lookups is written once. This fails when a
// route file writes such a lookup by hand again: a SELECT on one of those tables that compares an
// id with a parameter and a user_id with a parameter, in any order, case, alias or schema, with
// casts, other conditions in between, or the user_id in a JOIN, subquery or EXISTS. Scoped writes
// (UPDATE/DELETE/INSERT) are not lookups and are not matched.
//
// It catches duplicated lookups, not missing ones: a query that forgets its user_id condition
// altogether looks like any other query and passes. SQL assembled at run time from fragments is
// not seen either.
//
// The exceptions below are lookups a shared helper would obscure; each names a fragment of its
// statement (lowercase, whitespace collapsed) and why it stays. An exception that no longer
// matches anything fails too, so the list cannot outlive what it excuses.
const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..');

const TABLES = { email_accounts: 'account', messages: 'message', account_aliases: 'alias', contacts: 'contact', address_books: 'address book', scheduled_messages: 'scheduled message' };
const NOT_ALIAS = new Set(['on', 'where', 'join', 'left', 'right', 'inner', 'outer', 'full', 'cross', 'natural', 'using', 'order', 'group', 'limit', 'offset', 'having', 'union', 'lateral', 'for', 'returning', 'set', 'window']);
const PARAM = String.raw`\$\d+(?:\s*::\s*\w+(?:\[\])?)?`;
const ID_VALUE = String.raw`(?:${PARAM}|any\s*\(\s*${PARAM}\s*\))`;
const ID_RE = new RegExp(String.raw`(?:\b(?:(\w+)\.)?id\s*=\s*${ID_VALUE})|(?:${PARAM}\s*=\s*(?:(\w+)\.)?id\b)`, 'g');
const USER_RE = new RegExp(String.raw`\b(?:\w+\.)?user_id\s*=\s*${PARAM}|${PARAM}\s*=\s*(?:\w+\.)?user_id\b`);
const TABLE_RE = /\b(?:from|join)\s+(?:"?\w+"?\.)?"?(\w+)"?(?:\s+(?:as\s+)?(\w+))?/g;

const EXCEPTIONS = [
  { file: 'routes/mail.js', near: 'u.preferences from messages m', reason: 'message body: joins users for the reader\'s preferences in the same read' },
  { file: 'routes/mail.js', near: 'm.id = $1 and a.user_id = $2 and m.is_deleted = false and ($3::uuid is null', reason: 'resolve-message: optional account filter on the legacy UUID fallback, mirroring the Message-ID lookup above it' },
  { file: 'routes/draft.js', near: "and m.is_deleted = false and m.folder = 'inbox'", reason: 'reply drafts: INBOX seed rows of enabled accounts for the thread walk' },
  { file: 'routes/draft.js', near: 'where id = any($1::uuid[]) and user_id = $2 and enabled = true', reason: 'reply drafts: the enabled accounts of the rows already found' },
  { file: 'routes/categories.js', near: "(u.preferences->>'categorizationenabled')", reason: 'recategorize: ownership and the categorization setting (account or user) in one condition' },
  { file: 'routes/carddav.js', near: 'where ab.id = $1 and ab.user_id = $2 and c.uid = $3', reason: 'CardDAV GET: a contact by vCard UID inside one of the user\'s books, in one read' },
];

// The kind of ownership lookup a SQL string is (account, message, ...), or null.
function ownershipLookup(rawSql) {
  const sql = rawSql.replace(/\s+/g, ' ').trim().toLowerCase();
  if (/^(update|delete|insert)\b/.test(sql) || !/\bselect\b/.test(sql) || !USER_RE.test(sql)) return null;
  const aliases = new Map();
  for (const [, table, alias] of sql.matchAll(TABLE_RE)) {
    if (!TABLES[table]) continue;
    aliases.set(table, table);
    if (alias && !NOT_ALIAS.has(alias)) aliases.set(alias, table);
  }
  if (!aliases.size) return null;
  const first = [...aliases.values()][0];
  for (const m of sql.matchAll(ID_RE)) {
    const alias = m[1] ?? m[2];
    if (!alias) return TABLES[first];
    if (aliases.has(alias)) return TABLES[aliases.get(alias)];
  }
  return null;
}

// Every string in a JS source: literals, template literals (an interpolation reads as $0) and
// + concatenations of them.
function sqlStrings(source) {
  const ast = espree.parse(source, { ecmaVersion: 'latest', sourceType: 'module', loc: true });
  const out = [];
  const text = node => {
    if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
    if (node.type === 'TemplateLiteral') return node.quasis.map(q => q.value.cooked ?? q.value.raw).join('$0');
    if (node.type === 'BinaryExpression' && node.operator === '+') {
      const l = text(node.left);
      const r = text(node.right);
      return l == null && r == null ? null : `${l ?? '$0'}${r ?? '$0'}`;
    }
    return null;
  };
  const walk = (node, parentIsConcat) => {
    if (!node || typeof node.type !== 'string') return;
    const isConcat = node.type === 'BinaryExpression' && node.operator === '+';
    if (!parentIsConcat) {
      const s = text(node);
      if (s != null) out.push({ sql: s, line: node.loc.start.line });
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'loc' || key === 'parent') continue;
      for (const child of Array.isArray(value) ? value : [value]) {
        if (child && typeof child.type === 'string') walk(child, isConcat && (key === 'left' || key === 'right'));
      }
    }
  };
  walk(ast, false);
  return out;
}

function routeFiles() {
  const routes = readdirSync(join(SRC, 'routes'))
    .filter(f => f.endsWith('.js') && !f.endsWith('.test.js'))
    .map(f => join(SRC, 'routes', f));
  const plugins = readdirSync(join(SRC, 'plugins'), { withFileTypes: true })
    .filter(d => d.isDirectory())
    .flatMap(d => readdirSync(join(SRC, 'plugins', d.name))
      .filter(f => f === 'routes.js')
      .map(f => join(SRC, 'plugins', d.name, f)));
  return [...routes, ...plugins];
}

describe('route ownership lookups', () => {
  it('go through services/ownership.js, apart from the documented exceptions', () => {
    const used = new Set();
    const stray = [];
    for (const path of routeFiles()) {
      const file = relative(SRC, path).split('\\').join('/');
      for (const { sql, line } of sqlStrings(readFileSync(path, 'utf8'))) {
        const kind = ownershipLookup(sql);
        if (!kind) continue;
        const flat = sql.replace(/\s+/g, ' ').toLowerCase();
        const exception = EXCEPTIONS.find(e => e.file === file && flat.includes(e.near));
        if (exception) used.add(exception);
        else stray.push(`${file}:${line} hand-written ${kind} ownership lookup; use services/ownership.js`);
      }
    }
    expect(stray).toEqual([]);
    expect(EXCEPTIONS.filter(e => !used.has(e)).map(e => `${e.file}: ${e.near}`)).toEqual([]);
  });
});

describe('the guard\'s matcher', () => {
  it.each([
    ['account', 'SELECT id FROM email_accounts WHERE id = $1 AND user_id = $2'],
    ['account', 'SELECT id FROM email_accounts WHERE user_id = $1 AND id = $2'],
    ['account', 'select * from email_accounts where id = $1 and user_id = $2'],
    ['account', 'SELECT * FROM email_accounts WHERE id = $1 AND enabled = true AND user_id = $2'],
    ['account', 'SELECT * FROM email_accounts WHERE id = $1::uuid AND user_id = $2'],
    ['account', 'SELECT * FROM public.email_accounts WHERE id = $1 AND user_id = $2'],
    ['account', 'SELECT * FROM "email_accounts" WHERE $1 = id AND $2 = user_id'],
    ['account', 'SELECT ea.id FROM email_accounts ea JOIN users u ON u.id = ea.user_id WHERE ea.id = $1 AND ea.user_id = $2'],
    ['account', 'SELECT * FROM email_accounts AS acc WHERE acc.id = ANY($1::uuid[]) AND acc.user_id = $2'],
    ['message', 'SELECT m.* FROM messages m JOIN email_accounts a ON m.account_id = a.id WHERE m.id = $1 AND a.user_id = $2'],
    ['message', 'SELECT m.* FROM messages m JOIN email_accounts ea ON ea.id = m.account_id WHERE ea.user_id = $2 AND m.id = $1'],
    ['message', 'SELECT msg.* FROM messages msg JOIN email_accounts acc ON acc.id = msg.account_id AND acc.user_id = $2 WHERE msg.id = $1'],
    ['message', 'SELECT * FROM messages WHERE id = $1 AND account_id IN (SELECT id FROM email_accounts WHERE user_id = $2)'],
    ['message', 'SELECT m.id FROM messages m WHERE m.id = $1 AND EXISTS (SELECT 1 FROM email_accounts a WHERE a.id = m.account_id AND a.user_id = $2)'],
    ['message', 'SELECT m.id FROM messages m JOIN email_accounts a ON a.id = m.account_id WHERE m.id = ANY($2::text[]) AND a.user_id = $1'],
    ['alias', 'SELECT a.id FROM account_aliases a JOIN email_accounts e ON a.account_id = e.id WHERE a.id = $1 AND e.user_id = $2'],
    ['contact', 'SELECT * FROM contacts WHERE id = $1 AND user_id = $2'],
    ['contact', 'SELECT k.* FROM contacts k WHERE k.user_id = $2 AND k.id = $1'],
    ['address book', 'SELECT * FROM address_books ab WHERE ab.id = $1 AND ab.user_id = $2'],
    ['scheduled message', 'SELECT status FROM scheduled_messages WHERE id = $1 AND user_id = $2 FOR UPDATE'],
  ])('finds a hand-written %s lookup: %s', (kind, sql) => {
    expect(ownershipLookup(sql)).toBe(kind);
  });

  it.each([
    'DELETE FROM email_accounts WHERE id = $1 AND user_id = $2',
    'UPDATE messages m SET is_read = true FROM email_accounts a WHERE m.id = $1 AND a.user_id = $2',
    'DELETE FROM inbox_rules WHERE id = $1 AND user_id = $2 RETURNING id',
    "UPDATE scheduled_messages SET status = 'cancelled' WHERE id = $1 AND user_id = $2 AND status = ANY($3) RETURNING id",
    'INSERT INTO contacts (id, user_id) SELECT $1, $2',
    'SELECT id FROM inbox_rules WHERE id = ANY($1::uuid[]) AND user_id = $2',
    'SELECT id FROM email_accounts WHERE user_id = $1 AND enabled = true',
    'SELECT id FROM email_accounts WHERE user_id = $1 AND email_address = $2',
    'SELECT * FROM email_accounts WHERE id = $1',
    'SELECT COUNT(*) FROM snoozed_messages sm JOIN email_accounts a ON a.id = sm.account_id AND a.user_id = $1',
    'SELECT username FROM users WHERE id = $1',
  ])('leaves alone what is not an ownership lookup: %s', (sql) => {
    expect(ownershipLookup(sql)).toBeNull();
  });

  it('reads SQL from literals, templates and concatenations, not from comments', () => {
    const found = sqlStrings([
      '// SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2',
      "const a = query('SELECT id FROM email_accounts ' + 'WHERE id = $1 AND user_id = $2');",
      'const b = query(`SELECT ${cols} FROM messages m JOIN email_accounts a ON a.id = m.account_id WHERE m.id = $1 AND a.user_id = $2`);',
    ].join('\n')).map(s => ownershipLookup(s.sql)).filter(Boolean);
    expect(found).toEqual(['account', 'message']);
  });
});
