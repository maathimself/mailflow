import { describe, it, expect, vi } from 'vitest';

vi.mock('./db.js', () => ({ pool: { query: vi.fn(), connect: vi.fn() } }));
import { warnOnCollationMismatch } from './migrations.js';

const row = (over = {}) => ({
  rows: [{ db: 'mailflow', recorded: '2.36', actual: '2.36', ...over }],
});

describe('warnOnCollationMismatch', () => {
  it('warns loudly, naming REINDEX DATABASE, when versions diverge', async () => {
    const warn = vi.fn();
    const query = vi.fn().mockResolvedValue(row({ recorded: '1.2.38', actual: '2.36' }));
    const hit = await warnOnCollationMismatch({ query, warn });
    expect(hit).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = warn.mock.calls[0][0];
    expect(msg).toContain('collation version mismatch');
    expect(msg).toContain('1.2.38');
    expect(msg).toContain('2.36');
    expect(msg).toContain('REINDEX DATABASE "mailflow";');
    expect(msg).toContain('REFRESH COLLATION VERSION');
  });

  it('stays silent when the recorded and actual versions match', async () => {
    const warn = vi.fn();
    const hit = await warnOnCollationMismatch({ query: vi.fn().mockResolvedValue(row()), warn });
    expect(hit).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns on the alpine→glibc signature: NULL recorded version, versioned current libc', async () => {
    // Field-verified: musl (postgres:16-alpine) records NO datcollversion, so after
    // the swap to pgvector/pgvector:pg16 the row reads recorded=NULL, actual=2.36 —
    // and Postgres itself stays silent. This is the primary case to catch.
    const warn = vi.fn();
    const query = vi.fn().mockResolvedValue(row({ recorded: null, actual: '2.36' }));
    expect(await warnOnCollationMismatch({ query, warn })).toBe(true);
    const msg = warn.mock.calls[0][0];
    expect(msg).toContain('reported no collation');
    expect(msg).toContain('REINDEX DATABASE "mailflow";');
  });

  it('stays silent for versionless locales (NULL actual, e.g. C/POSIX or still on musl)', async () => {
    const warn = vi.fn();
    for (const over of [{ actual: null }, { recorded: null, actual: null }]) {
      expect(await warnOnCollationMismatch({ query: vi.fn().mockResolvedValue(row(over)), warn })).toBe(false);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it('never throws — a failing query (e.g. PG < 15) only skips the check', async () => {
    const warn = vi.fn();
    const query = vi.fn().mockRejectedValue(new Error('column "datcollversion" does not exist'));
    await expect(warnOnCollationMismatch({ query, warn })).resolves.toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});
