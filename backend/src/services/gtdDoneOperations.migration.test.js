import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('GTD Done operation migration', () => {
  it('keeps the frozen worklist after the acted message row disappears and constrains phase cursors', () => {
    const sql = readFileSync(new URL('../../migrations/0059_gtd_done_operations.sql', import.meta.url), 'utf8');
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS gtd_done_operations/);
    expect(sql).toMatch(/acted_message_id UUID NOT NULL/);
    expect(sql).not.toMatch(/FOREIGN KEY\s*\(acted_message_id\)/i);
    expect(sql).toMatch(/plan JSONB NOT NULL/);
    expect(sql).toMatch(/phase TEXT NOT NULL CHECK \(phase IN \('seen', 'archive', 'labels', 'completed'\)\)/);
    expect(sql).toMatch(/UNIQUE \(operation_key\)/);
    expect(sql).toMatch(/claim_owner UUID/);
    expect(sql).toMatch(/claim_expires_at TIMESTAMPTZ/);
  });
});
