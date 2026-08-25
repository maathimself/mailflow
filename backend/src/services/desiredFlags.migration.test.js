import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('../../migrations/0054_desired_message_flags.sql', import.meta.url),
  'utf8',
);

describe('desired message flags migration', () => {
  it('adds independent monotonic read and star revisions to every message row', () => {
    expect(migration).toMatch(/ALTER TABLE messages[\s\S]*read_revision\s+BIGINT\s+NOT NULL\s+DEFAULT\s+0/i);
    expect(migration).toMatch(/ALTER TABLE messages[\s\S]*star_revision\s+BIGINT\s+NOT NULL\s+DEFAULT\s+0/i);
    expect(migration).toMatch(/provider_modseq\s+NUMERIC\s*\(\s*20\s*,\s*0\s*\)/i);
  });

  it('persists one checked delivery record for each exact row and logical flag', () => {
    expect(migration).toMatch(/CREATE TABLE message_flag_deliveries/i);
    expect(migration).toMatch(/message_id\s+UUID\s+NOT NULL\s+REFERENCES messages\s*\(id\)\s+ON DELETE CASCADE/i);
    expect(migration).toMatch(/flag\s+TEXT\s+NOT NULL[\s\S]*CHECK\s*\(\s*flag\s+IN\s*\(\s*'read'\s*,\s*'star'\s*\)\s*\)/i);
    expect(migration).toMatch(/PRIMARY KEY\s*\(\s*message_id\s*,\s*flag\s*\)/i);
    expect(migration).toMatch(/revision\s+BIGINT\s+NOT NULL/i);
    expect(migration).toMatch(/desired_value\s+BOOLEAN\s+NOT NULL/i);
    expect(migration).toMatch(/uid_validity\s+BIGINT\s+NOT NULL/i);
    expect(migration).toMatch(/folder_generation\s+BIGINT\s+NOT NULL/i);
  });

  it('retains ownership, provider baseline, and predecessor uncertainty across restarts', () => {
    expect(migration).toMatch(/attempt_generation\s+BIGINT\s+NOT NULL/i);
    expect(migration).toMatch(/attempt_owner\s+UUID/i);
    expect(migration).toMatch(/captured_modseq\s+NUMERIC\s*\(\s*20\s*,\s*0\s*\)/i);
    expect(migration).toMatch(/uncertainty_tombstones\s+JSONB\s+NOT NULL\s+DEFAULT\s+'\[\]'/i);
    expect(migration).toMatch(/state\s+TEXT\s+NOT NULL[\s\S]*pending[\s\S]*delivering[\s\S]*uncertain[\s\S]*confirmed/i);
  });
});
