import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('../../migrations/0057_send_operations.sql', import.meta.url),
  'utf8',
);

describe('send operations migration', () => {
  it('persists an integrity-bound SMTP payload and its source snapshots before provider start', () => {
    expect(migration).toMatch(/smtp_message\s+BYTEA/i);
    expect(migration).toMatch(/smtp_envelope\s+JSONB/i);
    expect(migration).toMatch(/prepared_payload_digest\s+CHAR\(64\)/i);
    expect(migration).toMatch(/source_snapshots\s+JSONB/i);
  });
});
