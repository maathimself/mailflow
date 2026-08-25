import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('../../migrations/0053_provider_operations.sql', import.meta.url),
  'utf8',
);
const topologyMigration = readFileSync(
  new URL('../../migrations/0052_folder_observation_generation.sql', import.meta.url),
  'utf8',
);

describe('provider operations migration', () => {
  it('stores monotonic intent, ownership, uncertainty, observations, and receipt data', () => {
    expect(migration).toMatch(/CREATE TABLE provider_operations/i);
    expect(migration).toMatch(/operation_key\s+TEXT\s+NOT NULL\s+UNIQUE/i);
    expect(migration).toMatch(/state\s+TEXT\s+NOT NULL/i);
    expect(migration).toMatch(/provider_started/i);
    expect(migration).toMatch(/provider_applied/i);
    expect(migration).toMatch(/completed/i);
    expect(migration).toMatch(/manual_intervention/i);
    expect(migration).toMatch(/attempt_generation\s+BIGINT\s+NOT NULL/i);
    expect(migration).toMatch(/attempt_owner\s+UUID/i);
    expect(migration).toMatch(/marker\s+TEXT\s+NOT NULL\s+UNIQUE/i);
    expect(migration).toMatch(/source_observation\s+JSONB/i);
    expect(migration).toMatch(/destination_observation\s+JSONB/i);
    expect(migration).toMatch(/receipt\s+JSONB/i);
    expect(migration).toMatch(/uncertainty\s+JSONB/i);
  });

  it('gives snooze wakeup an exact message-row identity', () => {
    expect(topologyMigration).toMatch(/ALTER TABLE snoozed_messages[\s\S]*message_row_id\s+UUID/i);
    expect(topologyMigration).toMatch(/REFERENCES messages\s*\(id\)/i);
    expect(topologyMigration).toMatch(/REFERENCES messages\s*\(id\)\s+ON DELETE SET NULL/i);
    expect(topologyMigration).not.toMatch(/message_row_id[\s\S]{0,100}ON DELETE CASCADE/i);
    expect(topologyMigration).toMatch(/UPDATE\s+snoozed_messages[\s\S]*SET\s+message_row_id/i);
    expect(topologyMigration).not.toMatch(/MIN\s*\(\s*m\.id\s*\)/i);
    expect(topologyMigration).toMatch(/COUNT\s*\(\*\)\s+OVER\s*\(\s*PARTITION BY\s+sm\.id\s*\)/i);
    expect(topologyMigration).toMatch(/m\.metadata_complete\s*=\s*true/i);
    expect(topologyMigration).toMatch(/JOIN\s+folders\s+f[\s\S]*f\.is_present\s*=\s*true[\s\S]*f\.uid_validity\s+IS\s+NOT\s+NULL/i);

    const bindLegacySnoozes = topologyMigration.search(/UPDATE\s+snoozed_messages\s+sm/i);
    const quarantineFolders = topologyMigration.search(/UPDATE\s+folders\s+SET\s+is_present\s*=\s*false/i);
    expect(bindLegacySnoozes).toBeGreaterThan(-1);
    expect(quarantineFolders).toBeGreaterThan(bindLegacySnoozes);
    expect(migration).not.toMatch(/UPDATE\s+snoozed_messages\s+sm[\s\S]*SET\s+message_row_id/i);
  });

  it('preserves active and manual snoozes when their correlated message is later deleted', () => {
    expect(topologyMigration).toMatch(/message_row_id\s+UUID[\s\S]{0,100}ON DELETE SET NULL/i);
  });

  it('retains ambiguous and null legacy snoozes for manual reconciliation', () => {
    expect(topologyMigration).not.toMatch(/DELETE\s+FROM\s+snoozed_messages/i);
  });

  it('persists a manual state that orphan cleanup cannot consume', () => {
    expect(topologyMigration).toMatch(/resolution_state\s+TEXT\s+NOT\s+NULL\s+DEFAULT\s+'active'/i);
    expect(topologyMigration).toMatch(/manual_intervention/i);
  });
});
