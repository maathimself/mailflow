import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The sender's orchestration against fakes: what one tick costs, boot recovery before the first
// claim, the per-process limit, stopping, and what an overdue claim turns into. The SQL itself
// runs against PostgreSQL in scheduledSend.postgres.test.js.
vi.mock('../index.js', () => ({ imapManager: { broadcast: vi.fn() } }));
vi.mock('./db.js', () => ({ query: vi.fn(), pool: { connect: vi.fn() } }));
vi.mock('./pushNotifications.js', () => ({ sendPushToUser: vi.fn() }));
vi.mock('../utils/mailUtils.js', () => ({ resolveSentFolder: vi.fn() }));

import { ScheduledSender } from './scheduledSend.js';
import { resolveSentFolder } from '../utils/mailUtils.js';
import { MAX_TICK_MS } from './scheduledSendRules.js';

const emptyState = { now: new Date('2026-10-25T07:00:00Z'), next_due: null, stale: false, lapsed: false, purgeable: false };

function fakeDb(state = emptyState) {
  return { query: vi.fn(async () => ({ rows: [state], rowCount: 1 })), connect: vi.fn() };
}

let sender;
afterEach(async () => { await sender?.stop(10); vi.restoreAllMocks(); });
beforeEach(() => {
  vi.stubEnv('ENCRYPTION_KEY', '7a'.repeat(32));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('a tick', () => {
  it('costs one query when there is nothing to do, and waits the full interval', async () => {
    const db = fakeDb();
    sender = new ScheduledSender({ db, imap: () => ({ broadcast: vi.fn() }) });
    expect(await sender.runTick()).toBe(MAX_TICK_MS);
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(db.query.mock.calls[0][0]).toMatch(/MIN\(due_at\) FROM scheduled_messages WHERE status = 'scheduled'/);
  });

  it('recovers only lapsed leases, at boot as later, and never its own claims', async () => {
    const db = fakeDb();
    sender = new ScheduledSender({ db });
    await sender.runTick();
    await sender.runTick();
    expect(db.query.mock.calls.map(c => c[1][0])).toEqual(['180000 milliseconds', '180000 milliseconds']);
    sender.track('11111111-1111-4111-8111-111111111111', new Promise(() => {}), 'm1');
    await sender.runTick();
    expect(db.query.mock.calls[2][1][1]).toEqual(['11111111-1111-4111-8111-111111111111']);
    sender.inFlight.clear();
    sender.leases.clear();
  });

  it('runs recovery before it claims', async () => {
    const db = fakeDb({ ...emptyState, stale: true, next_due: new Date('2026-10-25T06:59:00Z') });
    sender = new ScheduledSender({ db });
    sender.running = true;
    const order = [];
    vi.spyOn(sender, 'recoverStale').mockImplementation(async () => { order.push('recover'); });
    vi.spyOn(sender, 'claimOne').mockImplementation(async () => { order.push('claim'); return null; });
    await sender.runTick();
    expect(order).toEqual(['recover', 'claim']);
  });

  it('claims no more than its share of sends at once', async () => {
    const db = fakeDb({ ...emptyState, next_due: new Date('2026-10-25T06:59:00Z') });
    sender = new ScheduledSender({ db, maxInFlight: 2 });
    sender.running = true;
    let n = 0;
    const claim = vi.spyOn(sender, 'claimOne').mockImplementation(async () => ({ id: `m${++n}`, claim_token: `t${n}` }));
    const releases = [];
    vi.spyOn(sender, 'send').mockImplementation(() => new Promise(resolve => releases.push(resolve)));
    await sender.runTick();
    expect(claim).toHaveBeenCalledTimes(2);
    expect(sender.inFlightCount).toBe(2);
    sender.running = false;
    releases.forEach(r => r());
    await new Promise(resolve => setImmediate(resolve));
    expect(sender.inFlightCount).toBe(0);
  });
});

describe('a claim conflict', () => {
  it('ends only that claim, and the loop goes on with the other accounts', async () => {
    const due = { ...emptyState, next_due: new Date('2026-10-25T06:59:00Z') };
    const db = { query: vi.fn(), connect: vi.fn() };
    db.query
      .mockResolvedValueOnce({ rows: [due] })
      .mockRejectedValueOnce(Object.assign(new Error('duplicate key'), { code: '23505' }))
      .mockResolvedValueOnce({ rows: [{ id: 'm2', claim_token: 't2', lag_ms: 0, first_attempt: true, due_before_start: false }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValue({ rows: [{ now: due.now, next_due: null }] });
    sender = new ScheduledSender({ db, imap: () => ({ broadcast: vi.fn() }) });
    sender.running = true;
    const send = vi.spyOn(sender, 'send').mockResolvedValue(true);
    await sender.runTick();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].id).toBe('m2');
    sender.running = false;
  });
});

describe('the heartbeat', () => {
  it('refreshes the claims in flight, and says when one was taken over', async () => {
    const db = fakeDb();
    db.query.mockResolvedValue({ rows: [{ claim_token: 't1' }] });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    sender = new ScheduledSender({ db });
    sender.track('t1', new Promise(() => {}), 'm1');
    sender.track('t2', new Promise(() => {}), 'm2');
    await sender.heartbeat();
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/SET claimed_at = NOW\(\)\s+WHERE claim_token = ANY\(\$1::uuid\[\]\) AND status = 'sending'/);
    expect(params).toEqual([['t1', 't2']]);
    expect(errors.mock.calls.map(c => c[0])).toEqual([expect.stringContaining('message m2 lost its claim')]);
    sender.inFlight.clear();
  });

  it('stops refreshing a claim stuck for more than 15 min, says so once, and gives up its slot', async () => {
    const db = fakeDb();
    db.query.mockResolvedValue({ rows: [{ claim_token: 't2' }] });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    sender = new ScheduledSender({ db });
    sender.track('t1', new Promise(() => {}), 'm1');
    sender.track('t2', new Promise(() => {}), 'm2');
    sender.leases.get('t1').at = Date.now() - 16 * 60_000;
    await sender.heartbeat();
    await sender.heartbeat();
    expect(db.query.mock.calls.map(c => c[1][0])).toEqual([['t2'], ['t2']]);
    expect(errors.mock.calls.map(c => c[0])).toEqual([expect.stringContaining('message m1 has been in flight for more than 15 min')]);
    expect(sender.inFlight.has('t1')).toBe(false);
    // Recovery may now take it: it is no longer this process's own.
    await sender.runTick();
    expect(db.query.mock.calls.at(-1)[1][1]).toEqual(['t2']);
    sender.inFlight.clear();
    sender.leases.clear();
  });

  it('forgets a claim once it is settled, so it never reports it lost', async () => {
    const db = fakeDb();
    db.query.mockResolvedValue({ rows: [], rowCount: 1 });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    sender = new ScheduledSender({ db });
    sender.track('t1', new Promise(() => {}), 'm1');
    await sender.settle({ id: 'm1', claim_token: 't1' }, { status: 'failed' });
    await sender.heartbeat();
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(errors).not.toHaveBeenCalled();
    sender.inFlight.clear();
  });

  it('costs nothing with no sends in flight', async () => {
    const db = fakeDb();
    sender = new ScheduledSender({ db });
    await sender.heartbeat();
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('recovery', () => {
  it('takes over a claim only if it is still lapsed at that moment', async () => {
    const db = fakeDb();
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'm1', claim_token: 'old' }] })
      .mockResolvedValueOnce({ rows: [] });
    sender = new ScheduledSender({ db });
    await sender.recoverStale('180000 milliseconds');
    const [sql, params] = db.query.mock.calls[1];
    expect(sql).toMatch(/claim_token IS NOT DISTINCT FROM \$2\s+AND \(claimed_at IS NULL OR claimed_at < NOW\(\) - \$4::interval\)/);
    expect(params).toEqual(['m1', 'old', expect.any(String), '180000 milliseconds']);
  });
});

describe('waiting for the Sent folder after a restore', () => {
  const account = { id: 'a1', folder_mappings: { sent: null } };
  const clocked = () => {
    const clock = { now: 0 };
    const sleep = vi.fn(async ms => { clock.now += ms; });
    return { clock, sleep };
  };

  it('looks again each step until the Sent folder resolves', async () => {
    resolveSentFolder.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce('Sent');
    const { clock, sleep } = clocked();
    sender = new ScheduledSender({ db: fakeDb(), sleep, clock: () => clock.now, folderWaitStepMs: 5000, recoveryBudgetMs: 60_000 });
    sender.running = true;
    expect(await sender.awaitSentFolder({ id: 'm1', recoveryClaimedAt: 0 }, account)).toEqual({ path: 'Sent' });
    expect(sleep.mock.calls).toEqual([[5000], [5000]]);
    expect(resolveSentFolder).toHaveBeenCalledWith('a1', { sent: null });
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('stops at the deadline counted from the claim, or when the sender stops', async () => {
    resolveSentFolder.mockResolvedValue(null);
    const { clock, sleep } = clocked();
    sender = new ScheduledSender({ db: fakeDb(), sleep, clock: () => clock.now, folderWaitStepMs: 5000, recoveryBudgetMs: 20_000 });
    sender.running = true;
    // Claimed 10 s before the wait began: 10 s of the budget are left.
    clock.now = 10_000;
    expect(await sender.awaitSentFolder({ id: 'm1', recoveryClaimedAt: 0 }, account)).toEqual({ path: null });
    expect(sleep).toHaveBeenCalledTimes(2);
    sender.running = false;
    expect(await sender.awaitSentFolder({ id: 'm1', recoveryClaimedAt: clock.now }, account)).toEqual({ stopped: true });
    resolveSentFolder.mockReset();
  });

  it('keeps recoveries out of the send slots, and stop waits for both', async () => {
    sender = new ScheduledSender({ db: fakeDb(), maxInFlight: 2 });
    let finish;
    sender.track('r1', new Promise(resolve => { finish = resolve; }), 'm1', { recovery: true });
    expect(sender.inFlightCount).toBe(0);
    expect(sender.recovering.size).toBe(1);
    expect(sender.leases.has('r1')).toBe(true);
    let stopped = false;
    const stopping = sender.stop(5000).then(() => { stopped = true; });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(stopped).toBe(false);
    finish();
    await stopping;
    expect(sender.recovering.size).toBe(0);
  });
});

describe('stop', () => {
  it('stops claiming at once and waits for the sends in flight', async () => {
    sender = new ScheduledSender({ db: fakeDb() });
    sender.start();
    let finish;
    sender.track('t1', new Promise(resolve => { finish = resolve; }));
    let stopped = false;
    const stopping = sender.stop(5000).then(() => { stopped = true; });
    expect(sender.running).toBe(false);
    sender.nudge();
    expect(sender.timer).toBeNull();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(stopped).toBe(false);
    finish();
    await stopping;
    expect(stopped).toBe(true);
  });

  it('gives up waiting after its budget, leaving the rest to recovery', async () => {
    sender = new ScheduledSender({ db: fakeDb() });
    sender.track('t1', new Promise(() => {}));
    const started = Date.now();
    await sender.stop(30);
    expect(Date.now() - started).toBeLessThan(1000);
    sender.inFlight.clear();
  });
});

describe('a claimed message', () => {
  it('more than 6 h overdue is paused and the user told, not sent', async () => {
    const db = fakeDb();
    db.query.mockResolvedValue({ rows: [], rowCount: 1 });
    const push = vi.fn();
    const broadcast = vi.fn();
    sender = new ScheduledSender({ db, push, imap: () => ({ broadcast }) });
    const row = { id: 'm1', user_id: 'u1', claim_token: 't1', version: 1, overdue: true, lateReason: 'offline', send_at: new Date('2026-10-24T22:00:00Z'), time_zone: null, summary_enc: null };
    await sender.send(row);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/WHERE id = \$1 AND claim_token = \$2 AND status = 'sending'/);
    expect(params.slice(0, 5)).toEqual(['m1', 't1', 'paused', 'overdue', 'overdue']);
    expect(broadcast).toHaveBeenCalledWith({ type: 'scheduled_changed', id: 'm1', status: 'paused' }, 'u1');
    expect(push).toHaveBeenCalledWith('u1', expect.objectContaining({
      title: 'Scheduled message', body: expect.stringMatching(/^Not sent: was scheduled for .*MailFlow was offline/), url: '/?scheduled=m1',
    }));
  });
});
