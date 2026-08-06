import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const migrationsDir = fileURLToPath(new URL('../../migrations/', import.meta.url));

describe('gtd delegations migration', () => {
  it('defines thread-stable ownership, snapshots, and deletion behavior', () => {
    const files = readdirSync(migrationsDir).filter(name => /^\d{4}_gtd_delegations\.sql$/.test(name));
    expect(files).toHaveLength(1);
    const sql = readFileSync(`${migrationsDir}/${files[0]}`, 'utf8');
    expect(sql).toMatch(/PRIMARY KEY \(user_id, account_id, thread_key\)/i);
    expect(sql).toMatch(/contact_id UUID REFERENCES contacts\(id\) ON DELETE SET NULL/i);
    expect(sql).toMatch(/contact_display_name_snapshot TEXT NOT NULL/i);
    expect(sql).toMatch(/contact_primary_email_snapshot TEXT/i);
    expect(sql).toMatch(/delegated_at TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/i);
    expect(sql).toMatch(/updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/i);
  });
});
