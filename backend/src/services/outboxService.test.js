import { describe, expect, it, vi } from 'vitest';

describe('normalizeUndoWindow', () => {
  it.each([
    [undefined, undefined, 0],
    [undefined, 30, 30],
    [200, undefined, 120],
    [-5, undefined, 0],
    ['30', undefined, 30],
    ['not-a-number', undefined, 0],
  ])('normalizes requested=%j preference=%j to %d', async (requested, preference, expected) => {
    const service = await import('./outboxService.js').catch(() => ({}));

    expect(service.normalizeUndoWindow).toBeTypeOf('function');
    expect(service.normalizeUndoWindow(requested, preference)).toBe(expected);
  });
});

describe('enqueue', () => {
  it('stores a fully resolved payload with denormalized receipt fields', async () => {
    const service = await import('./outboxService.js');
    const sendAt = new Date('2026-07-28T12:00:30.000Z');
    const query = vi.fn().mockResolvedValue({
      rows: [{ id: 'outbox-1', send_at: sendAt }],
    });

    expect(service.enqueue).toBeTypeOf('function');
    const result = await service.enqueue({
      userId: 'user-1',
      accountId: 'account-1',
      payload: {
        userId: 'user-1',
        to: ['Recipient <recipient@example.com>'],
        body: 'Hello',
      },
      undoSeconds: 30,
      idempotencyKey: 'compose-1',
      subject: 'Subject',
      toPreview: ['Recipient <recipient@example.com>'],
      messageId: '<fixed@example.com>',
    }, { query });

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('INSERT INTO outbox_messages');
    expect(sql).toContain('ON CONFLICT (user_id, idempotency_key)');
    expect(params).toEqual([
      'user-1',
      'account-1',
      {
        userId: 'user-1',
        to: ['Recipient <recipient@example.com>'],
        body: 'Hello',
        account_id: 'account-1',
      },
      30,
      'Subject',
      ['Recipient <recipient@example.com>'],
      '<fixed@example.com>',
      'compose-1',
    ]);
    expect(result).toEqual({
      outbox_id: 'outbox-1',
      send_at: sendAt,
      undo_seconds: 30,
    });
  });
});

describe('cancel', () => {
  function depsFor(query) {
    return {
      withTransaction: async (fn) => fn({ query }),
    };
  }

  it('atomically cancels a pending row and wipes its payload', async () => {
    const service = await import('./outboxService.js');
    const query = vi.fn().mockResolvedValue({ rows: [{ id: 'outbox-1' }] });

    expect(service.cancel).toBeTypeOf('function');
    await expect(service.cancel(
      { id: 'outbox-1', userId: 'user-1' },
      depsFor(query),
    )).resolves.toEqual({ cancelled: true });

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain("status='cancelled'");
    expect(query.mock.calls[0][0]).toContain("payload='{}'::jsonb");
    expect(query.mock.calls[0][0]).toContain("status='pending'");
    expect(query.mock.calls[0][1]).toEqual(['outbox-1', 'user-1']);
  });

  it.each(['sent', 'claimed'])('reports %s rows as already sent', async (status) => {
    const service = await import('./outboxService.js');
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ status }] });

    expect(service.cancel).toBeTypeOf('function');
    await expect(service.cancel(
      { id: 'outbox-1', userId: 'user-1' },
      depsFor(query),
    )).resolves.toEqual({ cancelled: false, reason: 'already_sent' });
  });

  it('does not reveal a row owned by another user', async () => {
    const service = await import('./outboxService.js');
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    expect(service.cancel).toBeTypeOf('function');
    await expect(service.cancel(
      { id: 'outbox-1', userId: 'user-2' },
      depsFor(query),
    )).resolves.toEqual({ cancelled: false, reason: 'not_found' });
    expect(query.mock.calls[1][0]).toContain('WHERE id=$1 AND user_id=$2');
  });

  it('treats an already-cancelled row as an idempotent no-op', async () => {
    const service = await import('./outboxService.js');
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ status: 'cancelled' }] });

    expect(service.cancel).toBeTypeOf('function');
    await expect(service.cancel(
      { id: 'outbox-1', userId: 'user-1' },
      depsFor(query),
    )).resolves.toEqual({ cancelled: false, reason: 'cancelled' });
  });
});

describe('listPending', () => {
  it('returns only pending receipt fields for the scoped user', async () => {
    const service = await import('./outboxService.js');
    const rows = [{
      id: 'outbox-1',
      subject: 'Subject',
      to_preview: ['recipient@example.com'],
      send_at: new Date('2026-07-28T12:00:30.000Z'),
    }];
    const query = vi.fn().mockResolvedValue({ rows });

    expect(service.listPending).toBeTypeOf('function');
    await expect(service.listPending(
      { userId: 'user-1' },
      { query },
    )).resolves.toEqual(rows);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain("user_id=$1 AND status='pending'");
    expect(query.mock.calls[0][0]).toContain('ORDER BY send_at');
    expect(query.mock.calls[0][1]).toEqual(['user-1']);
  });
});

describe('claimDue', () => {
  it('claims due rows with the plan SQL under a transaction', async () => {
    const service = await import('./outboxService.js');
    const rows = [{ id: 'outbox-1', status: 'claimed', attempts: 1 }];
    const query = vi.fn().mockResolvedValue({ rows });
    const withTransaction = vi.fn(async (fn) => fn({ query }));

    expect(service.claimDue).toBeTypeOf('function');
    await expect(service.claimDue(
      { limit: 25, now: new Date('2026-07-28T12:00:00.000Z') },
      { withTransaction },
    )).resolves.toEqual(rows);

    expect(withTransaction).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("SET status='claimed', claimed_at=NOW(), attempts=attempts+1");
    expect(sql).toContain("WHERE status='pending' AND send_at <= NOW()");
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(sql).toContain('LIMIT $1');
    expect(params).toEqual([25]);
  });

  it('allows exactly one winner when cancel and claim race', async () => {
    const service = await import('./outboxService.js');
    let status = 'pending';
    let arrivals = 0;
    let release;
    const barrier = new Promise(resolve => { release = resolve; });
    const query = vi.fn(async (sql) => {
      if (sql.includes("status='pending'")) {
        arrivals += 1;
        if (arrivals === 2) release();
        await barrier;
      }
      if (sql.includes("SET status='claimed'")) {
        if (status !== 'pending') return { rows: [] };
        status = 'claimed';
        return { rows: [{ id: 'outbox-1', status }] };
      }
      if (sql.includes("SET status='cancelled'")) {
        if (status !== 'pending') return { rows: [] };
        status = 'cancelled';
        return { rows: [{ id: 'outbox-1' }] };
      }
      if (sql.includes('SELECT status')) return { rows: [{ status }] };
      return { rows: [] };
    });
    const withTransaction = vi.fn(async (fn) => fn({ query }));
    const deps = { withTransaction };

    expect(service.claimDue).toBeTypeOf('function');
    const [claimed, cancelled] = await Promise.all([
      service.claimDue({ limit: 1 }, deps),
      service.cancel({ id: 'outbox-1', userId: 'user-1' }, deps),
    ]);

    const claimWon = claimed.length === 1;
    const cancelWon = cancelled.cancelled === true;
    expect(Number(claimWon) + Number(cancelWon)).toBe(1);
    expect(withTransaction).toHaveBeenCalledTimes(2);
  });
});

describe('markSent', () => {
  it('marks only a claimed row sent and wipes the payload atomically', async () => {
    const service = await import('./outboxService.js');
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [] });

    expect(service.markSent).toBeTypeOf('function');
    await expect(service.markSent(
      'outbox-1',
      '<fixed@example.com>',
      { query },
    )).resolves.toBe(1);

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("status='sent'");
    expect(sql).toContain("payload='{}'::jsonb");
    expect(sql).toContain("WHERE id=$1 AND status='claimed'");
    expect(params).toEqual(['outbox-1', '<fixed@example.com>']);
  });
});

describe('markFailed', () => {
  it('marks only a claimed row failed with an error and wipes the payload', async () => {
    const service = await import('./outboxService.js');
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [] });

    expect(service.markFailed).toBeTypeOf('function');
    await expect(service.markFailed(
      'outbox-1',
      'Failed to send message.',
      { query },
    )).resolves.toBe(1);

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("status='failed'");
    expect(sql).toContain("payload='{}'::jsonb");
    expect(sql).toContain("WHERE id=$1 AND status='claimed'");
    expect(params).toEqual(['outbox-1', 'Failed to send message.']);
  });
});

describe('sweepStaleClaims', () => {
  it('fails stale claims loudly instead of returning them to pending', async () => {
    const service = await import('./outboxService.js');
    const query = vi.fn().mockResolvedValue({ rowCount: 2, rows: [] });

    expect(service.sweepStaleClaims).toBeTypeOf('function');
    await expect(service.sweepStaleClaims({ query })).resolves.toBe(2);

    const [sql] = query.mock.calls[0];
    expect(sql).toContain("SET status='failed', payload='{}'::jsonb");
    expect(sql).toContain(
      "error='delivery interrupted — the send was not retried; check your Sent folder'",
    );
    expect(sql).toContain("status='claimed'");
    expect(sql).toContain("claimed_at < NOW() - INTERVAL '5 minutes'");
    expect(sql).not.toContain("status='pending'");
  });
});

describe('purgeTerminalRows', () => {
  it('deletes only terminal rows whose last update is older than seven days', async () => {
    const service = await import('./outboxService.js');
    const query = vi.fn().mockResolvedValue({ rowCount: 3, rows: [] });

    expect(service.purgeTerminalRows).toBeTypeOf('function');
    await expect(service.purgeTerminalRows({ query })).resolves.toBe(3);

    const [sql] = query.mock.calls[0];
    expect(sql).toContain('DELETE FROM outbox_messages');
    expect(sql).toContain("status IN ('sent','cancelled','failed')");
    expect(sql).toContain("updated_at < NOW() - INTERVAL '7 days'");
    expect(sql).not.toContain("'pending'");
    expect(sql).not.toContain("'claimed'");
  });
});
