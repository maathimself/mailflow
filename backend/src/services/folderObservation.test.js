import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(callback => callback({ query: vi.fn() })),
}));

import { query, withTransaction } from './db.js';
import { claimFolderObservations, readFolderObservation } from './folderObservation.js';
import * as folderObservations from './folderObservation.js';

const migration = readFileSync(
  new URL('../../migrations/0052_folder_observation_generation.sql', import.meta.url),
  'utf8',
);

describe('folder lifecycle migration', () => {
  it('adds durable folder presence and account topology generations and quarantines unsafe rows', () => {
    expect(migration).toMatch(/folders[\s\S]*is_present\s+BOOLEAN\s+NOT NULL\s+DEFAULT true/i);
    expect(migration).toMatch(/email_accounts[\s\S]*mailbox_topology_generation\s+BIGINT\s+NOT NULL\s+DEFAULT 0/i);
    expect(migration).toMatch(/UPDATE messages[\s\S]*metadata_complete\s*=\s*false/i);
    expect(migration).toMatch(/NOT EXISTS[\s\S]*FROM folders/i);
    expect(migration).toMatch(/uid_validity\s+IS\s+NOT\s+NULL/i);
    expect(migration).toMatch(/is_present\s*=\s*true/i);
    expect(migration).toMatch(/topology_identity\s+UUID\s+NOT NULL/i);
    expect(migration).toMatch(
      /UPDATE folders[\s\S]*is_present\s*=\s*false[\s\S]*uid_validity\s*=\s*NULL/i,
    );
  });
});

describe('folder observation snapshots', () => {
  beforeEach(() => {
    query.mockReset();
    withTransaction.mockReset();
  });

  it('reads a non-advancing snapshot including presence without opening a transaction', async () => {
    query.mockResolvedValueOnce({
      rows: [{ uid_validity: '42', observation_generation: '7', is_present: true }],
    });

    await expect(readFolderObservation('acct-1', 'INBOX')).resolves.toEqual({
      folder: 'INBOX', uidValidity: '42', generation: '7', isPresent: true,
    });

    expect(withTransaction).not.toHaveBeenCalled();
    expect(query.mock.calls[0][0]).toMatch(
      /SELECT uid_validity, observation_generation, topology_identity, is_present/,
    );
  });
});

describe('advancing folder operation contexts', () => {
  beforeEach(() => {
    query.mockReset();
    withTransaction.mockReset();
  });

  it('extends a context under sorted locks while advancing only newly owned paths', async () => {
    const txQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [
        { path: 'Archive', uid_validity: '22', observation_generation: '3', is_present: true },
        { path: 'INBOX', uid_validity: '11', observation_generation: '8', is_present: true },
      ] })
      .mockResolvedValueOnce({ rows: [
        { path: 'Archive', uid_validity: '22', observation_generation: '4', is_present: true },
      ] });
    withTransaction.mockImplementationOnce(callback => callback({ query: txQuery }));

    const context = [{
      folder: 'INBOX', uidValidity: '11', generation: '8', isPresent: true,
    }];
    const expected = [{
      folder: 'Archive', uidValidity: '22', generation: '3', isPresent: true,
    }];

    await expect(claimFolderObservations('acct-1', ['Archive'], { context, expected }))
      .resolves.toEqual([
        { folder: 'Archive', uidValidity: '22', generation: '4', isPresent: true },
        { folder: 'INBOX', uidValidity: '11', generation: '8', isPresent: true },
      ]);

    expect(txQuery.mock.calls[0][1]).toEqual(['acct-1', ['Archive', 'INBOX']]);
    expect(txQuery.mock.calls[0][0]).toMatch(/ORDER BY path[\s\S]*FOR UPDATE/);
    expect(txQuery.mock.calls[1][1]).toEqual(['acct-1', ['Archive']]);
  });

  it('rejects an expected null epoch when the same generation now has a concrete epoch', async () => {
    const txQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [{
        path: 'Archive', uid_validity: '99', observation_generation: '3', is_present: true,
      }] })
      .mockResolvedValueOnce({ rows: [{
        path: 'Archive', uid_validity: '99', observation_generation: '4', is_present: true,
      }] });
    withTransaction.mockImplementationOnce(callback => callback({ query: txQuery }));

    const expected = [{
      folder: 'Archive', uidValidity: null, generation: '3', isPresent: true,
    }];
    await expect(claimFolderObservations('acct-1', ['Archive'], { expected }))
      .rejects.toMatchObject({ code: 'FOLDER_OBSERVATION_UIDVALIDITY_CHANGED' });
    expect(txQuery).toHaveBeenCalledTimes(1);
  });

  it('rejects a recreated folder incarnation even when generation and UIDVALIDITY match', async () => {
    const txQuery = vi.fn().mockResolvedValueOnce({ rows: [{
      path: 'Archive', uid_validity: '99', observation_generation: '3',
      topology_identity: 'new-incarnation', is_present: true,
    }] });
    withTransaction.mockImplementationOnce(callback => callback({ query: txQuery }));

    await expect(claimFolderObservations('acct-1', [], { context: [{
      folder: 'Archive', uidValidity: '99', generation: '3',
      topologyIdentity: 'old-incarnation', isPresent: true,
    }] })).rejects.toMatchObject({ code: 'FOLDER_OBSERVATION_TOPOLOGY_CHANGED' });
  });
});

describe('mailbox topology claims', () => {
  beforeEach(() => {
    query.mockReset();
    withTransaction.mockReset();
  });

  it('claims a durable account-level topology generation', async () => {
    const txQuery = vi.fn().mockResolvedValueOnce({
      rows: [{ mailbox_topology_generation: '12' }],
    });
    withTransaction.mockImplementationOnce(callback => callback({ query: txQuery }));

    const result = await folderObservations.claimMailboxTopology?.('acct-1');
    expect(result).toEqual({ accountId: 'acct-1', generation: '12' });
    expect(txQuery.mock.calls[0][0]).toMatch(
      /UPDATE email_accounts[\s\S]*mailbox_topology_generation = mailbox_topology_generation \+ 1/,
    );
  });

  it('commits a complete LIST atomically by tombstoning absence and resetting reappearances', async () => {
    const txQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [{ mailbox_topology_generation: '12' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ path: 'Gone' }] })
      .mockResolvedValueOnce({ rowCount: 3, rows: [] });
    withTransaction.mockImplementationOnce(callback => callback({ query: txQuery }));

    const result = await folderObservations.commitMailboxTopology?.(
      'acct-1',
      { accountId: 'acct-1', generation: '12' },
      [{
        path: 'Archive', name: 'Archive', delimiter: '/', specialUse: '\\Archive', noSelect: false,
      }],
    );

    expect(result).toEqual({ tombstoned: ['Gone'] });
    expect(withTransaction).toHaveBeenCalledOnce();
    expect(query).not.toHaveBeenCalled();
    expect(txQuery.mock.calls[0][0]).toMatch(/email_accounts[\s\S]*FOR UPDATE/);
    expect(txQuery.mock.calls[1][0]).toMatch(/ORDER BY f\.path[\s\S]*FOR UPDATE OF f/);
    expect(txQuery.mock.calls[2][0]).toMatch(/ON CONFLICT[\s\S]*is_present = true/);
    expect(txQuery.mock.calls[2][0]).toMatch(
      /uid_validity = CASE WHEN folders\.is_present = false THEN NULL/,
    );
    expect(txQuery.mock.calls[2][0]).toMatch(
      /highest_modseq = CASE WHEN folders\.is_present = false THEN NULL/,
    );
    expect(txQuery.mock.calls[2][0]).toMatch(
      /observation_generation = folders\.observation_generation \+[\s\S]*is_present = false/,
    );
    expect(txQuery.mock.calls[3][0]).toMatch(
      /UPDATE folders[\s\S]*is_present = false[\s\S]*uid_validity = NULL[\s\S]*observation_generation = observation_generation \+ 1/,
    );
    expect(txQuery.mock.calls[3][0]).not.toMatch(/DELETE FROM folders/);
    expect(txQuery.mock.calls[4][0]).toMatch(
      /UPDATE messages[\s\S]*metadata_complete = false[\s\S]*uid_validity IS NOT NULL/,
    );
  });

  it('locks the complete returned/current folder union before topology writes', async () => {
    const txQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [{ mailbox_topology_generation: '12' }] })
      .mockResolvedValueOnce({ rows: [
        { path: 'Archive', is_present: true },
        { path: 'Gone', is_present: true },
        { path: 'Old-Tombstone', is_present: false },
      ] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ path: 'Gone' }] })
      .mockResolvedValueOnce({ rowCount: 2, rows: [] });
    withTransaction.mockImplementationOnce(callback => callback({ query: txQuery }));

    await folderObservations.commitMailboxTopology?.(
      'acct-1',
      { accountId: 'acct-1', generation: '12' },
      [
        { path: 'New', name: 'New' },
        { path: 'Archive', name: 'Archive' },
      ],
    );

    const [lockSql, lockParams] = txQuery.mock.calls[1];
    expect(lockParams).toEqual(['acct-1', ['Archive', 'New']]);
    expect(lockSql).toMatch(
      /WITH candidate_paths[\s\S]*unnest\(\$2::text\[\]\)[\s\S]*UNION[\s\S]*FROM folders[\s\S]*ORDER BY f\.path[\s\S]*FOR UPDATE OF f/,
    );
    expect(lockSql).not.toMatch(/is_present\s*=\s*true/);

    const [upsertSql, upsertParams] = txQuery.mock.calls[2];
    expect(upsertSql).toMatch(/INSERT INTO folders/);
    expect(JSON.parse(upsertParams[1]).map(mailbox => mailbox.path)).toEqual(['Archive', 'New']);
    expect(upsertSql).toMatch(/FROM incoming[\s\S]*ORDER BY path[\s\S]*ON CONFLICT/);
    expect(txQuery.mock.calls[3][0]).toMatch(/UPDATE folders/);
  });
});

describe('authoritative folder epoch seeding', () => {
  it('purges quarantined rows before seeding a recreated null-epoch folder', async () => {
    const txQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [{
        uid_validity: null, observation_generation: '9', is_present: true,
      }] })
      .mockResolvedValueOnce({ rowCount: 2, rows: [] })
      .mockResolvedValueOnce({ rows: [{
        path: 'Archive', uid_validity: '77', observation_generation: '9', is_present: true,
      }] });
    const token = {
      folder: 'Archive', uidValidity: null, generation: '9', isPresent: true,
    };

    const result = await folderObservations.seedFolderUidValidity?.(
      { query: txQuery }, 'acct-1', token, '77',
    );

    expect(result).toEqual({
      folder: 'Archive', uidValidity: '77', generation: '9', isPresent: true,
    });
    expect(txQuery.mock.calls[1][0]).toMatch(
      /DELETE FROM messages[\s\S]*metadata_complete = false/,
    );
    expect(txQuery.mock.calls[2][0]).toMatch(/UPDATE folders[\s\S]*uid_validity = \$3/);
    expect(txQuery.mock.calls[2][0].split('WHERE')[0]).not.toMatch(/observation_generation\s*=/);
  });
});
