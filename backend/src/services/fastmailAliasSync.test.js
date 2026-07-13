import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('./db.js', () => ({
  pool: { connect: vi.fn() },
  query: vi.fn(),
}));
vi.mock('./encryption.js', () => ({ decrypt: vi.fn(value => `plain:${value}`) }));
vi.mock('./fastmailClient.js', async importOriginal => {
  const actual = await importOriginal();
  return {
    ...actual,
    loadFastmailSession: vi.fn(),
    fetchFastmailSnapshot: vi.fn(),
    createFastmailIdentities: vi.fn(),
  };
});

import { pool, query } from './db.js';
import { decrypt } from './encryption.js';
import {
  createFastmailIdentities,
  fetchFastmailSnapshot,
  loadFastmailSession,
} from './fastmailClient.js';
import {
  mergeFastmailSnapshot,
  startFastmailAliasScheduler,
  syncAllFastmailAliases,
  syncFastmailAliases,
} from './fastmailAliasSync.js';
import { wildcardCovers } from './senderAddress.js';

const account = {
  id: 'a1', name: 'Mailbox', sender_name: 'Configured Sender',
  fastmail_api_token: 'encrypted-token',
};
const session = { apiUrl: 'https://api.fastmail.com/jmap/api/' };
const tx = { query: vi.fn() };
let advisoryLocks;
let lockClients;

function identity(email, overrides = {}) {
  return {
    id: `identity-${email}`, name: 'Identity Name', email,
    replyTo: null, bcc: null, textSignature: '', htmlSignature: '', ...overrides,
  };
}

function mask(email, overrides = {}) {
  return { id: `mask-${email}`, email, state: 'enabled', description: '', ...overrides };
}

function completeSnapshot(email = 'alias@example.com') {
  return { identities: [identity(email)], maskedEmails: [mask(email)] };
}

beforeEach(() => {
  vi.clearAllMocks();
  query.mockImplementation((sql, params) => {
    if (sql.includes('SELECT * FROM email_accounts')) return Promise.resolve({ rows: [account] });
    if (sql.includes('INSERT INTO fastmail_identity_promotions')) {
      return Promise.resolve({
        rows: JSON.parse(params[1]).map(item => ({ masked_email_id: item.id })),
      });
    }
    return Promise.resolve({ rows: [] });
  });
  advisoryLocks = new Map();
  lockClients = [];
  pool.connect.mockImplementation(async () => {
    const client = new EventEmitter();
    client.query = vi.fn(async (sql, params) => {
      const key = params?.join(':');
      if (sql.includes('pg_try_advisory_lock')) {
        if (advisoryLocks.has(key)) return { rows: [{ acquired: false }] };
        advisoryLocks.set(key, client);
        return { rows: [{ acquired: true }] };
      }
      if (sql.includes('pg_advisory_unlock')) {
        const owned = advisoryLocks.get(key) === client;
        if (owned) advisoryLocks.delete(key);
        return { rows: [{ pg_advisory_unlock: owned }] };
      }
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      return tx.query(sql, params);
    });
    client.release = vi.fn();
    lockClients.push(client);
    return client;
  });
  let inserted = 0;
  tx.query.mockImplementation(sql => Promise.resolve(
    sql.includes('FOR UPDATE')
      ? { rows: [account] }
      : sql.includes('INSERT INTO account_aliases')
        ? { rows: [{ id: `inserted-${++inserted}` }] }
        : { rows: [] },
  ));
  loadFastmailSession.mockResolvedValue(session);
  fetchFastmailSnapshot.mockResolvedValue(completeSnapshot());
  createFastmailIdentities.mockResolvedValue(undefined);
});

describe('mergeFastmailSnapshot', () => {
  it('merges identity and enabled mask case-insensitively with identity metadata precedence', () => {
    expect(mergeFastmailSnapshot({
      account,
      identities: [identity('MASK@Example.com', {
        id: 'i1', name: 'Alice',
        replyTo: [{ name: '', email: 'reply@example.com' }],
        htmlSignature: '<b>Alice</b>',
      })],
      maskedEmails: [mask('mask@example.com', { id: 'm1', description: 'Shopping' })],
    })).toMatchObject({
      aliases: [{
        email: 'mask@example.com', name: 'Alice', replyTo: 'reply@example.com',
        signature: '<b>Alice</b>', fastmailIdentityId: 'i1',
        fastmailMaskedEmailId: 'm1', fastmailLabel: 'Shopping',
      }],
      missingMasks: [],
    });
  });

  it('keeps identities and enabled masks, but ignores non-enabled masks', () => {
    const result = mergeFastmailSnapshot({
      account,
      identities: [identity('send@example.com')],
      maskedEmails: [
        mask('pending@example.com', { state: 'pending' }),
        mask('deleted@example.com', { state: 'deleted' }),
      ],
    });
    expect(result.aliases.map(item => item.email)).toEqual(['send@example.com']);
    expect(result.missingMasks).toEqual([]);
  });

  it('preserves distinct Fastmail identities that share one email address', () => {
    const result = mergeFastmailSnapshot({
      account,
      identities: [
        identity('shared@example.com', {
          id: 'identity-formal',
          name: 'Formal Name',
          htmlSignature: '<p>Formal signature</p>',
        }),
        identity('SHARED@example.com', {
          id: 'identity-casual',
          name: 'Casual Name',
          htmlSignature: '<p>Casual signature</p>',
        }),
      ],
      maskedEmails: [],
    });

    expect(result.aliases).toMatchObject([
      {
        email: 'shared@example.com',
        name: 'Formal Name',
        signature: '<p>Formal signature</p>',
        fastmailIdentityId: 'identity-formal',
      },
      {
        email: 'shared@example.com',
        name: 'Casual Name',
        signature: '<p>Casual signature</p>',
        fastmailIdentityId: 'identity-casual',
      },
    ]);
  });

  it.each(['pending', 'disabled', 'deleted'])(
    'keeps an exact Identity sendable when its same-address Masked Email is %s',
    state => {
      const result = mergeFastmailSnapshot({
        account,
        identities: [identity('Overlap@Example.com', {
          id: 'identity-overlap',
          name: 'Verified Identity',
          replyTo: [{ name: '', email: 'reply@example.com' }],
          htmlSignature: '<b>Verified</b>',
        })],
        maskedEmails: [mask('overlap@example.com', {
          id: `mask-${state}`,
          state,
          description: `Mask ${state}`,
        })],
      });

      expect(result).toMatchObject({
        aliases: [{
          email: 'overlap@example.com',
          name: 'Verified Identity',
          replyTo: 'reply@example.com',
          signature: '<b>Verified</b>',
          fastmailIdentityId: 'identity-overlap',
          fastmailMaskedEmailId: null,
          fastmailLabel: null,
        }],
        missingMasks: [],
      });
    },
  );

  it('converts text signatures to safe HTML and sanitizes HTML signatures', () => {
    const result = mergeFastmailSnapshot({
      account,
      identities: [
        identity('text@example.com', { textSignature: '<Alice>\nTeam' }),
        identity('html@example.com', { htmlSignature: '<b onclick="bad()">Alice</b><script>bad()</script>' }),
      ],
      maskedEmails: [],
    });
    expect(result.aliases[0].signature).toBe('&lt;Alice&gt;<br />Team');
    expect(result.aliases[1].signature).toBe('<b>Alice</b>');
  });

  it('preserves every identity Reply-To and Bcc address', () => {
    const result = mergeFastmailSnapshot({
      account,
      identities: [identity('sender@example.com', {
        replyTo: [
          { name: 'Support', email: 'Support@Example.com' },
          { name: null, email: 'archive@example.com' },
        ],
        bcc: [
          { name: 'Compliance', email: 'compliance@example.com' },
          { name: '', email: 'journal@example.com' },
        ],
      })],
      maskedEmails: [],
    });

    expect(result.aliases[0]).toMatchObject({
      replyTo: 'support@example.com',
      fastmailReplyTo: [
        { name: 'Support', email: 'support@example.com' },
        { name: '', email: 'archive@example.com' },
      ],
      fastmailBcc: [
        { name: 'Compliance', email: 'compliance@example.com' },
        { name: '', email: 'journal@example.com' },
      ],
    });
  });

  it('rejects malformed remote records instead of treating them as a complete snapshot', () => {
    expect(() => mergeFastmailSnapshot({
      account,
      identities: [identity('valid@example.com')],
      maskedEmails: [{ id: 'm1', state: 'enabled' }],
    })).toThrow('Fastmail returned an invalid alias snapshot');
  });

  it.each([
    'not-an-address',
    'two@@example.com',
    '*example.com',
    '*@bad domain.example',
  ])('rejects malformed remote identity address %s', email => {
    expect(() => mergeFastmailSnapshot({
      account,
      identities: [identity(email)],
      maskedEmails: [],
    })).toThrow('Fastmail returned an invalid alias snapshot');
  });

  it('rejects malformed identity reply-to addresses', () => {
    expect(() => mergeFastmailSnapshot({
      account,
      identities: [identity('valid@example.com', { replyTo: [{ email: 'not-an-address' }] })],
      maskedEmails: [],
    })).toThrow('Fastmail returned an invalid alias snapshot');
  });

  it.each([
    ['name', { name: null }],
    ['header-unsafe name', { name: 'Sender\r\nBcc: victim@example.com' }],
    ['text signature', { textSignature: null }],
    ['HTML signature', { htmlSignature: null }],
    ['Reply-To list', { replyTo: undefined }],
    ['Bcc list', { bcc: undefined }],
  ])('rejects an identity with malformed %s metadata', (_field, overrides) => {
    expect(() => mergeFastmailSnapshot({
      account,
      identities: [identity('valid@example.com', overrides)],
      maskedEmails: [],
    })).toThrow('Fastmail returned an invalid alias snapshot');
  });

  it.each([
    ['Identity', {
      identities: [
        identity('one@example.com', { id: 'duplicate' }),
        identity('two@example.com', { id: 'duplicate' }),
      ],
      maskedEmails: [],
    }],
    ['Masked Email', {
      identities: [],
      maskedEmails: [
        mask('one@example.com', { id: 'duplicate' }),
        mask('two@example.com', { id: 'duplicate' }),
      ],
    }],
  ])('rejects duplicate %s provider IDs', (_type, snapshot) => {
    expect(() => mergeFastmailSnapshot({ account, ...snapshot }))
      .toThrow('Fastmail returned an invalid alias snapshot');
  });

  it.each([
    ['unknown state', { state: 'paused' }],
    ['non-string description', { description: null }],
  ])('rejects a Masked Email with %s', (_field, overrides) => {
    expect(() => mergeFastmailSnapshot({
      account,
      identities: [],
      maskedEmails: [mask('valid@example.com', overrides)],
    })).toThrow('Fastmail returned an invalid alias snapshot');
  });

  it('reports only masks lacking exact or exact-domain wildcard authorization for promotion', () => {
    const result = mergeFastmailSnapshot({
      account,
      identities: [identity('*@example.com', { id: 'wild' })],
      maskedEmails: [mask('covered@example.com'), mask('missing@sub.example.com')],
    });
    expect(wildcardCovers('*@example.com', 'covered@example.com')).toBe(true);
    expect(wildcardCovers('*@example.com', 'covered@sub.example.com')).toBe(false);
    expect(result.missingMasks.map(item => item.email)).toEqual(['missing@sub.example.com']);
    expect(result.aliases.find(item => item.email === 'covered@example.com')).toMatchObject({
      fastmailIdentityId: null,
      fastmailMaskedEmailId: 'mask-covered@example.com',
    });
  });
});

describe('syncFastmailAliases', () => {
  it('aborts without reconciling when the lock-owning connection is lost', async () => {
    const connectionError = new Error('database connection lost');
    const client = new EventEmitter();
    client.query = vi.fn(async sql => (
      sql.includes('pg_try_advisory_lock')
        ? { rows: [{ acquired: true }] }
        : { rows: [] }
    ));
    client.release = vi.fn();
    pool.connect.mockResolvedValue(client);
    let releaseRemote;
    loadFastmailSession.mockImplementationOnce(() => new Promise(resolve => {
      releaseRemote = () => resolve(session);
    }));

    const syncing = syncFastmailAliases('a1');
    try {
      await vi.waitFor(() => expect(releaseRemote).toBeTypeOf('function'));
      expect(() => client.emit('error', connectionError)).not.toThrow();
      releaseRemote();

      await expect(syncing).rejects.toThrow('Fastmail synchronization lock was lost');
      expect(client.query.mock.calls.some(([sql]) => sql === 'BEGIN')).toBe(false);
      expect(client.release).toHaveBeenCalledWith(connectionError);
      expect(query.mock.calls.some(([sql]) => sql.includes('fastmail_sync_error = $2'))).toBe(false);
    } finally {
      releaseRemote?.();
      await Promise.allSettled([syncing]);
    }
  });

  it('does not duplicate an in-flight identity promotion after lock loss', async () => {
    const workerOne = await import('./fastmailAliasSync.js?worker=promotion-one');
    const workerTwo = await import('./fastmailAliasSync.js?worker=promotion-two');
    const claims = new Set();
    query.mockImplementation(async (sql, params) => {
      if (sql.includes('SELECT * FROM email_accounts')) return { rows: [account] };
      if (sql.includes('INSERT INTO fastmail_identity_promotions')) {
        const rows = [];
        for (const item of JSON.parse(params[1])) {
          if (claims.has(item.id)) continue;
          claims.add(item.id);
          rows.push({ masked_email_id: item.id });
        }
        return { rows };
      }
      return { rows: [] };
    });
    fetchFastmailSnapshot.mockResolvedValue({
      identities: [],
      maskedEmails: [mask('private@example.com', { id: 'mask-private' })],
    });
    let finishFirstPromotion;
    createFastmailIdentities
      .mockImplementationOnce(() => new Promise(resolve => { finishFirstPromotion = resolve; }))
      .mockResolvedValue(undefined);

    const first = workerOne.syncFastmailAliases('a1');
    await vi.waitFor(() => expect(finishFirstPromotion).toBeTypeOf('function'));
    const firstClient = lockClients[0];
    firstClient.emit('error', new Error('database connection lost'));
    for (const [key, owner] of advisoryLocks) {
      if (owner === firstClient) advisoryLocks.delete(key);
    }

    const second = workerTwo.syncFastmailAliases('a1');
    await expect(second).rejects.toThrow('Fastmail identity promotion is already in progress');
    expect(createFastmailIdentities).toHaveBeenCalledOnce();

    finishFirstPromotion();
    await expect(first).rejects.toThrow('Fastmail synchronization lock was lost');
  });

  it('discards the advisory-lock connection when lock acquisition fails', async () => {
    const error = new Error('lock connection failed');
    const client = new EventEmitter();
    client.query = vi.fn().mockRejectedValue(error);
    client.release = vi.fn();
    pool.connect.mockResolvedValue(client);

    await expect(syncFastmailAliases('a1')).rejects.toThrow(error);
    expect(client.release).toHaveBeenCalledWith(error);
  });

  it('discards the advisory-lock connection when unlock fails', async () => {
    const error = new Error('unlock failed');
    const client = new EventEmitter();
    client.query = vi.fn(async (sql, params) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] };
      if (sql.includes('pg_advisory_unlock')) throw error;
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      return tx.query(sql, params);
    });
    client.release = vi.fn();
    pool.connect.mockResolvedValue(client);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});

    await syncFastmailAliases('a1');

    expect(client.release).toHaveBeenCalledWith(error);
    expect(errorLog).toHaveBeenCalledWith('Fastmail synchronization lock release failed');
    errorLog.mockRestore();
  });

  it('batches all promotions, rereads, verifies, then mutates local rows transactionally', async () => {
    fetchFastmailSnapshot
      .mockResolvedValueOnce({ identities: [], maskedEmails: [mask('one@example.com'), mask('two@example.com')] })
      .mockResolvedValueOnce({
        identities: [identity('one@example.com'), identity('two@example.com')],
        maskedEmails: [mask('one@example.com'), mask('two@example.com')],
      });

    await syncFastmailAliases('a1');

    expect(createFastmailIdentities).toHaveBeenCalledOnce();
    expect(createFastmailIdentities.mock.calls[0][2]).toEqual([
      { name: 'Configured Sender', email: 'one@example.com' },
      { name: 'Configured Sender', email: 'two@example.com' },
    ]);
    expect(fetchFastmailSnapshot).toHaveBeenCalledTimes(2);
    expect(lockClients[0].query).toHaveBeenCalledWith('BEGIN');
    expect(lockClients[0].query).toHaveBeenCalledWith('COMMIT');
    expect(tx.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO account_aliases'))).toBe(true);
    expect(tx.query.mock.calls.at(-1)).toEqual([
      expect.stringContaining('fastmail_last_sync = NOW()'), ['a1', 'encrypted-token'],
    ]);
  });

  it('finishes Fastmail network I/O before opening the reconciliation transaction', async () => {
    const events = [];
    loadFastmailSession.mockImplementation(async () => {
      events.push('session');
      return session;
    });
    fetchFastmailSnapshot.mockImplementation(async () => {
      events.push('snapshot');
      return completeSnapshot();
    });
    tx.query.mockImplementation(async sql => {
      if (sql.includes('FOR UPDATE')) {
        events.push('transaction');
        return { rows: [account] };
      }
      if (sql.includes('INSERT INTO account_aliases')) return { rows: [{ id: 'inserted-1' }] };
      return { rows: [] };
    });

    await syncFastmailAliases('a1');

    expect(events).toEqual(['session', 'snapshot', 'transaction']);
  });

  it('persists an explicit blank provider signature without inheriting the account signature', async () => {
    fetchFastmailSnapshot.mockResolvedValue({
      identities: [identity('blank-signature@example.com')],
      maskedEmails: [],
    });

    await syncFastmailAliases('a1');

    const insert = tx.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO account_aliases'));
    expect(insert[1][4]).toBe('');
  });

  it('reconciles a mask-only row if promotion remains incomplete', async () => {
    fetchFastmailSnapshot.mockResolvedValue({
      identities: [], maskedEmails: [mask('private@example.com')],
    });

    await expect(syncFastmailAliases('a1')).rejects.toThrow(
      'Fastmail did not authorize every enabled Masked Email address',
    );

    expect(lockClients[0].query).toHaveBeenCalledWith('COMMIT');
    expect(tx.query.mock.calls[0][0]).toContain('FOR UPDATE');
    const insert = tx.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO account_aliases'));
    expect(insert[1][2]).toBe('private@example.com');
    expect(insert[1][5]).toBeNull();
    expect(insert[1][6]).toBe('mask-private@example.com');
    expect(query).toHaveBeenLastCalledWith(
      expect.stringContaining('fastmail_sync_error = $2'),
      ['a1', 'Fastmail did not authorize every enabled Masked Email address', 'encrypted-token'],
    );
  });

  it('reconciles the authoritative snapshot after a partially successful promotion', async () => {
    fetchFastmailSnapshot
      .mockResolvedValueOnce({
        identities: [],
        maskedEmails: [mask('created@example.com'), mask('rejected@example.com')],
      })
      .mockResolvedValueOnce({
        identities: [identity('created@example.com')],
        maskedEmails: [mask('created@example.com'), mask('rejected@example.com')],
      });

    await expect(syncFastmailAliases('a1')).rejects.toThrow(
      'Fastmail did not authorize every enabled Masked Email address',
    );

    expect(createFastmailIdentities).toHaveBeenCalledOnce();
    expect(fetchFastmailSnapshot).toHaveBeenCalledTimes(2);
    const inserts = tx.query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO account_aliases'));
    expect(inserts).toHaveLength(2);
    expect(inserts.map(([, params]) => params[2])).toEqual([
      'created@example.com',
      'rejected@example.com',
    ]);
    expect(query).toHaveBeenLastCalledWith(
      expect.stringContaining('fastmail_sync_error = $2'),
      ['a1', 'Fastmail did not authorize every enabled Masked Email address', 'encrypted-token'],
    );
  });

  it('preserves the snapshot on remote failure and records only a fixed safe error', async () => {
    fetchFastmailSnapshot.mockRejectedValue(new Error('secret token and alias@example.com'));

    await expect(syncFastmailAliases('a1')).rejects.toThrow();

    expect(lockClients[0].query.mock.calls.some(([sql]) => sql === 'BEGIN')).toBe(false);
    expect(query).toHaveBeenLastCalledWith(
      expect.stringContaining('fastmail_sync_error = $2'),
      ['a1', 'Fastmail synchronization failed', 'encrypted-token'],
    );
  });

  it('rolls back transaction failure and records a safe error afterward', async () => {
    const events = [];
    query.mockImplementation(async (sql, params) => {
      if (sql.includes('SELECT * FROM email_accounts')) {
        events.push('account-load');
        return { rows: [account] };
      }
      if (sql.includes('INSERT INTO fastmail_identity_promotions')) {
        return { rows: JSON.parse(params[1]).map(item => ({ masked_email_id: item.id })) };
      }
      if (sql.includes('DELETE FROM fastmail_identity_promotions')) return { rows: [] };
      events.push('safe-error-update');
      expect(sql).toContain('fastmail_sync_error = $2');
      return { rows: [] };
    });
    tx.query.mockImplementation(async sql => {
      if (sql.includes('FOR UPDATE')) {
        events.push('tx-credential-lock');
        return { rows: [account] };
      }
      if (sql.includes('SELECT id, email')) {
        events.push('tx-select');
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO account_aliases')) {
        events.push('tx-insert');
        return { rows: [{ id: 'inserted-1' }] };
      }
      events.push('tx-delete-failed');
      throw new Error('duplicate alias@example.com');
    });

    await expect(syncFastmailAliases('a1')).rejects.toThrow();

    expect(tx.query).toHaveBeenCalledTimes(4);
    expect(tx.query.mock.calls.map(([sql]) => sql)).toEqual([
      expect.stringContaining('FOR UPDATE'),
      expect.stringContaining("provenance = 'fastmail'"),
      expect.stringContaining('INSERT INTO account_aliases'),
      expect.stringContaining('DELETE FROM account_aliases'),
    ]);
    expect(lockClients[0].query).toHaveBeenCalledWith('ROLLBACK');
    expect(query.mock.calls).toHaveLength(3);
    expect(query.mock.calls.every(([sql]) => !sql.includes('account_aliases'))).toBe(true);
    expect(query).toHaveBeenLastCalledWith(
      expect.stringContaining('fastmail_sync_error = $2'),
      ['a1', 'Fastmail synchronization failed', 'encrypted-token'],
    );
    expect(events).toEqual([
      'account-load', 'tx-credential-lock', 'tx-select', 'tx-insert',
      'tx-delete-failed', 'safe-error-update',
    ]);
  });

  it('selects and deletes only Fastmail rows inside the successful transaction', async () => {
    tx.query
      .mockResolvedValueOnce({ rows: [account] })
      .mockResolvedValueOnce({ rows: [{
        id: 'stale-id', email: 'stale@example.com',
        fastmail_identity_id: 'stale-identity', fastmail_masked_email_id: null,
      }] })
      .mockResolvedValueOnce({ rows: [{ id: 'inserted-1' }] });

    await syncFastmailAliases('a1');

    expect(tx.query.mock.calls[1]).toEqual([
      expect.stringContaining("provenance = 'fastmail'"), ['a1'],
    ]);
    const deleteCall = tx.query.mock.calls.find(([sql]) => sql.includes('DELETE FROM account_aliases'));
    expect(deleteCall[0]).toContain("provenance = 'fastmail'");
    expect(deleteCall[1][0]).toBe('a1');
    expect(deleteCall[1]).not.toContain(undefined);
  });

  it('reconciles same-address identities by Fastmail identity ID', async () => {
    fetchFastmailSnapshot.mockResolvedValue({
      identities: [
        identity('shared@example.com', { id: 'identity-formal', name: 'Formal' }),
        identity('shared@example.com', { id: 'identity-casual', name: 'Casual' }),
      ],
      maskedEmails: [],
    });
    tx.query.mockImplementation(async sql => {
      if (sql.includes('FOR UPDATE')) {
        return { rows: [account] };
      }
      if (sql.includes("provenance = 'fastmail'") && sql.includes('SELECT')) {
        return { rows: [
          {
            id: 'row-formal', email: 'shared@example.com',
            fastmail_identity_id: 'identity-formal', fastmail_masked_email_id: null,
          },
          {
            id: 'row-casual', email: 'shared@example.com',
            fastmail_identity_id: 'identity-casual', fastmail_masked_email_id: null,
          },
        ] };
      }
      return { rows: [] };
    });

    await syncFastmailAliases('a1');

    const updatedRowIds = tx.query.mock.calls
      .filter(([sql]) => sql.includes('UPDATE account_aliases'))
      .map(([, params]) => params[9]);
    expect(updatedRowIds).toEqual(['row-formal', 'row-casual']);
  });

  it('moves a mask association before updating its new same-address identity', async () => {
    const rows = [
      {
        id: 'row-formal', email: 'shared@example.com',
        fastmail_identity_id: 'identity-formal', fastmail_masked_email_id: 'mask-shared',
      },
      {
        id: 'row-casual', email: 'shared@example.com',
        fastmail_identity_id: 'identity-casual', fastmail_masked_email_id: null,
      },
    ];
    fetchFastmailSnapshot.mockResolvedValue({
      identities: [
        identity('shared@example.com', { id: 'identity-casual', name: 'Casual' }),
        identity('shared@example.com', { id: 'identity-formal', name: 'Formal' }),
      ],
      maskedEmails: [mask('shared@example.com', { id: 'mask-shared' })],
    });
    tx.query.mockImplementation(async (sql, params) => {
      if (sql.includes('FOR UPDATE')) return { rows: [account] };
      if (sql.includes("provenance = 'fastmail'") && sql.includes('SELECT')) {
        return { rows: rows.map(row => ({ ...row })) };
      }
      if (sql.includes('SET fastmail_masked_email_id = NULL')) {
        for (const row of rows) {
          if (row.fastmail_masked_email_id === params[1]
              && row.fastmail_identity_id !== params[2]) {
            row.fastmail_masked_email_id = null;
          }
        }
        return { rows: [] };
      }
      if (sql.includes('UPDATE account_aliases')) {
        const row = rows.find(candidate => candidate.id === params[9]);
        if (params[5] && rows.some(candidate => (
          candidate.id !== row.id && candidate.fastmail_masked_email_id === params[5]
        ))) {
          throw new Error('duplicate mask association');
        }
        row.fastmail_identity_id = params[4];
        row.fastmail_masked_email_id = params[5];
      }
      return { rows: [] };
    });

    await syncFastmailAliases('a1');

    expect(rows).toMatchObject([
      { id: 'row-formal', fastmail_masked_email_id: null },
      { id: 'row-casual', fastmail_masked_email_id: 'mask-shared' },
    ]);
  });

  it('coalesces simultaneous triggers for one account into the same Promise', async () => {
    let release;
    loadFastmailSession.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));

    const calls = [
      syncFastmailAliases('a1'),
      syncFastmailAliases('a1'),
      syncFastmailAliases('a1'),
      syncFastmailAliases('a1'),
    ];
    expect(calls.every(promise => promise === calls[0])).toBe(true);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    release(session);
    await Promise.all(calls);
    expect(loadFastmailSession).toHaveBeenCalledOnce();
    expect(fetchFastmailSnapshot).toHaveBeenCalledOnce();
  });

  it('serializes remote promotion across independent process workers', async () => {
    const workerOne = await import('./fastmailAliasSync.js?worker=one');
    const workerTwo = await import('./fastmailAliasSync.js?worker=two');

    let remoteIdentityExists = false;
    fetchFastmailSnapshot.mockImplementation(() => {
      if (remoteIdentityExists) return Promise.resolve(completeSnapshot('shared@example.com'));
      return Promise.resolve({ identities: [], maskedEmails: [mask('shared@example.com')] });
    });
    createFastmailIdentities.mockImplementation(async () => {
      remoteIdentityExists = true;
    });

    await Promise.all([
      workerOne.syncFastmailAliases('a1'),
      workerTwo.syncFastmailAliases('a1'),
    ]);

    expect(createFastmailIdentities).toHaveBeenCalledTimes(1);
  });

  it('keeps independent workers serialized throughout a long-running synchronization', async () => {
    vi.useFakeTimers();
    const workerOne = await import('./fastmailAliasSync.js?worker=long-one');
    const workerTwo = await import('./fastmailAliasSync.js?worker=long-two');

    let releaseFirst;
    loadFastmailSession
      .mockImplementationOnce(() => new Promise(resolve => { releaseFirst = () => resolve(session); }))
      .mockResolvedValue(session);

    const first = workerOne.syncFastmailAliases('a1');
    try {
      await vi.waitFor(() => expect(releaseFirst).toBeTypeOf('function'));
      await vi.advanceTimersByTimeAsync((3 * 60 * 1000) + 1);
      const second = workerTwo.syncFastmailAliases('a1');
      await vi.advanceTimersByTimeAsync(1);

      expect(loadFastmailSession).toHaveBeenCalledOnce();

      releaseFirst();
      await first;
      await vi.advanceTimersByTimeAsync(100);
      await second;
    } finally {
      releaseFirst?.();
      await vi.runAllTimersAsync();
      vi.useRealTimers();
    }
  });

  it('allows different account IDs to synchronize concurrently', async () => {
    const releases = new Map();
    tx.query.mockImplementation((sql, params) => {
      if (!sql.includes('FOR UPDATE')) {
        if (sql.includes('INSERT INTO account_aliases')) return Promise.resolve({ rows: [{ id: 'inserted' }] });
        return Promise.resolve({ rows: [] });
      }
      return new Promise(resolve => releases.set(params[0], resolve));
    });

    const first = syncFastmailAliases('a1');
    const second = syncFastmailAliases('a2');
    await vi.waitFor(() => expect(releases.size).toBe(2));
    releases.get('a1')({ rows: [{ ...account, id: 'a1' }] });
    releases.get('a2')({ rows: [{ ...account, id: 'a2' }] });
    await Promise.all([first, second]);
    expect(loadFastmailSession).toHaveBeenCalledTimes(2);
  });

  it('caps direct synchronization entry points at three concurrent remote operations', async () => {
    let releaseRemote;
    const remoteGate = new Promise(resolve => { releaseRemote = resolve; });
    let active = 0;
    let maximumActive = 0;
    loadFastmailSession.mockImplementation(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await remoteGate;
      active -= 1;
      return session;
    });

    const syncing = ['a1', 'a2', 'a3', 'a4'].map(id => syncFastmailAliases(id));
    try {
      await vi.waitFor(() => expect(maximumActive).toBeGreaterThanOrEqual(3));
      expect(maximumActive).toBe(3);
    } finally {
      releaseRemote();
      await Promise.allSettled(syncing);
    }
  });

  it('queues a complete new-token sync without allowing stale-token writes', async () => {
    const state = {
      account: { ...account, fastmail_api_token: 'encrypted-old' },
      aliases: [{ id: 'before', email: 'before@example.com' }],
      lastSync: 'previous-sync',
      syncError: 'previous-error',
    };
    let releaseOldRemote;
    let inserted = 0;
    query.mockImplementation(async (sql, params) => {
      if (sql.includes('SELECT * FROM email_accounts')) {
        return { rows: [{ ...state.account }] };
      }
      if (sql.includes('fastmail_sync_error = $2')) {
        if (state.account.fastmail_api_token === params[2]) state.syncError = params[1];
        return { rows: [] };
      }
      return { rows: [] };
    });
    fetchFastmailSnapshot.mockImplementation((_session, token) => {
      if (token === 'plain:encrypted-old') {
        return new Promise(resolve => { releaseOldRemote = resolve; });
      }
      return Promise.resolve(completeSnapshot('new@example.com'));
    });
    tx.query.mockImplementation(async (sql, params) => {
      if (sql.includes('FOR UPDATE')) {
        return { rows: [{ ...state.account }] };
      }
      if (sql.includes('SELECT id, email')) return { rows: state.aliases.map(alias => ({ ...alias })) };
      if (sql.includes('INSERT INTO account_aliases')) {
        const alias = { id: `new-${++inserted}`, email: params[2] };
        state.aliases.push(alias);
        return { rows: [{ id: alias.id }] };
      }
      if (sql.includes('DELETE FROM account_aliases')) {
        const retained = params[1] || [];
        state.aliases = state.aliases.filter(alias => retained.includes(alias.id));
        return { rows: [] };
      }
      if (sql.includes('fastmail_last_sync = NOW()')) {
        state.lastSync = 'new-sync';
        state.syncError = null;
        return { rows: [{ id: 'a1' }] };
      }
      return { rows: [] };
    });

    const oldSync = syncFastmailAliases('a1');
    await vi.waitFor(() => expect(releaseOldRemote).toBeTypeOf('function'));
    state.account.fastmail_api_token = 'encrypted-new';
    const replacementSync = syncFastmailAliases('a1', { credentialChanged: true });
    expect(replacementSync).not.toBe(oldSync);
    releaseOldRemote(completeSnapshot('old@example.com'));

    await expect(oldSync).rejects.toThrow('Fastmail credentials changed during synchronization');
    await replacementSync;
    expect(fetchFastmailSnapshot.mock.calls.map(([, token]) => token)).toEqual([
      'plain:encrypted-old',
      'plain:encrypted-new',
    ]);
    expect(state.aliases.map(alias => alias.email)).toEqual(['new@example.com']);
    expect(state).toMatchObject({ lastSync: 'new-sync', syncError: null });
  });
});

describe('syncAllFastmailAliases', () => {
  it('loads enabled configured accounts and synchronizes at most three concurrently', async () => {
    const ids = ['a1', 'a2', 'a3', 'a4'];
    const started = [];
    const releases = new Map();
    let active = 0;
    let maximumActive = 0;
    tx.query.mockImplementation(async (sql, params) => {
      if (sql.includes('FOR UPDATE')) {
        return { rows: [{ ...account, id: params[0], fastmail_api_token: `encrypted-${params[0]}` }] };
      }
      if (sql.includes('INSERT INTO account_aliases')) {
        return { rows: [{ id: `inserted-${params[0]}` }] };
      }
      return { rows: [] };
    });
    query.mockImplementation(async (sql, params) => {
      if (sql.includes('SELECT id FROM email_accounts')) {
        return { rows: ids.map(id => ({ id })) };
      }
      if (sql.includes('SELECT * FROM email_accounts')) {
        const id = params[0];
        return { rows: [{ ...account, id, fastmail_api_token: `encrypted-${id}` }] };
      }
      return { rows: [] };
    });
    loadFastmailSession.mockImplementation(token => new Promise(resolve => {
      const id = token.replace('plain:encrypted-', '');
      started.push(id);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      releases.set(id, () => {
        active -= 1;
        resolve(session);
      });
    }));

    const syncing = syncAllFastmailAliases();
    await vi.waitFor(() => expect(started).toHaveLength(3));
    expect(started).toEqual(['a1', 'a2', 'a3']);
    expect(releases.has('a4')).toBe(false);

    releases.get('a1')();
    await vi.waitFor(() => expect(started).toHaveLength(4));
    expect(started[3]).toBe('a4');
    for (const id of ['a2', 'a3', 'a4']) releases.get(id)();
    await syncing;

    expect(query.mock.calls[0][0]).toContain('fastmail_api_token IS NOT NULL');
    expect(loadFastmailSession).toHaveBeenCalledTimes(4);
    expect(decrypt).toHaveBeenCalledTimes(4);
    expect(maximumActive).toBe(3);
  });

  it('runs on startup and every fifteen minutes', async () => {
    vi.useFakeTimers();
    query.mockResolvedValue({ rows: [] });
    const timer = startFastmailAliasScheduler();
    await vi.runAllTicks();
    expect(query).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(query).toHaveBeenCalledTimes(2);
    clearInterval(timer);
    vi.useRealTimers();
  });
});
