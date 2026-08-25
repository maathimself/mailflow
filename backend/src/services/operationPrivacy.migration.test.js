import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('../../migrations/0060_completed_operation_privacy.sql', import.meta.url),
  'utf8',
);

describe('completed provider payload privacy migration', () => {
  it('redacts existing completed send and forward payloads and enforces terminal cleanup', () => {
    const sendCleanup = migration.match(
      /UPDATE\s+send_operations[\s\S]*?WHERE\s+state\s*=\s*'completed'/i,
    )?.[0];
    const forwardCleanup = migration.match(
      /UPDATE\s+inbox_rule_forwards[\s\S]*?WHERE\s+status\s*=\s*'sent'/i,
    )?.[0];
    for (const field of [
      'message_id', 'sent_folder', 'sent_metadata', 'raw_message',
      'server_auto_saves', 'smtp_message', 'smtp_envelope',
      'prepared_payload_digest', 'source_snapshots',
    ]) {
      expect(sendCleanup).toMatch(new RegExp(`${field}\\s*=\\s*NULL`, 'i'));
    }
    for (const field of ['recipient', 'smtp_message', 'smtp_envelope', 'source_snapshot']) {
      expect(forwardCleanup).toMatch(new RegExp(`${field}\\s*=\\s*NULL`, 'i'));
    }
    expect(migration).toMatch(
      /CHECK\s*\([\s\S]*state\s*<>\s*'completed'[\s\S]*smtp_message\s+IS\s+NULL/i,
    );
    expect(migration).toMatch(
      /CHECK\s*\([\s\S]*status\s*<>\s*'sent'[\s\S]*source_snapshot\s+IS\s+NULL/i,
    );
  });
});
