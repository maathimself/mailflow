import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));

import { query } from '../services/db.js';

const adapterPromise = import('./triageAdapter.js').catch(() => null);

function cursor(date = '2026-07-28T08:00:00.000Z', header = '<cursor@example.com>') {
  return Buffer.from(JSON.stringify({ d: date, h: header }), 'utf8').toString('base64');
}

describe('listTriageCandidates', () => {
  beforeEach(() => query.mockReset());

  it('uses one scoped, enriched inbox query and excludes triaged messages by default', async () => {
    const adapter = await adapterPromise;
    expect(adapter?.listTriageCandidates).toBeTypeOf('function');
    query.mockResolvedValueOnce({ rows: [] });

    await adapter.listTriageCandidates({
      accountIds: ['acc-1'],
      limit: 25,
      unreadOnly: true,
      includeTriaged: false,
    });

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('m.account_id = ANY($1)');
    expect(sql).toContain("m.folder = 'INBOX'");
    expect(sql).toContain('m.is_deleted = false');
    expect(sql).toContain('m.message_id IS NOT NULL');
    expect(sql).toContain('m.is_read = false');
    expect(sql).toMatch(/NOT EXISTS\s*\(\s*SELECT 1\s+FROM message_triage mt/i);
    expect(sql).toContain('LEFT JOIN LATERAL');
    expect(sql).toContain('t.thread_key = m.thread_key');
    expect(sql).toContain('AS i_replied');
    expect(sql).toContain('WITH sender_history AS');
    expect(sql).toContain('LEFT JOIN sender_history');
    expect(sql).toContain('LEFT JOIN contacts');
    expect(sql).toContain('received_count');
    expect(sql).not.toContain('receive_count');
    expect(sql).toContain('ORDER BY m.date ASC, m.message_id ASC');
    expect(params[0]).toEqual(['acc-1']);
    expect(params.at(-1)).toBe(26);
  });

  it('adds the tuple keyset predicate only when a cursor is supplied', async () => {
    const adapter = await adapterPromise;
    query.mockResolvedValue({ rows: [] });

    await adapter.listTriageCandidates({ accountIds: ['acc-1'], limit: 10 });
    expect(query.mock.calls[0][0]).not.toMatch(/\(m\.date,\s*m\.message_id\)\s*>/);

    query.mockClear();
    const date = '2026-07-28T08:00:00.000Z';
    const header = '<cursor@example.com>';
    await adapter.listTriageCandidates({
      accountIds: ['acc-1'],
      cursor: cursor(date, header),
      limit: 10,
    });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/\(m\.date,\s*m\.message_id\)\s*>\s*\(\$\d+,\s*\$\d+\)/);
    expect(params).toContain(date);
    expect(params).toContain(header);
  });

  it('honors includeTriaged, unreadOnly, categories, and since without losing scope', async () => {
    const adapter = await adapterPromise;
    query.mockResolvedValueOnce({ rows: [] });

    await adapter.listTriageCandidates({
      accountIds: ['acc-1', 'acc-2'],
      limit: 5,
      unreadOnly: false,
      includeTriaged: true,
      categories: ['primary', 'newsletter'],
      since: '2026-07-01T00:00:00.000Z',
    });

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('m.account_id = ANY($1)');
    expect(sql).not.toContain('FROM message_triage mt');
    expect(sql).not.toContain('m.is_read = false');
    expect(sql).toContain("COALESCE(m.category, 'primary') = ANY");
    expect(sql).toMatch(/m\.date >= \$\d+/);
    expect(params).toContainEqual(['primary', 'newsletter']);
    expect(params).toContain('2026-07-01T00:00:00.000Z');
  });

  it('returns limit rows plus hasMore and a header-based cursor from limit+1 results', async () => {
    const adapter = await adapterPromise;
    query.mockResolvedValueOnce({
      rows: [
        { id: 'm1', date: new Date('2026-07-01T00:00:00Z'), message_id: '<one@example.com>' },
        { id: 'm2', date: new Date('2026-07-02T00:00:00Z'), message_id: '<two@example.com>' },
        { id: 'm3', date: new Date('2026-07-03T00:00:00Z'), message_id: '<three@example.com>' },
      ],
    });

    const page = await adapter.listTriageCandidates({ accountIds: ['acc-1'], limit: 2 });

    expect(page.rows.map(row => row.id)).toEqual(['m1', 'm2']);
    expect(page.hasMore).toBe(true);
    expect(JSON.parse(Buffer.from(page.cursor, 'base64').toString('utf8'))).toEqual({
      d: '2026-07-02T00:00:00.000Z',
      h: '<two@example.com>',
    });
  });
});

describe('senderHistory', () => {
  beforeEach(() => query.mockReset());

  it('returns computed receive history and the matching scoped contact in one query', async () => {
    const adapter = await adapterPromise;
    const row = {
      received_count: 4,
      first_received: '2026-01-01T00:00:00Z',
      last_received: '2026-07-01T00:00:00Z',
      send_count: 2,
      last_sent: '2026-06-01T00:00:00Z',
      is_auto: false,
    };
    query.mockResolvedValueOnce({ rows: [row] });

    await expect(adapter.senderHistory('Sender@Example.com', ['acc-1'])).resolves.toEqual(row);

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('m.account_id = ANY($1)');
    expect(sql).toContain('COUNT(*)::int AS received_count');
    expect(sql).toContain('LEFT JOIN contacts');
    expect(sql).toContain('c.primary_email = lower($2)');
    expect(params).toEqual([['acc-1'], 'Sender@Example.com']);
  });
});

describe('resolveHeadersForIds', () => {
  beforeEach(() => query.mockReset());

  it('resolves message row ids to durable headers within account scope', async () => {
    const adapter = await adapterPromise;
    const rows = [{ id: 'm1', account_id: 'acc-1', message_id_header: '<one@example.com>' }];
    query.mockResolvedValueOnce({ rows });

    await expect(adapter.resolveHeadersForIds(['m1'], ['acc-1'])).resolves.toEqual(rows);

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('id = ANY($1');
    expect(sql).toContain('account_id = ANY($2');
    expect(sql).toContain('message_id AS message_id_header');
    expect(params).toEqual([['m1'], ['acc-1']]);
  });
});

describe('triageActionsForMessages', () => {
  beforeEach(() => query.mockReset());

  it('reads actions for account/header pairs with one pairwise scoped query', async () => {
    const adapter = await adapterPromise;
    const pairs = [
      { accountId: 'acc-1', messageIdHeader: '<one@example.com>' },
      { accountId: 'acc-2', messageIdHeader: '<two@example.com>' },
    ];
    const rows = [
      {
        account_id: 'acc-1',
        message_id_header: '<one@example.com>',
        action: 'archived',
        triaged_at: '2026-07-28T08:00:00Z',
      },
    ];
    query.mockResolvedValueOnce({ rows });

    await expect(adapter.triageActionsForMessages(pairs)).resolves.toEqual(rows);

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(
      /FROM unnest\(\$1::uuid\[\], \$2::text\[\]\) AS input\(account_id, message_id_header\)/,
    );
    expect(sql).toContain('JOIN message_triage mt');
    expect(sql).toContain('mt.account_id = input.account_id');
    expect(sql).toContain('mt.message_id_header = input.message_id_header');
    expect(sql).toContain('mt.action');
    expect(sql).toContain('mt.triaged_at');
    expect(params).toEqual([
      ['acc-1', 'acc-2'],
      ['<one@example.com>', '<two@example.com>'],
    ]);
  });

  it('returns no actions without querying when the pair list is empty', async () => {
    const adapter = await adapterPromise;

    await expect(adapter.triageActionsForMessages([])).resolves.toEqual([]);

    expect(query).not.toHaveBeenCalled();
  });
});

describe('sentFolderForAccount', () => {
  beforeEach(() => query.mockReset());

  it('resolves the mapped sent folder with a \\Sent special-use fallback in one query', async () => {
    const adapter = await adapterPromise;
    query.mockResolvedValueOnce({ rows: [{ path: 'Custom/Outgoing' }] });

    await expect(adapter.sentFolderForAccount('acc-1')).resolves.toBe('Custom/Outgoing');

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("a.folder_mappings->>'sent'");
    expect(sql).toContain("f.special_use = '\\Sent'");
    expect(sql).toContain('WHERE a.id = $1');
    expect(params).toEqual(['acc-1']);
  });

  it('returns null without querying when no account id is given', async () => {
    const adapter = await adapterPromise;

    await expect(adapter.sentFolderForAccount(null)).resolves.toBeNull();

    expect(query).not.toHaveBeenCalled();
  });
});

describe('markTriaged', () => {
  beforeEach(() => query.mockReset());

  it('skips a null-header id without issuing an UPSERT for it', async () => {
    const adapter = await adapterPromise;
    query.mockResolvedValueOnce({
      rows: [{ id: 'm-null', account_id: 'acc-1', message_id_header: null }],
    });

    const result = await adapter.markTriaged({
      userId: 'user-1',
      accountIds: ['acc-1'],
      messageIds: ['m-null'],
      action: 'left',
      note: null,
      tokenId: 'token-1',
    });

    expect(query).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      ok: true,
      marked: 0,
      newly_marked: 0,
      already_triaged: 0,
      skipped: [{ id: 'm-null', reason: 'no_message_id_header' }],
    });
  });

  it('uses xmax=0 to distinguish new checkpoints from updated checkpoints', async () => {
    const adapter = await adapterPromise;
    query
      .mockResolvedValueOnce({
        rows: [
          { id: 'm-new', account_id: 'acc-1', message_id_header: '<new@example.com>' },
          { id: 'm-old', account_id: 'acc-1', message_id_header: '<old@example.com>' },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          { account_id: 'acc-1', message_id_header: '<new@example.com>', inserted: true },
          { account_id: 'acc-1', message_id_header: '<old@example.com>', inserted: false },
        ],
      });

    const result = await adapter.markTriaged({
      userId: 'user-1',
      accountIds: ['acc-1'],
      messageIds: ['m-new', 'm-old'],
      action: 'archived',
      note: 'morning pass',
      tokenId: 'token-1',
    });

    expect(result).toEqual({
      ok: true,
      marked: 2,
      newly_marked: 1,
      already_triaged: 1,
      skipped: [],
    });
    const [sql, params] = query.mock.calls[1];
    expect(sql).toContain('ON CONFLICT (account_id, message_id_header) DO UPDATE');
    expect(sql).toContain('triaged_at = NOW()');
    expect(sql).toContain('action = EXCLUDED.action');
    expect(sql).toContain('note = EXCLUDED.note');
    expect(sql).toContain('RETURNING');
    expect(sql).toContain('(xmax = 0) AS inserted');
    expect(params).toEqual([
      'user-1',
      ['acc-1', 'acc-1'],
      ['<new@example.com>', '<old@example.com>'],
      'archived',
      'morning pass',
      'token-1',
    ]);
  });

  it('reports unresolved or out-of-scope ids as skipped', async () => {
    const adapter = await adapterPromise;
    query.mockResolvedValueOnce({ rows: [] });

    const result = await adapter.markTriaged({
      userId: 'user-1',
      accountIds: ['acc-1'],
      messageIds: ['foreign-id'],
    });

    expect(result.skipped).toEqual([{ id: 'foreign-id', reason: 'not_found_or_out_of_scope' }]);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('deduplicates folder-copy rows that share one durable checkpoint key', async () => {
    const adapter = await adapterPromise;
    query
      .mockResolvedValueOnce({
        rows: [
          { id: 'm-inbox', account_id: 'acc-1', message_id_header: '<same@example.com>' },
          { id: 'm-label', account_id: 'acc-1', message_id_header: '<same@example.com>' },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ account_id: 'acc-1', message_id_header: '<same@example.com>', inserted: true }],
      });

    const result = await adapter.markTriaged({
      userId: 'user-1',
      accountIds: ['acc-1'],
      messageIds: ['m-inbox', 'm-label'],
    });

    expect(result).toMatchObject({ marked: 1, newly_marked: 1, already_triaged: 0 });
    expect(query.mock.calls[1][1][1]).toEqual(['acc-1']);
    expect(query.mock.calls[1][1][2]).toEqual(['<same@example.com>']);
  });
});
