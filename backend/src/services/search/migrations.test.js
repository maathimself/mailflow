import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { searchFtsExpr, FTS_VERSION } from './lexicalRepo.js';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../../migrations');
const read = (f) => readFileSync(join(MIGRATIONS, f), 'utf8');
const norm = (s) => s.replace(/\s+/g, ' ').trim();

describe('0035_search_fts.sql', () => {
  const sql = read('0035_search_fts.sql');

  it('is transactional (no no-transaction header — the $$ body cannot survive the ; splitter)', () => {
    expect(/^--\s*no-transaction/im.test(sql)).toBe(false);
  });

  it('adds nullable search_fts + fts_version with IF NOT EXISTS (fast metadata DDL, D1)', () => {
    expect(norm(sql)).toContain('ADD COLUMN IF NOT EXISTS search_fts tsvector');
    expect(norm(sql)).toContain('ADD COLUMN IF NOT EXISTS fts_version int');
    expect(sql).not.toContain('GENERATED ALWAYS AS'); // D1: not a generated column
  });

  it('installs a BEFORE INSERT OR UPDATE trigger whose body equals searchFtsExpr(NEW)', () => {
    expect(norm(sql)).toContain('BEFORE INSERT OR UPDATE ON messages');
    expect(norm(sql)).toContain(norm(searchFtsExpr('NEW')));
    expect(norm(sql)).toContain(`NEW.fts_version := ${FTS_VERSION}`);
  });

  it('handles the oversized-tsvector case gracefully (never fails the row write)', () => {
    expect(sql).toContain('EXCEPTION WHEN program_limit_exceeded');
  });

  it('skips recompute only on columns that actually feed searchFtsExpr — snippet is not one of them', () => {
    // snippet isn't part of the weighted A/B/C/D expression (subject, from,
    // to/cc, body_text), so guarding on it made a snippet-only UPDATE (e.g.
    // read/star-adjacent metadata writes that also touch snippet) recompute
    // an identical search_fts for nothing.
    expect(sql).toContain('NEW.subject      IS NOT DISTINCT FROM OLD.subject');
    expect(sql).toContain('NEW.from_name    IS NOT DISTINCT FROM OLD.from_name');
    expect(sql).toContain('NEW.from_email   IS NOT DISTINCT FROM OLD.from_email');
    expect(sql).toContain('NEW.to_addresses IS NOT DISTINCT FROM OLD.to_addresses');
    expect(sql).toContain('NEW.cc_addresses IS NOT DISTINCT FROM OLD.cc_addresses');
    expect(sql).toContain('NEW.body_text    IS NOT DISTINCT FROM OLD.body_text');
    expect(sql).not.toContain('OLD.snippet');
    expect(sql).not.toContain('NEW.snippet');
  });
});

describe('0037_search_fts_index.sql', () => {
  const sql = read('0037_search_fts_index.sql');

  it('runs outside a transaction and builds both indexes CONCURRENTLY', () => {
    expect(/^--\s*no-transaction/im.test(sql)).toBe(true);
    expect(sql).toContain('CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_search_fts');
    expect(sql).toContain('USING GIN (search_fts)');
    expect(sql).toContain('idx_messages_fts_stale_v1');
    expect(sql).toContain(`WHERE fts_version IS DISTINCT FROM ${FTS_VERSION}`);
    expect(sql).not.toContain('$$'); // no function bodies — safe for the ; splitter
  });

  // A cancelled/crashed CREATE INDEX CONCURRENTLY leaves an INVALID index under the
  // target name; retrying with IF NOT EXISTS silently skips it, so the scan stays
  // unindexed forever. Drop-if-exists before each create makes the retry crash-idempotent.
  it('drops each index CONCURRENTLY before creating it (invalid-index retry hazard)', () => {
    for (const name of ['idx_messages_search_fts', 'idx_messages_fts_stale_v1']) {
      expect(sql).toContain(`DROP INDEX CONCURRENTLY IF EXISTS ${name}`);
      expect(sql.indexOf(`DROP INDEX CONCURRENTLY IF EXISTS ${name}`))
        .toBeLessThan(sql.indexOf(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${name}`));
    }
  });
});
