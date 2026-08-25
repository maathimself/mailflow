import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('../../migrations/0055_desired_flag_leases.sql', import.meta.url),
  'utf8',
);

describe('desired flag delivery lease migration', () => {
  it('adds a durable bounded lease expiry used by reconciliation and takeover', () => {
    expect(migration).toMatch(/ALTER TABLE message_flag_deliveries[\s\S]*lease_expires_at\s+TIMESTAMPTZ/i);
    expect(migration).toMatch(/message_flag_deliveries_reconcile_idx/i);
    expect(migration).toMatch(/lease_expires_at/i);
  });
});
