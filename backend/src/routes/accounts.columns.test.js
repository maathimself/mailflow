import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => {
    req.session = { userId: 'user-1' };
    next();
  },
}));
vi.mock('../index.js', () => ({ imapManager: {} }));
vi.mock('../services/connectionPolicy.js', () => ({
  getConnectionPolicy: vi.fn().mockResolvedValue({
    allowPrivateHosts: false,
    allowInsecureTls: false,
    allowNonstandardPorts: false,
  }),
}));

import express from 'express';
import accountRoutes, { ACCOUNT_UPDATE_FIELDS, SAFE_FIELDS } from './accounts.js';
import { query } from '../services/db.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/accounts', accountRoutes);
  return app;
}

// Write-only credentials: the form sends them only when the user types a new one.
const WRITE_ONLY = new Set(['auth_pass', 'smtp_auth_pass']);

describe('GET /api/accounts columns', () => {
  let server;
  let base;

  beforeAll(async () => {
    await new Promise(resolve => {
      server = buildApp().listen(0, resolve);
    });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  beforeEach(() => {
    query.mockReset();
  });

  // The settings form is filled from GET and sends fields like trusted_authserv_id back on every
  // save. A column PUT can write but GET does not return goes back as empty, clearing it.
  it('selects every non-secret column that PUT can write', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    const response = await fetch(`${base}/api/accounts`);
    expect(response.status).toBe(200);

    const sql = query.mock.calls[0][0];
    const selected = sql.match(/SELECT\s+([\s\S]+?)\s+FROM\s+email_accounts/i)[1]
      .split(',')
      .map(c => c.trim());
    const missing = ACCOUNT_UPDATE_FIELDS.filter(f => !WRITE_ONLY.has(f) && !selected.includes(f));
    expect(missing).toEqual([]);
  });
});

const MIGRATIONS_DIR = new URL('../../migrations/', import.meta.url);
const TABLE_CONSTRAINT = /^(constraint|primary|unique|check|foreign|exclude)$/i;

// The email_accounts columns the migrations leave behind, read as mail.relocate.test.js reads
// messages: the baseline CREATE TABLE, then every ALTER TABLE ADD / DROP COLUMN in file order.
function accountColumnsFromMigrations() {
  const cols = new Set();
  const files = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = readFileSync(new URL(file, MIGRATIONS_DIR), 'utf8').replace(/--[^\n]*/g, '');
    const create = sql.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?email_accounts\s*\(([\s\S]*?)\n\);/i);
    if (create) {
      for (const line of create[1].split('\n')) {
        const name = line.trim().match(/^\w+/)?.[0];
        if (name && !TABLE_CONSTRAINT.test(name)) cols.add(name.toLowerCase());
      }
    }
    for (const [, body] of sql.matchAll(/ALTER\s+TABLE\s+email_accounts\s([^;]*);/gi)) {
      for (const [, op, name] of body.matchAll(/\b(ADD|DROP)\s+COLUMN\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(\w+)/gi)) {
        if (op.toUpperCase() === 'ADD') cols.add(name.toLowerCase());
        else cols.delete(name.toLowerCase());
      }
    }
  }
  return cols;
}

// The route tests mock the database, so a name that is not a column passes them all. In production
// it breaks GET /api/accounts for every user (SAFE_FIELDS) or every PUT that sends it (ACCOUNT_UPDATE_FIELDS).
describe('account field lists', () => {
  const schemaCols = accountColumnsFromMigrations();

  it('reads the email_accounts schema out of the migrations', () => {
    // Baseline CREATE TABLE, a single ALTER, the second clause of a multi-clause ALTER, and a
    // column added then dropped.
    for (const col of ['email_address', 'sender_name', 'auto_bcc_addresses']) {
      expect(schemaCols).toContain(col);
    }
    expect(schemaCols).not.toContain('gtd_folders');
  });

  it('names only real email_accounts columns', () => {
    const unknown = [...new Set([...SAFE_FIELDS, ...ACCOUNT_UPDATE_FIELDS])].filter(f => !schemaCols.has(f));
    expect(unknown).toEqual([]);
  });
});
