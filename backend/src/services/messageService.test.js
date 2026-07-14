import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));

const { query } = await import('./db.js');
const { _clearLookupPhotoCache } = await import('./carddavLookupService.js');
import { listMessages } from './messageService.js';

beforeEach(() => {
  query.mockClear();
  _clearLookupPhotoCache();
});

describe('listMessages — account scope', () => {
  it('returns empty result immediately when user has no enabled accounts', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    const result = await listMessages({ userId: 'user-1' });

    expect(result).toEqual({ messages: [], total: 0 });
    expect(query).toHaveBeenCalledOnce();
  });

  it('falls back to unified inbox when accountId is not owned by the user', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1' }] })           // accounts
      .mockResolvedValueOnce({ rows: [{ n: 5 }] })                  // folder count
      .mockResolvedValueOnce({ rows: [{ id: 'msg-1', folder: 'INBOX' }] }); // messages

    const result = await listMessages({ userId: 'user-1', accountId: 'acc-other' });

    // Unified inbox returns the cached total from the folder sum query
    expect(result.total).toBe(5);
    expect(result.resolvedAccountId).toBeNull();

    // The folder count query should have used total_count (not unread_count)
    const countSql = query.mock.calls[1][0];
    expect(countSql).toContain('total_count');
    expect(countSql).not.toContain('unread_count');
  });
});

describe('listMessages — total count selection', () => {
  it('sums unread_count across accounts for unified inbox when unreadOnly=true', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1' }, { id: 'acc-2' }] }) // accounts
      .mockResolvedValueOnce({ rows: [{ n: 7 }] })                          // folder count
      .mockResolvedValueOnce({ rows: [] });                                  // messages

    const result = await listMessages({ userId: 'user-1', unreadOnly: 'true' });

    expect(result.total).toBe(7);

    const countSql = query.mock.calls[1][0];
    expect(countSql).toContain('unread_count');
    expect(countSql).not.toContain('total_count');
  });

  it('sums total_count across accounts for unified inbox when unreadOnly is not set', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1' }, { id: 'acc-2' }] }) // accounts
      .mockResolvedValueOnce({ rows: [{ n: 42 }] })                         // folder count
      .mockResolvedValueOnce({ rows: [] });                                  // messages

    const result = await listMessages({ userId: 'user-1' });

    expect(result.total).toBe(42);

    const countSql = query.mock.calls[1][0];
    expect(countSql).toContain('total_count');
    expect(countSql).not.toContain('unread_count');
  });

  it('reads unread_count from folder row for specific account when unreadOnly=true', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1' }] })                       // accounts
      .mockResolvedValueOnce({ rows: [{ total_count: 100, unread_count: 3 }] })  // folder row
      .mockResolvedValueOnce({ rows: [] });                                        // messages

    const result = await listMessages({ userId: 'user-1', accountId: 'acc-1', unreadOnly: 'true' });

    expect(result.total).toBe(3);
    expect(result.resolvedAccountId).toBe('acc-1');
  });

  it('reads total_count from folder row for specific account when unreadOnly is not set', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1' }] })                       // accounts
      .mockResolvedValueOnce({ rows: [{ total_count: 100, unread_count: 3 }] })  // folder row
      .mockResolvedValueOnce({ rows: [] });                                        // messages

    const result = await listMessages({ userId: 'user-1', accountId: 'acc-1' });

    expect(result.total).toBe(100);
  });
});

// Threaded mode: 4 query calls — accounts, folder cache, thread CTE, thread count
describe('listMessages — threaded mode', () => {
  it('returns thread count as total, ignoring the cached folder count', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1' }] })                       // accounts
      .mockResolvedValueOnce({ rows: [{ total_count: 99, unread_count: 2 }] })  // folder cache (not used)
      .mockResolvedValueOnce({ rows: [{ id: 'msg-1' }] })                       // thread CTE
      .mockResolvedValueOnce({ rows: [{ total: 5 }] });                          // thread count

    const result = await listMessages({ userId: 'user-1', accountId: 'acc-1', threaded: 'true' });

    expect(result.total).toBe(5);
    expect(result.threaded).toBe(true);
    expect(result.messages).toHaveLength(1);
  });

  it('scopes thread_totals to INBOX when viewing a specific account INBOX', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1' }] })
      .mockResolvedValueOnce({ rows: [{ total_count: 10, unread_count: 0 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 0 }] });

    await listMessages({ userId: 'user-1', accountId: 'acc-1', folder: 'INBOX', threaded: 'true' });

    const cteSql = query.mock.calls[2][0];
    expect(cteSql).toContain('AND folder = $2');
  });

  it('counts thread messages across all folders when viewing a non-INBOX folder', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1' }] })
      .mockResolvedValueOnce({ rows: [{ total_count: 10, unread_count: 0 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 0 }] });

    await listMessages({ userId: 'user-1', accountId: 'acc-1', folder: 'Sent', threaded: 'true' });

    // thread_totals must not be scoped to a specific folder so the badge reflects true thread size
    const cteSql = query.mock.calls[2][0];
    expect(cteSql).not.toContain('AND folder = $2');
    expect(cteSql).not.toContain("AND folder = 'INBOX'");
  });

  it('scopes thread_totals to INBOX for unified inbox threaded view', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1' }, { id: 'acc-2' }] })
      .mockResolvedValueOnce({ rows: [{ n: 20 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 0 }] });

    await listMessages({ userId: 'user-1', threaded: 'true' });

    const cteSql = query.mock.calls[2][0];
    expect(cteSql).toContain("AND folder = 'INBOX'");
  });
});

describe('listMessages — lookup-only sender resolution', () => {
  it('joins lookup-only ledger rows so a headerless sender resolves a name and avatar (flat)', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1' }] }) // accounts
      .mockResolvedValueOnce({ rows: [{ n: 1 }] })        // folder count
      .mockResolvedValueOnce({ rows: [] });                // messages

    await listMessages({ userId: 'user-1' });

    const listSql = query.mock.calls[2][0];
    expect(listSql).toContain('LEFT JOIN LATERAL');
    expect(listSql).toContain("lo.mapping_status = 'lookup'");
    expect(listSql).toContain('lab.is_lookup_source = true');
    expect(listSql).toContain("lab.source = 'carddav'");
    expect(listSql).toContain("COALESCE(NULLIF(m.from_name, ''), lookup.lookup_display_name)");
    // has_contact_photo comes from the materialized contact alone; a lookup match is
    // only flagged as a photo *candidate*, which listMessages then resolves through
    // the real bounded decode path (not a syntactic PHOTO check) so the gate cannot
    // diverge from what GET /api/contacts/photo actually serves.
    expect(listSql).toContain('(co.id IS NOT NULL) AS has_contact_photo');
    expect(listSql).toContain('lookup.matched IS TRUE) AS lookup_photo_candidate');
    // At most one lookup match per row keeps the fallback from multiplying messages.
    expect(listSql).toContain('LIMIT 1');
  });

  it('joins lookup-only ledger rows in the threaded CTE as well', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1' }] })
      .mockResolvedValueOnce({ rows: [{ total_count: 1, unread_count: 0 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 0 }] });

    await listMessages({ userId: 'user-1', accountId: 'acc-1', threaded: 'true' });

    const cteSql = query.mock.calls[2][0];
    expect(cteSql).toContain('LEFT JOIN LATERAL');
    expect(cteSql).toContain("lo.mapping_status = 'lookup'");
    expect(cteSql).toContain('lab.is_lookup_source = true');
    expect(cteSql).toContain("COALESCE(NULLIF(m.from_name, ''), lookup.lookup_display_name)");
    expect(cteSql).toContain('(co.id IS NOT NULL) AS has_contact_photo');
    expect(cteSql).toContain('lookup.matched IS TRUE) AS lookup_photo_candidate');
  });

  it('resolves a repeated lookup-only sender once per page instead of one DB read per row', async () => {
    // A valid lookup vCard whose PHOTO decodes, so every candidate row gets a photo.
    const photoBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
    const vcard = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'UID:lookup-1',
      'FN:Lookup Sender',
      'EMAIL:sender@example.test',
      `PHOTO;ENCODING=b;TYPE=JPEG:${photoBytes.toString('base64')}`,
      'END:VCARD',
    ].join('\r\n');

    query
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1' }] }) // accounts
      .mockResolvedValueOnce({ rows: [{ n: 3 }] })        // folder count
      .mockResolvedValueOnce({ rows: [                    // three rows, one sender (mixed case)
        { id: 'm1', from_email: 'Sender@Example.test', lookup_photo_candidate: true },
        { id: 'm2', from_email: 'sender@example.test', lookup_photo_candidate: true },
        { id: 'm3', from_email: 'SENDER@EXAMPLE.TEST', lookup_photo_candidate: true },
      ] })
      .mockResolvedValue({ rows: [{ primary_email: 'sender@example.test', vcard }] }); // batched probe

    const result = await listMessages({ userId: 'user-1' });

    // 3 base queries (accounts, folder count, messages) + exactly ONE shared
    // lookup-photo probe for the case-insensitively identical sender — not one
    // per row, which would be a cache stampede past the in-process LRU.
    expect(query).toHaveBeenCalledTimes(4);
    expect(result.messages.map(m => m.has_contact_photo)).toEqual([true, true, true]);
    // The internal candidate marker never leaks to the API response.
    expect(result.messages.every(m => !('lookup_photo_candidate' in m))).toBe(true);
  });

  it('resolves N distinct lookup-only senders in a single batched DB round-trip', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1' }] }) // accounts
      .mockResolvedValueOnce({ rows: [{ n: 3 }] })        // folder count
      .mockResolvedValueOnce({ rows: [                    // three distinct senders
        { id: 'm1', from_email: 'alice@example.test', lookup_photo_candidate: true },
        { id: 'm2', from_email: 'bob@example.test', lookup_photo_candidate: true },
        { id: 'm3', from_email: 'carol@example.test', lookup_photo_candidate: true },
      ] })
      .mockResolvedValue({ rows: [] });                   // one batched probe, no photos

    await listMessages({ userId: 'user-1' });

    // 3 base queries + exactly ONE batched probe for all distinct senders,
    // never one query per sender (that would flood the connection pool).
    expect(query).toHaveBeenCalledTimes(4);
    const probeSql = query.mock.calls[3][0];
    expect(probeSql).toContain('primary_email = ANY($2::text[])');
    expect(query.mock.calls[3][1]).toEqual([
      'user-1',
      ['alice@example.test', 'bob@example.test', 'carol@example.test'],
    ]);
  });
});
