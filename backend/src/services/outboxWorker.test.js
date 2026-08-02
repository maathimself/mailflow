import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const NOW = new Date('2026-07-28T12:00:00.000Z');

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

function workerDeps({ rows = [], sendMessage, missingAccountIds = [] } = {}) {
  const state = rows.map(row => ({ status: 'pending', ...row }));
  let claimQueries = 0;
  const query = vi.fn(async (sql, params = []) => {
    if (sql.includes('SELECT * FROM email_accounts')) {
      if (missingAccountIds.includes(params[0])) return { rows: [] };
      return {
        rows: [{
          id: params[0],
          user_id: params[1],
          email_address: 'sender@example.com',
        }],
      };
    }
    if (sql.includes("SET status='sent'")) {
      const row = state.find(candidate => candidate.id === params[0]);
      if (row?.status !== 'claimed') return { rowCount: 0, rows: [] };
      row.status = 'sent';
      return { rowCount: 1, rows: [] };
    }
    if (sql.includes("SET status='failed'") && sql.includes('WHERE id=$1')) {
      const row = state.find(candidate => candidate.id === params[0]);
      if (row?.status !== 'claimed') return { rowCount: 0, rows: [] };
      row.status = 'failed';
      row.error = params[1];
      return { rowCount: 1, rows: [] };
    }
    if (sql.includes("claimed_at < NOW() - INTERVAL '5 minutes'")) {
      return { rowCount: 0, rows: [] };
    }
    if (sql.includes('DELETE FROM outbox_messages')) {
      return { rowCount: 0, rows: [] };
    }
    return { rowCount: 0, rows: [] };
  });
  const withTransaction = vi.fn(async (fn) => fn({
    query: vi.fn(async (sql) => {
      if (!sql.includes('FOR UPDATE SKIP LOCKED')) return { rows: [] };
      claimQueries += 1;
      const due = state.filter(row => (
        row.status === 'pending' && new Date(row.send_at).getTime() <= Date.now()
      ));
      for (const row of due) row.status = 'claimed';
      return { rows: due };
    }),
  }));
  return {
    deps: {
      query,
      withTransaction,
      imapManager: {},
      redisClient: {},
      refreshMicrosoftToken: vi.fn(),
      sendMessage: sendMessage || vi.fn().mockResolvedValue({ messageId: '<fixed@example.com>' }),
    },
    query,
    state,
    claimCount: () => claimQueries,
  };
}

describe('startOutboxWorker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('claims and delivers only rows whose send time is due', async () => {
    const service = await import('./outboxService.js');
    const due = {
      id: 'due',
      user_id: 'user-1',
      account_id: 'account-1',
      send_at: new Date(NOW.getTime() - 1),
      message_id: '<due@example.com>',
      payload: { to: ['due@example.com'], body: 'Due' },
    };
    const future = {
      id: 'future',
      user_id: 'user-1',
      account_id: 'account-1',
      send_at: new Date(NOW.getTime() + 60_000),
      message_id: '<future@example.com>',
      payload: { to: ['future@example.com'], body: 'Future' },
    };
    const { deps, state } = workerDeps({ rows: [due, future] });

    expect(service.startOutboxWorker).toBeTypeOf('function');
    const worker = service.startOutboxWorker(deps, { tickMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(deps.sendMessage).toHaveBeenCalledTimes(1);
    expect(deps.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        account: expect.objectContaining({ id: 'account-1', user_id: 'user-1' }),
        account_id: 'account-1',
        messageId: '<due@example.com>',
        userId: 'user-1',
      }),
      deps,
    );
    expect(state.find(row => row.id === 'due').status).toBe('sent');
    expect(state.find(row => row.id === 'future').status).toBe('pending');
    worker.stop();
  });

  it('deletes a queued draft only after delivery succeeds and the row is marked sent', async () => {
    const service = await import('./outboxService.js');
    const row = {
      id: 'draft-send',
      user_id: 'user-1',
      account_id: 'account-1',
      send_at: NOW,
      message_id: '<draft-send@example.com>',
      payload: {
        to: ['recipient@example.com'],
        body: 'Draft body',
        deleteDraftOnSend: { uid: 7, folder: 'Drafts' },
      },
    };
    const { deps, state } = workerDeps({ rows: [row] });
    deps.draftService = {
      deleteDraft: vi.fn().mockResolvedValue({ ok: true }),
    };

    const worker = service.startOutboxWorker(deps, { tickMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(state[0].status).toBe('sent');
    expect(deps.draftService.deleteDraft).toHaveBeenCalledWith({
      account: expect.objectContaining({ id: 'account-1', user_id: 'user-1' }),
      uid: 7,
      folder: 'Drafts',
    }, deps);
    const markSentCall = deps.query.mock.invocationCallOrder.find((_, index) => (
      deps.query.mock.calls[index][0].includes("SET status='sent'")
    ));
    expect(markSentCall).toBeLessThan(
      deps.draftService.deleteDraft.mock.invocationCallOrder[0],
    );
    worker.stop();
  });

  it('owner-resolves and deletes a queued source draft through its cross-account source', async () => {
    const service = await import('./outboxService.js');
    const row = {
      id: 'cross-account-draft-send',
      user_id: 'user-1',
      account_id: 'destination-account',
      send_at: NOW,
      message_id: '<cross-account-draft-send@example.com>',
      payload: {
        to: ['recipient@example.com'],
        body: 'Draft body',
        deleteDraftOnSend: {
          accountId: 'source-account',
          uid: 7,
          folder: 'Drafts',
        },
      },
    };
    const { deps, state } = workerDeps({ rows: [row] });
    deps.draftService = {
      deleteDraft: vi.fn().mockResolvedValue({ ok: true }),
    };

    const worker = service.startOutboxWorker(deps, { tickMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(state[0].status).toBe('sent');
    expect(deps.query).toHaveBeenCalledWith(
      expect.stringMatching(/FROM email_accounts[\s\S]+id\s*=\s*\$1[\s\S]+user_id\s*=\s*\$2/),
      ['source-account', 'user-1'],
    );
    expect(deps.draftService.deleteDraft).toHaveBeenCalledWith({
      account: expect.objectContaining({ id: 'source-account', user_id: 'user-1' }),
      uid: 7,
      folder: 'Drafts',
    }, deps);
    worker.stop();
  });

  it('never deletes a queued source through the destination when the owned source is missing', async () => {
    const service = await import('./outboxService.js');
    const row = {
      id: 'missing-source-draft-send',
      user_id: 'user-1',
      account_id: 'destination-account',
      send_at: NOW,
      message_id: '<missing-source-draft-send@example.com>',
      payload: {
        to: ['recipient@example.com'],
        body: 'Draft body',
        deleteDraftOnSend: {
          accountId: 'missing-source-account',
          uid: 7,
          folder: 'Drafts',
        },
      },
    };
    const { deps, state } = workerDeps({
      rows: [row],
      missingAccountIds: ['missing-source-account'],
    });
    deps.draftService = { deleteDraft: vi.fn() };
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const worker = service.startOutboxWorker(deps, { tickMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(state[0].status).toBe('sent');
    expect(deps.draftService.deleteDraft).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      'Outbox draft cleanup error:',
      'Source draft account not found',
    );
    worker.stop();
  });

  it('keeps a delivered row sent when deferred draft cleanup fails', async () => {
    const service = await import('./outboxService.js');
    const row = {
      id: 'draft-cleanup-failure',
      user_id: 'user-1',
      account_id: 'account-1',
      send_at: NOW,
      message_id: '<draft-cleanup-failure@example.com>',
      payload: {
        to: ['recipient@example.com'],
        body: 'Draft body',
        deleteDraftOnSend: { uid: 7, folder: 'Drafts' },
      },
    };
    const { deps, query, state } = workerDeps({ rows: [row] });
    deps.draftService = {
      deleteDraft: vi.fn().mockRejectedValue(new Error('IMAP delete failed')),
    };
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const worker = service.startOutboxWorker(deps, { tickMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(state[0].status).toBe('sent');
    expect(query.mock.calls.some(([sql]) => (
      sql.includes("SET status='failed'") && sql.includes('WHERE id=$1')
    ))).toBe(false);
    expect(console.error).toHaveBeenCalledWith(
      'Outbox draft cleanup error:',
      'IMAP delete failed',
    );
    worker.stop();
  });

  it('does not stack ticks while delivery is still running', async () => {
    const service = await import('./outboxService.js');
    const slow = deferred();
    const row = {
      id: 'slow',
      user_id: 'user-1',
      account_id: 'account-1',
      send_at: NOW,
      message_id: '<slow@example.com>',
      payload: { to: ['slow@example.com'], body: 'Slow' },
    };
    const { deps, claimCount } = workerDeps({
      rows: [row],
      sendMessage: vi.fn().mockReturnValue(slow.promise),
    });

    expect(service.startOutboxWorker).toBeTypeOf('function');
    const worker = service.startOutboxWorker(deps, { tickMs: 1_000 });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(claimCount()).toBe(1);

    slow.resolve({ messageId: '<slow@example.com>' });
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(claimCount()).toBe(2);
    worker.stop();
  });

  it('marks a delivery failure with a sanitized error and never retries it', async () => {
    const service = await import('./outboxService.js');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const row = {
      id: 'failure',
      user_id: 'user-1',
      account_id: 'account-1',
      send_at: NOW,
      message_id: '<failure@example.com>',
      payload: { to: ['failure@example.com'], body: 'Failure' },
    };
    const sendMessage = vi.fn().mockRejectedValue(
      new Error('ECONNREFUSED smtp.secret.internal:2525'),
    );
    const { deps, state } = workerDeps({ rows: [row], sendMessage });

    expect(service.startOutboxWorker).toBeTypeOf('function');
    const worker = service.startOutboxWorker(deps, { tickMs: 1_000 });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(state[0]).toMatchObject({
      status: 'failed',
      error: 'Could not connect to the mail server. Check your SMTP settings.',
    });
    worker.stop();
  });

  it('stop clears the interval', async () => {
    const service = await import('./outboxService.js');
    const { deps, claimCount } = workerDeps();
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

    expect(service.startOutboxWorker).toBeTypeOf('function');
    const worker = service.startOutboxWorker(deps, { tickMs: 1_000 });
    worker.stop();
    await vi.advanceTimersByTimeAsync(3_000);

    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    expect(claimCount()).toBe(0);
  });

  it('unrefs the interval timer so it cannot keep the process alive', async () => {
    const service = await import('./outboxService.js');
    const { deps } = workerDeps();
    const timer = { unref: vi.fn() };
    vi.spyOn(globalThis, 'setInterval').mockReturnValue(timer);

    expect(service.startOutboxWorker).toBeTypeOf('function');
    const worker = service.startOutboxWorker(deps, { tickMs: 1_000 });

    expect(timer.unref).toHaveBeenCalledTimes(1);
    worker.stop();
  });

  it('sweeps on startup and every 12th tick, and purges every 720th tick', async () => {
    const service = await import('./outboxService.js');
    const { deps, query } = workerDeps();

    expect(service.startOutboxWorker).toBeTypeOf('function');
    const worker = service.startOutboxWorker(deps, { tickMs: 1 });
    await vi.runAllTicks();
    for (let tick = 0; tick < 720; tick += 1) {
      await vi.advanceTimersByTimeAsync(1);
    }

    const sweepCalls = query.mock.calls.filter(([sql]) => (
      sql.includes("claimed_at < NOW() - INTERVAL '5 minutes'")
    ));
    const purgeCalls = query.mock.calls.filter(([sql]) => (
      sql.includes('DELETE FROM outbox_messages')
    ));
    expect(sweepCalls).toHaveLength(61);
    expect(purgeCalls).toHaveLength(1);
    worker.stop();
  });
});

describe('outbox worker startup wiring', () => {
  it('arms beside the snooze watcher and exposes the service to MCP', () => {
    const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

    expect(source).toContain("import * as outboxService from './services/outboxService.js';");
    expect(source.indexOf('outboxService.startOutboxWorker(')).toBeGreaterThan(
      source.indexOf('imapManager.startSnoozeWatcher();'),
    );
    expect(source).toContain(`outboxService.startOutboxWorker(
  { imapManager, refreshMicrosoftToken, redisClient, query },
  { tickMs: 5000 },
);`);
    expect(source).toMatch(
      /mountMcp\(app,\s*\{[\s\S]*?sendService,\s*outboxService,\s*draftService,[\s\S]*?\}\);/,
    );
  });
});
