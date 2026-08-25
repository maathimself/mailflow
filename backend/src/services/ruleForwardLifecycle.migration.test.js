import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('../../migrations/0058_rule_forward_lifecycle.sql', import.meta.url),
  'utf8',
);

describe('rule-forward lifecycle migration', () => {
  it('migrates legacy pending deliveries to fail-closed uncertainty', () => {
    expect(migration).toMatch(
      /UPDATE\s+inbox_rule_forwards\s+SET\s+status\s*=\s*'uncertain'\s+WHERE\s+status\s*=\s*'pending'/i,
    );
    expect(migration).not.toMatch(
      /UPDATE\s+inbox_rule_forwards\s+SET\s+status\s*=\s*'ready'\s+WHERE\s+status\s*=\s*'pending'/i,
    );
  });

  it('adds immutable prepared SMTP payload fields to new retryable forwards', () => {
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS recipient\s+TEXT/i);
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS payload_digest\s+CHAR\(64\)/i);
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS smtp_message\s+BYTEA/i);
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS smtp_envelope\s+JSONB/i);
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS source_snapshot\s+JSONB/i);
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS prepared_at\s+TIMESTAMPTZ/i);
  });
});
