import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));
import { query } from './db.js';
import {
  getAnnotatedThreadKeysMissingFolder,
  getThreadAnnotationRows,
  loadOwnedContact,
  loadOwnedMessages,
  setThreadAnnotation,
} from './mailAccess.js';

beforeEach(() => query.mockReset());

describe('delegation-safe mail access', () => {
  it('loads only live messages joined through the owning user', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'm1' }] });
    await expect(loadOwnedMessages('user-1', ['m1'])).resolves.toEqual([{ id: 'm1' }]);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('JOIN email_accounts a ON a.id = m.account_id');
    expect(sql).toContain('a.user_id = $1');
    expect(sql).toContain('m.is_deleted = false');
    expect(params).toEqual(['user-1', ['m1']]);
  });

  it('loads a contact only through its owning user', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await expect(loadOwnedContact('user-1', 'contact-1')).resolves.toBeNull();
    expect(query.mock.calls[0][0]).toContain('c.user_id = $2');
    expect(query.mock.calls[0][1]).toEqual(['contact-1', 'user-1']);
  });

  it('loads only annotation fields for bounded account threads', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'm1', thread_key: 'thread-1' }] });
    await expect(getThreadAnnotationRows('account-1', ['thread-1'])).resolves.toHaveLength(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('SELECT id, thread_key, plugin_annotations');
    expect(sql).not.toContain('SELECT *');
    expect(sql).toContain('account_id = $1');
    expect(sql).toContain('thread_key = ANY($2::text[])');
    expect(sql).toContain('is_deleted = false');
    expect(params).toEqual(['account-1', ['thread-1']]);
  });

  it('finds annotated threads whose label folder has no live copy', async () => {
    query.mockResolvedValueOnce({ rows: [{ thread_key: 'thread-orphan' }] });
    await expect(getAnnotatedThreadKeysMissingFolder(
      'account-1', 'Delegated', 'gtd', 'delegation',
    )).resolves.toEqual(['thread-orphan']);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('plugin_annotations -> $3 -> $4 IS NOT NULL');
    expect(sql).toContain('NOT EXISTS');
    expect(sql).toContain('label.folder = $2');
    expect(params).toEqual(['account-1', 'Delegated', 'gtd', 'delegation']);
  });

  it('sets and clears one key without replacing the plugin namespace', async () => {
    query.mockResolvedValue({ rowCount: 2, rows: [] });
    const snapshot = { contactId: 'contact-1' };
    await expect(setThreadAnnotation('account-1', 'thread-1', 'gtd', 'delegation', snapshot)).resolves.toBe(2);
    await expect(setThreadAnnotation('account-1', 'thread-1', 'gtd', 'delegation', null)).resolves.toBe(2);

    const [setSql, setParams] = query.mock.calls[0];
    expect(setSql).toContain("COALESCE(plugin_annotations -> $3, '{}'::jsonb) || jsonb_build_object($4::text, $5::jsonb)");
    expect(setParams).toEqual(['account-1', 'thread-1', 'gtd', 'delegation', JSON.stringify(snapshot)]);
    const [clearSql, clearParams] = query.mock.calls[1];
    expect(clearSql).toContain('(plugin_annotations -> $3) - $4');
    expect(clearParams).toEqual(['account-1', 'thread-1', 'gtd', 'delegation']);
  });
});
