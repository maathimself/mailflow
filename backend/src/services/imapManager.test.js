import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('imapflow', () => ({ ImapFlow: vi.fn() }));
vi.mock('./db.js', () => {
  const query = vi.fn();
  return {
    query,
    withTransaction: vi.fn(callback => callback({ query })),
    withSession: vi.fn(callback => callback({ query: vi.fn().mockResolvedValue({ rows: [] }) })),
  };
});
vi.mock('./folderObservation.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    claimFolderObservation: vi.fn(async (_accountId, folder) => ({
      folder, uidValidity: null, generation: null,
    })),
    claimFolderObservations: vi.fn(async (_accountId, paths) => paths.map(folder => ({
      folder, uidValidity: null, generation: null,
    }))),
    readFolderObservation: vi.fn(async (_accountId, folder) => ({
      folder, uidValidity: null, generation: null,
    })),
    claimMailboxTopology: vi.fn(async accountId => ({ accountId, generation: '1' })),
    commitMailboxTopology: vi.fn(async () => ({ tombstoned: [] })),
    seedFolderUidValidity: vi.fn(async (_tx, _accountId, token, uidValidity) => ({
      ...token, uidValidity: String(uidValidity), isPresent: true,
    })),
    assertFolderObservation: vi.fn(async (tx, accountId, token) => {
      const result = await tx.query(
        `SELECT uid_validity, highest_modseq FROM folders
          WHERE account_id = $1 AND path = $2
          FOR UPDATE`,
        [accountId, token.folder],
      );
      return result?.rows?.[0] || {
        uid_validity: token.uidValidity, highest_modseq: null, is_present: true,
      };
    }),
  };
});
vi.mock('./messageParser.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    parseMessage: vi.fn(),
    buildSnippetFromHtml: vi.fn(),
    snippetFromBody: vi.fn(),
    decodeMimeWords: vi.fn(),
    detectBulkFromParsedHeaders: vi.fn(),
    parseRawHeaders: vi.fn(),
    enrichParsedMetadata: vi.fn((parsed) => parsed),
  };
});
vi.mock('../routes/oauth.js', () => ({ refreshMicrosoftToken: vi.fn() }));
vi.mock('./emailSanitizer.js', () => ({ sanitizeEmail: vi.fn() }));
vi.mock('./encryption.js', () => ({ decrypt: vi.fn() }));
vi.mock('./aiProvider.js', () => ({ getAiStatus: vi.fn(), completeText: vi.fn() }));
vi.mock('./pushNotifications.js', () => ({ sendPushToUser: vi.fn() }));
vi.mock('../utils/redact.js', () => ({ redactEmail: vi.fn() }));
vi.mock('./hostValidation.js', () => ({ resolveForConnection: vi.fn() }));
vi.mock('./connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn() }));

import { ImapManager, COMPLETE_METADATA_CONFLICT_UPDATE_SQL, providerProfile, makeClientCfg, relocateExemptGuard, insertCopiedSibling, deleteMessageCopyRow, emitSectionsChanged, ensureMailbox, createKeyedSemaphore, isConnectionRefusal, connectCooldownMs, effectiveSyncIntervalMs, folderSyncDue, planModseqSync, connectStaggerFor, walkStructure, parsePersistentCap, resolvePersistentCap, persistentEligible, shouldRetryIPv4, recoveryKeywordAllowed, findSingleRecoveryKeywordUid, findSingleMessageIdUid, recoverProviderMarkerOnClient, searchContainsExactUid, validateRecoveryDestinationUid, desiredFlagDeliverySnapshot, abortPoolClients, registerTemporaryPoolClient, abortConnectionPool, withUidEpochFence, validateFrozenMoveCapabilities, normalizeFrozenMailboxAcquisitionError } from './imapManager.js';
import { pluginRegistry } from '../plugins/registry.js';
import { EventEmitter } from 'node:events';
import { ImapFlow } from 'imapflow';
import { query, withTransaction } from './db.js';
import { resolveForConnection } from './hostValidation.js';
import { getConnectionPolicy } from './connectionPolicy.js';
import { invalidateGtdConfigCache } from '../plugins/gtd/gtdConfig.js';
import { parseMessage } from './messageParser.js';
import {
  assertFolderObservation,
  claimFolderObservation,
  claimFolderObservations,
  claimMailboxTopology,
  commitMailboxTopology,
  readFolderObservation,
  seedFolderUidValidity,
} from './folderObservation.js';
import * as imapModule from './imapManager.js';
import { desiredFlagExecutor } from './desiredFlags.js';
import { buildProviderOperationId, providerOperationMarker } from './providerOperations.js';

const account = (imap_host, oauth_provider = null) => ({ imap_host, oauth_provider });

const resolved = { host: '127.0.0.1', servername: null };
const baseAccount = { imap_host: '127.0.0.1', imap_port: 1143, imap_tls: true, imap_skip_tls_verify: false, auth_user: 'user', auth_pass: 'enc' };
const sourceSnapshot = (uid = 7, {
  accountId = 'acct-1', folder = 'INBOX', uidValidity = '101', generation = '4',
} = {}) => ({
  id: `11111111-1111-4111-8111-${String(uid).padStart(12, '0')}`,
  accountId, uid, folder, uidValidity, folderGeneration: generation,
  readRevision: 1, starRevision: 2,
});
const exactSourceSnapshot = Object.freeze(sourceSnapshot());
const sourceSnapshotMap = (...uids) => new Map(uids.map(uid => [uid, sourceSnapshot(uid)]));

beforeEach(() => {
  withTransaction.mockReset();
  withTransaction.mockImplementation(callback => callback({ query }));
});

describe('metadata conflict flag safety', () => {
  it('never publishes provider flags through a metadata UPSERT without a captured revision CAS', () => {
    expect(COMPLETE_METADATA_CONFLICT_UPDATE_SQL).toMatch(
      /is_read = CASE WHEN NOT messages\.metadata_complete THEN EXCLUDED\.is_read ELSE messages\.is_read END/,
    );
    expect(COMPLETE_METADATA_CONFLICT_UPDATE_SQL).toMatch(
      /is_starred = CASE WHEN NOT messages\.metadata_complete THEN EXCLUDED\.is_starred ELSE messages\.is_starred END/,
    );
    expect(COMPLETE_METADATA_CONFLICT_UPDATE_SQL).not.toMatch(/read_changed_at|star_changed_at|30 seconds/);
  });
});

describe('headerless move recovery protocol', () => {
  const keyword = '$MailFlowMove-row-1';

  it('rejects a mailbox that explicitly disallows new keywords', () => {
    expect(recoveryKeywordAllowed({ permanentFlags: new Set(['\\Seen']) }, keyword)).toBe(false);
    expect(recoveryKeywordAllowed({ permanentFlags: new Set(['\\*']) }, keyword)).toBe(true);
    expect(recoveryKeywordAllowed({}, keyword)).toBe(true);
  });

  it('treats SEARCH false as an error and rejects ambiguous destination markers', async () => {
    await expect(findSingleRecoveryKeywordUid({ search: vi.fn().mockResolvedValue(false) }, keyword))
      .rejects.toThrow(/search/i);
    await expect(findSingleRecoveryKeywordUid({ search: vi.fn().mockResolvedValue([81, 82]) }, keyword))
      .rejects.toThrow(/ambiguous/i);
    await expect(findSingleRecoveryKeywordUid({ search: vi.fn().mockResolvedValue([]) }, keyword))
      .resolves.toBeNull();
  });

  it('requires a unique Message-ID destination and treats SEARCH false as failure', async () => {
    await expect(findSingleMessageIdUid({ search: vi.fn().mockResolvedValue(false) }, 'm@x'))
      .rejects.toThrow(/search/i);
    await expect(findSingleMessageIdUid({
      search: vi.fn().mockResolvedValue([81, 82]),
      fetchOne: vi.fn().mockImplementation(async uid => ({
        uid: Number(uid),
        headers: Buffer.from('Message-ID: <m@x>\r\n'),
      })),
    }, 'm@x'))
      .rejects.toThrow(/ambiguous/i);
    await expect(findSingleMessageIdUid({
      search: vi.fn().mockResolvedValue([82, 82]),
      fetchOne: vi.fn().mockResolvedValue({
        uid: 82,
        headers: Buffer.from('Message-ID: <m@x>\r\n'),
      }),
    }, 'm@x'))
      .resolves.toBe(82);
  });

  it('rejects a sole substring Message-ID search result', async () => {
    const client = {
      search: vi.fn().mockResolvedValue([82]),
      fetchOne: vi.fn().mockResolvedValue({
        uid: 82,
        headers: Buffer.from('Message-ID: <prefix-m@x>\r\n'),
      }),
    };

    await expect(findSingleMessageIdUid(client, '<m@x>'))
      .rejects.toThrow(/does not exactly match/i);
  });

  it('selects the one exact Message-ID when SEARCH also returns substring matches', async () => {
    const client = {
      search: vi.fn().mockResolvedValue([81, 82]),
      fetchOne: vi.fn().mockImplementation(async uid => ({
        uid: Number(uid),
        headers: Buffer.from(Number(uid) === 82
          ? 'Message-ID: <m@x>\r\n'
          : 'Message-ID: <prefix-m@x>\r\n'),
      })),
    };

    await expect(findSingleMessageIdUid(client, '<m@x>')).resolves.toBe(82);
  });

  it('never converts an exact-UID SEARCH command failure into message absence', async () => {
    await expect(searchContainsExactUid({ search: vi.fn().mockResolvedValue(false) }, 7))
      .rejects.toThrow(/search/i);
    await expect(searchContainsExactUid({ search: vi.fn().mockResolvedValue([]) }, 7))
      .resolves.toBe(false);
  });

  it('rejects disagreement between UIDPLUS and the verified keyword destination', () => {
    expect(() => validateRecoveryDestinationUid(81, 82)).toThrow(/uidplus/i);
    expect(validateRecoveryDestinationUid(82, 82)).toBe(82);
    expect(validateRecoveryDestinationUid(null, 82)).toBe(82);
  });

});

describe('causal COPY and APPEND marker protocol', () => {
  const marker = '$MailFlowOp-abcdefghijklmnopqrstuvwxyzABCDEFGH123456789';

  it.each([
    [[], { status: 'absent' }],
    [[88], { status: 'unique', uid: 88, uidValidity: '202' }],
    [[88, 89], { status: 'ambiguous', uids: [88, 89] }],
  ])('recovers only a unique marker match (%j)', async (uids, expected) => {
    const client = { mailbox: { uidValidity: 202 }, search: vi.fn().mockResolvedValue(uids) };
    await expect(recoverProviderMarkerOnClient(client, marker)).resolves.toEqual(expected);
  });
});

describe('durable provider operation wiring', () => {
  afterEach(() => {
    query.mockReset();
    claimFolderObservation.mockClear();
    claimFolderObservations.mockClear();
    readFolderObservation.mockClear();
  });

  it('rejects MOVE, COPY, and bulk MOVE without exact source snapshots', async () => {
    readFolderObservation.mockImplementation(async (_accountId, folder) => ({
      folder, uidValidity: folder === 'INBOX' ? '101' : '202',
      generation: folder === 'INBOX' ? '4' : '8', isPresent: true,
    }));
    const execute = vi.fn();

    await expect(ImapManager.prototype.moveMessage.call(
      { providerOperationExecutor: { execute } },
      { id: 'acct-1' }, 7, 'INBOX', 'Archive', { operationKey: 'move-without-row' },
    )).rejects.toThrow(/exact live message snapshot/i);

    query.mockResolvedValueOnce({ rows: [{ id: 'acct-1' }] });
    await expect(ImapManager.prototype.copyMessage.call(
      { providerOperationExecutor: { execute }, pluginFacade: {} },
      'acct-1', 7, 'INBOX', 'Todo', { operationKey: 'copy-without-row' },
    )).rejects.toThrow(/exact live message snapshot/i);

    await expect(ImapManager.prototype.bulkMoveMessages.call(
      { moveMessage: vi.fn() }, { id: 'acct-1' }, [7], 'INBOX', 'Archive',
      { operationKey: 'bulk-without-rows' },
    )).rejects.toThrow(/exact source snapshot.*uid 7/i);
    expect(execute).not.toHaveBeenCalled();
  });

  it('classifies permanent frozen MOVE capability failures explicitly', () => {
    const marker = '$MailFlowOp-test';
    expect(() => validateFrozenMoveCapabilities({
      client: { capabilities: new Set(), mailbox: { permanentFlags: new Set(['\\*']) } },
    }, marker, { role: 'Source', requireMove: true })).toThrow(expect.objectContaining({
      code: 'PROVIDER_NATIVE_MOVE_UNSUPPORTED', retryable: false,
    }));
    expect(() => validateFrozenMoveCapabilities({
      client: { capabilities: new Set(['MOVE']), mailbox: { permanentFlags: new Set() } },
    }, marker, { role: 'Source', requireMove: true })).toThrow(expect.objectContaining({
      code: 'PROVIDER_RECOVERY_MARKER_UNSUPPORTED', retryable: false,
    }));
    expect(() => validateFrozenMoveCapabilities({
      client: { capabilities: new Set(['MOVE']), mailbox: { permanentFlags: new Set() } },
    }, marker, { role: 'Destination', requireMove: false })).toThrow(expect.objectContaining({
      code: 'PROVIDER_RECOVERY_MARKER_UNSUPPORTED', retryable: false,
    }));
  });

  it('normalizes only explicit frozen mailbox-not-found acquisition failures', () => {
    const missing = Object.assign(new Error('Mailbox does not exist'), { responseStatus: 'NONEXISTENT' });
    expect(normalizeFrozenMailboxAcquisitionError(missing, ['INBOX', 'Archive'])).toMatchObject({
      code: 'PROVIDER_MAILBOX_SUPERSEDED', retryable: false,
    });
    const transient = Object.assign(new Error('socket timeout'), { code: 'ETIMEDOUT', retryable: true });
    expect(normalizeFrozenMailboxAcquisitionError(transient, ['INBOX', 'Archive'])).toBe(transient);
  });

  it.each([
    ['deleted destination', [
      { uid_validity: '202', observation_generation: '8', is_present: false },
    ], 'FOLDER_OBSERVATION_UNSAFE'],
    ['renamed destination', [
      Object.assign(new Error('Archive observation missing'), { code: 'FOLDER_OBSERVATION_SUPERSEDED' }),
    ], 'FOLDER_OBSERVATION_SUPERSEDED'],
    ['deleted source', [
      { uid_validity: '202', observation_generation: '8', is_present: true },
      { uid_validity: '101', observation_generation: '4', is_present: false },
    ], 'FOLDER_OBSERVATION_UNSAFE'],
    ['renamed source', [
      { uid_validity: '202', observation_generation: '8', is_present: true },
      Object.assign(new Error('INBOX observation missing'), { code: 'FOLDER_OBSERVATION_SUPERSEDED' }),
    ], 'FOLDER_OBSERVATION_SUPERSEDED'],
  ])('preflights a frozen MOVE before provider acquisition when the %s is stale', async (
    _case, observations, expectedCode,
  ) => {
    for (const observation of observations) {
      if (observation instanceof Error) assertFolderObservation.mockRejectedValueOnce(observation);
      else assertFolderObservation.mockResolvedValueOnce(observation);
    }
    const execute = vi.fn().mockResolvedValue({ uid: 88, uidValidity: '202' });
    const operationTokens = [
      { folder: 'INBOX', uidValidity: '101', generation: '4', isPresent: true },
      { folder: 'Archive', uidValidity: '202', generation: '8', isPresent: true },
    ];

    await expect(ImapManager.prototype.moveMessage.call(
      { providerOperationExecutor: { execute } },
      { id: 'acct-1' }, 7, 'INBOX', 'Archive', {
        operationKey: 'frozen-move-1', snapshot: exactSourceSnapshot, operationTokens,
      },
    )).rejects.toMatchObject({ code: expectedCode, retryable: false });
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not classify a transient provider connection error as frozen-plan supersession', async () => {
    assertFolderObservation
      .mockResolvedValueOnce({ uid_validity: '202', observation_generation: '8', is_present: true })
      .mockResolvedValueOnce({ uid_validity: '101', observation_generation: '4', is_present: true });
    const transient = Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET', retryable: true });
    const execute = vi.fn().mockRejectedValue(transient);

    await expect(ImapManager.prototype.moveMessage.call(
      { providerOperationExecutor: { execute } },
      { id: 'acct-1' }, 7, 'INBOX', 'Archive', {
        operationKey: 'frozen-move-2', snapshot: exactSourceSnapshot,
        operationTokens: [
          { folder: 'INBOX', uidValidity: '101', generation: '4', isPresent: true },
          { folder: 'Archive', uidValidity: '202', generation: '8', isPresent: true },
        ],
      },
    )).rejects.toBe(transient);
    expect(execute).toHaveBeenCalledOnce();
  });

  it('does not expose orphan raw provider mutation helpers', () => {
    for (const name of ['moveMessageOnClient', 'copyMessageOnClient', 'appendMessageOnClient']) {
      expect(imapModule).not.toHaveProperty(name);
    }
    for (const name of [
      'setFlag', 'moveMessageGetNewUid', 'emptyFolder', 'markAllReadImap',
      'clearMoveRecoveryKeyword', '_bulkMoveMessages', 'bulkPermanentDelete',
    ]) {
      expect(ImapManager.prototype).not.toHaveProperty(name);
    }
  });

  it('routes a headerful MOVE through the same marker identity as a headerless MOVE', async () => {
    readFolderObservation.mockImplementation(async (_accountId, folder) => ({
      folder,
      uidValidity: folder === 'INBOX' ? '101' : '202',
      generation: folder === 'INBOX' ? '4' : '8',
      isPresent: true,
    }));
    const execute = vi.fn().mockResolvedValue({ uid: 88, uidValidity: '202' });
    const ctx = { providerOperationExecutor: { execute } };

    await expect(ImapManager.prototype.moveMessage.call(
      ctx, { id: 'acct-1' }, 7, 'INBOX', 'Archive', {
        messageId: '<duplicate@x>', operationKey: 'move-request-1',
        snapshot: exactSourceSnapshot,
      },
    )).resolves.toBe(88);
    const headerful = execute.mock.calls[0][0].intent;
    execute.mockClear();
    await ImapManager.prototype.moveMessage.call(
      ctx, { id: 'acct-1' }, 7, 'INBOX', 'Archive', {
        messageId: null, operationKey: 'move-request-1', snapshot: exactSourceSnapshot,
      },
    );
    const headerless = execute.mock.calls[0][0].intent;

    expect(headerful.id).toBe(headerless.id);
    expect(headerful.marker).toBe(headerless.marker);
  });

  it('extends a nested observation context by claiming the destination while reusing source ownership', async () => {
    const source = {
      folder: 'INBOX', uidValidity: '101', generation: '4',
      topologyIdentity: 'source-incarnation', isPresent: true,
    };
    const destination = {
      folder: 'Archive', uidValidity: '202', generation: '9',
      topologyIdentity: 'dest-incarnation', isPresent: true,
    };
    const observationContext = { accountId: 'acct-1', tokens: [source] };
    claimFolderObservations.mockResolvedValueOnce([destination, source]);
    const execute = vi.fn().mockResolvedValue({ uid: 88, uidValidity: '202' });

    await ImapManager.prototype.moveMessage.call(
      { providerOperationExecutor: { execute } },
      { id: 'acct-1' }, 7, 'INBOX', 'Archive', {
        operationKey: 'nested-rule-move', observationContext, snapshot: exactSourceSnapshot,
      },
    );

    expect(claimFolderObservations).toHaveBeenCalledWith(
      'acct-1', ['INBOX', 'Archive'], { context: [source] },
    );
    expect(observationContext.tokens).toEqual([destination, source]);
    expect(execute.mock.calls[0][0].intent.source).toMatchObject({
      folder: source.folder, uidValidity: source.uidValidity,
      generation: source.generation, topologyIdentity: source.topologyIdentity,
    });
    expect(execute.mock.calls[0][0].intent.destination).toMatchObject({
      folder: destination.folder, uidValidity: destination.uidValidity,
      generation: destination.generation, topologyIdentity: destination.topologyIdentity,
    });
    expect(readFolderObservation).not.toHaveBeenCalled();
  });

  it('runs MOVE materialization inside the durable completion fence transaction', async () => {
    readFolderObservation.mockImplementation(async (_accountId, folder) => ({
      folder,
      uidValidity: folder === 'INBOX' ? '101' : '202',
      generation: folder === 'INBOX' ? '4' : '8',
      isPresent: true,
    }));
    const tx = { query: vi.fn() };
    const providerReceipt = {
      uid: 88, uidValidity: '202', folder: 'Archive', marker: '$MailFlowOp-test',
    };
    const materialize = vi.fn().mockResolvedValue({ archived: true });
    const execute = vi.fn(spec => spec.complete(providerReceipt, spec.intent, tx));
    const ctx = { providerOperationExecutor: { execute } };

    await expect(ImapManager.prototype.moveMessage.call(
      ctx, { id: 'acct-1' }, 7, 'INBOX', 'Archive', {
        operationKey: 'archive:row-1', returnReceipt: true, materialize,
        snapshot: exactSourceSnapshot,
      },
    )).resolves.toBe(providerReceipt);

    expect(materialize).toHaveBeenCalledWith(providerReceipt, expect.objectContaining({
      kind: 'move', accountId: 'acct-1',
    }), tx, undefined);
  });

  it('cleans a completed MOVE marker from each still-live epoch while accepting a reset side', async () => {
    readFolderObservation.mockImplementation(async (_accountId, folder) => ({
      folder,
      uidValidity: folder === 'INBOX' ? '101' : '202',
      generation: folder === 'INBOX' ? '4' : '8',
      topologyIdentity: folder === 'INBOX' ? 'source-incarnation' : 'dest-incarnation',
      isPresent: true,
    }));
    let spec;
    const execute = vi.fn(async value => {
      spec = value;
      return { uid: 88, uidValidity: '202', folder: 'Archive' };
    });
    await ImapManager.prototype.moveMessage.call(
      { providerOperationExecutor: { execute } },
      { id: 'acct-1' }, 7, 'INBOX', 'Archive', {
        operationKey: 'cleanup-reset-side', snapshot: exactSourceSnapshot,
      },
    );
    const present = new Set([`${spec.intent.marker}:88`]);
    const client = {
      mailbox: { path: 'Archive', uidValidity: 202 },
      search: vi.fn(async queryValue => (
        present.has(`${queryValue.keyword}:${queryValue.uid}`) ? [Number(queryValue.uid)] : []
      )),
      messageFlagsRemove: vi.fn(async (uid, [marker]) => {
        present.delete(`${marker}:${uid}`);
        return true;
      }),
    };
    const switchTo = vi.fn(async folder => {
      client.mailbox = {
        path: folder,
        uidValidity: folder === 'INBOX' ? 999 : 202,
      };
    });
    const operation = {
      ...spec.intent,
      state: 'completed',
      receipt: {
        uid: 88, folder: 'Archive', uidValidity: '202', marker: spec.intent.marker,
        sourceToken: spec.intent.source, destinationToken: spec.intent.destination,
      },
    };

    await expect(spec.cleanup(
      { client, switchTo }, spec.intent.marker, operation.receipt, operation,
    )).resolves.toBeUndefined();
    expect(client.messageFlagsRemove).toHaveBeenCalledOnce();
    expect(client.messageFlagsRemove).toHaveBeenCalledWith('88', [spec.intent.marker], { uid: true });
  });

  it('autonomously retries a bounded batch of completed pending marker cleanups', async () => {
    const operation = {
      id: 'operation-1', accountId: 'acct-1', kind: 'move', marker: '$MailFlowOp-one',
      state: 'completed', cleanupState: 'pending', requestKey: 'request-1',
      source: { folder: 'INBOX', uid: 7, uidValidity: '101', generation: '4' },
      destination: { folder: 'Archive', uidValidity: '202', generation: '8' },
      receipt: { folder: 'Archive', uid: 88, uidValidity: '202' },
    };
    const listPendingCleanup = vi.fn().mockResolvedValue([operation]);
    const removed = [];
    const completeExisting = vi.fn(async (_id, spec) => {
      let present = true;
      const client = {
        mailbox: { path: 'Archive', uidValidity: 202 },
        search: vi.fn(async () => present ? [88] : []),
        messageFlagsRemove: vi.fn(async (uid, markers) => {
          removed.push([uid, markers]);
          present = false;
          return true;
        }),
      };
      await spec.cleanup({
        client,
        switchTo: async folder => {
          client.mailbox = {
            path: folder, uidValidity: folder === 'INBOX' ? 999 : 202,
          };
        },
      }, operation.marker, operation.receipt, operation);
      return { status: 'completed', replayed: true };
    });
    query.mockImplementation(async sql => (
      /SELECT \* FROM email_accounts/.test(sql)
        ? { rows: [{ id: 'acct-1', enabled: true, protocol: 'imap' }] }
        : { rows: [] }
    ));

    await expect(ImapManager.prototype._sweepProviderOperationCleanup.call({
      providerOperationExecutor: { listPendingCleanup, completeExisting },
    }, 5)).resolves.toBe(1);

    expect(listPendingCleanup).toHaveBeenCalledWith(5);
    expect(completeExisting).toHaveBeenCalledWith(
      'operation-1', expect.objectContaining({
        acquireProvider: expect.any(Function), cleanup: expect.any(Function),
      }),
    );
    expect(removed).toEqual([['88', ['$MailFlowOp-one']]]);
  });

  it('defers APPEND before executor/provider access when destination epoch is unknown', async () => {
    readFolderObservation.mockResolvedValueOnce({
      folder: 'Drafts', uidValidity: null, generation: '8', isPresent: true,
    });
    const execute = vi.fn();
    const ctx = { providerOperationExecutor: { execute } };

    await expect(ImapManager.prototype.appendToFolder.call(
      ctx, { id: 'acct-1' }, 'Drafts', Buffer.from('mime'), ['\\Draft'],
      { operationKey: 'draft-request-1' },
    )).rejects.toThrow(/destination uidvalidity/i);
    expect(execute).not.toHaveBeenCalled();
  });

  it('never issues DELETE during provider_started takeover when the persisted marker is absent', async () => {
    readFolderObservation.mockResolvedValueOnce({
      folder: 'Trash', uidValidity: '303', generation: '12',
      topologyIdentity: 'trash-incarnation', isPresent: true,
    });
    let spec;
    const execute = vi.fn(async value => { spec = value; return { status: 'pending' }; });
    const snapshot = sourceSnapshot(7, {
      folder: 'Trash', uidValidity: '303', generation: '12',
    });
    await ImapManager.prototype.permanentDeleteMessage.call(
      { providerOperationExecutor: { execute } },
      { id: 'acct-1' }, 7, 'Trash', {
        snapshot, operationKey: 'delete-row-7', expectedUidValidity: '303',
      },
    );
    const client = {
      capabilities: new Set(['UIDPLUS']),
      search: vi.fn().mockResolvedValue([]),
      messageDelete: vi.fn(),
    };

    await expect(spec.recover({ client }, spec.intent.marker, spec.intent))
      .resolves.toEqual({ status: 'absent' });
    expect(client.messageDelete).not.toHaveBeenCalled();
    expect(client.search).toHaveBeenCalledWith(
      { uid: '7', keyword: spec.intent.marker }, { uid: true },
    );
  });

  it('passes APPEND local materialization through durable completion', async () => {
    readFolderObservation.mockResolvedValueOnce({
      folder: 'Sent', uidValidity: '202', generation: '8', isPresent: true,
    });
    const materialize = vi.fn();
    const execute = vi.fn(async spec => spec.complete({ uid: 88, uidValidity: '202' }));
    const ctx = { providerOperationExecutor: { execute } };

    await expect(ImapManager.prototype.appendToFolder.call(
      ctx, { id: 'acct-1' }, 'Sent', Buffer.from('mime'), ['\\Seen'],
      { operationKey: 'send-request-1', materialize },
    )).resolves.toEqual({ uid: 88, uidValidity: '202', folder: 'Sent' });
    expect(materialize).toHaveBeenCalledWith({ uid: 88, uidValidity: '202', folder: 'Sent' });
  });

  it('routes COPY through a durable marker operation before local sibling work', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'acct-1' }] });
    readFolderObservation.mockImplementation(async (_accountId, folder) => ({
      folder,
      uidValidity: folder === 'INBOX' ? '101' : '202',
      generation: folder === 'INBOX' ? '4' : '8',
      isPresent: true,
    }));
    const execute = vi.fn().mockResolvedValue({ uid: 88, uidValidity: '202', folder: 'Todo' });
    const ctx = { providerOperationExecutor: { execute }, pluginFacade: {} };

    await expect(ImapManager.prototype.copyMessage.call(
      ctx, 'acct-1', 7, 'INBOX', 'Todo', {
        operationKey: 'label-apply-1', snapshot: exactSourceSnapshot,
      },
    )).resolves.toBe(88);

    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0][0].intent).toMatchObject({ kind: 'copy', accountId: 'acct-1' });
  });

  it('defers afterLabelCopy until the durable completion transaction has committed', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'acct-1' }] });
    readFolderObservation.mockImplementation(async (_accountId, folder) => ({
      folder, uidValidity: folder === 'INBOX' ? '101' : '202',
      generation: folder === 'INBOX' ? '4' : '8', isPresent: true,
    }));
    const runHook = vi.spyOn(pluginRegistry, 'runHook').mockResolvedValue(undefined);
    let spec;
    const execute = vi.fn(async value => { spec = value; return { uid: 88 }; });

    await ImapManager.prototype.copyMessage.call(
      { providerOperationExecutor: { execute }, pluginFacade: {} },
      'acct-1', 7, 'INBOX', 'Todo', {
        operationKey: 'label-apply-post-commit', snapshot: exactSourceSnapshot,
      },
    );

    await spec.complete({
      uid: 88, uidValidity: '202', folder: 'Todo', marker: spec.intent.marker,
      sourceToken: spec.intent.source, destinationToken: spec.intent.destination,
    }, spec.intent, { query: vi.fn().mockResolvedValue({ rows: [{ id: 'copy-row', is_read: true }] }) });
    expect(runHook).not.toHaveBeenCalled();
    await spec.afterCommit(spec.intent.receipt || {
      uid: 88, uidValidity: '202', folder: 'Todo', marker: spec.intent.marker,
    });
    expect(runHook).toHaveBeenCalledWith('afterLabelCopy', expect.objectContaining({ newUid: 88 }));
    runHook.mockRestore();
  });

  it('fans bulk MOVE into independently durable causal operations', async () => {
    readFolderObservation.mockImplementation(async (_accountId, folder) => ({
      folder,
      uidValidity: folder === 'INBOX' ? '101' : '202',
      generation: folder === 'INBOX' ? '4' : '8',
      isPresent: true,
    }));
    const execute = vi.fn(async spec => ({
      uid: spec.intent.source.uid + 80,
      uidValidity: '202',
      folder: 'Archive',
    }));
    const ctx = {
      providerOperationExecutor: { execute },
      moveMessage: ImapManager.prototype.moveMessage,
    };

    await expect(ImapManager.prototype.bulkMoveMessages.call(
      ctx, { id: 'acct-1' }, [7, 8], 'INBOX', 'Archive', {
        operationKey: 'bulk-archive-1', sourceSnapshots: sourceSnapshotMap(7, 8),
      },
    )).resolves.toEqual({
      uidMap: new Map([[7, 87], [8, 88]]), succeeded: [7, 8], failed: [],
    });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('extends nested bulk MOVE ownership to its destination before fanning out operations', async () => {
    const source = {
      folder: 'INBOX', uidValidity: '101', generation: '4',
      topologyIdentity: 'source-incarnation', isPresent: true,
    };
    const destination = {
      folder: 'Archive', uidValidity: '202', generation: '9',
      topologyIdentity: 'dest-incarnation', isPresent: true,
    };
    const observationContext = { accountId: 'acct-1', tokens: [source] };
    claimFolderObservations.mockResolvedValueOnce([destination, source]);
    const moveMessage = vi.fn().mockResolvedValue({
      uid: 88, uidValidity: '202', folder: 'Archive',
    });

    await ImapManager.prototype.bulkMoveMessages.call(
      { moveMessage }, { id: 'acct-1' }, [7], 'INBOX', 'Archive', {
        operationKey: 'nested-bulk', observationContext,
        sourceSnapshots: sourceSnapshotMap(7),
      },
    );

    expect(claimFolderObservations).toHaveBeenCalledWith(
      'acct-1', ['INBOX', 'Archive'], { context: [source] },
    );
    expect(observationContext.tokens).toEqual([destination, source]);
    expect(moveMessage).toHaveBeenCalledWith(
      { id: 'acct-1' }, 7, 'INBOX', 'Archive', expect.objectContaining({
        operationTokens: [destination, source],
      }),
    );
  });

  it('reuses each exact source row snapshot through bulk MOVE provider validation', async () => {
    readFolderObservation.mockImplementation(async (_accountId, folder) => ({
      folder,
      uidValidity: folder === 'INBOX' ? '101' : '202',
      generation: folder === 'INBOX' ? '4' : '8',
      isPresent: true,
    }));
    const source = {
      id: '11111111-1111-4111-8111-111111111111', accountId: 'acct-1', uid: 7,
      folder: 'INBOX', uidValidity: '101', folderGeneration: '4',
      readRevision: 1, starRevision: 2,
    };
    const moveMessage = vi.fn().mockResolvedValue({
      uid: 87, uidValidity: '202', folder: 'Archive',
    });

    await ImapManager.prototype.bulkMoveMessages.call(
      { moveMessage }, { id: 'acct-1' }, [7], 'INBOX', 'Archive', {
        operationKey: 'bulk-move', operationKeys: new Map([[7, 'row-key']]),
        sourceSnapshots: new Map([[7, source]]),
      },
    );

    expect(moveMessage).toHaveBeenCalledWith(
      { id: 'acct-1' }, 7, 'INBOX', 'Archive', expect.objectContaining({
        operationKey: 'row-key', expectedUidValidity: '101', snapshot: source,
      }),
    );
  });

  it('forwards the exact source snapshot through the receipt MOVE helper', async () => {
    const snapshot = {
      id: '11111111-1111-4111-8111-111111111111', accountId: 'acct-1', uid: 7,
      folder: 'INBOX', uidValidity: '101', folderGeneration: '4',
      readRevision: 1, starRevision: 2,
    };
    const moveMessage = vi.fn().mockResolvedValue({ uid: 87, folder: 'Archive' });

    await ImapManager.prototype.moveMessageWithReceipt.call(
      { moveMessage }, { id: 'acct-1' }, 7, 'INBOX', 'Archive', {
        expectedUidValidity: '101', operationKey: 'archive:row-1', snapshot,
      },
    );

    expect(moveMessage).toHaveBeenCalledWith(
      { id: 'acct-1' }, 7, 'INBOX', 'Archive', {
        expectedUidValidity: '101', observationContext: null,
        operationKey: 'archive:row-1', materialize: null, snapshot, returnReceipt: true,
      },
    );
  });

  it('reuses the uncertain row operation when a bulk retry contains only the failed subset', async () => {
    readFolderObservation.mockImplementation(async (_accountId, folder) => ({
      folder,
      uidValidity: folder === 'INBOX' ? '101' : '202',
      generation: folder === 'INBOX' ? '4' : '8',
      isPresent: true,
    }));
    const idsForSeven = [];
    const execute = vi.fn(async spec => {
      if (spec.intent.source.uid === 7) {
        idsForSeven.push(spec.intent.id);
        if (idsForSeven.length === 1) throw new Error('uncertain');
      }
      return { uid: spec.intent.source.uid + 80, uidValidity: '202', folder: 'Archive' };
    });
    const ctx = {
      providerOperationExecutor: { execute },
      moveMessage: ImapManager.prototype.moveMessage,
    };
    const operationKeys = new Map([
      [7, 'bulk-archive:request-1:row-7'],
      [8, 'bulk-archive:request-1:row-8'],
    ]);

    await ImapManager.prototype.bulkMoveMessages.call(
      ctx, { id: 'acct-1' }, [7, 8], 'INBOX', 'Archive', {
        operationKey: 'batch:7,8', operationKeys, sourceSnapshots: sourceSnapshotMap(7, 8),
      },
    );
    await ImapManager.prototype.bulkMoveMessages.call(
      ctx, { id: 'acct-1' }, [7], 'INBOX', 'Archive', {
        operationKey: 'batch:7', operationKeys, sourceSnapshots: sourceSnapshotMap(7),
      },
    );

    expect(idsForSeven).toHaveLength(2);
    expect(idsForSeven[1]).toBe(idsForSeven[0]);
  });

  it('fails a row closed when an exact bulk operation-key map omits its uid', async () => {
    readFolderObservation.mockImplementation(async (_accountId, folder) => ({
      folder,
      uidValidity: folder === 'INBOX' ? '101' : '202',
      generation: folder === 'INBOX' ? '4' : '8',
      isPresent: true,
    }));
    const moveMessage = vi.fn().mockResolvedValue({
      uid: 87, uidValidity: '202', folder: 'Archive',
    });
    const ctx = { moveMessage };

    await expect(ImapManager.prototype.bulkMoveMessages.call(
      ctx, { id: 'acct-1' }, [7, 8], 'INBOX', 'Archive', {
        operationKey: 'bulk-archive',
        operationKeys: new Map([[7, 'exact-row-key-7']]),
        sourceSnapshots: sourceSnapshotMap(7, 8),
      },
    )).resolves.toEqual({
      uidMap: new Map([[7, 87]]), succeeded: [7], failed: [8],
    });
    expect(moveMessage).toHaveBeenCalledOnce();
    expect(moveMessage).toHaveBeenCalledWith(
      { id: 'acct-1' }, 7, 'INBOX', 'Archive', expect.objectContaining({
        operationKey: 'exact-row-key-7',
      }),
    );
  });

  it('wakes a snooze by exact row and durable receipt without Message-ID selection', async () => {
    query.mockImplementation(async sql => {
      if (sql.includes('FROM snoozed_messages sm') && sql.includes('JOIN messages')) {
        return { rows: [{
          snooze_id: 'snooze-1', user_id: 'user-1', account_id: 'acct-1',
          message_row_id: 'row-1', message_id_header: '<duplicate@x>',
          original_folder: 'INBOX', snoozed_folder: 'Snoozed', uid: 7, is_read: true,
          folder_uid_validity: '101', folder_observation_generation: '7',
        }] };
      }
      if (sql.includes('SELECT * FROM email_accounts')) return { rows: [{ id: 'acct-1' }] };
      return { rows: [], rowCount: 1 };
    });
    const moveMessage = vi.fn().mockResolvedValue({
      uid: 88, uidValidity: '202', folder: 'INBOX', destinationToken: { generation: '8' },
    });
    const ctx = {
      moveMessage,
      setDesiredFlag: vi.fn().mockResolvedValue({ delivery: { state: 'confirmed' } }),
      _guardMoveUid: vi.fn(), _unguardMoveUid: vi.fn(), broadcast: vi.fn(),
    };

    await ImapManager.prototype._runSnoozeWakeup.call(ctx);

    expect(moveMessage).toHaveBeenCalledWith(
      { id: 'acct-1' }, 7, 'Snoozed', 'INBOX', expect.objectContaining({
        operationKey: 'snooze-wakeup:snooze-1', returnReceipt: true,
        snapshot: expect.objectContaining({ id: 'row-1', uidValidity: '101' }),
        materialize: expect.any(Function),
      }),
    );
    expect(ctx.setDesiredFlag).toHaveBeenCalledWith(
      { id: 'acct-1' }, 'row-1', 'read', false,
      expect.objectContaining({ snapshot: expect.objectContaining({ uid: 88, folder: 'INBOX' }) }),
    );
    expect(query.mock.calls.some(([sql]) => (
      sql.includes('DELETE FROM snoozed_messages sm') && sql.includes('5 minutes')
    ))).toBe(false);
    const dueSql = query.mock.calls[0][0];
    expect(dueSql).toMatch(/m\.metadata_complete\s*=\s*true/i);
    expect(dueSql).toMatch(/JOIN folders live_folder[\s\S]*live_folder\.is_present\s*=\s*true/i);
    expect(dueSql).toMatch(/live_folder\.uid_validity\s+IS\s+NOT\s+NULL/i);
    expect(dueSql).toMatch(/sm\.resolution_state\s*=\s*'active'/i);
  });

  it('keeps the snooze and reports no wakeup when the exact message-row CAS updates zero rows', async () => {
    query.mockImplementation(async sql => {
      if (sql.includes('FROM snoozed_messages sm') && sql.includes('JOIN messages')) {
        return { rows: [{
          snooze_id: 'snooze-1', user_id: 'user-1', account_id: 'acct-1',
          message_row_id: 'row-1', message_id_header: '<duplicate@x>',
          original_folder: 'INBOX', snoozed_folder: 'Snoozed', uid: 7, is_read: true,
          folder_uid_validity: '101', folder_observation_generation: '7',
        }] };
      }
      if (sql.includes('SELECT * FROM email_accounts')) return { rows: [{ id: 'acct-1' }] };
      if (/DELETE FROM snoozed_messages/.test(sql)) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 1 };
    });
    const ctx = {
      moveMessage: vi.fn().mockResolvedValue({ uid: 88, uidValidity: '202', folder: 'INBOX', destinationToken: { generation: '8' } }),
      setDesiredFlag: vi.fn().mockResolvedValue({ delivery: { state: 'confirmed' } }),
      _guardMoveUid: vi.fn(), _unguardMoveUid: vi.fn(), broadcast: vi.fn(),
    };

    await ImapManager.prototype._runSnoozeWakeup.call(ctx);

    expect(query.mock.calls.some(([sql]) => (
      /^DELETE FROM snoozed_messages WHERE id/.test(sql)
    ))).toBe(false);
    expect(query.mock.calls.some(([sql]) => sql.includes('5 minutes'))).toBe(false);
    expect(ctx.broadcast).not.toHaveBeenCalled();
  });

  it('does not select a prior zero-CAS manual snooze on a later watcher run', async () => {
    query.mockResolvedValue({ rows: [], rowCount: 0 });
    const ctx = {
      moveMessage: vi.fn(), setFlag: vi.fn(),
      _guardMoveUid: vi.fn(), _unguardMoveUid: vi.fn(), broadcast: vi.fn(),
    };

    await ImapManager.prototype._runSnoozeWakeup.call(ctx);

    expect(query.mock.calls[0][0]).toMatch(/sm\.resolution_state\s*=\s*'active'/i);
    expect(query.mock.calls).toHaveLength(1);
    expect(ctx.moveMessage).not.toHaveBeenCalled();
  });

  it('surfaces a typed persistence failure when zero-CAS cannot retain the snooze', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    query.mockImplementation(async sql => {
      if (sql.includes('FROM snoozed_messages sm') && sql.includes('JOIN messages')) {
        return { rows: [{
          snooze_id: 'snooze-vanished', user_id: 'user-1', account_id: 'acct-1',
          message_row_id: 'row-1', message_id_header: '<gone@x>',
          original_folder: 'INBOX', snoozed_folder: 'Snoozed', uid: 7, is_read: true,
          folder_uid_validity: '101', folder_observation_generation: '7',
        }] };
      }
      if (sql.includes('SELECT * FROM email_accounts')) return { rows: [{ id: 'acct-1' }] };
      if (/DELETE FROM snoozed_messages/.test(sql)) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 1 };
    });
    const ctx = {
      moveMessage: vi.fn().mockResolvedValue({ uid: 88, uidValidity: '202', folder: 'INBOX', destinationToken: { generation: '8' } }),
      setDesiredFlag: vi.fn().mockResolvedValue({ delivery: { state: 'confirmed' } }),
      _guardMoveUid: vi.fn(), _unguardMoveUid: vi.fn(), broadcast: vi.fn(),
    };

    await ImapManager.prototype._runSnoozeWakeup.call(ctx);

    expect(errorLog.mock.calls.flat().join(' ')).toMatch(/SNOOZE_RESOLUTION_PERSISTENCE_FAILED/);
    expect(query.mock.calls.some(([sql]) => /^DELETE FROM snoozed_messages/.test(sql))).toBe(true);
    expect(ctx.broadcast).not.toHaveBeenCalled();
    errorLog.mockRestore();
  });

  it('re-enters one MOVE operation across fresh manager/process observations', async () => {
    readFolderObservation
      .mockResolvedValueOnce({ folder: 'INBOX', uidValidity: '101', generation: '4', isPresent: true })
      .mockResolvedValueOnce({ folder: 'Archive', uidValidity: '202', generation: '8', isPresent: true })
      .mockResolvedValueOnce({ folder: 'INBOX', uidValidity: '101', generation: '40', isPresent: true })
      .mockResolvedValueOnce({ folder: 'Archive', uidValidity: '202', generation: '80', isPresent: true });
    let operationId;
    let providerCommands = 0;
    const replayingExecutor = {
      async execute(spec) {
        if (operationId == null) {
          operationId = spec.intent.id;
          providerCommands++;
          return { uid: 88, uidValidity: '202', folder: 'Archive' };
        }
        expect(spec.intent.id).toBe(operationId);
        return { uid: 88, uidValidity: '202', folder: 'Archive' };
      },
    };

    const firstManager = { providerOperationExecutor: replayingExecutor };
    const restartedManager = { providerOperationExecutor: replayingExecutor };
    await ImapManager.prototype.moveMessage.call(
      firstManager, { id: 'acct-1' }, 7, 'INBOX', 'Archive', {
        returnReceipt: true, operationKey: 'archive-row-1', snapshot: exactSourceSnapshot,
      },
    );
    await ImapManager.prototype.moveMessage.call(
      restartedManager, { id: 'acct-1' }, 7, 'INBOX', 'Archive', {
        returnReceipt: true, operationKey: 'archive-row-1', snapshot: exactSourceSnapshot,
      },
    );

    expect(providerCommands).toBe(1);
    expect(claimFolderObservations).not.toHaveBeenCalled();
  });

  it('re-enters one APPEND operation across a fresh destination observation', async () => {
    readFolderObservation
      .mockResolvedValueOnce({ folder: 'Sent', uidValidity: '202', generation: '8', isPresent: true })
      .mockResolvedValueOnce({ folder: 'Sent', uidValidity: '202', generation: '80', isPresent: true });
    const ids = [];
    const executor = { execute: vi.fn(async spec => {
      ids.push(spec.intent.id);
      return { uid: 88, uidValidity: '202', folder: 'Sent' };
    }) };

    await ImapManager.prototype.appendToFolder.call(
      { providerOperationExecutor: executor }, { id: 'acct-1' }, 'Sent', Buffer.from('mime'),
      ['\\Seen'], { operationKey: 'send-request-1' },
    );
    await ImapManager.prototype.appendToFolder.call(
      { providerOperationExecutor: executor }, { id: 'acct-1' }, 'Sent', Buffer.from('mime'),
      ['\\Seen'], { operationKey: 'send-request-1' },
    );

    expect(ids[1]).toBe(ids[0]);
    expect(claimFolderObservation).not.toHaveBeenCalled();
  });

  it('re-enters one COPY operation across fresh manager/process observations', async () => {
    query.mockResolvedValue({ rows: [{ id: 'acct-1' }] });
    readFolderObservation
      .mockResolvedValueOnce({ folder: 'INBOX', uidValidity: '101', generation: '4', isPresent: true })
      .mockResolvedValueOnce({ folder: 'Todo', uidValidity: '202', generation: '8', isPresent: true })
      .mockResolvedValueOnce({ folder: 'INBOX', uidValidity: '101', generation: '40', isPresent: true })
      .mockResolvedValueOnce({ folder: 'Todo', uidValidity: '202', generation: '80', isPresent: true });
    let operationId;
    let providerCommands = 0;
    const replayingExecutor = {
      async execute(spec) {
        if (operationId == null) {
          operationId = spec.intent.id;
          providerCommands++;
        } else {
          expect(spec.intent.id).toBe(operationId);
        }
        return { uid: 88, uidValidity: '202', folder: 'Todo' };
      },
    };

    await ImapManager.prototype.copyMessage.call(
      { providerOperationExecutor: replayingExecutor, pluginFacade: {} },
      'acct-1', 7, 'INBOX', 'Todo', {
        operationKey: 'label-apply-1', snapshot: exactSourceSnapshot,
      },
    );
    await ImapManager.prototype.copyMessage.call(
      { providerOperationExecutor: replayingExecutor, pluginFacade: {} },
      'acct-1', 7, 'INBOX', 'Todo', {
        operationKey: 'label-apply-1', snapshot: exactSourceSnapshot,
      },
    );

    expect(providerCommands).toBe(1);
    expect(claimFolderObservations).not.toHaveBeenCalled();
  });

  it('returns the persisted MOVE observation tokens from marker crash recovery', async () => {
    readFolderObservation
      .mockResolvedValueOnce({ folder: 'INBOX', uidValidity: '101', generation: '4', isPresent: true })
      .mockResolvedValueOnce({ folder: 'Archive', uidValidity: '202', generation: '8', isPresent: true });
    let captured;
    const execute = vi.fn(async spec => {
      captured = spec;
      return { uid: 88, uidValidity: '202', folder: 'Archive' };
    });
    await ImapManager.prototype.moveMessage.call(
      { providerOperationExecutor: { execute } },
      { id: 'acct-1' }, 7, 'INBOX', 'Archive', {
        returnReceipt: true, operationKey: 'archive-row-1', snapshot: exactSourceSnapshot,
      },
    );
    query.mockResolvedValueOnce({ rows: [{ uid_validity: 202 }] });
    const client = {
      mailbox: { uidValidity: 202 },
      search: vi.fn().mockResolvedValue([88]),
      close: vi.fn(),
    };

    await expect(captured.recover(
      { client, switchTo: vi.fn() }, captured.intent.marker, captured.intent,
    )).resolves.toEqual({
      status: 'unique', uid: 88, uidValidity: '202', folder: 'Archive',
      sourceToken: captured.intent.source,
      destinationToken: captured.intent.destination,
      marker: captured.intent.marker,
    });
  });

  it('uses persisted destination facts for APPEND validation after public re-entry', async () => {
    readFolderObservation.mockResolvedValueOnce({
      folder: 'Sent', uidValidity: '999', generation: '80', isPresent: true,
    });
    const persisted = {
      destination: { folder: 'Sent', uidValidity: '202', generation: '8', isPresent: true },
    };
    const execute = vi.fn(async spec => {
      await expect(spec.validate(
        {
          client: { mailbox: { permanentFlags: new Set(['\\*']), uidValidity: 202 } },
          folder: 'Sent',
        },
        { query },
        persisted,
      )).resolves.toBeUndefined();
      return { uid: 88, uidValidity: '202', folder: 'Sent' };
    });

    await ImapManager.prototype.appendToFolder.call(
      { providerOperationExecutor: { execute } }, { id: 'acct-1' }, 'Sent', Buffer.from('mime'),
      ['\\Seen'], { operationKey: 'send-request-1' },
    );
  });

  it('rejects a live destination epoch mismatch before first MOVE command', async () => {
    readFolderObservation
      .mockResolvedValueOnce({ folder: 'INBOX', uidValidity: '101', generation: '4', isPresent: true })
      .mockResolvedValueOnce({ folder: 'Archive', uidValidity: '202', generation: '8', isPresent: true });
    const execute = vi.fn(async spec => {
      const operation = spec.intent;
      const tx = { query: vi.fn(async sql => ({
        rows: sql.includes('jsonb_to_recordset') ? [{ id: exactSourceSnapshot.id }] : [],
      })) };
      await expect(spec.validate({
        client: {
          capabilities: new Set(['MOVE']),
          mailbox: { permanentFlags: new Set(['\\*']), uidValidity: 101 },
        },
        uidValidities: new Map([['INBOX', '101'], ['Archive', '999']]),
      }, tx, operation)).rejects.toThrow(/destination uidvalidity/i);
      return { uid: 88, uidValidity: '202', folder: 'Archive' };
    });

    await ImapManager.prototype.moveMessage.call(
      { providerOperationExecutor: { execute } },
      { id: 'acct-1' }, 7, 'INBOX', 'Archive', {
        returnReceipt: true, operationKey: 'archive-row-1', snapshot: exactSourceSnapshot,
      },
    );
  });

  it('validates persisted destination generation and live epoch through MOVE recovery', async () => {
    readFolderObservation
      .mockResolvedValueOnce({ folder: 'INBOX', uidValidity: '101', generation: '40', isPresent: true })
      .mockResolvedValueOnce({ folder: 'Archive', uidValidity: '999', generation: '80', isPresent: true });
    const persisted = {
      source: { folder: 'INBOX', uid: 7, uidValidity: '101', generation: '4' },
      destination: { folder: 'Archive', uidValidity: '202', generation: '8' },
    };
    const execute = vi.fn(async spec => {
      await expect(spec.validateRecovery({
        client: { mailbox: { uidValidity: 999 } },
        uidValidities: new Map([['Archive', '999']]),
      }, { query }, persisted)).rejects.toThrow(/destination uidvalidity/i);
      return { uid: 88, uidValidity: '202', folder: 'Archive' };
    });

    await ImapManager.prototype.moveMessage.call(
      { providerOperationExecutor: { execute } },
      { id: 'acct-1' }, 7, 'INBOX', 'Archive', {
        returnReceipt: true, operationKey: 'archive-row-1', snapshot: exactSourceSnapshot,
      },
    );
    expect(assertFolderObservation).toHaveBeenCalledWith(
      expect.anything(), 'acct-1', persisted.destination,
    );
  });
});

// ── providerProfile — host detection ─────────────────────────────────────────

describe('providerProfile — host detection', () => {
  it.each([
    ['imap.gmail.com'],
    ['imap.googlemail.com'],
    ['smtp.gmail.com'],
  ])('detects google for %s', host => {
    expect(providerProfile(account(host)).pushesFlags).toBe(false);
    expect(providerProfile(account(host)).speculativeFetch).toBe(false);
    expect(providerProfile(account(host)).snippetIndex).toBe(false);
  });

  it.each([
    ['imap.mail.yahoo.com'],
    ['imap.ymail.com'],
    ['smtp.mail.yahoo.com'],
  ])('detects yahoo for %s', host => {
    expect(providerProfile(account(host)).speculativeFetch).toBe(false);
    expect(providerProfile(account(host)).pushesFlags).toBe(true);
    expect(providerProfile(account(host)).snippetIndex).toBe(true);
  });

  it.each([
    ['imap.mail.me.com'],
    ['imap.icloud.com'],
    ['imap.apple.com'],
  ])('detects apple for %s', host => {
    expect(providerProfile(account(host)).speculativeFetch).toBe(true);
    expect(providerProfile(account(host)).batchSize).toBe(200);
  });

  it.each([
    ['outlook.office365.com'],
    ['imap.hotmail.com'],
    ['imap.live.com'],
  ])('detects microsoft for %s', host => {
    expect(providerProfile(account(host)).speculativeFetch).toBe(true);
    expect(providerProfile(account(host)).pushesFlags).toBe(true);
  });

  it.each([
    ['imap.purelymail.com'],
    ['mail.purelymail.com'],
  ])('detects purelymail (IDLE-based profile) for %s', host => {
    const p = providerProfile(account(host));
    // IDLE-first with an aggressive keepalive: one long-lived IDLE connection pushes new
    // mail, re-issued every 4 min so it never goes deaf; the periodic tick is a light
    // backstop. Body work stays conservative (no snippet indexing / speculative fetch,
    // user body fetches bypass the pool) — see PROVIDERS.purelymail.
    expect(p.snippetIndex).toBe(false);
    expect(p.speculativeFetch).toBe(false);
    expect(p.preferFreshBodyFetch).toBe(true);
    expect(p.freshInboxSync).toBe(false);
    expect(p.autoBackfillExistingOnConnect).toBe(false);
    expect(p.usesIdle).toBe(true);
    expect(p.idleKeepaliveMs).toBe(4 * 60 * 1000);
    expect(p.pushesFlags).toBe(false);
    expect(p.maxSyncIntervalMs).toBe(120000);
    expect(p.flagPollEveryTicks).toBe(6);
    expect(p.prefetchNewBodies).toBe(true);
    expect(p.prefetchNewBodiesLimit).toBe(1);
  });

  it.each([
    ['imap.fastmail.com'],
    ['imap.protonmail.com'],
  ])('falls back to generic for unknown host %s', host => {
    const p = providerProfile(account(host));
    expect(p.speculativeFetch).toBe(true);
    expect(p.pushesFlags).toBe(true);
    expect(p.snippetIndex).toBe(true);
  });

  it.each([
    ['acme.com'],
    ['olive.com'],
    ['snapple.com'],
    ['webgmail.ru'],
  ])('does not false-positive on %s', host => {
    expect(providerProfile(account(host))).toBe(providerProfile(account('generic.example.com')));
  });
});

// ── providerProfile — oauth_provider detection ────────────────────────────────

describe('providerProfile — oauth_provider fallback', () => {
  it('detects microsoft via oauth_provider (only supported OAuth flow)', () => {
    expect(providerProfile(account('', 'microsoft')).pushesFlags).toBe(true);
  });

  it('does not detect google via oauth_provider alone — host-based only', () => {
    expect(providerProfile(account('', 'google'))).toBe(providerProfile(account('generic.example.com')));
  });
});

// ── providerProfile — skipFolderPatterns ─────────────────────────────────────

describe('providerProfile — skipFolderPatterns', () => {
  it('google skips All Mail, Starred, Important', () => {
    const { skipFolderPatterns } = providerProfile(account('imap.gmail.com'));
    expect(skipFolderPatterns.some(p => '[Gmail]/All Mail'.toLowerCase().includes(p))).toBe(true);
    expect(skipFolderPatterns.some(p => '[Gmail]/Starred'.toLowerCase().includes(p))).toBe(true);
    expect(skipFolderPatterns.some(p => '[Gmail]/Important'.toLowerCase().includes(p))).toBe(true);
  });

  it('yahoo has no skip patterns', () => {
    expect(providerProfile(account('imap.mail.yahoo.com')).skipFolderPatterns).toHaveLength(0);
  });

  it('generic has no skip patterns', () => {
    // Use a genuinely-unknown host — purelymail.com now routes to its own profile.
    expect(providerProfile(account('imap.fastmail.com')).skipFolderPatterns).toHaveLength(0);
  });
});

// ── providerProfile — robustness ──────────────────────────────────────────────

describe('providerProfile — robustness', () => {
  it('handles null imap_host gracefully', () => {
    expect(() => providerProfile({ imap_host: null, oauth_provider: null })).not.toThrow();
  });

  it('handles missing fields gracefully', () => {
    expect(() => providerProfile({})).not.toThrow();
  });

  it('is case-insensitive for host matching', () => {
    expect(providerProfile(account('IMAP.GMAIL.COM')).pushesFlags).toBe(false);
  });
});

// ── relocateExemptGuard — move-detector exemption ────────────────────────────

describe('relocateExemptGuard — label folder relocate exemption', () => {
  it('is a no-op when no label plugin contributes folders', () => {
    const guard = relocateExemptGuard([], 5);
    expect(guard.clause).toBe('');
    expect(guard.params).toEqual([]);
  });

  it('binds the exempt folders as a single array param', () => {
    const guard = relocateExemptGuard(['Todo', 'Watch'], 5);
    expect(guard.params).toEqual([['Todo', 'Watch']]);
  });

  it('exempts both the target folder ($1) and the row current folder', () => {
    const { clause } = relocateExemptGuard(['Todo'], 5);
    // Target folder being synced ($1) must not be relocated INTO an exempt label folder…
    expect(clause).toContain('$1 <> ALL($5::text[])');
    // …and a row already living in an exempt label folder must not be relocated OUT of it.
    expect(clause).toContain('folder <> ALL($5::text[])');
  });

  it('uses the supplied positional bind index', () => {
    const { clause } = relocateExemptGuard(['Todo'], 7);
    expect(clause).toContain('$7::text[]');
    expect(clause).not.toContain('$5');
  });
});

// ── makeClientCfg — TLS enforcement ──────────────────────────────────────────

describe('makeClientCfg — TLS enforcement', () => {
  it('throws for plain-text IMAP when allowInsecureTls is false', () => {
    expect(() =>
      makeClientCfg({ ...baseAccount, imap_tls: false }, resolved, { policy: { allowInsecureTls: false } })
    ).toThrow(/plain-text IMAP/i);
  });

  it('throws for plain-text IMAP when policy is empty (default)', () => {
    expect(() =>
      makeClientCfg({ ...baseAccount, imap_tls: false }, resolved)
    ).toThrow(/plain-text IMAP/i);
  });

  it('does not throw for plain-text IMAP when allowInsecureTls is true', () => {
    expect(() =>
      makeClientCfg({ ...baseAccount, imap_tls: false }, resolved, { policy: { allowInsecureTls: true } })
    ).not.toThrow();
  });

  it('does not throw for TLS IMAP regardless of allowInsecureTls', () => {
    expect(() =>
      makeClientCfg({ ...baseAccount, imap_tls: true }, resolved, { policy: { allowInsecureTls: false } })
    ).not.toThrow();
    expect(() =>
      makeClientCfg({ ...baseAccount, imap_tls: true }, resolved, { policy: { allowInsecureTls: true } })
    ).not.toThrow();
  });
});

// ── makeClientCfg — rejectUnauthorized ───────────────────────────────────────

describe('makeClientCfg — rejectUnauthorized', () => {
  it('sets rejectUnauthorized true by default (no policy)', () => {
    const cfg = makeClientCfg(baseAccount, resolved);
    expect(cfg.tls.rejectUnauthorized).toBe(true);
  });

  it('sets rejectUnauthorized true when allowInsecureTls is false even if skip_tls_verify is set', () => {
    const cfg = makeClientCfg(
      { ...baseAccount, imap_skip_tls_verify: true },
      resolved,
      { policy: { allowInsecureTls: false } }
    );
    expect(cfg.tls.rejectUnauthorized).toBe(true);
  });

  it('sets rejectUnauthorized false when allowInsecureTls is true and imap_skip_tls_verify is true', () => {
    const cfg = makeClientCfg(
      { ...baseAccount, imap_skip_tls_verify: true },
      resolved,
      { policy: { allowInsecureTls: true } }
    );
    expect(cfg.tls.rejectUnauthorized).toBe(false);
  });

  it('sets rejectUnauthorized true when allowInsecureTls is true but imap_skip_tls_verify is false', () => {
    const cfg = makeClientCfg(
      { ...baseAccount, imap_skip_tls_verify: false },
      resolved,
      { policy: { allowInsecureTls: true } }
    );
    expect(cfg.tls.rejectUnauthorized).toBe(true);
  });

  it('sets servername from resolved when present', () => {
    const cfg = makeClientCfg(baseAccount, { host: '142.250.80.46', servername: 'imap.gmail.com' });
    expect(cfg.tls.servername).toBe('imap.gmail.com');
  });

  it('does not set servername when resolved.servername is null', () => {
    const cfg = makeClientCfg(baseAccount, resolved);
    expect(cfg.tls.servername).toBeUndefined();
  });

  it('uses the original hostname with a pinned multi-address lookup', () => {
    const lookup = vi.fn();
    const cfg = makeClientCfg(baseAccount, {
      host: '203.0.113.1',
      servername: 'imap.example.com',
      addresses: ['203.0.113.1', '203.0.113.2'],
      lookup,
    });
    expect(cfg.host).toBe('imap.example.com');
    expect(cfg.tls.lookup).toBe(lookup);
    expect(cfg.tls.autoSelectFamily).toBe(true);
    expect(cfg.tls.autoSelectFamilyAttemptTimeout).toBe(1000);
  });
});

// ── copyMessage DB side — insertCopiedSibling ────────────────────────────────
// The IMAP COPY itself runs through withFreshClient (not unit-testable without a
// live pool), so the destination-sibling INSERT is extracted here and tested with
// the UID a UIDPLUS copyuid map would yield — same seam as gtdRelocateGuard in 1a.

const findCall = (frag) => query.mock.calls.find(([sql]) => sql.includes(frag));
const countAdjusts = () => query.mock.calls.filter(([sql]) => sql.includes('UPDATE folders'));

describe('insertCopiedSibling', () => {
  beforeEach(() => query.mockReset());
  const receipt = {
    uid: 5001, marker: '$MailFlowOp-copy-row-1',
    destinationToken: { folder: 'Todo', uidValidity: '202', generation: '8' },
  };

  it('inserts the destination sibling from the source row with the copied UID', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'row-new', is_read: true }] });
    query.mockResolvedValue({ rows: [] });

    await insertCopiedSibling('acct-1', 100, 'INBOX', 'Todo', 5001, { receipt });

    const ins = findCall('INSERT INTO messages');
    expect(ins).toBeTruthy();
    // Content columns come from the source row; only uid ($4) and folder ($5) change.
    expect(ins[0]).toContain('FROM messages');
    expect(ins[0]).toContain('WHERE account_id = $1 AND folder = $2 AND uid = $3');
    // Idempotent against the next destination-folder sync.
    expect(ins[0]).toContain('ON CONFLICT (account_id, uid, folder) DO NOTHING');
    expect(ins[1]).toEqual([
      'acct-1', 'INBOX', 100, 5001, 'Todo', receipt.marker,
    ]);
    // delivery_addresses is copied verbatim from the source row, same as list_unsubscribe.
    expect(ins[0]).toContain('delivery_addresses');
    expect(ins[0]).toMatch(/has_attachments, flags,\s+body_html[\s\S]*SELECT[\s\S]*has_attachments, COALESCE\(flags/);
  });

  it('increments destination unread only when the copied message is unread', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'row-new', is_read: false }] });
    query.mockResolvedValue({ rows: [] });
    await insertCopiedSibling('acct-1', 100, 'INBOX', 'Todo', 5001, { receipt });
    // total +1, unread +1 for an unread copy.
    expect(countAdjusts()[0][1]).toEqual([1, 1, 'acct-1', 'Todo']);
  });

  it('counts total but not unread for a read copy', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'row-new', is_read: true }] });
    query.mockResolvedValue({ rows: [] });
    await insertCopiedSibling('acct-1', 100, 'INBOX', 'Todo', 5001, { receipt });
    expect(countAdjusts()[0][1]).toEqual([1, 0, 'acct-1', 'Todo']);
  });

  it('fails closed when a conflicting destination row is not an exact live marker receipt', async () => {
    query.mockResolvedValueOnce({ rows: [] }); // DO NOTHING → no RETURNING row
    query.mockResolvedValueOnce({ rows: [] });
    await expect(insertCopiedSibling(
      'acct-1', 100, 'INBOX', 'Todo', 5001, { receipt },
    )).rejects.toMatchObject({ code: 'COPY_DESTINATION_NOT_ACTIONABLE' });
    expect(countAdjusts()).toHaveLength(0);
  });

  it('accepts only an exact live marker-bearing conflict as idempotent completion', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    query.mockResolvedValueOnce({ rows: [{ id: 'row-synced' }] });

    await expect(insertCopiedSibling(
      'acct-1', 100, 'INBOX', 'Todo', 5001, { receipt },
    )).resolves.toBe('row-synced');
    const verify = query.mock.calls[1];
    expect(verify[0]).toMatch(/m\.metadata_complete = true/);
    expect(verify[0]).toMatch(/m\.is_deleted = false/);
    expect(verify[0]).toMatch(/m\.flags @> jsonb_build_array/);
    expect(verify[0]).toMatch(/f\.uid_validity = \$5/);
    expect(verify[0]).toMatch(/f\.observation_generation = \$6/);
    expect(verify[1]).toEqual(['acct-1', 5001, 'Todo', receipt.marker, '202', '8']);
  });
});

// ── removeMessageCopy DB side — deleteMessageCopyRow ─────────────────────────

describe('deleteMessageCopyRow', () => {
  beforeEach(() => query.mockReset());

  it('deletes exactly one folder copy, scoped by (account_id, uid, folder)', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    query.mockResolvedValueOnce({ rows: [{ is_read: true }] });
    query.mockResolvedValue({ rows: [] });

    await deleteMessageCopyRow('acct-1', 100, 'Todo');

    const del = findCall('DELETE FROM messages');
    expect(del[0]).toContain('WHERE account_id = $1 AND uid = $2 AND folder = $3');
    // Never keyed on message_id — sibling rows in other folders are left intact.
    expect(del[0]).not.toContain('message_id');
    expect(del[1]).toEqual(['acct-1', 100, 'Todo']);
  });

  it('decrements the folder count, dropping unread only if the removed copy was unread', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    query.mockResolvedValueOnce({ rows: [{ is_read: false }] });
    query.mockResolvedValue({ rows: [] });
    await deleteMessageCopyRow('acct-1', 100, 'Todo');
    expect(countAdjusts()[0][1]).toEqual([-1, -1, 'acct-1', 'Todo']);
  });

  it('waits for the label-folder count write before confirming the row deletion', async () => {
    let releaseCount;
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ is_read: false }] })
      .mockReturnValueOnce(new Promise(resolve => { releaseCount = resolve; }));
    let settled = false;

    const pending = deleteMessageCopyRow('acct-1', 100, 'Todo')
      .then(result => { settled = true; return result; });
    await Promise.resolve();
    await Promise.resolve();

    expect(settled).toBe(false);
    releaseCount({ rows: [] });
    await expect(pending).resolves.toBe(1);
  });

  it('adjusts no counts when the row was already gone', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    query.mockResolvedValueOnce({ rows: [] });
    await deleteMessageCopyRow('acct-1', 100, 'Todo');
    expect(countAdjusts()).toHaveLength(0);
  });

  it('CAS-deletes the exact snapshot id when one is supplied', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    query.mockResolvedValueOnce({ rows: [{ is_read: true }] });
    query.mockResolvedValue({ rows: [] });

    await deleteMessageCopyRow('acct-1', 100, 'Todo', 'row-1');

    const del = findCall('DELETE FROM messages');
    expect(del[0]).toContain('id = $4');
    expect(del[1]).toEqual(['acct-1', 100, 'Todo', 'row-1']);
  });
});

describe('interrupted message-copy mutation recovery', () => {
  beforeEach(() => query.mockReset());

  const archiveRow = {
    id: 'row-1', account_id: 'acct-1', uid: 7, folder: 'INBOX',
    message_id: '<duplicate@x>', is_read: true, folder_uid_validity: 101,
  };
  const archiveReceipt = {
    folder: 'Archive', uid: 88, uidValidity: '202',
    sourceToken: { folder: 'INBOX', uid: 7, uidValidity: '101', generation: '4' },
    destinationToken: { folder: 'Archive', uidValidity: '202', generation: '8' },
  };
  const archiveOperationId = buildProviderOperationId({
    kind: 'move', accountId: 'acct-1', requestKey: 'archive:row-1',
    source: archiveReceipt.sourceToken, destinationFolder: 'Archive',
  });
  const exactArchiveOperation = state => ({
    id: archiveOperationId,
    kind: 'move',
    accountId: 'acct-1',
    marker: providerOperationMarker(archiveOperationId),
    source: archiveReceipt.sourceToken,
    destination: archiveReceipt.destinationToken,
    state,
    receipt: state === 'provider_started' ? null : {
      ...archiveReceipt, marker: providerOperationMarker(archiveOperationId),
    },
  });

  function archiveQueries({ coarseRows = [], allMail = false, confirmed = true } = {}) {
    query.mockImplementation(async sql => {
      if (typeof sql !== 'string') return { rows: [] };
      if (sql.includes('no_select = false')) return { rows: [{ '?column?': 1 }] };
      if (sql.includes("special_use = '\\All'")) {
        return { rows: allMail ? [{ '?column?': 1 }] : [] };
      }
      if (sql.includes('FROM provider_operations')) return { rows: coarseRows };
      if (sql.includes('JOIN folders live_folder')) {
        return { rows: confirmed ? [{ id: 'row-1' }] : [] };
      }
      if (sql.includes('SELECT 1 FROM messages WHERE id')) {
        return { rows: confirmed ? [{ '?column?': 1 }] : [] };
      }
      return { rows: [] };
    });
  }

  it('never uses a duplicate Message-ID as causal evidence when no durable receipt exists', async () => {
    const acct = { id: 'acct-1', folder_mappings: { archive: 'Archive' } };
    const stale = {
      id: 'row-1', account_id: 'acct-1', uid: 7, folder: 'INBOX',
      message_id: '<duplicate@x>', is_read: true,
    };
    const ctx = {
      findUidByMessageIdReceipt: vi.fn(),
      findUidByRecoveryKeywordReceipt: vi.fn(),
    };
    query.mockImplementation(async sql => {
      if (typeof sql !== 'string') return { rows: [] };
      if (sql.includes("special_use = '\\All'")) return { rows: [] };
      if (sql.includes('SELECT 1 FROM folders')) return { rows: [{ '?column?': 1 }] };
      if (sql.includes('SELECT receipt')) return { rows: [] };
      return { rows: [] };
    });

    await expect(ImapManager.prototype.reconcileMissingMessageCopy.call(ctx, acct, stale))
      .resolves.toEqual({ reconciled: false, changed: 0 });
    expect(ctx.findUidByMessageIdReceipt).not.toHaveBeenCalled();
    expect(ctx.findUidByRecoveryKeywordReceipt).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]) => sql.includes('UPDATE messages SET folder'))).toBe(false);
  });

  it.each(['ordinary', 'bulk'])('ignores an unrelated %s MOVE with the same coarse tuple', async kind => {
    const acct = { id: 'acct-1', folder_mappings: { archive: 'Archive' } };
    archiveQueries({ coarseRows: [{ receipt: { ...archiveReceipt, marker: `$${kind}-move` } }] });
    const completeExisting = vi.fn().mockResolvedValue({ status: 'missing' });
    const ctx = {
      providerOperationExecutor: { completeExisting },
      moveMessage: vi.fn(), moveMessageWithReceipt: vi.fn(),
    };

    await expect(ImapManager.prototype.reconcileMissingMessageCopy.call(ctx, acct, archiveRow))
      .resolves.toEqual({ reconciled: false, changed: 0 });
    expect(completeExisting).toHaveBeenCalledWith(archiveOperationId, expect.any(Object));
    expect(query.mock.calls.some(([sql]) => sql.includes('FROM provider_operations'))).toBe(false);
    expect(ctx.moveMessage).not.toHaveBeenCalled();
    expect(ctx.moveMessageWithReceipt).not.toHaveBeenCalled();
  });

  it('selects the exact archive operation when multiple coarse MOVE receipts exist', async () => {
    const acct = { id: 'acct-1', folder_mappings: { archive: 'Archive' } };
    archiveQueries({ coarseRows: [{ receipt: { uid: 40 } }, { receipt: archiveReceipt }] });
    const operation = exactArchiveOperation('completed');
    const completeExisting = vi.fn(async (operationId, spec) => {
      expect(operationId).toBe(archiveOperationId);
      await spec.validateExisting(operation);
      return { status: 'completed', operation, receipt: operation.receipt, replayed: true };
    });
    const ctx = {
      providerOperationExecutor: { completeExisting },
      moveMessage: vi.fn(), moveMessageWithReceipt: vi.fn(),
    };

    await expect(ImapManager.prototype.reconcileMissingMessageCopy.call(ctx, acct, archiveRow))
      .resolves.toEqual({ reconciled: true, changed: 0 });
    expect(query.mock.calls.some(([sql]) => sql.includes('FROM provider_operations'))).toBe(false);
    expect(ctx.moveMessage).not.toHaveBeenCalled();
    expect(ctx.moveMessageWithReceipt).not.toHaveBeenCalled();
  });

  it('supplies a topology-safe fresh intent when completing an interrupted archive MOVE', async () => {
    const acct = { id: 'acct-1', folder_mappings: { archive: 'Archive' } };
    const recoverableRow = {
      ...archiveRow,
      folder_observation_generation: '4',
      folder_topology_identity: 'source-incarnation',
    };
    archiveQueries();
    readFolderObservation.mockImplementation(async (_accountId, folder) => ({
      folder,
      uidValidity: folder === 'INBOX' ? '101' : '202',
      generation: folder === 'INBOX' ? '40' : '80',
      topologyIdentity: folder === 'INBOX' ? 'source-incarnation' : 'dest-incarnation',
      isPresent: true,
    }));
    const completeExisting = vi.fn(async (_operationId, spec) => {
      expect(spec.intent).toMatchObject({
        source: { generation: '40', topologyIdentity: 'source-incarnation' },
        destination: { generation: '80', topologyIdentity: 'dest-incarnation' },
      });
      return { status: 'pending', operation: exactArchiveOperation('provider_started') };
    });

    await expect(ImapManager.prototype.reconcileMissingMessageCopy.call({
      providerOperationExecutor: { completeExisting },
    }, acct, recoverableRow)).resolves.toEqual({ reconciled: false, changed: 0 });
  });

  it.each([
    ['provider_started', false],
    ['provider_applied', true],
    ['completed', true],
  ])('consumes only the exact archive %s state without provider work', async (state, reconciled) => {
    const acct = { id: 'acct-1', folder_mappings: { archive: 'Archive' } };
    archiveQueries();
    const operation = exactArchiveOperation(state);
    const completeExisting = vi.fn(async (operationId, spec) => {
      expect(operationId).toBe(archiveOperationId);
      await spec.validateExisting(operation);
      if (state === 'provider_started') return { status: 'pending', operation };
      return {
        status: 'completed', operation, receipt: operation.receipt,
        replayed: state === 'completed',
      };
    });
    const ctx = {
      providerOperationExecutor: { completeExisting },
      moveMessage: vi.fn(), moveMessageWithReceipt: vi.fn(),
    };

    await expect(ImapManager.prototype.reconcileMissingMessageCopy.call(ctx, acct, archiveRow))
      .resolves.toEqual({ reconciled, changed: 0 });
    expect(ctx.moveMessage).not.toHaveBeenCalled();
    expect(ctx.moveMessageWithReceipt).not.toHaveBeenCalled();
  });

  it.each([
    ['operation marker', operation => ({ ...operation, marker: '$wrong-marker' })],
    ['source generation', operation => ({
      ...operation, source: { ...operation.source, generation: null },
    })],
    ['destination generation', operation => ({
      ...operation, destination: { ...operation.destination, generation: '999' },
    })],
    ['receipt source token', operation => ({
      ...operation,
      receipt: {
        ...operation.receipt,
        sourceToken: { ...operation.receipt.sourceToken, generation: '999' },
      },
    })],
  ])('rejects a stored archive operation with mismatched exact %s', async (_field, mutate) => {
    const acct = { id: 'acct-1', folder_mappings: { archive: 'Archive' } };
    archiveQueries();
    const operation = mutate(exactArchiveOperation('completed'));
    const completeExisting = vi.fn(async (_operationId, spec) => {
      await spec.validateExisting(operation);
      return { status: 'completed', operation, receipt: operation.receipt, replayed: true };
    });
    const ctx = {
      providerOperationExecutor: { completeExisting },
      moveMessage: vi.fn(), moveMessageWithReceipt: vi.fn(),
    };

    await expect(ImapManager.prototype.reconcileMissingMessageCopy.call(ctx, acct, archiveRow))
      .rejects.toMatchObject({
        code: 'PROVIDER_OPERATION_IDENTITY_MISMATCH', retryable: true, uncertain: true,
      });
    expect(ctx.moveMessage).not.toHaveBeenCalled();
    expect(ctx.moveMessageWithReceipt).not.toHaveBeenCalled();
  });

  it('idempotently confirms a completed All Mail archive without provider work', async () => {
    const acct = { id: 'acct-1', folder_mappings: { archive: 'All Mail' } };
    const allMailReceipt = {
      ...archiveReceipt,
      folder: 'All Mail',
      destinationToken: { folder: 'All Mail', uidValidity: '202', generation: '8' },
    };
    const operationId = buildProviderOperationId({
      kind: 'move', accountId: 'acct-1', requestKey: 'archive:row-1',
      source: allMailReceipt.sourceToken, destinationFolder: 'All Mail',
    });
    const operation = {
      ...exactArchiveOperation('completed'),
      id: operationId,
      marker: providerOperationMarker(operationId),
      destination: allMailReceipt.destinationToken,
      receipt: { ...allMailReceipt, marker: providerOperationMarker(operationId) },
    };
    archiveQueries({ allMail: true, confirmed: false });
    const completeExisting = vi.fn(async (_operationId, spec) => {
      await spec.validateExisting(operation);
      return { status: 'completed', operation, receipt: operation.receipt, replayed: true };
    });
    const ctx = {
      providerOperationExecutor: { completeExisting },
      moveMessage: vi.fn(), moveMessageWithReceipt: vi.fn(),
    };

    await expect(ImapManager.prototype.reconcileMissingMessageCopy.call(ctx, acct, archiveRow))
      .resolves.toEqual({ reconciled: true, changed: 0 });
    await expect(ImapManager.prototype.reconcileMissingMessageCopy.call(ctx, acct, archiveRow))
      .resolves.toEqual({ reconciled: true, changed: 0 });
    expect(completeExisting).toHaveBeenCalledTimes(2);
    expect(ctx.moveMessage).not.toHaveBeenCalled();
    expect(ctx.moveMessageWithReceipt).not.toHaveBeenCalled();
  });

  it('keeps a concurrently relocated label copy retryable after a zero-row exact delete', async () => {
    const acct = { id: 'acct-1' };
    const stale = { id: 'row-1', account_id: 'acct-1', uid: 7, folder: 'Todo', message_id: '<m@x>', is_read: true };
    query.mockImplementation(async (sql) => {
      if (typeof sql !== 'string') return { rows: [] };
      if (sql.includes('DELETE FROM messages')) return { rowCount: 0, rows: [] };
      if (sql.includes('SELECT 1 FROM messages') && sql.includes('id = $1')) {
        return { rows: [{ '?column?': 1 }] };
      }
      return { rows: [] };
    });

    await expect(ImapManager.prototype.reconcileMissingMessageCopy.call({}, acct, stale))
      .resolves.toEqual({ reconciled: false, changed: 0 });
  });

  it('does not suppress a provider failure merely because old coordinates disappeared', async () => {
    const acct = { id: 'acct-1' };
    const ctx = { permanentDeleteMessage: vi.fn().mockRejectedValue(new Error('no matching message')) };
    query
      .mockResolvedValueOnce({ rows: [acct] })
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(ImapManager.prototype.removeMessageCopy.call(
      ctx, 'acct-1', 7, 'Todo', {
        expectedId: 'row-1', notify: false,
        snapshot: { ...sourceSnapshot(7, { folder: 'Todo' }), id: 'row-1' },
      }
    )).rejects.toThrow('no matching message');
    expect(ctx.permanentDeleteMessage).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('never suppresses a snapshot epoch change as a concurrent label delete', async () => {
    const acct = { id: 'acct-1' };
    const epochErr = Object.assign(new Error('Snapshot UIDVALIDITY changed'), {
      code: 'SNAPSHOT_UIDVALIDITY_CHANGED',
    });
    const ctx = { permanentDeleteMessage: vi.fn().mockRejectedValue(epochErr) };
    query
      .mockResolvedValueOnce({ rows: [acct] })
      .mockResolvedValue({ rows: [] });

    await expect(ImapManager.prototype.removeMessageCopy.call(
      ctx,
      'acct-1',
      7,
      'Todo',
      {
        expectedId: 'row-1', notify: false, expectedUidValidity: 100,
        snapshot: {
          ...sourceSnapshot(7, { folder: 'Todo', uidValidity: '100' }), id: 'row-1',
        },
      },
    )).rejects.toBe(epochErr);
    expect(query).toHaveBeenCalledTimes(1);
  });

});


// ── ensureMailbox — provider-correct folder creation ─────────────────────────
// The namespace matrix (no-prefix + '/', 'INBOX.' + '.') is resolved INSIDE imapflow's
// normalizePath, which runs on mailboxCreate. So the unit here mocks mailboxCreate and
// asserts (a) we hand imapflow an ARRAY split on '/' — letting it join with the server
// delimiter and prepend the namespace prefix rather than us hand-joining — and (b) we
// surface imapflow's reported real path + created flag, treating already-exists (both the
// { created:false } return and a thrown "already exists") as success-not-created.

describe('ensureMailbox — namespace + already-exists matrix', () => {
  const clientReturning = (result) => ({ mailboxCreate: vi.fn().mockResolvedValue(result) });
  const clientThrowing = (err) => ({ mailboxCreate: vi.fn().mockRejectedValue(err) });

  it('flat server (no prefix, "/" delimiter): passes ["Todo"], surfaces the flat path as created', async () => {
    const client = clientReturning({ path: 'Todo', created: true });
    const res = await ensureMailbox(client, 'Todo');
    expect(client.mailboxCreate).toHaveBeenCalledWith(['Todo']);
    expect(res).toEqual({ path: 'Todo', created: true });
  });

  it('prefixed server ("INBOX." + "."): imapflow prefixes the array, we surface the real INBOX.Todo path', async () => {
    // imapflow's normalizePath turns ['Todo'] into 'INBOX.Todo' on a prefixed namespace
    // and returns it — we must report that, not the bare requested name.
    const client = clientReturning({ path: 'INBOX.Todo', created: true });
    const res = await ensureMailbox(client, 'Todo');
    expect(client.mailboxCreate).toHaveBeenCalledWith(['Todo']);
    expect(res).toEqual({ path: 'INBOX.Todo', created: true });
  });

  it('splits a nested name on "/" so imapflow joins with the server delimiter', async () => {
    const client = clientReturning({ path: 'INBOX.Work.Todo', created: true });
    const res = await ensureMailbox(client, 'Work/Todo');
    expect(client.mailboxCreate).toHaveBeenCalledWith(['Work', 'Todo']);
    expect(res).toEqual({ path: 'INBOX.Work.Todo', created: true });
  });

  it('already-exists via imapflow ALREADYEXISTS return: created=false with the real path', async () => {
    // imapflow catches ALREADYEXISTS and returns { created:false } + the normalized path
    // (covers a case-insensitive server reporting an existing "todo" for a requested "Todo").
    const client = clientReturning({ path: 'INBOX.todo', created: false });
    const res = await ensureMailbox(client, 'Todo');
    expect(res).toEqual({ path: 'INBOX.todo', created: false });
  });

  it('already-exists via a thrown NO with serverResponseCode ALREADYEXISTS: treated as created=false', async () => {
    // Real imapflow shape (lib/tools.js enhanceCommandError + lib/imap-flow.js NO/BAD
    // handling): err.message is always the generic 'Command failed'; the server's text
    // lands in err.responseText and the RFC 5530 code in err.serverResponseCode.
    const client = clientThrowing(
      Object.assign(new Error('Command failed'), {
        responseText: 'Mailbox already exists',
        serverResponseCode: 'ALREADYEXISTS',
      })
    );
    const res = await ensureMailbox(client, 'Todo');
    expect(res).toEqual({ path: 'Todo', created: false });
  });

  it('already-exists via a thrown NO with only responseText (non-RFC5530 server): treated as created=false', async () => {
    const client = clientThrowing(
      Object.assign(new Error('Command failed'), { responseText: 'Mailbox already exists' })
    );
    const res = await ensureMailbox(client, 'Watch');
    expect(res).toEqual({ path: 'Watch', created: false });
  });

  it('re-throws an unrelated failure with a realistic responseText/serverResponseCode shape', async () => {
    const client = clientThrowing(
      Object.assign(new Error('Command failed'), {
        responseText: 'Quota exceeded',
        serverResponseCode: 'OVERQUOTA',
      })
    );
    await expect(ensureMailbox(client, 'Todo')).rejects.toThrow('Command failed');
  });

  it('re-throws an unrelated failure (e.g. over quota) rather than swallowing it', async () => {
    const client = clientThrowing(new Error('Over quota'));
    await expect(ensureMailbox(client, 'Todo')).rejects.toThrow('Over quota');
  });

  it('falls back to the requested name when imapflow returns no path', async () => {
    const client = clientReturning(undefined);
    const res = await ensureMailbox(client, 'Reference');
    expect(res).toEqual({ path: 'Reference', created: false });
  });
});

// ── ensureMailbox — case-insensitive casing resolution ────────────────────────
// On a case-insensitive server an existing "TODO" satisfies a "Todo" CREATE, but imapflow's
// already-exists result echoes the REQUESTED casing. Persisting that (planGtdFolderPersist)
// never case-matches the synced rows' folder value. With resolvePath set (only /folders/ensure,
// which persists), the already-exists branches resolve the real casing from the folder LIST;
// classify/snooze leave it off so they skip the extra round-trip.
describe('ensureMailbox — case-insensitive casing resolution', () => {
  it('ALREADYEXISTS return + resolvePath: resolves the server casing from LIST', async () => {
    const client = {
      mailboxCreate: vi.fn().mockResolvedValue({ path: 'Todo', created: false }),
      list: vi.fn().mockResolvedValue([{ path: 'INBOX' }, { path: 'TODO' }]),
    };
    const res = await ensureMailbox(client, 'Todo', { resolvePath: true });
    expect(res).toEqual({ path: 'TODO', created: false });
    expect(client.list).toHaveBeenCalledTimes(1);
  });

  it('plain-NO throw + resolvePath: resolves the casing from the bare requested name', async () => {
    const client = {
      mailboxCreate: vi.fn().mockRejectedValue(
        Object.assign(new Error('Command failed'), { responseText: 'Mailbox already exists' })
      ),
      list: vi.fn().mockResolvedValue([{ path: 'TODO' }]),
    };
    const res = await ensureMailbox(client, 'Todo', { resolvePath: true });
    expect(res).toEqual({ path: 'TODO', created: false });
  });

  it('does NOT list without resolvePath — the hot classify path skips the round-trip', async () => {
    const client = {
      mailboxCreate: vi.fn().mockResolvedValue({ path: 'Todo', created: false }),
      list: vi.fn().mockResolvedValue([{ path: 'TODO' }]),
    };
    const res = await ensureMailbox(client, 'Todo');
    expect(res).toEqual({ path: 'Todo', created: false });
    expect(client.list).not.toHaveBeenCalled();
  });

  it('falls back to the known path when the LIST has no case-insensitive match', async () => {
    const client = {
      mailboxCreate: vi.fn().mockResolvedValue({ path: 'Todo', created: false }),
      list: vi.fn().mockResolvedValue([{ path: 'Inbox' }, { path: 'Sent' }]),
    };
    expect(await ensureMailbox(client, 'Todo', { resolvePath: true })).toEqual({ path: 'Todo', created: false });
  });

  it('never throws when the LIST itself fails — falls back to the input path', async () => {
    const client = {
      mailboxCreate: vi.fn().mockResolvedValue({ path: 'Todo', created: false }),
      list: vi.fn().mockRejectedValue(new Error('LIST failed')),
    };
    expect(await ensureMailbox(client, 'Todo', { resolvePath: true })).toEqual({ path: 'Todo', created: false });
  });

  it('a freshly-created folder never triggers a lookup, even with resolvePath', async () => {
    const client = {
      mailboxCreate: vi.fn().mockResolvedValue({ path: 'INBOX.Todo', created: true }),
      list: vi.fn(),
    };
    expect(await ensureMailbox(client, 'Todo', { resolvePath: true })).toEqual({ path: 'INBOX.Todo', created: true });
    expect(client.list).not.toHaveBeenCalled();
  });
});

// ── ensureMailbox — flat-namespace hierarchy guard ────────────────────────────
// A server whose personal-namespace delimiter is null cannot represent nesting: imapflow would
// join ['Projects','Todo'] with '' into "ProjectsTodo". Guard nested paths loudly, but only when
// the namespace is KNOWN to be flat (an unfetched namespace is left to imapflow).
describe('ensureMailbox — flat-namespace hierarchy guard', () => {
  it('throws a clear error for a nested path when the namespace delimiter is null', async () => {
    const client = { namespace: { prefix: '', delimiter: null }, mailboxCreate: vi.fn() };
    await expect(ensureMailbox(client, 'Projects/Todo')).rejects.toThrow(/hierarchy/i);
    expect(client.mailboxCreate).not.toHaveBeenCalled();
  });

  it('allows a single-segment name on a flat-namespace server', async () => {
    const client = { namespace: { prefix: '', delimiter: null }, mailboxCreate: vi.fn().mockResolvedValue({ path: 'Todo', created: true }) };
    expect(await ensureMailbox(client, 'Todo')).toEqual({ path: 'Todo', created: true });
  });

  it('allows a nested path when the server advertises a hierarchy delimiter', async () => {
    const client = { namespace: { prefix: 'INBOX.', delimiter: '.' }, mailboxCreate: vi.fn().mockResolvedValue({ path: 'INBOX.Work.Todo', created: true }) };
    const res = await ensureMailbox(client, 'Work/Todo');
    expect(client.mailboxCreate).toHaveBeenCalledWith(['Work', 'Todo']);
    expect(res).toEqual({ path: 'INBOX.Work.Todo', created: true });
  });

  it('does not guard a nested path when the namespace is unknown (bare client)', async () => {
    const client = { mailboxCreate: vi.fn().mockResolvedValue({ path: 'INBOX.Work.Todo', created: true }) };
    expect(await ensureMailbox(client, 'Work/Todo')).toEqual({ path: 'INBOX.Work.Todo', created: true });
  });
});

// ── emitSectionsChanged — generic label-feed refresh dispatch ─────────────────
// Core's generic notify: an ordinary mail mutation (delete/purge/backfill/flag flip) changed
// the messages table outside a label plugin's tick, so core dispatches the `sectionsChanged`
// hook and each active plugin decides whether to broadcast its own refresh. The wrapper's only
// job is the cheap changedCount gate + the dispatch; the GTD-specific enabled-gate + broadcast
// live in the plugin handler (see plugins/gtd/hooks.test.js). Here we assert the dispatch
// contract by spying on the registry.
describe('emitSectionsChanged', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('dispatches the sectionsChanged hook with the mutation context when rows changed', async () => {
    const spy = vi.spyOn(pluginRegistry, 'runHook').mockResolvedValue([]);
    const mgr = { broadcast: vi.fn() };
    const account = { id: 'acct-sc-on', user_id: 'user-1' };
    await emitSectionsChanged(mgr, account, 4);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('sectionsChanged', { mgr, account, changedCount: 4 });
  });

  it('never dispatches — no plugin work at all — when nothing changed', async () => {
    const spy = vi.spyOn(pluginRegistry, 'runHook').mockResolvedValue([]);
    await emitSectionsChanged({ broadcast: vi.fn() }, { id: 'acct-sc-zero', user_id: 'user-1' }, 0);
    expect(spy).not.toHaveBeenCalled();
  });
});

// ── _startPluginSyncTimers / _stopPluginSyncTimers — plugin background ticks ──
// The GTD label-folder tick is now a plugin-declared background task; core just arms/tears down
// a jittered timer per active plugin, keyed `${accountId}::${pluginId}`. These assert the generic
// scheduler: it honors sync.isActive, fires the tick, and tears down per-account independently.

describe('_startPluginSyncTimers / _stopPluginSyncTimers', () => {
  const makeMgr = () => { const m = Object.create(ImapManager.prototype); m.pluginSyncIntervals = new Map(); m.pluginFacade = { __facade: true }; return m; };
  let listSpy;

  beforeEach(() => { vi.useFakeTimers(); vi.spyOn(Math, 'random').mockReturnValue(0); });
  afterEach(() => { listSpy?.mockRestore(); vi.restoreAllMocks(); vi.useRealTimers(); });

  it('arms a jittered first fire then a steady interval for an active plugin tick', async () => {
    const tick = vi.fn().mockResolvedValue(undefined);
    listSpy = vi.spyOn(pluginRegistry, 'list').mockReturnValue([
      { id: 'fake', sync: { intervalMs: 1000, isActive: () => true, tick } },
    ]);
    const mgr = makeMgr();
    const account = { id: 'a1', user_id: 'u1', email_address: 'e@x' };
    await mgr._startPluginSyncTimers(account); // isActive is awaited before arming
    expect(tick).not.toHaveBeenCalled();     // still waiting on the (zeroed) jitter delay
    vi.advanceTimersByTime(1);               // jitter fires
    expect(tick).toHaveBeenCalledTimes(1);
    expect(tick).toHaveBeenCalledWith({ mgr: mgr.pluginFacade, account }); // facade, not the raw engine
    vi.advanceTimersByTime(1000);            // one steady interval later
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it('arms nothing for a plugin whose sync.isActive rejects the account', async () => {
    const tick = vi.fn();
    listSpy = vi.spyOn(pluginRegistry, 'list').mockReturnValue([
      { id: 'gated', sync: { intervalMs: 1000, isActive: (ctx) => ctx.account.on === true, tick } },
    ]);
    const mgr = makeMgr();
    await mgr._startPluginSyncTimers({ id: 'a2', on: false });
    expect(mgr.pluginSyncIntervals.size).toBe(0);
    vi.advanceTimersByTime(5000);
    expect(tick).not.toHaveBeenCalled();
  });

  it('ignores a plugin with no sync descriptor', async () => {
    listSpy = vi.spyOn(pluginRegistry, 'list').mockReturnValue([{ id: 'routeronly' }]);
    const mgr = makeMgr();
    await mgr._startPluginSyncTimers({ id: 'a3' });
    expect(mgr.pluginSyncIntervals.size).toBe(0);
  });

  it('tears down only the given account\'s timers', async () => {
    const tick = vi.fn();
    listSpy = vi.spyOn(pluginRegistry, 'list').mockReturnValue([
      { id: 'fake', sync: { intervalMs: 1000, isActive: () => true, tick } },
    ]);
    const mgr = makeMgr();
    await mgr._startPluginSyncTimers({ id: 'a1', user_id: 'u1' });
    await mgr._startPluginSyncTimers({ id: 'a2', user_id: 'u1' });
    expect(mgr.pluginSyncIntervals.size).toBe(2);
    mgr._stopPluginSyncTimers('a1');
    expect(mgr.pluginSyncIntervals.has('a1::fake')).toBe(false);
    expect(mgr.pluginSyncIntervals.has('a2::fake')).toBe(true);
    expect(mgr.pluginSyncIntervals.size).toBe(1);
  });
});

// ── createKeyedSemaphore — per-host backfill concurrency cap ───────────────────

describe('createKeyedSemaphore', () => {
  it('runs up to `limit` holders per key concurrently', async () => {
    const sem = createKeyedSemaphore(2);
    await sem.acquire('h');
    await sem.acquire('h');
    expect(sem.activeCount('h')).toBe(2);
    expect(sem.waitingCount('h')).toBe(0);
  });

  it('queues acquirers beyond the limit until a release', async () => {
    const sem = createKeyedSemaphore(1);
    await sem.acquire('h');
    let entered = false;
    const p = sem.acquire('h').then(() => { entered = true; });
    await Promise.resolve();
    expect(sem.waitingCount('h')).toBe(1);
    expect(entered).toBe(false);
    sem.release('h');
    await p;
    expect(entered).toBe(true);
    expect(sem.waitingCount('h')).toBe(0);
    expect(sem.activeCount('h')).toBe(1);
  });

  it('hands slots to waiters in FIFO order', async () => {
    const sem = createKeyedSemaphore(1);
    await sem.acquire('h');
    const order = [];
    const a = sem.acquire('h').then(() => order.push('a'));
    const b = sem.acquire('h').then(() => order.push('b'));
    await Promise.resolve();
    sem.release('h');
    await a;
    sem.release('h');
    await b;
    expect(order).toEqual(['a', 'b']);
  });

  it('treats different keys independently', async () => {
    const sem = createKeyedSemaphore(1);
    await sem.acquire('h1');
    await sem.acquire('h2'); // different host — not blocked by h1 being full
    expect(sem.activeCount('h1')).toBe(1);
    expect(sem.activeCount('h2')).toBe(1);
  });

  it('cleans up the entry once fully released', async () => {
    const sem = createKeyedSemaphore(1);
    await sem.acquire('h');
    sem.release('h');
    expect(sem.activeCount('h')).toBe(0);
    expect(sem.waitingCount('h')).toBe(0);
  });

  it('release is a safe no-op for an unknown key', () => {
    const sem = createKeyedSemaphore(1);
    expect(() => sem.release('never-acquired')).not.toThrow();
  });
});

// ── connection-refusal cooldown ───────────────────────────────────────────────

describe('isConnectionRefusal', () => {
  it.each([
    'Connection not available',
    'Too many simultaneous connections',
    'Maximum number of connections exceeded',
    'Please try again later',
    'Account temporarily locked',
    'THROTTLED: too many requests',
    'rate limit exceeded',
    'Fresh sync connect timeout (30000ms)',
  ])('flags a refusal: %s', (msg) => {
    expect(isConnectionRefusal(msg)).toBe(true);
  });

  it.each([
    ['Invalid credentials'],
    ['Mailbox does not exist'],
    ['ECONNRESET'],
    // Mid-operation timeouts are NOT connection-limit signals — must stay retry-normal.
    ['Socket timeout'],
    ['Fresh sync wall-clock timeout (55000ms)'],
    [''],
    [null],
    [undefined],
  ])('does not flag a non-refusal: %s', (msg) => {
    expect(isConnectionRefusal(msg)).toBe(false);
  });
});

describe('parsePersistentCap', () => {
  it('parses a positive integer as the cap', () => {
    expect(parsePersistentCap('5')).toBe(5);
    expect(parsePersistentCap('1')).toBe(1);
  });
  it.each(['0', '-3', '', 'abc', null, undefined, ' '])('treats %s as unlimited', (raw) => {
    expect(parsePersistentCap(raw)).toBe(Infinity);
  });
});

describe('resolvePersistentCap', () => {
  it('is unlimited when neither env nor profile caps', () => {
    expect(resolvePersistentCap(Infinity, undefined)).toBe(Infinity);
  });
  it('uses whichever cap is set', () => {
    expect(resolvePersistentCap(Infinity, 4)).toBe(4);
    expect(resolvePersistentCap(6, undefined)).toBe(6);
  });
  it('takes the tighter of the two', () => {
    expect(resolvePersistentCap(10, 3)).toBe(3);
    expect(resolvePersistentCap(2, 8)).toBe(2);
  });
  it('ignores non-positive caps', () => {
    expect(resolvePersistentCap(0, 0)).toBe(Infinity);
  });
});

describe('persistentEligible', () => {
  const host = ['a', 'b', 'c', 'd']; // stable order (created_at, then id)
  it('is always eligible when the cap is unlimited or non-positive', () => {
    expect(persistentEligible(host, 'd', Infinity)).toBe(true);
    expect(persistentEligible(host, 'd', 0)).toBe(true);
  });
  it('keeps the first `cap` accounts persistent and demotes the rest', () => {
    expect(persistentEligible(host, 'a', 2)).toBe(true);
    expect(persistentEligible(host, 'b', 2)).toBe(true);
    expect(persistentEligible(host, 'c', 2)).toBe(false); // surplus → poll-only
    expect(persistentEligible(host, 'd', 2)).toBe(false);
  });
  it('fails safe to eligible for an account not in the host list', () => {
    expect(persistentEligible(host, 'zz', 2)).toBe(true);
  });
});

describe('shouldRetryIPv4', () => {
  const dual = ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'];
  it('retries IPv4-only on a timeout for a dual-stack host', () => {
    expect(shouldRetryIPv4('IMAP connect timeout (30000ms)', dual)).toBe(true);
    expect(shouldRetryIPv4('Reconnect timeout (40000ms)', dual)).toBe(true);
  });
  it('does not retry when the failure was not a timeout (auth/refusal/cert)', () => {
    expect(shouldRetryIPv4('Invalid credentials', dual)).toBe(false);
    expect(shouldRetryIPv4('Too many simultaneous connections', dual)).toBe(false);
    expect(shouldRetryIPv4('self signed certificate', dual)).toBe(false);
  });
  it('does not retry when the host is single-family (nothing to fall back to)', () => {
    expect(shouldRetryIPv4('connect timeout', ['93.184.216.34'])).toBe(false);            // v4-only
    expect(shouldRetryIPv4('connect timeout', ['2606:2800:220:1::1'])).toBe(false);       // v6-only
    expect(shouldRetryIPv4('connect timeout', [])).toBe(false);
    expect(shouldRetryIPv4('connect timeout', undefined)).toBe(false);
  });
  it('handles empty/nullish error messages', () => {
    expect(shouldRetryIPv4('', dual)).toBe(false);
    expect(shouldRetryIPv4(null, dual)).toBe(false);
  });
  it('does not retry when a provider refusal was seen during the attempt (#384)', () => {
    // A timeout on a dual-stack host would normally retry, but a refusal means back off instead.
    expect(shouldRetryIPv4('connect timeout', dual, true)).toBe(false);
    expect(shouldRetryIPv4('connect timeout', dual, false)).toBe(true);
  });
});

describe('connectCooldownMs', () => {
  it('grows exponentially from 30s and caps at 15 min', () => {
    expect(connectCooldownMs(1)).toBe(30_000);
    expect(connectCooldownMs(2)).toBe(60_000);
    expect(connectCooldownMs(3)).toBe(120_000);
    expect(connectCooldownMs(4)).toBe(240_000);
    expect(connectCooldownMs(5)).toBe(480_000);
    expect(connectCooldownMs(6)).toBe(900_000); // 960k clamped to the 15-min cap
    expect(connectCooldownMs(20)).toBe(900_000);
  });

  it('treats 0 / negative failures as at least one', () => {
    expect(connectCooldownMs(0)).toBe(30_000);
    expect(connectCooldownMs(-3)).toBe(30_000);
  });
});

// ── effectiveSyncIntervalMs — provider interval clamp ─────────────────────────

describe('effectiveSyncIntervalMs', () => {
  it('clamps to the provider cap when the requested interval is longer', () => {
    // PurelyMail uses IDLE for instant push; the periodic tick is only a ~2-min backstop cap.
    expect(effectiveSyncIntervalMs(account('imap.purelymail.com'), 300000)).toBe(120000);
  });

  it('leaves a faster-than-cap request untouched', () => {
    expect(effectiveSyncIntervalMs(account('imap.purelymail.com'), 5000)).toBe(5000);
  });

  it('passes the requested interval through for providers without a cap', () => {
    expect(effectiveSyncIntervalMs(account('imap.fastmail.com'), 60000)).toBe(60000);
    expect(effectiveSyncIntervalMs(account('imap.gmail.com'), 120000)).toBe(120000);
  });
});

// ── folderSyncDue — periodic folder-structure sync gate ──────────────────────

describe('folderSyncDue', () => {
  it('is due immediately when the account has never folder-synced', () => {
    expect(folderSyncDue(1800000, undefined, 5000000)).toBe(true);
  });

  it('is not due again within the interval', () => {
    expect(folderSyncDue(1800000, 5000000, 5000000 + 1799999)).toBe(false);
  });

  it('is due once the interval has elapsed', () => {
    expect(folderSyncDue(1800000, 5000000, 5000000 + 1800000)).toBe(true);
  });

  it('never fires when disabled (0 = never)', () => {
    expect(folderSyncDue(0, undefined, Number.MAX_SAFE_INTEGER)).toBe(false);
  });
});

// ── connectStaggerFor — initial connect pacing (#218) ─────────────────────────

describe('connectStaggerFor', () => {
  it('spaces a connection-sensitive provider (PurelyMail) wider than a lenient one (Gmail)', () => {
    const pm = providerProfile(account('imap.purelymail.com'));
    const gmail = providerProfile(account('imap.gmail.com'));
    expect(connectStaggerFor(pm, 1)).toBeGreaterThan(connectStaggerFor(gmail, 1));
  });

  it('widens the gap as account count grows, capped at 2x the base', () => {
    const pm = providerProfile(account('imap.purelymail.com'));
    expect(connectStaggerFor(pm, 100)).toBeGreaterThan(connectStaggerFor(pm, 1));
    expect(connectStaggerFor(pm, 100)).toBe(2400); // 1200 base x capped factor 2
  });

  it('defaults to a 200ms base for providers without an explicit stagger (Gmail)', () => {
    const gmail = providerProfile(account('imap.gmail.com'));
    expect(connectStaggerFor(gmail, 1)).toBe(208); // 200 x (1 + 1/25)
  });

  it('never drops below the base for an empty account list', () => {
    const pm = providerProfile(account('imap.purelymail.com'));
    expect(connectStaggerFor(pm, 0)).toBe(1200);
  });
});

// ── planModseqSync — CONDSTORE delta-sync strategy decision ────────────────────

describe('planModseqSync', () => {
  it('forces a full sync when the local cache is empty but a nonempty server has an equal modseq', () => {
    expect(planModseqSync({
      storedModseq: '100',
      serverModseq: '100',
      uidValidityChanged: false,
      maxKnownUid: 0,
      serverExists: 1,
    })).toBe('full');
  });

  it('forces a full sync when the local cache is empty and the server modseq advanced', () => {
    expect(planModseqSync({
      storedModseq: '100',
      serverModseq: '101',
      uidValidityChanged: false,
      maxKnownUid: 0,
      serverExists: 1,
    })).toBe('full');
  });

  it('leaves an empty local cache and empty server unchanged when the modseqs match', () => {
    expect(planModseqSync({
      storedModseq: '100',
      serverModseq: '100',
      uidValidityChanged: false,
      maxKnownUid: 0,
      serverExists: 0,
    })).toBe('unchanged');
  });

  it('retains the existing CONDSTORE plans when the local cache has a UID watermark', () => {
    const localState = { maxKnownUid: 50, serverExists: 50 };
    expect(planModseqSync({ ...localState, storedModseq: '100', serverModseq: '100', uidValidityChanged: false })).toBe('unchanged');
    expect(planModseqSync({ ...localState, storedModseq: '100', serverModseq: '101', uidValidityChanged: false })).toBe('delta');
    expect(planModseqSync({ ...localState, storedModseq: '100', serverModseq: '100', uidValidityChanged: true })).toBe('full');
    expect(planModseqSync({ ...localState, storedModseq: null, serverModseq: '100', uidValidityChanged: false })).toBe('full');
    expect(planModseqSync({ ...localState, storedModseq: '100', serverModseq: null, uidValidityChanged: false })).toBe('full');
  });

  it('falls back to full sync when there is no stored baseline (first sync / seed)', () => {
    expect(planModseqSync({ storedModseq: null, serverModseq: '42', uidValidityChanged: false })).toBe('full');
  });

  it('falls back to full sync when the server has no modseq (no CONDSTORE)', () => {
    expect(planModseqSync({ storedModseq: '42', serverModseq: null, uidValidityChanged: false })).toBe('full');
    expect(planModseqSync({ storedModseq: null, serverModseq: null, uidValidityChanged: false })).toBe('full');
  });

  it('forces full sync on a UIDVALIDITY change even when the modseqs happen to match', () => {
    // modseq is only comparable within a UIDVALIDITY epoch — a matching value across a
    // reset must NOT be treated as "nothing changed".
    expect(planModseqSync({ storedModseq: '100', serverModseq: '100', uidValidityChanged: true })).toBe('full');
    expect(planModseqSync({ storedModseq: '100', serverModseq: '200', uidValidityChanged: true })).toBe('full');
  });

  it('returns "unchanged" when the stored watermark equals the server modseq', () => {
    expect(planModseqSync({ storedModseq: '500', serverModseq: '500', uidValidityChanged: false })).toBe('unchanged');
  });

  it('returns "delta" when the server modseq has advanced', () => {
    expect(planModseqSync({ storedModseq: '500', serverModseq: '501', uidValidityChanged: false })).toBe('delta');
  });

  it('accepts BigInt and string interchangeably (ImapFlow yields BigInt, pg yields string)', () => {
    expect(planModseqSync({ storedModseq: '77', serverModseq: 77n, uidValidityChanged: false })).toBe('unchanged');
    expect(planModseqSync({ storedModseq: 77n, serverModseq: '78', uidValidityChanged: false })).toBe('delta');
  });

  it('compares in BigInt so values above 2^53 stay exact (a JS Number would collapse them)', () => {
    // 9007199254740993 and ...992 are indistinguishable as JS Numbers (both round to 2^53).
    const a = '9007199254740992';
    const b = '9007199254740993';
    expect(Number(a) === Number(b)).toBe(true);            // the trap we must avoid
    expect(planModseqSync({ storedModseq: a, serverModseq: b, uidValidityChanged: false })).toBe('delta');
    expect(planModseqSync({ storedModseq: b, serverModseq: b, uidValidityChanged: false })).toBe('unchanged');
  });
});

describe('_applyFlagUpdates — UIDVALIDITY fence', () => {
  it('publishes a bulk pull through the per-row revisions captured before FETCH began', async () => {
    const applyPull = vi.fn().mockResolvedValue(1);
    const pullSnapshot = {
      uidValidity: '100', folderGeneration: '9',
      rows: [{ id: 'row-1', uid: 7, readRevision: 3, starRevision: 5 }],
    };

    await expect(ImapManager.prototype._applyFlagUpdates.call(
      { _desiredFlagRepository: { applyPull } },
      { id: 'acct-1' }, 'INBOX',
      [{ uid: 7, isRead: true, isStarred: false, modseq: 51n }],
      100, null, pullSnapshot,
    )).resolves.toBe(1);

    expect(applyPull).toHaveBeenCalledWith({
      accountId: 'acct-1', folder: 'INBOX', uidValidity: '100', folderGeneration: '9',
      rows: [{
        id: 'row-1', uid: 7, readRevision: 3, starRevision: 5,
        isRead: true, isStarred: false, modseq: '51',
      }],
    });
  });

  it('rejects stale flag data before it can mutate reused UIDs in a new epoch', async () => {
    query.mockReset();
    query.mockImplementation((sql) => {
      if (sql.includes('SELECT uid_validity, highest_modseq FROM folders')) {
        return Promise.resolve({ rows: [{ uid_validity: 200 }] });
      }
      if (sql.includes('UPDATE messages SET')) return Promise.resolve({ rowCount: 1, rows: [] });
      return Promise.resolve({ rows: [] });
    });

    await expect(ImapManager.prototype._applyFlagUpdates.call(
      {}, { id: 'acct-1' }, 'INBOX', [{ uid: 7, isRead: true, isStarred: false }], 100
    )).rejects.toThrow(/UIDVALIDITY/i);
    expect(query.mock.calls.some(([sql]) => sql.includes('UPDATE messages SET'))).toBe(false);
  });
});

describe('_reconcileFolderDeletes — UIDVALIDITY fence', () => {
  it('routes a missing source row through durable provider recovery instead of hard deletion', async () => {
    query.mockReset();
    const orphan = {
      id: 'row-1', account_id: 'acct-1', uid: 2, folder: 'INBOX', is_read: false,
      folder_uid_validity: '100', folder_observation_generation: '7',
      folder_topology_identity: 'inbox-incarnation',
    };
    query.mockImplementation((sql) => {
      if (sql.includes('FROM messages m') && sql.includes('f.topology_identity')) {
        return Promise.resolve({ rows: [orphan] });
      }
      if (sql.includes('DELETE FROM messages')) return Promise.resolve({ rowCount: 1, rows: [] });
      if (sql.includes('uid_validity') && sql.includes('FOR UPDATE')) {
        return Promise.resolve({ rows: [{ uid_validity: 100 }] });
      }
      return Promise.resolve({ rowCount: 1, rows: [] });
    });
    const reconcileMissingMessageCopy = vi.fn().mockResolvedValue({ reconciled: true, changed: 1 });

    const changed = await ImapManager.prototype._reconcileFolderDeletes.call(
      { _isMoveUidGuarded: vi.fn().mockReturnValue(false), reconcileMissingMessageCopy },
      { id: 'acct-1' }, 'INBOX', new Set([1]), 100,
      new Date('2026-08-25T10:00:00Z'),
    );

    expect(changed).toBe(1);
    expect(reconcileMissingMessageCopy).toHaveBeenCalledWith(
      { id: 'acct-1' }, orphan, { deleteIfUncaused: true },
    );
    expect(query.mock.calls.some(([sql]) => sql.includes('DELETE FROM messages'))).toBe(false);
  });

  it('validates every folder in the authoritative reconcile context before deleting', async () => {
    query.mockReset();
    assertFolderObservation.mockClear();
    query.mockImplementation((sql) => {
      if (sql.includes('FROM messages m') && sql.includes('f.topology_identity')) {
        return Promise.resolve({ rows: [{ uid: 2 }] });
      }
      if (sql.includes('DELETE FROM messages')) return Promise.resolve({ rowCount: 1, rows: [] });
      return Promise.resolve({ rowCount: 1, rows: [] });
    });
    const observationContext = {
      accountId: 'acct-1',
      tokens: [
        { folder: 'Archive', uidValidity: '100', generation: '8' },
        { folder: 'INBOX', uidValidity: '100', generation: '7' },
      ],
    };

    const changed = await ImapManager.prototype._reconcileFolderDeletes.call(
      {
        _isMoveUidGuarded: vi.fn().mockReturnValue(false),
        reconcileMissingMessageCopy: vi.fn().mockResolvedValue({ changed: 1 }),
      },
      { id: 'acct-1' }, 'INBOX', new Set([1]), 100,
      new Date('2026-08-25T10:00:00Z'), observationContext
    );

    expect(changed).toBe(1);
    expect(assertFolderObservation.mock.calls.map(([, , token]) => token.folder))
      .toEqual(['Archive', 'INBOX', 'Archive', 'INBOX']);
  });

  it('skips destructive reconciliation when a pooled snapshot belongs to an old epoch', async () => {
    query.mockReset();
    query.mockImplementation((sql) => {
      if (sql.includes('SELECT uid_validity') && sql.includes('FOR UPDATE')) {
        return Promise.resolve({ rows: [{ uid_validity: 200 }] });
      }
      if (sql.includes('DELETE FROM messages')) return Promise.resolve({ rowCount: 1, rows: [] });
      return Promise.resolve({ rows: [] });
    });

    const changed = await ImapManager.prototype._reconcileFolderDeletes.call(
      { _isMoveUidGuarded: vi.fn().mockReturnValue(false) },
      { id: 'acct-1' }, 'INBOX', new Set([1]), 100, new Date('2026-08-25T10:00:00Z')
    );

    expect(changed).toBe(0);
    expect(query.mock.calls.some(([sql]) => sql.includes('DELETE FROM messages'))).toBe(false);
  });

  it('keeps the server total authoritative and marks a hidden historical UID for backfill', async () => {
    query.mockReset();
    query.mockImplementation((sql) => {
      if (sql.includes('SELECT uid_validity') && sql.includes('FOR UPDATE')) {
        return Promise.resolve({ rows: [{ uid_validity: 100 }] });
      }
      if (sql.includes('FROM messages m') && sql.includes('f.topology_identity')) {
        return Promise.resolve({ rows: [{ uid: 1 }, { uid: 2 }, { uid: 4 }] });
      }
      if (sql.includes('DELETE FROM messages')) return Promise.resolve({ rowCount: 1, rows: [] });
      return Promise.resolve({ rowCount: 1, rows: [] });
    });

    const changed = await ImapManager.prototype._reconcileFolderDeletes.call(
      {
        _isMoveUidGuarded: vi.fn().mockReturnValue(false),
        reconcileMissingMessageCopy: vi.fn().mockImplementation(async (_account, row) => ({
          changed: Number(row.uid) === 2 ? 1 : 0,
        })),
      },
      { id: 'acct-1' }, 'INBOX', new Set([1, 3, 4]), 100, new Date('2026-08-25T10:00:00Z')
    );

    expect(changed).toBe(1);
    const countWrite = query.mock.calls.find(([sql]) => sql.includes('UPDATE folders f'));
    expect(countWrite[0]).toMatch(/total_count\s*= \$3/);
    expect(countWrite[0]).toContain('backfill_incomplete');
    expect(countWrite[1]).toEqual(['acct-1', 'INBOX', 3]);
  });
});

describe('pool epoch eviction', () => {
  it('synchronously closes active clients instead of queueing graceful logout', () => {
    const clients = [
      { close: vi.fn(), logout: vi.fn() },
      { close: vi.fn(), logout: vi.fn() },
    ];
    abortPoolClients(clients);
    for (const client of clients) {
      expect(client.close).toHaveBeenCalledOnce();
      expect(client.logout).not.toHaveBeenCalled();
    }
  });

  it('rejects a pooled UID operation when selected and durable epochs differ', async () => {
    query.mockReset().mockResolvedValueOnce({ rows: [{ uid_validity: 200 }] });
    const client = { mailbox: { uidValidity: 100 }, close: vi.fn() };
    const operation = vi.fn();

    await expect(withUidEpochFence('acct-1', 'INBOX', client, operation))
      .rejects.toThrow(/UIDVALIDITY/i);

    expect(operation).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalled();
    expect(query.mock.calls[0][0]).toMatch(/FOR SHARE/);
  });

  it('holds a shared folder-epoch lock through the pooled UID operation', async () => {
    query.mockReset().mockResolvedValueOnce({ rows: [{ uid_validity: 200 }] });
    const client = { mailbox: { uidValidity: 200 }, close: vi.fn() };
    const operation = vi.fn().mockResolvedValue('ok');

    await expect(withUidEpochFence('acct-1', 'INBOX', client, operation)).resolves.toBe('ok');

    expect(operation).toHaveBeenCalledOnce();
    expect(withTransaction).toHaveBeenCalled();
    expect(client.close).not.toHaveBeenCalled();
  });

  it('rejects a UID operation when its authorized snapshot belongs to an older epoch', async () => {
    query.mockReset().mockResolvedValueOnce({ rows: [{ uid_validity: 200 }] });
    const client = { mailbox: { uidValidity: 200 }, close: vi.fn() };
    const operation = vi.fn();

    await expect(withUidEpochFence('acct-1', 'INBOX', client, operation, 100))
      .rejects.toThrow(/snapshot.*UIDVALIDITY/i);

    expect(operation).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalled();
  });

  it('rejects a provider read when its exact message row relocated after authorization', async () => {
    query.mockReset()
      .mockResolvedValueOnce({ rows: [{ uid_validity: 200 }] })
      .mockResolvedValueOnce({ rows: [] });
    const client = { mailbox: { uidValidity: 200 }, close: vi.fn() };
    const operation = vi.fn();
    const snapshot = {
      id: 'row-1', accountId: 'acct-1', uid: 7, folder: 'INBOX',
      uidValidity: '200', folderGeneration: '9', readRevision: 2, starRevision: 3,
    };

    await expect(withUidEpochFence(
      'acct-1', 'INBOX', client, operation, 200, null, [snapshot]
    )).rejects.toMatchObject({ code: 'MESSAGE_SNAPSHOT_SUPERSEDED' });

    expect(operation).not.toHaveBeenCalled();
    expect(query.mock.calls[1][0]).toMatch(/FOR SHARE OF f, m/);
  });

  it('discards a whole snippet batch before FETCH/publication when one captured row relocates', async () => {
    query.mockReset()
      .mockResolvedValueOnce({ rows: [{ uid_validity: 200 }] })
      .mockResolvedValueOnce({ rows: [{ id: 'row-1' }] });
    const client = { mailbox: { uidValidity: 200 }, close: vi.fn(), fetch: vi.fn() };
    const publishSnippetBatch = vi.fn(async tx => {
      await tx.query('UPDATE messages SET snippet = $1 WHERE id = $2', ['wrong', 'row-1']);
    });
    const snapshots = [
      { id: 'row-1', accountId: 'acct-1', uid: 7, folder: 'INBOX',
        uidValidity: '200', folderGeneration: '9', readRevision: 2, starRevision: 3 },
      { id: 'row-2', accountId: 'acct-1', uid: 8, folder: 'INBOX',
        uidValidity: '200', folderGeneration: '9', readRevision: 0, starRevision: 0 },
    ];

    await expect(withUidEpochFence(
      'acct-1', 'INBOX', client, publishSnippetBatch, 200, null, snapshots,
    )).rejects.toMatchObject({ code: 'MESSAGE_SNAPSHOT_SUPERSEDED' });

    expect(publishSnippetBatch).not.toHaveBeenCalled();
    expect(client.fetch).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('tracks overflow clients so epoch eviction aborts their in-flight commands too', () => {
    const pooled = { close: vi.fn(), logout: vi.fn() };
    const overflow = { close: vi.fn(), logout: vi.fn() };
    const pool = {
      clients: [pooled], inUse: new Set([pooled]), waiters: [],
      temporaryClients: new Set(), evicted: false,
    };

    expect(registerTemporaryPoolClient(pool, overflow)).toBe(true);
    abortConnectionPool(pool);

    expect(pooled.close).toHaveBeenCalledOnce();
    expect(overflow.close).toHaveBeenCalledOnce();
  });

  it('aborts a temporary client whose connection finishes after eviction', () => {
    const pool = {
      clients: [], inUse: new Set(), waiters: [],
      temporaryClients: new Set(), evicted: true,
    };
    const late = { close: vi.fn(), logout: vi.fn() };

    expect(registerTemporaryPoolClient(pool, late)).toBe(false);
    expect(late.close).toHaveBeenCalledOnce();
    expect(pool.temporaryClients).not.toContain(late);
  });
});

// ── syncMessages — empty-cache/modseq wiring ─────────────────────────────────

describe('syncMessages — empty local cache vs nonempty server (wiring)', () => {
  const parsedFetch = uid => ({
    uid,
    messageId: null,
    subject: 'Valid message',
    fromName: 'External',
    fromEmail: 'them@example.com',
    to: [],
    cc: [],
    replyTo: [],
    inReplyTo: null,
    references: null,
    date: new Date('2026-08-25T10:00:00Z'),
    snippet: 'hi',
    isRead: true,
    isStarred: false,
    hasAttachments: false,
    flags: ['\\Seen'],
    isBulk: false,
    parsedHeaders: {},
  });

  const stubSyncQueries = ({ maxUid, storedModseq = '500' }) => {
    query.mockImplementation((sql) => {
      if (sql.includes('SELECT uid_validity, highest_modseq FROM folders')) {
        return Promise.resolve({ rows: [{ uid_validity: 100, highest_modseq: storedModseq }] });
      }
      if (sql.includes('COUNT(*) FILTER (WHERE is_read = false)')) return Promise.resolve({ rows: [{ n: 0 }] });
      if (sql.includes('COALESCE(MAX(uid), 0)')) return Promise.resolve({ rows: [{ max_uid: maxUid }] });
      if (sql.includes('INSERT INTO messages')) return Promise.resolve({ rows: [{ id: 'new-message', is_new: true }] });
      return Promise.resolve({ rows: [] });
    });
  };

  beforeEach(() => {
    query.mockReset();
    parseMessage.mockReset();
    ['acct-sync-empty-cache', 'acct-sync-watermark'].forEach(invalidateGtdConfigCache);
  });

  it('restarts a superseded sync once with a fresh SELECT and recomputed UID search', async () => {
    const account = {
      id: 'acct-sync-watermark', user_id: 'user-1', email_address: 'me@example.com',
      gtd_enabled: false, categorization_enabled: false, imap_host: 'imap.example.com',
    };
    const makeClient = uid => ({
      getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
      mailbox: { exists: uid, uidValidity: 100, highestModseq: 500n },
      search: vi.fn().mockResolvedValue([uid]),
      fetch: vi.fn(async function* () {
        yield { uid, envelope: { subject: `Message ${uid}` }, flags: new Set() };
      }),
      close: vi.fn(),
    });
    const staleClient = makeClient(51);
    const freshClient = makeClient(52);
    const originalClaim = claimFolderObservation.getMockImplementation();
    const originalAssert = assertFolderObservation.getMockImplementation();
    let assertionCount = 0;
    claimFolderObservation
      .mockResolvedValueOnce({ folder: 'Watch', uidValidity: '100', generation: '1' })
      .mockResolvedValueOnce({ folder: 'Watch', uidValidity: '100', generation: '2' });
    assertFolderObservation.mockImplementation(async () => {
      assertionCount++;
      if (assertionCount === 2) {
        const err = new Error('newer observation won');
        err.code = 'FOLDER_OBSERVATION_SUPERSEDED';
        throw err;
      }
      return { uid_validity: 100, highest_modseq: '500' };
    });
    query.mockImplementation((sql) => {
      if (sql.includes('SELECT uid_validity, highest_modseq FROM folders')) {
        return Promise.resolve({ rows: [{ uid_validity: 100, highest_modseq: '500' }] });
      }
      if (sql.includes('COUNT(*) FILTER (WHERE is_read = false)') && !sql.includes('UPDATE folders')) {
        return Promise.resolve({ rows: [{ n: 0 }] });
      }
      if (sql.includes('COALESCE(MAX(uid), 0)')) return Promise.resolve({ rows: [{ max_uid: 50 }] });
      if (sql.includes("preferences->>'categorizationEnabled'")) return Promise.resolve({ rows: [{ val: false }] });
      if (sql.includes('INSERT INTO messages')) return Promise.resolve({ rows: [{ id: 'fresh-52', is_new: true }] });
      return Promise.resolve({ rowCount: 1, rows: [] });
    });
    parseMessage.mockImplementation(async msg => parsedFetch(msg.uid));
    const ctx = {
      pluginFacade: {},
      _withFreshSyncSession: vi.fn((_account, callback) => callback(freshClient)),
    };
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const result = await ImapManager.prototype.syncMessages.call(
        ctx, account, staleClient, 'Watch', 20, false, true
      );

      expect(staleClient.search).toHaveBeenCalledWith({ uid: '51:*' }, { uid: true });
      expect(freshClient.getMailboxLock).toHaveBeenCalledWith('Watch');
      expect(freshClient.search).toHaveBeenCalledWith({ uid: '51:*' }, { uid: true });
      expect(claimFolderObservation.mock.calls.map(([, folder]) => folder)).toEqual(['Watch', 'Watch']);
      expect(query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO messages')))
        .toHaveLength(1);
      expect(result).toEqual(expect.objectContaining({ insertedCount: 1 }));
      expect(staleClient.close).toHaveBeenCalledOnce();
    } finally {
      error.mockRestore();
      claimFolderObservation.mockReset().mockImplementation(originalClaim);
      assertFolderObservation.mockReset().mockImplementation(originalAssert);
    }
  });

  it('purges stale rows when an empty mailbox has a new UIDVALIDITY epoch', async () => {
    const account = {
      id: 'acct-sync-empty-cache', user_id: 'user-1', email_address: 'me@example.com',
      gtd_enabled: false, categorization_enabled: false, imap_host: 'imap.example.com',
    };
    const client = {
      getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
      mailbox: { exists: 0, uidValidity: 200, highestModseq: null },
      status: vi.fn().mockResolvedValue({ uidValidity: 200 }),
      fetch: vi.fn(async function* () {}),
    };
    let storedValidity = 100;
    query.mockImplementation((sql) => {
      if (sql.includes('SELECT uid_validity, highest_modseq FROM folders')) {
        return Promise.resolve({ rows: [{ uid_validity: storedValidity, highest_modseq: '500' }] });
      }
      if (sql.includes('SELECT uid_validity FROM folders')) {
        return Promise.resolve({ rows: [{ uid_validity: storedValidity }] });
      }
      if (sql.includes('SET uid_validity = $1, highest_modseq = NULL')) {
        storedValidity = 200;
        return Promise.resolve({ rowCount: 1, rows: [] });
      }
      if (sql.includes('DELETE FROM messages')) return Promise.resolve({ rowCount: 3, rows: [] });
      return Promise.resolve({ rowCount: 1, rows: [] });
    });
    const ctx = {
      pluginFacade: {},
      _bgConnSem: { acquire: vi.fn(), release: vi.fn() },
      backfillMessages: vi.fn(),
      _evictPool: vi.fn(),
    };

    const result = await ImapManager.prototype.syncMessages.call(
      ctx, account, client, 'Watch', 50, false, true
    );

    const epochWrite = query.mock.calls.find(([sql]) =>
      sql.includes('SET uid_validity = $1, highest_modseq = NULL, backfill_incomplete = true'));
    const purge = query.mock.calls.find(([sql]) => sql.includes('DELETE FROM messages'));
    const emptyReconcile = query.mock.calls.find(([sql]) =>
      sql.includes('UPDATE folders f') && sql.includes('stats.complete_count'));
    expect(epochWrite).toBeTruthy();
    expect(purge).toBeTruthy();
    expect(query.mock.calls.indexOf(epochWrite)).toBeLessThan(query.mock.calls.indexOf(purge));
    expect(emptyReconcile).toBeTruthy();
    expect(client.fetch).not.toHaveBeenCalled();
    expect(ctx.backfillMessages).not.toHaveBeenCalled();
    expect(ctx._evictPool).toHaveBeenCalledWith(account.id);
    expect(result).toEqual({ insertedCount: 0, broadcastedNewMessages: false });
  });

  it('does not delete a current-epoch row synced after an older empty mailbox snapshot', async () => {
    const account = {
      id: 'acct-sync-empty-cache', user_id: 'user-1', email_address: 'me@example.com',
      gtd_enabled: false, categorization_enabled: false, imap_host: 'imap.example.com',
    };
    const client = {
      getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
      mailbox: { exists: 0, uidValidity: 100, highestModseq: null },
      fetch: vi.fn(async function* () {}),
    };
    query.mockImplementation((sql) => {
      if (sql.includes('SELECT uid_validity, highest_modseq FROM folders')) {
        return Promise.resolve({ rows: [{ uid_validity: 100, highest_modseq: null }] });
      }
      if (sql.includes('SELECT uid_validity FROM folders')) {
        return Promise.resolve({ rows: [{ uid_validity: 100 }] });
      }
      if (sql.includes('DELETE FROM messages')) return Promise.resolve({ rowCount: 0, rows: [] });
      return Promise.resolve({ rowCount: 1, rows: [] });
    });

    await ImapManager.prototype.syncMessages.call(
      { pluginFacade: {} }, account, client, 'INBOX', 50, false, true
    );

    const deletion = query.mock.calls.find(([sql]) => sql.includes('DELETE FROM messages'));
    expect(deletion[0]).toMatch(/synced_at.*< \$3/s);
    expect(deletion[1][2]).toBeInstanceOf(Date);
    const countWrite = query.mock.calls.find(([sql]) => sql.includes('UPDATE folders f'));
    expect(countWrite?.[0]).toContain('backfill_incomplete');
    expect(countWrite?.[0]).not.toMatch(/total_count\s*=\s*0/);
  });

  it('evicts this process pool when another process already committed the observed epoch', async () => {
    const account = {
      id: 'acct-sync-empty-cache', user_id: 'user-1', email_address: 'me@example.com',
      gtd_enabled: false, categorization_enabled: false, imap_host: 'imap.example.com',
    };
    const client = {
      getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
      mailbox: { exists: 0, uidValidity: 200, highestModseq: null },
      status: vi.fn().mockResolvedValue({ uidValidity: 200 }),
      fetch: vi.fn(async function* () {}),
    };
    query.mockImplementation((sql) => {
      if (sql.includes('SELECT uid_validity, highest_modseq FROM folders') && sql.includes('FOR UPDATE')) {
        return Promise.resolve({ rows: [{ uid_validity: 200, highest_modseq: null }] });
      }
      if (sql.includes('SELECT uid_validity, highest_modseq FROM folders')) {
        return Promise.resolve({ rows: [{ uid_validity: 100, highest_modseq: '500' }] });
      }
      return Promise.resolve({ rowCount: 1, rows: [] });
    });
    const ctx = {
      pluginFacade: {},
      _bgConnSem: { acquire: vi.fn(), release: vi.fn() },
      backfillMessages: vi.fn(),
      _evictPool: vi.fn(),
    };

    await ImapManager.prototype.syncMessages.call(ctx, account, client, 'Watch', 50, false, true);

    expect(ctx._evictPool).toHaveBeenCalledWith(account.id);
  });

  it('evicts an old local pool generation when durable and selected epochs already match', async () => {
    const account = {
      id: 'acct-sync-empty-cache', user_id: 'user-1', email_address: 'me@example.com',
      gtd_enabled: false, categorization_enabled: false, imap_host: 'imap.example.com',
    };
    const client = {
      getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
      mailbox: { exists: 0, uidValidity: 200, highestModseq: null },
      fetch: vi.fn(async function* () {}),
    };
    query.mockImplementation((sql) => {
      if (sql.includes('SELECT uid_validity, highest_modseq FROM folders')) {
        return Promise.resolve({ rows: [{ uid_validity: 200, highest_modseq: null }] });
      }
      if (sql.includes('SELECT uid_validity FROM folders')) {
        return Promise.resolve({ rows: [{ uid_validity: 200 }] });
      }
      return Promise.resolve({ rowCount: 1, rows: [] });
    });
    const ctx = {
      pluginFacade: {},
      _observedSyncEpochs: new Map([[`${account.id}:INBOX`, 100]]),
      _observeSyncEpoch: ImapManager.prototype._observeSyncEpoch,
      _evictPool: vi.fn(),
    };

    await ImapManager.prototype.syncMessages.call(ctx, account, client, 'INBOX', 50, false, true);

    expect(ctx._evictPool).toHaveBeenCalledWith(account.id);
    expect(ctx._observedSyncEpochs.get(`${account.id}:INBOX`)).toBe(200);
  });

  it('does not rewind a newer durable epoch from a stale selected client', async () => {
    const account = {
      id: 'acct-sync-empty-cache', user_id: 'user-1', email_address: 'me@example.com',
      gtd_enabled: false, categorization_enabled: false, imap_host: 'imap.example.com',
    };
    const client = {
      getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
      mailbox: { exists: 1, uidValidity: 100, highestModseq: null },
      status: vi.fn().mockResolvedValue({ uidValidity: 200 }),
      fetch: vi.fn(async function* () {}),
    };
    query.mockImplementation((sql) => {
      if (sql.includes('SELECT uid_validity, highest_modseq FROM folders')) {
        return Promise.resolve({ rows: [{ uid_validity: 200, highest_modseq: null }] });
      }
      return Promise.resolve({ rowCount: 1, rows: [] });
    });
    const ctx = {
      pluginFacade: {},
      _bgConnSem: { acquire: vi.fn(), release: vi.fn() },
      backfillMessages: vi.fn(),
    };

    await expect(ImapManager.prototype.syncMessages.call(
      ctx, account, client, 'Watch', 50, false, true
    )).rejects.toThrow(/UIDVALIDITY/i);

    expect(client.status).toHaveBeenCalledWith('Watch', { uidValidity: true });
    expect(query.mock.calls.some(([sql, params]) =>
      sql.includes('SET uid_validity = $1') && params?.[0] === 100)).toBe(false);
    expect(query.mock.calls.some(([sql]) => sql.includes('DELETE FROM messages'))).toBe(false);
  });

  it('does not insert old-epoch metadata when another sync transitions after the initial read', async () => {
    const account = {
      id: 'acct-sync-empty-cache', user_id: 'user-1', email_address: 'me@example.com',
      gtd_enabled: false, categorization_enabled: false, imap_host: 'imap.example.com',
    };
    let durableValidity = 100;
    const client = {
      getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
      mailbox: { exists: 1, uidValidity: 100, highestModseq: null },
      fetch: vi.fn(async function* () { yield { uid: 501, envelope: { subject: 'Old epoch' } }; }),
    };
    query.mockImplementation((sql) => {
      if (sql.includes('SELECT uid_validity, highest_modseq FROM folders')) {
        return Promise.resolve({ rows: [{ uid_validity: durableValidity, highest_modseq: null }] });
      }
      if (sql.includes('COUNT(*) FILTER (WHERE is_read = false)') && !sql.includes('UPDATE folders')) {
        return Promise.resolve({ rows: [{ n: 0 }] });
      }
      if (sql.includes('UPDATE folders') && sql.includes('SET total_count = $3')) {
        durableValidity = 200; // concurrent connection publishes the new epoch here
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('COALESCE(MAX(uid), 0)')) return Promise.resolve({ rows: [{ max_uid: 0 }] });
      if (sql.includes("preferences->>'categorizationEnabled'")) return Promise.resolve({ rows: [{ val: false }] });
      if (sql.includes('INSERT INTO messages')) return Promise.resolve({ rows: [{ id: 'stale', is_new: true }] });
      return Promise.resolve({ rows: [] });
    });
    parseMessage.mockResolvedValue({
      uid: 501, messageId: '<old@example.com>', subject: 'Old epoch',
      fromName: 'Sender', fromEmail: 'sender@example.com', to: [], cc: [], replyTo: [],
      inReplyTo: null, references: null, date: new Date('2026-08-25T10:00:00Z'),
      snippet: '', isRead: true, isStarred: false, hasAttachments: false, flags: [],
      isBulk: false, parsedHeaders: {},
    });

    await expect(ImapManager.prototype.syncMessages.call(
      { pluginFacade: {} }, account, client, 'Watch', 50, false, true, 0
    )).rejects.toThrow(/UIDVALIDITY/i);
    expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO messages'))).toBe(false);
  });

  it('empty cache forces the full metadata scan and accepts an envelope without Message-ID', async () => {
    const account = {
      id: 'acct-sync-empty-cache',
      user_id: 'user-1',
      email_address: 'me@example.com',
      gtd_enabled: false,
      categorization_enabled: false,
      imap_host: 'imap.example.com',
    };
    const client = {
      getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
      mailbox: { exists: 1, uidValidity: 100, highestModseq: 500n },
      fetch: vi.fn(async function* () { yield { uid: 501, envelope: { subject: 'Watch first message' } }; }),
    };
    query.mockImplementation((sql) => {
      if (sql.includes('SELECT uid_validity, highest_modseq FROM folders')) {
        return Promise.resolve({ rows: [{ uid_validity: 100, highest_modseq: '500' }] });
      }
      if (sql.includes('COUNT(*) FILTER (WHERE is_read = false)')) return Promise.resolve({ rows: [{ n: 0 }] });
      if (sql.includes('INSERT INTO folders')) return Promise.resolve({ rows: [] });
      if (sql.includes('COALESCE(MAX(uid), 0)')) return Promise.resolve({ rows: [{ max_uid: 0 }] });
      if (sql.includes('SELECT gtd_enabled, gtd_folders FROM email_accounts')) {
        return Promise.resolve({ rows: [{ gtd_enabled: false, gtd_folders: {} }] });
      }
      if (sql.includes("preferences->>'categorizationEnabled'")) return Promise.resolve({ rows: [{ val: false }] });
      if (sql.includes('INSERT INTO messages')) return Promise.resolve({ rows: [{ id: 'msg-1', is_new: true }] });
      if (sql.includes('UPDATE folders SET highest_modseq')) return Promise.resolve({ rows: [] });
      if (sql.includes('UPDATE email_accounts SET last_sync')) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] });
    });
    parseMessage.mockResolvedValue({
      uid: 501,
      messageId: null,
      subject: 'Watch first message',
      fromName: 'External',
      fromEmail: 'them@example.com',
      to: [],
      cc: [],
      replyTo: [],
      inReplyTo: null,
      references: null,
      date: new Date('2026-07-17T10:00:00Z'),
      snippet: 'hi',
      isRead: true,
      isStarred: false,
      hasAttachments: false,
      flags: ['\\Seen'],
      isBulk: false,
      parsedHeaders: {},
    });

    const result = await ImapManager.prototype.syncMessages.call({}, account, client, 'Watch', 50, false, true);

    expect(client.fetch).toHaveBeenCalledTimes(1);
    expect(client.fetch.mock.calls[0][0]).toBe('1:1');
    expect(client.fetch.mock.calls[0][1]).toEqual(expect.objectContaining({
      envelope: true,
      bodyStructure: true,
      flags: true,
      uid: true,
    }));
    expect(client.fetch.mock.calls[0][2]).toBeUndefined();
    const insertIndex = query.mock.calls.findIndex(([sql]) => sql.includes('INSERT INTO messages'));
    const modseqUpdateIndex = query.mock.calls.findIndex(([sql]) => sql.includes('UPDATE folders SET highest_modseq'));
    expect(insertIndex).toBeGreaterThanOrEqual(0);
    expect(modseqUpdateIndex).toBeGreaterThan(insertIndex);
    expect(result).toEqual(expect.objectContaining({ insertedCount: 1 }));
  });

  it('skips the UID fetch when SEARCH finds no UID above the watermark', async () => {
    const account = {
      id: 'acct-sync-watermark',
      user_id: 'user-1',
      email_address: 'me@example.com',
      gtd_enabled: false,
      categorization_enabled: false,
      imap_host: 'imap.example.com',
    };
    const client = {
      getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
      mailbox: { exists: 50, uidNext: 51, uidValidity: 100, highestModseq: 500n },
      search: vi.fn().mockResolvedValue([]),
      fetch: vi.fn(async function* () {}),
    };
    query.mockImplementation((sql) => {
      if (sql.includes('SELECT uid_validity, highest_modseq FROM folders')) {
        return Promise.resolve({ rows: [{ uid_validity: 100, highest_modseq: '500' }] });
      }
      if (sql.includes('COUNT(*) FILTER (WHERE is_read = false)')) return Promise.resolve({ rows: [{ n: 0 }] });
      if (sql.includes('INSERT INTO folders')) return Promise.resolve({ rows: [] });
      if (sql.includes('COALESCE(MAX(uid), 0)')) return Promise.resolve({ rows: [{ max_uid: 50 }] });
      if (sql.includes('SELECT gtd_enabled, gtd_folders FROM email_accounts')) {
        return Promise.resolve({ rows: [{ gtd_enabled: false, gtd_folders: {} }] });
      }
      if (sql.includes('UPDATE email_accounts SET last_sync')) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] });
    });

    await ImapManager.prototype.syncMessages.call({}, account, client, 'Watch', 50, false, true);

    expect(client.search).toHaveBeenCalledWith({ uid: '51:*' }, { uid: true });
    expect(client.fetch).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]) => sql.includes('UPDATE folders SET highest_modseq'))).toBe(false);
  });

  it('defers later phases when the primary UID SEARCH fails', async () => {
    const account = {
      id: 'acct-sync-watermark', user_id: 'user-1', email_address: 'me@example.com',
      gtd_enabled: false, categorization_enabled: false, imap_host: 'imap.example.com',
    };
    const client = {
      getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
      mailbox: { exists: 600, uidValidity: 100, highestModseq: 501n },
      search: vi.fn().mockResolvedValue(false),
      fetch: vi.fn(async function* () {
        yield { uid: 600, envelope: { subject: 'Later message' }, flags: new Set() };
      }),
    };
    stubSyncQueries({ maxUid: 500, storedModseq: null });
    parseMessage.mockImplementation(async msg => parsedFetch(msg.uid));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await ImapManager.prototype.syncMessages.call(
        { pluginFacade: {} }, account, client, 'Watch', 20, false, true
      );

      expect(client.fetch).not.toHaveBeenCalled();
      expect(parseMessage).not.toHaveBeenCalled();
      expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO messages'))).toBe(false);
      expect(query.mock.calls.some(([sql]) => sql.includes('UPDATE folders SET highest_modseq'))).toBe(false);
      expect(result.insertedCount).toBe(0);
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });

  it('does not issue a reversed UID range after expunge moves the mailbox below the watermark', async () => {
    const account = {
      id: 'acct-sync-watermark',
      user_id: 'user-1',
      email_address: 'me@example.com',
      gtd_enabled: false,
      categorization_enabled: false,
      imap_host: 'imap.example.com',
    };
    const client = {
      getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
      mailbox: { exists: 40, uidNext: 501, uidValidity: 100, highestModseq: 500n },
      search: vi.fn().mockResolvedValue([498, 500]),
      fetch: vi.fn(async function* () {}),
    };
    query.mockImplementation((sql) => {
      if (sql.includes('SELECT uid_validity, highest_modseq FROM folders')) {
        return Promise.resolve({ rows: [{ uid_validity: 100, highest_modseq: '500' }] });
      }
      if (sql.includes('COUNT(*) FILTER (WHERE is_read = false)')) return Promise.resolve({ rows: [{ n: 0 }] });
      if (sql.includes('COALESCE(MAX(uid), 0)')) return Promise.resolve({ rows: [{ max_uid: 500 }] });
      if (sql.includes('INSERT INTO messages')) return Promise.resolve({ rows: [{ id: 'ghost', is_new: true }] });
      return Promise.resolve({ rows: [] });
    });
    parseMessage.mockImplementation(async msg => ({
      uid: msg.uid,
      messageId: null,
      subject: '(no subject)',
      fromName: '',
      fromEmail: '',
      to: [],
      cc: [],
      replyTo: [],
      inReplyTo: null,
      references: null,
      date: new Date(),
      snippet: '',
      isRead: true,
      isStarred: false,
      hasAttachments: false,
      flags: [],
      isBulk: false,
      parsedHeaders: {},
    }));

    const result = await ImapManager.prototype.syncMessages.call(
      { pluginFacade: {} }, account, client, 'Watch', 20, false, true
    );

    expect(client.fetch).not.toHaveBeenCalled();
    expect(client.search).toHaveBeenCalledWith({ uid: '501:*' }, { uid: true });
    expect(parseMessage).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO messages'))).toBe(false);
    expect(result.insertedCount).toBe(0);
  });

  it('does not let later UIDs leapfrog incomplete metadata', async () => {
    const account = {
      id: 'acct-sync-watermark', user_id: 'user-1', email_address: 'me@example.com',
      gtd_enabled: false, categorization_enabled: false, imap_host: 'imap.example.com',
    };
    let fetchRound = 0;
    const client = {
      getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
      mailbox: { exists: 502, uidNext: 504, uidValidity: 100, highestModseq: 500n },
      search: vi.fn().mockResolvedValue([501, 502, 503]),
      fetch: vi.fn(async function* () {
        fetchRound++;
        if (fetchRound === 1) {
          yield { uid: 501 };
          yield { uid: 502, envelope: {}, flags: new Set() };
          yield { uid: 503, envelope: { subject: 'secret-subject' }, flags: new Set() };
          return;
        }
        yield { uid: 501, envelope: { subject: 'first' }, flags: new Set() };
        yield { uid: 502, envelope: { subject: 'second' }, flags: new Set() };
        yield { uid: 503, envelope: { subject: 'third' }, flags: new Set() };
      }),
    };
    stubSyncQueries({ maxUid: 500 });
    parseMessage.mockImplementation(async msg => parsedFetch(msg.uid));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const first = await ImapManager.prototype.syncMessages.call(
        { pluginFacade: {} }, account, client, 'Watch', 20, false, true
      );

      expect(parseMessage).not.toHaveBeenCalled();
      expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO messages'))).toBe(false);
      expect(first.insertedCount).toBe(0);
      expect(warn).toHaveBeenCalledOnce();
      expect(client.fetch.mock.calls[0][0]).toBe('501,502,503');
      const warning = warn.mock.calls[0].join(' ');
      expect(warning).not.toMatch(/501|502|503|secret-subject|them@example\.com/);

      parseMessage.mockClear();
      query.mockClear();
      const second = await ImapManager.prototype.syncMessages.call(
        { pluginFacade: {} }, account, client, 'Watch', 20, false, true
      );

      expect(parseMessage).toHaveBeenCalledTimes(3);
      expect(query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO messages'))).toHaveLength(3);
      expect(second.insertedCount).toBe(3);
    } finally {
      warn.mockRestore();
    }
  });

  it('does not let a later UID leapfrog when parsing or persistence fails', async () => {
    const account = {
      id: 'acct-sync-watermark', user_id: 'user-1', email_address: 'me@example.com',
      gtd_enabled: false, categorization_enabled: false, imap_host: 'imap.example.com',
    };
    const client = {
      getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
      mailbox: { exists: 502, uidNext: 503, uidValidity: 100, highestModseq: 501n },
      search: vi.fn().mockResolvedValue([501, 502]),
      fetch: vi.fn(async function* () {
        yield { uid: 501, envelope: { subject: 'First' }, flags: new Set() };
        yield { uid: 502, envelope: { subject: 'Second' }, flags: new Set() };
      }),
    };
    stubSyncQueries({ maxUid: 500, storedModseq: '500' });
    parseMessage.mockImplementation(async msg => {
      if (msg.uid === 501) throw new Error('parser failed');
      return parsedFetch(msg.uid);
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await ImapManager.prototype.syncMessages.call(
        { pluginFacade: {} }, account, client, 'Watch', 20, false, true
      );

      expect(parseMessage.mock.calls.map(([msg]) => msg.uid)).toEqual([501]);
      expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO messages'))).toBe(false);
      expect(query.mock.calls.some(([sql]) => sql.includes('UPDATE folders SET highest_modseq'))).toBe(false);
      expect(result.insertedCount).toBe(0);
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      error.mockRestore();
      warn.mockRestore();
    }
  });

  it('accepts an explicitly returned all-NIL envelope', async () => {
    const account = {
      id: 'acct-sync-watermark', user_id: 'user-1', email_address: 'me@example.com',
      gtd_enabled: false, categorization_enabled: false, imap_host: 'imap.example.com',
    };
    const client = {
      getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
      mailbox: { exists: 501, uidNext: 502, uidValidity: 100, highestModseq: 500n },
      search: vi.fn().mockResolvedValue([501]),
      fetch: vi.fn(async function* () {
        yield { uid: 501, envelope: {}, internalDate: new Date('2026-08-25T10:00:00Z') };
      }),
    };
    stubSyncQueries({ maxUid: 500 });
    parseMessage.mockImplementation(async msg => parsedFetch(msg.uid));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await ImapManager.prototype.syncMessages.call(
        { pluginFacade: {} }, account, client, 'Watch', 20, false, true
      );

      expect(parseMessage).toHaveBeenCalledOnce();
      expect(query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO messages'))).toHaveLength(1);
      expect(result.insertedCount).toBe(1);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('processes a large new-mail range in bounded metadata batches', async () => {
    const account = {
      id: 'acct-sync-watermark', user_id: 'user-1', email_address: 'me@example.com',
      gtd_enabled: false, categorization_enabled: false, imap_host: 'imap.example.com',
    };
    let yielded = 0;
    let yieldedAtFirstParse = null;
    const client = {
      getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
      mailbox: { exists: 705, uidNext: 706, uidValidity: 100, highestModseq: 500n },
      search: vi.fn().mockResolvedValue(Array.from({ length: 205 }, (_, index) => index + 501)),
      fetch: vi.fn(async function* (uidSet) {
        for (const uid of uidSet.split(',').map(Number)) {
          yielded++;
          yield { uid, envelope: { subject: `Message ${uid}` }, flags: new Set() };
        }
      }),
    };
    stubSyncQueries({ maxUid: 500 });
    parseMessage.mockImplementation(async msg => {
      if (yieldedAtFirstParse === null) yieldedAtFirstParse = yielded;
      return parsedFetch(msg.uid);
    });

    const result = await ImapManager.prototype.syncMessages.call(
      { pluginFacade: {} }, account, client, 'Watch', 20, false, true
    );

    expect(client.fetch.mock.calls.map(([uidSet]) => uidSet.split(',').map(Number))).toEqual([
      Array.from({ length: 100 }, (_, index) => index + 501),
      Array.from({ length: 100 }, (_, index) => index + 601),
      Array.from({ length: 5 }, (_, index) => index + 701),
    ]);
    expect(yieldedAtFirstParse).toBe(100);
    expect(parseMessage).toHaveBeenCalledTimes(205);
    expect(result.insertedCount).toBe(205);
  });

  it('persists a growing live EXISTS count after bounded initial sync so backfill runs the exact UID diff', async () => {
    const account = {
      id: 'acct-sync-empty-cache', user_id: 'user-1', email_address: 'me@example.com',
      gtd_enabled: false, categorization_enabled: false, imap_host: 'imap.example.com',
      imap_port: 993, imap_tls: true, auth_user: 'me@example.com', auth_pass: 'encrypted',
    };
    const localUids = new Set();
    let folderTotal = 0;
    let backfillIncomplete = false;
    const syncClient = {
      getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
      mailbox: { exists: 20, uidValidity: 100, highestModseq: 500n },
      fetch: vi.fn(async function* () {
        for (let uid = 2; uid <= 21; uid++) {
          yield { uid, envelope: { subject: `Message ${uid}` }, flags: new Set() };
        }
      }),
    };
    const exactDiffReached = new Error('exact UID diff reached');
    const backfillClient = {
      mailbox: { exists: 21, uidValidity: 100 },
      on: vi.fn(),
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
      logout: vi.fn().mockResolvedValue(undefined),
      getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
      search: vi.fn().mockRejectedValue(exactDiffReached),
    };
    ImapFlow.mockImplementation(function () { return backfillClient; });
    getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: true, allowInsecureTls: true });
    resolveForConnection.mockResolvedValue({ host: '127.0.0.1', addresses: ['127.0.0.1'], servername: null });
    query.mockImplementation((sql, params = []) => {
      if (sql.includes('SELECT uid_validity, highest_modseq FROM folders')) {
        return Promise.resolve({ rows: [{ uid_validity: 100, highest_modseq: '500' }] });
      }
      if (sql.includes('COUNT(*) FILTER (WHERE is_read = false) AS n')) {
        return Promise.resolve({ rows: [{ n: 0 }] });
      }
      if (sql.includes('UPDATE folders') && sql.includes('SET total_count = $3')) {
        folderTotal = Number(params[2]);
        syncClient.mailbox.exists = 21;
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('COALESCE(MAX(uid), 0) as max_uid')) {
        return Promise.resolve({ rows: [{ max_uid: 0 }] });
      }
      if (sql.includes('INSERT INTO messages')) {
        localUids.add(Number(params[1]));
        return Promise.resolve({ rows: [{ id: `row-${params[1]}`, is_new: true }] });
      }
      if (sql.includes('UPDATE folders') && sql.includes('SET total_count = (SELECT COUNT(*)')) {
        folderTotal = localUids.size;
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('UPDATE folders') && sql.includes('SET total_count = $3')) {
        folderTotal = Number(params[2]);
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('SELECT uid_validity, total_count, backfill_incomplete FROM folders')) {
        return Promise.resolve({ rows: [{ uid_validity: 100, total_count: folderTotal, backfill_incomplete: backfillIncomplete }] });
      }
      if (sql.includes('SELECT COUNT(*) AS n FROM messages')) {
        return Promise.resolve({ rows: [{ n: localUids.size }] });
      }
      if (sql.includes('UPDATE folders SET backfill_incomplete = true')) {
        backfillIncomplete = true;
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('SELECT * FROM email_accounts')) {
        return Promise.resolve({ rows: [{ ...account, enabled: true }] });
      }
      if (sql.includes('SELECT gtd_enabled, gtd_folders FROM email_accounts')) {
        return Promise.resolve({ rows: [{ gtd_enabled: false, gtd_folders: {} }] });
      }
      if (sql.includes("preferences->>'categorizationEnabled'")) {
        return Promise.resolve({ rows: [{ val: false }] });
      }
      return Promise.resolve({ rows: [] });
    });
    parseMessage.mockImplementation(async msg => parsedFetch(msg.uid));
    const ctx = { backfillRunning: new Set(), pluginFacade: {}, broadcast: vi.fn() };
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(ImapManager.prototype.syncMessages.call(
        ctx, account, syncClient, 'INBOX', 20, false, true
      )).resolves.toMatchObject({ insertedCount: 20 });
      expect(localUids.size).toBe(20);

      await expect(ImapManager.prototype.backfillMessages.call(ctx, account, 'INBOX'))
        .resolves.toBe(false);
      expect(syncClient.fetch).toHaveBeenCalledWith('2:21', expect.any(Object));
      expect(folderTotal).toBe(21);
      expect(backfillClient.search).toHaveBeenCalledWith({ all: true }, { uid: true });
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  it('fetches sparse UIDs by candidate count rather than numeric distance', async () => {
    const account = {
      id: 'acct-sync-watermark', user_id: 'user-1', email_address: 'me@example.com',
      gtd_enabled: false, categorization_enabled: false, imap_host: 'imap.example.com',
    };
    const client = {
      getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
      mailbox: { exists: 501, uidValidity: 100, highestModseq: 500n },
      search: vi.fn().mockResolvedValue([1_000_000]),
      fetch: vi.fn(async function* () {
        yield { uid: 1_000_000, envelope: { subject: 'Sparse message' }, flags: new Set() };
      }),
    };
    stubSyncQueries({ maxUid: 500 });
    parseMessage.mockImplementation(async msg => parsedFetch(msg.uid));

    const result = await ImapManager.prototype.syncMessages.call(
      { pluginFacade: {} }, account, client, 'Watch', 20, false, true
    );

    expect(client.search).toHaveBeenCalledWith({ uid: '501:*' }, { uid: true });
    expect(client.fetch).toHaveBeenCalledTimes(1);
    expect(client.fetch.mock.calls[0][0]).toBe('1000000');
    expect(parseMessage).toHaveBeenCalledOnce();
    expect(result.insertedCount).toBe(1);
  });

  it('defers a UID batch when FETCH omits a SEARCH candidate', async () => {
    const account = {
      id: 'acct-sync-watermark', user_id: 'user-1', email_address: 'me@example.com',
      gtd_enabled: false, categorization_enabled: false, imap_host: 'imap.example.com',
    };
    const client = {
      getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
      mailbox: { exists: 502, uidValidity: 100, highestModseq: 500n },
      search: vi.fn()
        .mockResolvedValueOnce([501, 502])
        .mockResolvedValueOnce([10]),
      fetch: vi.fn()
        .mockImplementationOnce(async function* () {
          yield { uid: 502, envelope: { subject: 'Later message' }, flags: new Set() };
        })
        .mockImplementationOnce(async function* () {
          yield { seq: 10, uid: 501 };
        }),
    };
    stubSyncQueries({ maxUid: 500 });
    parseMessage.mockImplementation(async msg => parsedFetch(msg.uid));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await ImapManager.prototype.syncMessages.call(
        { pluginFacade: {} }, account, client, 'Watch', 20, false, true
      );

      expect(client.fetch.mock.calls[0][0]).toBe('501,502');
      expect(client.search).toHaveBeenNthCalledWith(2, { uid: '501' }, { uid: false });
      expect(client.fetch.mock.calls[1][0]).toBe('10');
      expect(parseMessage).not.toHaveBeenCalled();
      expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO messages'))).toBe(false);
      expect(result.insertedCount).toBe(0);
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });

  it('does not let a sequence-unmapped phantom UID block valid new mail', async () => {
    const account = {
      id: 'acct-sync-watermark', user_id: 'user-1', email_address: 'me@example.com',
      gtd_enabled: false, categorization_enabled: false, imap_host: 'imap.example.com',
    };
    const client = {
      getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
      mailbox: { exists: 502, uidValidity: 100, highestModseq: 500n },
      search: vi.fn()
        .mockResolvedValueOnce([501, 502])
        .mockResolvedValueOnce([]),
      fetch: vi.fn(async function* () {
        yield { uid: 502, envelope: { subject: 'Valid message' }, flags: new Set() };
      }),
    };
    stubSyncQueries({ maxUid: 500 });
    parseMessage.mockImplementation(async msg => parsedFetch(msg.uid));

    const result = await ImapManager.prototype.syncMessages.call(
      { pluginFacade: {} }, account, client, 'Watch', 20, false, true
    );

    expect(client.search).toHaveBeenNthCalledWith(2, { uid: '501' }, { uid: false });
    expect(client.fetch).toHaveBeenCalledTimes(1);
    expect(parseMessage).toHaveBeenCalledOnce();
    expect(parseMessage).toHaveBeenCalledWith(expect.objectContaining({ uid: 502 }));
    expect(result.insertedCount).toBe(1);
  });

  it('recovers an omitted UID through sequence addressing before committing the batch', async () => {
    const account = {
      id: 'acct-sync-watermark', user_id: 'user-1', email_address: 'me@example.com',
      gtd_enabled: false, categorization_enabled: false, imap_host: 'imap.example.com',
    };
    const client = {
      getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
      mailbox: { exists: 502, uidValidity: 100, highestModseq: 500n },
      search: vi.fn()
        .mockResolvedValueOnce([501, 502])
        .mockResolvedValueOnce([10]),
      fetch: vi.fn()
        .mockImplementationOnce(async function* () {
          yield { uid: 502, envelope: { subject: 'Second message' }, flags: new Set() };
        })
        .mockImplementationOnce(async function* () {
          yield { seq: 10, uid: 501, envelope: { subject: 'First message' }, flags: new Set() };
        }),
    };
    stubSyncQueries({ maxUid: 500 });
    parseMessage.mockImplementation(async msg => parsedFetch(msg.uid));

    const result = await ImapManager.prototype.syncMessages.call(
      { pluginFacade: {} }, account, client, 'Watch', 20, false, true
    );

    expect(client.fetch.mock.calls.map(([set]) => set)).toEqual(['501,502', '10']);
    expect(parseMessage.mock.calls.map(([msg]) => msg.uid)).toEqual([501, 502]);
    expect(result.insertedCount).toBe(2);
  });

  it('defers when sequence revalidation fails instead of assuming a phantom', async () => {
    const account = {
      id: 'acct-sync-watermark', user_id: 'user-1', email_address: 'me@example.com',
      gtd_enabled: false, categorization_enabled: false, imap_host: 'imap.example.com',
    };
    const client = {
      getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
      mailbox: { exists: 502, uidValidity: 100, highestModseq: 501n },
      search: vi.fn()
        .mockResolvedValueOnce([501, 502])
        .mockResolvedValueOnce(false),
      fetch: vi.fn(async function* () {
        yield { uid: 502, envelope: { subject: 'Later message' }, flags: new Set() };
      }),
    };
    stubSyncQueries({ maxUid: 500, storedModseq: '500' });
    parseMessage.mockImplementation(async msg => parsedFetch(msg.uid));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await ImapManager.prototype.syncMessages.call(
        { pluginFacade: {} }, account, client, 'Watch', 20, false, true
      );

      expect(parseMessage).not.toHaveBeenCalled();
      expect(query.mock.calls.some(([sql]) => sql.includes('UPDATE folders SET highest_modseq'))).toBe(false);
      expect(result.insertedCount).toBe(0);
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });

  it('cannot commit a later UID range before an incomplete earlier range', async () => {
    const account = {
      id: 'acct-sync-watermark', user_id: 'user-1', email_address: 'me@example.com',
      gtd_enabled: false, categorization_enabled: false, imap_host: 'imap.example.com',
    };
    const client = {
      getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
      mailbox: { exists: 705, uidNext: 706, uidValidity: 100, highestModseq: 500n },
      search: vi.fn().mockResolvedValue(Array.from({ length: 205 }, (_, index) => index + 501)),
      fetch: vi.fn(async function* (uidSet) {
        const uids = uidSet.split(',').map(Number);
        for (let index = uids.length - 1; index > 0; index--) {
          const uid = uids[index];
          yield { uid, envelope: { subject: `Message ${uid}` }, flags: new Set() };
        }
        yield { uid: uids[0] };
      }),
    };
    stubSyncQueries({ maxUid: 500 });
    parseMessage.mockImplementation(async msg => parsedFetch(msg.uid));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await ImapManager.prototype.syncMessages.call(
        { pluginFacade: {} }, account, client, 'Watch', 20, false, true
      );

      expect(client.fetch).toHaveBeenCalledTimes(1);
      expect(client.fetch.mock.calls[0][0].split(',').map(Number)).toEqual(
        Array.from({ length: 100 }, (_, index) => index + 501)
      );
      expect(parseMessage).not.toHaveBeenCalled();
      expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO messages'))).toBe(false);
      expect(result.insertedCount).toBe(0);
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });

  it('rejects an incomplete full metadata batch without advancing modseq', async () => {
    const account = {
      id: 'acct-sync-empty-cache', user_id: 'user-1', email_address: 'me@example.com',
      gtd_enabled: false, categorization_enabled: false, imap_host: 'imap.example.com',
    };
    const client = {
      getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
      mailbox: { exists: 2, uidValidity: 100, highestModseq: 501n },
      fetch: vi.fn(async function* () {
        yield { uid: 1 };
        yield { uid: 2, envelope: { subject: 'complete' }, flags: new Set() };
      }),
    };
    stubSyncQueries({ maxUid: 0, storedModseq: '500' });
    parseMessage.mockImplementation(async msg => parsedFetch(msg.uid));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await ImapManager.prototype.syncMessages.call(
        { pluginFacade: {} }, account, client, 'Watch', 20, false, true
      );

      expect(parseMessage).not.toHaveBeenCalled();
      expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO messages'))).toBe(false);
      expect(query.mock.calls.some(([sql]) => sql.includes('UPDATE folders SET highest_modseq'))).toBe(false);
      expect(result.insertedCount).toBe(0);
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });

  it('rejects a full metadata scan that omits an expected message', async () => {
    const account = {
      id: 'acct-sync-empty-cache', user_id: 'user-1', email_address: 'me@example.com',
      gtd_enabled: false, categorization_enabled: false, imap_host: 'imap.example.com',
    };
    const client = {
      getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
      mailbox: { exists: 2, uidValidity: 100, highestModseq: 501n },
      fetch: vi.fn(async function* () {
        yield { uid: 2, envelope: { subject: 'Later message' }, flags: new Set() };
      }),
    };
    stubSyncQueries({ maxUid: 0, storedModseq: '500' });
    parseMessage.mockImplementation(async msg => parsedFetch(msg.uid));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await ImapManager.prototype.syncMessages.call(
        { pluginFacade: {} }, account, client, 'Watch', 20, false, true
      );

      expect(client.fetch.mock.calls[0][0]).toBe('1:2');
      expect(parseMessage).not.toHaveBeenCalled();
      expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO messages'))).toBe(false);
      expect(query.mock.calls.some(([sql]) => sql.includes('UPDATE folders SET highest_modseq'))).toBe(false);
      expect(result.insertedCount).toBe(0);
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });

  it('bounds a full scan to the mailbox snapshot when new mail arrives', async () => {
    const account = {
      id: 'acct-sync-empty-cache', user_id: 'user-1', email_address: 'me@example.com',
      gtd_enabled: false, categorization_enabled: false, imap_host: 'imap.example.com',
    };
    const client = {
      getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
      mailbox: { exists: 2, uidValidity: 100, highestModseq: 501n },
      fetch: vi.fn(async function* (range) {
        yield { uid: 1, envelope: { subject: 'First message' }, flags: new Set() };
        yield { uid: 2, envelope: { subject: 'Second message' }, flags: new Set() };
        if (range === '1:*') {
          yield { uid: 3, envelope: { subject: 'Post-snapshot arrival' }, flags: new Set() };
        }
      }),
    };
    stubSyncQueries({ maxUid: 0, storedModseq: '500' });
    parseMessage.mockImplementation(async msg => parsedFetch(msg.uid));

    const result = await ImapManager.prototype.syncMessages.call(
      { pluginFacade: {} }, account, client, 'Watch', 20, false, true
    );

    expect(client.fetch.mock.calls[0][0]).toBe('1:2');
    expect(parseMessage).toHaveBeenCalledTimes(2);
    expect(result.insertedCount).toBe(2);
    expect(query.mock.calls.some(([sql]) => sql.includes('UPDATE folders SET highest_modseq'))).toBe(true);
  });

  it('keeps the retry barrier across UID and full metadata phases', async () => {
    const account = {
      id: 'acct-sync-watermark', user_id: 'user-1', email_address: 'me@example.com',
      gtd_enabled: false, categorization_enabled: false, imap_host: 'imap.example.com',
    };
    const client = {
      getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
      mailbox: { exists: 600, uidNext: 503, uidValidity: 100, highestModseq: 501n },
      search: vi.fn().mockResolvedValue([501, 502]),
      fetch: vi.fn()
        .mockImplementationOnce(async function* () {
          yield { uid: 501 };
          yield { uid: 502, envelope: { subject: 'later' }, flags: new Set() };
        })
        .mockImplementationOnce(async function* () {
          yield { uid: 600, envelope: { subject: 'much later' }, flags: new Set() };
        }),
    };
    stubSyncQueries({ maxUid: 500, storedModseq: null });
    parseMessage.mockImplementation(async msg => parsedFetch(msg.uid));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await ImapManager.prototype.syncMessages.call(
        { pluginFacade: {} }, account, client, 'Watch', 20, false, true
      );

      expect(client.fetch).toHaveBeenCalledTimes(1);
      expect(parseMessage).not.toHaveBeenCalled();
      expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO messages'))).toBe(false);
      expect(query.mock.calls.some(([sql]) => sql.includes('UPDATE folders SET highest_modseq'))).toBe(false);
      expect(result.insertedCount).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps the retry barrier when an exact UID FETCH becomes stale', async () => {
    const account = {
      id: 'acct-sync-watermark', user_id: 'user-1', email_address: 'me@example.com',
      gtd_enabled: false, categorization_enabled: false, imap_host: 'imap.example.com',
    };
    const client = {
      getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
      mailbox: { exists: 600, uidValidity: 100, highestModseq: 501n },
      search: vi.fn().mockResolvedValue([501, 502]),
      fetch: vi.fn()
        .mockImplementationOnce(async function* (uidSet) {
          if (!uidSet) yield null;
          throw new Error('Invalid messageset after concurrent expunge');
        })
        .mockImplementationOnce(async function* () {
          yield { uid: 600, envelope: { subject: 'much later' }, flags: new Set() };
        }),
    };
    stubSyncQueries({ maxUid: 500, storedModseq: null });
    parseMessage.mockImplementation(async msg => parsedFetch(msg.uid));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await ImapManager.prototype.syncMessages.call(
        { pluginFacade: {} }, account, client, 'Watch', 20, false, true
      );

      expect(client.fetch).toHaveBeenCalledTimes(1);
      expect(parseMessage).not.toHaveBeenCalled();
      expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO messages'))).toBe(false);
      expect(query.mock.calls.some(([sql]) => sql.includes('UPDATE folders SET highest_modseq'))).toBe(false);
      expect(result.insertedCount).toBe(0);
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });

  it('hands a newly-inserted INBOX row to the inboxIngest hook when a plugin is active', async () => {
    // wire: an active inbox-ingest plugin makes syncMessages collect the new row's id and
    // dispatch runHook('inboxIngest', …). We spy the registry rather than register a real
    // plugin so the singleton stays clean for other suites.
    const hasActive = vi.spyOn(pluginRegistry, 'hasActiveAsync').mockImplementation(async (name) => name === 'inboxIngest');
    const runHook = vi.spyOn(pluginRegistry, 'runHook').mockResolvedValue([]);
    try {
      const account = {
        id: 'acct-ingest', user_id: 'user-1', email_address: 'me@example.com',
        gtd_enabled: true, categorization_enabled: false, imap_host: 'imap.example.com',
      };
      const client = {
        getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
        mailbox: { exists: 1, uidValidity: 100, highestModseq: 500n },
        fetch: vi.fn(async function* () { yield { uid: 501, envelope: { messageId: '<in1@x>' } }; }),
      };
      query.mockImplementation((sql) => {
        if (sql.includes('SELECT uid_validity, highest_modseq FROM folders')) {
          return Promise.resolve({ rows: [{ uid_validity: 100, highest_modseq: '500' }] });
        }
        if (sql.includes('COUNT(*) FILTER (WHERE is_read = false)')) return Promise.resolve({ rows: [{ n: 0 }] });
        if (sql.includes('INSERT INTO folders')) return Promise.resolve({ rows: [] });
        if (sql.includes('COALESCE(MAX(uid), 0)')) return Promise.resolve({ rows: [{ max_uid: 0 }] });
        if (sql.includes('SELECT gtd_enabled, gtd_folders FROM email_accounts')) {
          return Promise.resolve({ rows: [{ gtd_enabled: true, gtd_folders: {} }] });
        }
        if (sql.includes('INSERT INTO messages')) return Promise.resolve({ rows: [{ id: 'ingest-1', is_new: true }] });
        if (sql.includes('UPDATE folders SET highest_modseq')) return Promise.resolve({ rows: [] });
        if (sql.includes('UPDATE email_accounts SET last_sync')) return Promise.resolve({ rows: [] });
        return Promise.resolve({ rows: [] });
      });
      // Arrived already \Seen, so it never enters the unread notification list — it must still
      // reach inboxIngest via the read-inclusive candidate set.
      parseMessage.mockResolvedValue({
        uid: 501, messageId: '<in1@x>', subject: 'Reply', fromName: 'External', fromEmail: 'them@example.com',
        to: [], cc: [], replyTo: [], inReplyTo: null, references: null, date: new Date('2026-07-17T10:00:00Z'),
        snippet: 'hi', isRead: true, isStarred: false, hasAttachments: false, flags: ['\\Seen'], isBulk: false, parsedHeaders: {},
      });

      const mgr = { pluginFacade: { __facade: true } };
      await ImapManager.prototype.syncMessages.call(mgr, account, client, 'INBOX', 50, false, true);

      expect(hasActive).toHaveBeenCalledWith('inboxIngest', { account });
      // The hook receives the bounded facade, never the raw engine (`this`).
      expect(runHook).toHaveBeenCalledWith('inboxIngest', {
        mgr: mgr.pluginFacade, account, newInboxIds: ['ingest-1'], deletedIds: new Set(),
      });
    } finally {
      hasActive.mockRestore();
      runHook.mockRestore();
    }
  });

  it('does not dispatch inboxIngest when no ingest plugin is active', async () => {
    const hasActive = vi.spyOn(pluginRegistry, 'hasActiveAsync').mockResolvedValue(false);
    const runHook = vi.spyOn(pluginRegistry, 'runHook').mockResolvedValue([]);
    try {
      const account = {
        id: 'acct-no-ingest', user_id: 'user-1', email_address: 'me@example.com',
        gtd_enabled: false, categorization_enabled: false, imap_host: 'imap.example.com',
      };
      const client = {
        getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
        mailbox: { exists: 1, uidValidity: 100, highestModseq: 500n },
        fetch: vi.fn(async function* () { yield { uid: 501, envelope: { messageId: '<in2@x>' } }; }),
      };
      query.mockImplementation((sql) => {
        if (sql.includes('SELECT uid_validity, highest_modseq FROM folders')) return Promise.resolve({ rows: [{ uid_validity: 100, highest_modseq: '500' }] });
        if (sql.includes('COUNT(*) FILTER (WHERE is_read = false)')) return Promise.resolve({ rows: [{ n: 0 }] });
        if (sql.includes('COALESCE(MAX(uid), 0)')) return Promise.resolve({ rows: [{ max_uid: 0 }] });
        if (sql.includes('INSERT INTO messages')) return Promise.resolve({ rows: [{ id: 'x', is_new: true }] });
        return Promise.resolve({ rows: [] });
      });
      parseMessage.mockResolvedValue({
        uid: 501, messageId: '<in2@x>', subject: 'Reply', fromName: 'External', fromEmail: 'them@example.com',
        to: [], cc: [], replyTo: [], inReplyTo: null, references: null, date: new Date('2026-07-17T10:00:00Z'),
        snippet: 'hi', isRead: true, isStarred: false, hasAttachments: false, flags: ['\\Seen'], isBulk: false, parsedHeaders: {},
      });

      await ImapManager.prototype.syncMessages.call({}, account, client, 'INBOX', 50, false, true);
      expect(runHook).not.toHaveBeenCalledWith('inboxIngest', expect.anything());
    } finally {
      hasActive.mockRestore();
      runHook.mockRestore();
    }
  });
});

describe('syncMessages — unread_count recompute ordering (folder badge fix)', () => {
  it('recomputes folders.unread_count from rows AFTER inserting new messages', async () => {
    // The provisional unread_count written before the fetch left on-demand folders (e.g. Junk)
    // showing a stale badge until their next sync. syncMessages must recompute from actual rows
    // AFTER the INSERT so the cached count reflects the just-synced messages.
    const hasActive = vi.spyOn(pluginRegistry, 'hasActiveAsync').mockResolvedValue(false);
    const runHook = vi.spyOn(pluginRegistry, 'runHook').mockResolvedValue([]);
    try {
      const account = {
        id: 'acct-junk', user_id: 'user-1', email_address: 'me@example.com',
        gtd_enabled: false, categorization_enabled: false, imap_host: 'imap.example.com',
      };
      const client = {
        getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
        mailbox: { exists: 1, uidValidity: 100, highestModseq: 500n },
        fetch: vi.fn(async function* () { yield { uid: 501, envelope: { messageId: '<n1@x>' } }; }),
      };
      query.mockReset();
      query.mockImplementation((sql) => {
        if (sql.includes('SELECT uid_validity, highest_modseq FROM folders')) return Promise.resolve({ rows: [{ uid_validity: 100, highest_modseq: '500' }] });
        if (sql.includes('COUNT(*) FILTER (WHERE is_read = false)') && !sql.includes('UPDATE folders')) return Promise.resolve({ rows: [{ n: 0 }] });
        if (sql.includes('COALESCE(MAX(uid), 0)')) return Promise.resolve({ rows: [{ max_uid: 0 }] });
        if (sql.includes('INSERT INTO messages')) return Promise.resolve({ rows: [{ id: 'new-1', is_new: true }] });
        return Promise.resolve({ rows: [] });
      });
      parseMessage.mockReset();
      // Already-\Seen so the message doesn't enter the new-mail notification path (which needs a
      // broadcast stub); it is still INSERTed, which is all the ordering assertion needs.
      parseMessage.mockResolvedValue({
        uid: 501, messageId: '<n1@x>', subject: 'Spam', fromName: 'Sketchy', fromEmail: 's@example.com',
        to: [], cc: [], replyTo: [], inReplyTo: null, references: null, date: new Date('2026-08-20T10:00:00Z'),
        snippet: 'hi', isRead: true, isStarred: false, hasAttachments: false, flags: ['\\Seen'], isBulk: false, parsedHeaders: {},
      });

      await ImapManager.prototype.syncMessages.call({ pluginFacade: {} }, account, client, 'Junk', 100, false, true);

      const calls = query.mock.calls.map(c => c[0]);
      const insertIdx = calls.findIndex(sql => sql.includes('INSERT INTO messages'));
      const recomputeIdx = calls.findIndex(sql =>
        sql.includes('UPDATE folders') && sql.includes('unread_count = (SELECT COUNT(*) FILTER (WHERE m.is_read = false)'));
      const recomputeLockIdx = calls.findIndex((sql, index) =>
        index > insertIdx && sql.includes('SELECT uid_validity, highest_modseq FROM folders') && sql.includes('FOR UPDATE'));
      expect(insertIdx).toBeGreaterThanOrEqual(0);
      expect(recomputeLockIdx).toBeGreaterThan(insertIdx);
      expect(recomputeIdx).toBeGreaterThanOrEqual(0);
      expect(recomputeIdx).toBeGreaterThan(recomputeLockIdx);
      expect(recomputeIdx).toBeGreaterThan(insertIdx);            // recompute strictly after insert
      expect(query.mock.calls[recomputeIdx][1]).toEqual(['acct-junk', 'Junk', 1]); // scoped to this folder + live EXISTS
    } finally {
      hasActive.mockRestore();
      runHook.mockRestore();
    }
  });
});

describe('backfillMessages — incomplete metadata', () => {
  beforeEach(() => {
    query.mockReset();
    parseMessage.mockReset();
    ImapFlow.mockReset();
  });

  it('keeps an incomplete UID eligible and does not announce completion', async () => {
    const account = {
      id: 'acct-backfill', user_id: 'user-1', email_address: 'me@example.com',
      imap_host: 'imap.fastmail.com', imap_port: 993, imap_tls: true,
      auth_user: 'me@example.com', auth_pass: 'encrypted', categorization_enabled: false,
    };
    const lock = { release: vi.fn() };
    const client = {
      mailbox: { exists: 2, uidValidity: 100 },
      on: vi.fn(),
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
      logout: vi.fn().mockResolvedValue(undefined),
      getMailboxLock: vi.fn().mockResolvedValue(lock),
      search: vi.fn().mockResolvedValue([501, 502]),
      fetch: vi.fn(async function* () {
        yield { uid: 501 };
        yield { uid: 502, envelope: { subject: 'complete' }, flags: new Set() };
      }),
    };
    ImapFlow.mockImplementation(function () { return client; });
    getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: true, allowInsecureTls: true });
    resolveForConnection.mockResolvedValue({ host: '127.0.0.1', addresses: ['127.0.0.1'], servername: null });
    query.mockImplementation((sql) => {
      if (sql.includes('SELECT uid_validity, total_count FROM folders')) {
        return Promise.resolve({ rows: [{ uid_validity: 100, total_count: 2, backfill_incomplete: false }] });
      }
      if (sql.includes('SELECT COUNT(*) AS n FROM messages')) return Promise.resolve({ rows: [{ n: 0 }] });
      if (sql.includes('SELECT uid_validity FROM folders')) return Promise.resolve({ rows: [{ uid_validity: 100 }] });
      if (sql.includes('SELECT COUNT(*) as count, COALESCE(MAX(uid), 0)')) {
        return Promise.resolve({ rows: [{ count: 0, max_uid: 0 }] });
      }
      if (sql.includes('SELECT uid FROM messages')) return Promise.resolve({ rows: [] });
      if (sql.includes('SELECT * FROM email_accounts')) return Promise.resolve({ rows: [{ ...account, enabled: true }] });
      if (sql.includes('SELECT id FROM email_accounts')) return Promise.resolve({ rows: [{ id: account.id }] });
      if (sql.includes("preferences->>'categorizationEnabled'")) return Promise.resolve({ rows: [{ val: false }] });
      if (sql.includes('INSERT INTO messages')) return Promise.resolve({ rows: [{ id: 'stored', is_new: true }] });
      return Promise.resolve({ rows: [] });
    });
    parseMessage.mockImplementation(async msg => ({
      uid: msg.uid, messageId: `<${msg.uid}@example.com>`, subject: 'Message',
      fromName: 'Sender', fromEmail: 'sender@example.com', to: [], cc: [], replyTo: [],
      inReplyTo: null, references: null, date: new Date('2026-08-25T10:00:00Z'),
      snippet: '', isRead: true, isStarred: false, hasAttachments: false, flags: [],
      isBulk: false, parsedHeaders: {},
    }));
    const ctx = {
      backfillRunning: new Set(),
      pluginFacade: {},
      broadcast: vi.fn(),
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await ImapManager.prototype.backfillMessages.call(ctx, account, 'INBOX');

      expect(parseMessage).not.toHaveBeenCalled();
      expect(query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO messages'))).toHaveLength(0);
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('SET total_count = $3'),
        [account.id, 'INBOX', 2]
      );
      const deferredCountUpdate = query.mock.calls.find(([sql]) => sql.includes('SET total_count = $3'));
      expect(deferredCountUpdate[0]).toContain('unread_count');
      expect(deferredCountUpdate[0]).toContain('COUNT(*) FILTER (WHERE is_read = false)');
      expect(deferredCountUpdate[0]).toContain('m.is_deleted = false');
      expect(deferredCountUpdate[0]).toContain('backfill_incomplete = true');
      expect(ctx.broadcast).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'backfill_complete' }), account.user_id
      );
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0].join(' ')).not.toMatch(/501|502|sender@example\.com|Message/);
    } finally {
      warn.mockRestore();
      vi.restoreAllMocks();
    }
  });

  it('keeps the durable marker when UIDVALIDITY changes after the UID snapshot', async () => {
    const account = {
      id: 'acct-backfill', user_id: 'user-1', email_address: 'me@example.com',
      imap_host: 'imap.fastmail.com', imap_port: 993, imap_tls: true,
      auth_user: 'me@example.com', auth_pass: 'encrypted', categorization_enabled: false,
    };
    let validityReads = 0;
    const client = {
      mailbox: { exists: 1, uidValidity: 100 },
      on: vi.fn(), connect: vi.fn().mockResolvedValue(undefined), close: vi.fn(),
      logout: vi.fn().mockResolvedValue(undefined),
      getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
      search: vi.fn().mockResolvedValue([501]),
      fetch: vi.fn(async function* () {
        yield { uid: 501, envelope: { subject: 'Wrong epoch' }, flags: new Set() };
      }),
    };
    ImapFlow.mockImplementation(function () { return client; });
    getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: true, allowInsecureTls: true });
    resolveForConnection.mockResolvedValue({ host: '127.0.0.1', addresses: ['127.0.0.1'], servername: null });
    query.mockImplementation((sql) => {
      if (sql.includes('SELECT uid_validity, total_count')) {
        return Promise.resolve({ rows: [{ uid_validity: 100, total_count: 1, backfill_incomplete: false }] });
      }
      if (sql.includes('SELECT COUNT(*) AS n FROM messages')) return Promise.resolve({ rows: [{ n: 0 }] });
      if (sql.includes('SELECT uid_validity FROM folders')) {
        validityReads++;
        return Promise.resolve({ rows: [{ uid_validity: validityReads <= 2 ? 100 : 200 }] });
      }
      if (sql.includes('SELECT COUNT(*) as count, COALESCE(MAX(uid), 0)')) {
        return Promise.resolve({ rows: [{ count: 0, max_uid: 0 }] });
      }
      if (sql.includes('SELECT uid FROM messages')) return Promise.resolve({ rows: [] });
      if (sql.includes('SELECT * FROM email_accounts')) return Promise.resolve({ rows: [{ ...account, enabled: true }] });
      if (sql.includes('SELECT id FROM email_accounts')) return Promise.resolve({ rows: [{ id: account.id }] });
      if (sql.includes("preferences->>'categorizationEnabled'")) return Promise.resolve({ rows: [{ val: false }] });
      if (sql.includes('INSERT INTO messages')) return Promise.resolve({ rows: [{ id: 'wrong-epoch', is_new: true }] });
      return Promise.resolve({ rows: [] });
    });
    parseMessage.mockImplementation(async msg => ({
      uid: msg.uid, messageId: `<${msg.uid}@example.com>`, subject: 'Wrong epoch',
      fromName: 'Sender', fromEmail: 'sender@example.com', to: [], cc: [], replyTo: [],
      inReplyTo: null, references: null, date: new Date('2026-08-25T10:00:00Z'),
      snippet: '', isRead: true, isStarred: false, hasAttachments: false, flags: [],
      isBulk: false, parsedHeaders: {},
    }));
    const ctx = { backfillRunning: new Set(), pluginFacade: {}, broadcast: vi.fn() };
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(ImapManager.prototype.backfillMessages.call(ctx, account, 'INBOX'))
        .resolves.toBe(false);
      expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO messages'))).toBe(false);
      expect(query.mock.calls.some(([sql]) => sql.includes('backfill_incomplete = false'))).toBe(false);
      expect(ctx.broadcast).not.toHaveBeenCalledWith(
        { type: 'backfill_complete', accountId: account.id }, account.user_id
      );
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  it('does not clear completion when UIDVALIDITY changes after final verification', async () => {
    const account = {
      id: 'acct-backfill', user_id: 'user-1', email_address: 'me@example.com',
      imap_host: 'imap.fastmail.com', imap_port: 993, imap_tls: true,
      auth_user: 'me@example.com', auth_pass: 'encrypted', categorization_enabled: false,
    };
    let validityReads = 0;
    const client = {
      mailbox: { exists: 1, uidValidity: 100 },
      on: vi.fn(), connect: vi.fn().mockResolvedValue(undefined), close: vi.fn(),
      logout: vi.fn().mockResolvedValue(undefined),
      getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
      search: vi.fn().mockResolvedValue([501]),
    };
    ImapFlow.mockImplementation(function () { return client; });
    getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: true, allowInsecureTls: true });
    resolveForConnection.mockResolvedValue({ host: '127.0.0.1', addresses: ['127.0.0.1'], servername: null });
    query.mockImplementation((sql) => {
      if (sql.includes('SELECT uid_validity, total_count')) {
        return Promise.resolve({ rows: [{ uid_validity: 100, total_count: 2, backfill_incomplete: false }] });
      }
      if (sql.includes('SELECT COUNT(*) AS n FROM messages')) return Promise.resolve({ rows: [{ n: 1 }] });
      if (sql.includes('SELECT uid_validity FROM folders')) {
        validityReads++;
        return Promise.resolve({ rows: [{ uid_validity: validityReads <= 2 ? 100 : 200 }] });
      }
      if (sql.includes('SELECT COUNT(*) as count, COALESCE(MAX(uid), 0)')) {
        return Promise.resolve({ rows: [{ count: 1, max_uid: 501 }] });
      }
      if (sql.includes('SELECT uid FROM messages')) return Promise.resolve({ rows: [{ uid: 501 }] });
      if (sql.includes('SELECT * FROM email_accounts')) return Promise.resolve({ rows: [{ ...account, enabled: true }] });
      return Promise.resolve({ rows: [] });
    });
    const ctx = { backfillRunning: new Set(), pluginFacade: {}, broadcast: vi.fn() };
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(ImapManager.prototype.backfillMessages.call(ctx, account, 'INBOX')).resolves.toBe(false);
    expect(query.mock.calls.some(([sql]) => sql.includes('backfill_incomplete = false'))).toBe(false);
    expect(ctx.broadcast).not.toHaveBeenCalledWith(
      { type: 'backfill_complete', accountId: account.id }, account.user_id
    );
  });

  it('does not clear an empty mailbox when the durable epoch changes under the completion fence', async () => {
    const account = {
      id: 'acct-backfill', user_id: 'user-1', email_address: 'me@example.com',
      imap_host: 'imap.fastmail.com', imap_port: 993, imap_tls: true,
      auth_user: 'me@example.com', auth_pass: 'encrypted', categorization_enabled: false,
    };
    let validityReads = 0;
    const client = {
      mailbox: { exists: 0, uidValidity: 100 },
      on: vi.fn(), connect: vi.fn().mockResolvedValue(undefined), close: vi.fn(),
      logout: vi.fn().mockResolvedValue(undefined),
      getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
    };
    ImapFlow.mockImplementation(function () { return client; });
    getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: true, allowInsecureTls: true });
    resolveForConnection.mockResolvedValue({ host: '127.0.0.1', addresses: ['127.0.0.1'], servername: null });
    query.mockImplementation((sql) => {
      if (sql.includes('SELECT uid_validity, total_count')) {
        return Promise.resolve({ rows: [{ uid_validity: 100, total_count: 0, backfill_incomplete: true }] });
      }
      if (sql.includes('SELECT * FROM email_accounts')) return Promise.resolve({ rows: [{ ...account, enabled: true }] });
      if (sql.includes('SELECT uid_validity FROM folders')) {
        validityReads++;
        return Promise.resolve({ rows: [{ uid_validity: validityReads === 1 ? 100 : 200 }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const ctx = { backfillRunning: new Set(), pluginFacade: {}, broadcast: vi.fn() };
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(ImapManager.prototype.backfillMessages.call(ctx, account, 'INBOX')).resolves.toBe(false);
    expect(query.mock.calls.some(([sql]) => sql.includes('backfill_incomplete = false'))).toBe(false);
  });

  it('does not publish zero/complete from an empty backfill snapshot superseded by a fresh row', async () => {
    const account = {
      id: 'acct-backfill', user_id: 'user-1', email_address: 'me@example.com',
      imap_host: 'imap.fastmail.com', imap_port: 993, imap_tls: true,
      auth_user: 'me@example.com', auth_pass: 'encrypted', categorization_enabled: false,
    };
    const client = {
      mailbox: { exists: 0, uidValidity: 100 },
      on: vi.fn(), connect: vi.fn().mockResolvedValue(undefined), close: vi.fn(),
      logout: vi.fn().mockResolvedValue(undefined),
      getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
    };
    ImapFlow.mockImplementation(function () { return client; });
    getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: true, allowInsecureTls: true });
    resolveForConnection.mockResolvedValue({ host: '127.0.0.1', addresses: ['127.0.0.1'], servername: null });
    query.mockImplementation((sql) => {
      if (sql.includes('SELECT uid_validity, total_count')) {
        return Promise.resolve({ rows: [{ uid_validity: 100, total_count: 0, backfill_incomplete: true }] });
      }
      if (sql.includes('SELECT * FROM email_accounts')) return Promise.resolve({ rows: [{ ...account, enabled: true }] });
      if (sql.includes('SELECT uid_validity FROM folders')) return Promise.resolve({ rows: [{ uid_validity: 100 }] });
      if (sql.includes('synced_at >=') && sql.includes('SELECT 1 FROM messages')) {
        return Promise.resolve({ rows: [{ '?column?': 1 }] });
      }
      return Promise.resolve({ rowCount: 1, rows: [] });
    });
    const ctx = { backfillRunning: new Set(), pluginFacade: {}, broadcast: vi.fn() };
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(ImapManager.prototype.backfillMessages.call(ctx, account, 'INBOX')).resolves.toBe(false);

    expect(query.mock.calls.some(([sql]) => sql.includes('synced_at >='))).toBe(true);
    expect(query.mock.calls.some(([sql]) => sql.includes('SET total_count = 0'))).toBe(false);
  });

  it('retries exact-diff work when atomic thread repair rolls back its insert', async () => {
    const account = {
      id: 'acct-backfill', user_id: 'user-1', email_address: 'me@example.com',
      imap_host: 'imap.fastmail.com', imap_port: 993, imap_tls: true,
      auth_user: 'me@example.com', auth_pass: 'encrypted', categorization_enabled: false,
    };
    const client = {
      mailbox: { exists: 2, uidValidity: 100 },
      on: vi.fn(), connect: vi.fn().mockResolvedValue(undefined), close: vi.fn(),
      logout: vi.fn().mockResolvedValue(undefined),
      getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
      search: vi.fn().mockResolvedValue([501, 502]),
      fetch: vi.fn(async function* () {
        yield { uid: 502, envelope: { subject: 'Recovered gap' }, flags: new Set() };
      }),
    };
    ImapFlow.mockImplementation(function () { return client; });
    getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: true, allowInsecureTls: true });
    resolveForConnection.mockResolvedValue({ host: '127.0.0.1', addresses: ['127.0.0.1'], servername: null });
    query.mockImplementation((sql) => {
      if (sql.includes('SELECT uid_validity, total_count')) {
        // Cached total is higher, so the cheap DB precheck correctly opens IMAP. The live server
        // total/max then match the two DB rows only because one DB UID is stale.
        return Promise.resolve({ rows: [{ uid_validity: 100, total_count: 3, backfill_incomplete: false }] });
      }
      if (sql.includes('SELECT COUNT(*) AS n FROM messages')) return Promise.resolve({ rows: [{ n: 2 }] });
      if (sql.includes('SELECT uid_validity FROM folders')) return Promise.resolve({ rows: [{ uid_validity: 100 }] });
      if (sql.includes('SELECT COUNT(*) as count, COALESCE(MAX(uid), 0)')) {
        return Promise.resolve({ rows: [{ count: 2, max_uid: 502 }] });
      }
      if (sql.includes('SELECT uid FROM messages')) return Promise.resolve({ rows: [{ uid: 501 }, { uid: 999 }] });
      if (sql.includes('SELECT * FROM email_accounts')) return Promise.resolve({ rows: [{ ...account, enabled: true }] });
      if (sql.includes('SELECT id FROM email_accounts')) return Promise.resolve({ rows: [{ id: account.id }] });
      if (sql.includes("preferences->>'categorizationEnabled'")) return Promise.resolve({ rows: [{ val: false }] });
      if (sql.includes('INSERT INTO messages')) return Promise.resolve({ rows: [{ id: 'stored', is_new: true }] });
      return Promise.resolve({ rows: [] });
    });
    parseMessage.mockImplementation(async msg => ({
      uid: msg.uid, messageId: `<${msg.uid}@example.com>`, subject: 'Recovered gap',
      fromName: 'Sender', fromEmail: 'sender@example.com', to: [], cc: [], replyTo: [],
      inReplyTo: '<root@example.com>', references: '<root@example.com>',
      date: new Date('2026-08-25T10:00:00Z'), snippet: '', isRead: true, isStarred: false,
      hasAttachments: false, flags: [], isBulk: false, parsedHeaders: {},
    }));
    let threadRepairFailed = false;
    let committedUid502 = false;
    withTransaction.mockImplementation(async callback => {
      let stagedInsert = false;
      const tx = {
        query: vi.fn(async (sql, params) => {
          const result = await query(sql, params);
          if (sql.includes('INSERT INTO messages')) stagedInsert = true;
          if (sql.includes('UPDATE messages SET thread_id') && !threadRepairFailed) {
            threadRepairFailed = true;
            throw new Error('thread propagation failed');
          }
          return result;
        }),
      };
      const result = await callback(tx);
      if (stagedInsert) committedUid502 = true;
      return result;
    });
    const ctx = { backfillRunning: new Set(), pluginFacade: {}, broadcast: vi.fn() };
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(ImapManager.prototype.backfillMessages.call(ctx, account, 'INBOX')).resolves.toBe(false);
      expect(committedUid502).toBe(false);
      expect(ctx.broadcast).not.toHaveBeenCalledWith(
        { type: 'backfill_complete', accountId: account.id }, account.user_id
      );
      const retainedMarker = query.mock.calls.find(([sql]) =>
        sql.includes('backfill_incomplete = true') && sql.includes('total_count = $3'));
      expect(retainedMarker).toBeTruthy();

      await expect(ImapManager.prototype.backfillMessages.call(ctx, account, 'INBOX')).resolves.toBe(true);
      expect(client.connect).toHaveBeenCalledTimes(2);
      expect(client.search).toHaveBeenCalledWith({ all: true }, { uid: true });
      expect(client.fetch).toHaveBeenCalled();
      expect(parseMessage).toHaveBeenCalledWith(expect.objectContaining({ uid: 502 }));
      expect(committedUid502).toBe(true);
      const uidDiffQuery = query.mock.calls.find(([sql]) => sql.includes('SELECT uid FROM messages'));
      expect(uidDiffQuery[0]).toContain('metadata_complete = true');
      const repairedInsert = query.mock.calls.find(([sql]) => sql.includes('INSERT INTO messages'));
      expect(repairedInsert[0]).toContain('metadata_complete = true');
      expect(query.mock.calls.some(([sql]) =>
        sql.includes('UPDATE messages SET') && sql.includes('message_id = $4'))).toBe(false);
      const completedCountUpdate = query.mock.calls.find(([sql]) => sql.includes('backfill_incomplete = false'));
      expect(completedCountUpdate).toBeTruthy();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('inserts an external destination copy independently instead of relocating by Message-ID', async () => {
    const account = {
      id: 'acct-backfill', user_id: 'user-1', email_address: 'me@example.com',
      imap_host: 'imap.fastmail.com', imap_port: 993, imap_tls: true,
      auth_user: 'me@example.com', auth_pass: 'encrypted', categorization_enabled: false,
    };
    const client = {
      mailbox: { exists: 1, uidValidity: 100 },
      on: vi.fn(), connect: vi.fn().mockResolvedValue(undefined), close: vi.fn(),
      logout: vi.fn().mockResolvedValue(undefined),
      getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
      search: vi.fn().mockResolvedValue([700]),
      fetch: vi.fn(async function* () {
        yield { uid: 700, envelope: { subject: 'External copy' }, flags: new Set() };
      }),
    };
    ImapFlow.mockImplementation(function () { return client; });
    getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: true, allowInsecureTls: true });
    resolveForConnection.mockResolvedValue({ host: '127.0.0.1', addresses: ['127.0.0.1'], servername: null });
    query.mockImplementation((sql) => {
      if (sql.includes('SELECT uid_validity, total_count')) {
        return Promise.resolve({ rows: [{ uid_validity: 100, total_count: 1, backfill_incomplete: true }] });
      }
      if (sql.includes('SELECT uid_validity FROM folders')) return Promise.resolve({ rows: [{ uid_validity: 100 }] });
      if (sql.includes('SELECT COUNT(*) as count')) return Promise.resolve({ rows: [{ count: 0, max_uid: 0 }] });
      if (sql.includes('SELECT uid FROM messages')) return Promise.resolve({ rows: [] });
      if (sql.includes('SELECT * FROM email_accounts')) return Promise.resolve({ rows: [{ ...account, enabled: true }] });
      if (sql.includes('SELECT id FROM email_accounts')) return Promise.resolve({ rows: [{ id: account.id }] });
      if (sql.includes("preferences->>'categorizationEnabled'")) return Promise.resolve({ rows: [{ val: false }] });
      if (sql.includes('INSERT INTO messages')) return Promise.resolve({ rows: [{ id: 'destination-copy', is_new: true }] });
      return Promise.resolve({ rowCount: 1, rows: [{ path: 'Archive' }] });
    });
    parseMessage.mockResolvedValue({
      uid: 700, messageId: '<shared@example.com>', subject: 'External copy',
      fromName: 'Sender', fromEmail: 'sender@example.com', to: [], cc: [], replyTo: [],
      inReplyTo: null, references: null, date: new Date('2026-08-25T10:00:00Z'),
      snippet: '', isRead: true, isStarred: false, hasAttachments: false, flags: [],
      isBulk: false, parsedHeaders: {},
    });
    const ctx = { backfillRunning: new Set(), pluginFacade: {}, broadcast: vi.fn() };
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(ImapManager.prototype.backfillMessages.call(ctx, account, 'Archive')).resolves.toBe(true);

    expect(query.mock.calls.some(([sql]) =>
      sql.includes('UPDATE messages SET') && sql.includes('message_id = $4'))).toBe(false);
    expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO messages'))).toBe(true);
  });

  it('confirms a sequence-unmapped phantom without blocking backfill completion', async () => {
    const account = {
      id: 'acct-backfill', user_id: 'user-1', email_address: 'me@example.com',
      imap_host: 'imap.fastmail.com', imap_port: 993, imap_tls: true,
      auth_user: 'me@example.com', auth_pass: 'encrypted', categorization_enabled: false,
    };
    const client = {
      mailbox: { exists: 2, uidValidity: 100 },
      on: vi.fn(),
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
      logout: vi.fn().mockResolvedValue(undefined),
      getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
      search: vi.fn()
        .mockResolvedValueOnce([501, 502])
        .mockResolvedValueOnce([]),
      fetch: vi.fn(async function* () {
        yield { uid: 502, envelope: { subject: 'Later message' }, flags: new Set() };
      }),
    };
    ImapFlow.mockImplementation(function () { return client; });
    getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: true, allowInsecureTls: true });
    resolveForConnection.mockResolvedValue({ host: '127.0.0.1', addresses: ['127.0.0.1'], servername: null });
    query.mockImplementation((sql) => {
      if (sql.includes('SELECT uid_validity, total_count FROM folders')) {
        return Promise.resolve({ rows: [{ uid_validity: 100, total_count: 2 }] });
      }
      if (sql.includes('SELECT COUNT(*) AS n FROM messages')) return Promise.resolve({ rows: [{ n: 0 }] });
      if (sql.includes('SELECT uid_validity FROM folders')) return Promise.resolve({ rows: [{ uid_validity: 100 }] });
      if (sql.includes('SELECT COUNT(*) as count, COALESCE(MAX(uid), 0)')) {
        return Promise.resolve({ rows: [{ count: 0, max_uid: 0 }] });
      }
      if (sql.includes('SELECT uid FROM messages')) return Promise.resolve({ rows: [] });
      if (sql.includes('SELECT * FROM email_accounts')) return Promise.resolve({ rows: [{ ...account, enabled: true }] });
      if (sql.includes('SELECT id FROM email_accounts')) return Promise.resolve({ rows: [{ id: account.id }] });
      if (sql.includes("preferences->>'categorizationEnabled'")) return Promise.resolve({ rows: [{ val: false }] });
      if (sql.includes('INSERT INTO messages')) return Promise.resolve({ rows: [{ id: 'stored', is_new: true }] });
      return Promise.resolve({ rows: [] });
    });
    parseMessage.mockImplementation(async msg => ({
      uid: msg.uid, messageId: `<${msg.uid}@example.com>`, subject: 'Message',
      fromName: 'Sender', fromEmail: 'sender@example.com', to: [], cc: [], replyTo: [],
      inReplyTo: null, references: null, date: new Date('2026-08-25T10:00:00Z'),
      snippet: '', isRead: true, isStarred: false, hasAttachments: false, flags: [],
      isBulk: false, parsedHeaders: {},
    }));
    const ctx = { backfillRunning: new Set(), pluginFacade: {}, broadcast: vi.fn() };
    vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const complete = await ImapManager.prototype.backfillMessages.call(ctx, account, 'INBOX');

      expect(complete).toBe(true);
      expect(parseMessage).toHaveBeenCalledOnce();
      expect(client.search).toHaveBeenNthCalledWith(2, { uid: '501' }, { uid: false });
      expect(ctx.broadcast).toHaveBeenCalledWith(
        { type: 'backfill_complete', accountId: account.id }, account.user_id
      );
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('does not report an empty mailbox complete when clearing the durable marker fails', async () => {
    const account = {
      id: 'acct-backfill', user_id: 'user-1', email_address: 'me@example.com',
      imap_host: 'imap.fastmail.com', imap_port: 993, imap_tls: true,
      auth_user: 'me@example.com', auth_pass: 'encrypted', categorization_enabled: false,
    };
    const client = {
      mailbox: { exists: 0, uidValidity: 100 },
      on: vi.fn(), connect: vi.fn().mockResolvedValue(undefined), close: vi.fn(),
      logout: vi.fn().mockResolvedValue(undefined),
      getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
    };
    ImapFlow.mockImplementation(function () { return client; });
    getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: true, allowInsecureTls: true });
    resolveForConnection.mockResolvedValue({ host: '127.0.0.1', addresses: ['127.0.0.1'], servername: null });
    query.mockImplementation((sql) => {
      if (sql.includes('SELECT uid_validity, total_count')) {
        return Promise.resolve({ rows: [{ uid_validity: 100, total_count: 0, backfill_incomplete: true }] });
      }
      if (sql.includes('SELECT * FROM email_accounts')) return Promise.resolve({ rows: [{ ...account, enabled: true }] });
      if (sql.includes('SET total_count = 0')) return Promise.reject(new Error('marker write failed'));
      return Promise.resolve({ rows: [] });
    });
    const ctx = { backfillRunning: new Set(), pluginFacade: {}, broadcast: vi.fn() };
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(ImapManager.prototype.backfillMessages.call(ctx, account, 'INBOX')).resolves.toBe(false);
      expect(ctx.broadcast).not.toHaveBeenCalledWith(
        { type: 'backfill_complete', accountId: account.id }, account.user_id
      );
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe('backfillAllFolders — incomplete metadata', () => {
  beforeEach(() => {
    query.mockReset();
  });

  it('does not announce all-folder completion when any folder defers metadata', async () => {
    const account = {
      id: 'acct-backfill-all', user_id: 'user-1', email_address: 'me@example.com',
      imap_host: 'imap.fastmail.com',
    };
    const ctx = {
      backfillAllRunning: new Set(),
      _bgConnSem: { acquire: vi.fn().mockResolvedValue(undefined), release: vi.fn() },
      backfillMessages: vi.fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true),
      broadcast: vi.fn(),
      refreshBulkFlags: vi.fn().mockResolvedValue(undefined),
      startSnippetIndexer: vi.fn().mockResolvedValue(undefined),
    };
    query.mockResolvedValue({ rows: [{ path: 'Archive' }] });

    const complete = await ImapManager.prototype.backfillAllFolders.call(ctx, account);

    expect(complete).toBe(false);
    expect(ctx.backfillMessages).toHaveBeenCalledTimes(2);
    expect(ctx.broadcast).toHaveBeenCalledWith(
      { type: 'backfill_all_start', accountId: account.id }, account.user_id
    );
    expect(ctx.broadcast).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'backfill_all_complete' }), account.user_id
    );
    expect(ctx.broadcast).toHaveBeenCalledWith(
      { type: 'backfill_all_deferred', accountId: account.id }, account.user_id
    );
    expect(ctx._bgConnSem.release).toHaveBeenCalledWith(account.imap_host);
  });

  it('announces completion and starts follow-up jobs after every folder completes', async () => {
    const account = {
      id: 'acct-backfill-all', user_id: 'user-1', email_address: 'me@example.com',
      imap_host: 'imap.fastmail.com',
    };
    const ctx = {
      backfillAllRunning: new Set(),
      _bgConnSem: { acquire: vi.fn().mockResolvedValue(undefined), release: vi.fn() },
      backfillMessages: vi.fn().mockResolvedValue(true),
      broadcast: vi.fn(),
      refreshBulkFlags: vi.fn().mockResolvedValue(undefined),
      startSnippetIndexer: vi.fn().mockResolvedValue(undefined),
    };
    query.mockResolvedValue({ rows: [{ path: 'Archive' }] });

    const complete = await ImapManager.prototype.backfillAllFolders.call(ctx, account);

    expect(complete).toBe(true);
    expect(ctx.broadcast).toHaveBeenCalledWith(
      { type: 'backfill_all_complete', accountId: account.id }, account.user_id
    );
    expect(ctx.refreshBulkFlags).toHaveBeenCalledWith(account);
    expect(ctx.startSnippetIndexer).toHaveBeenCalledWith(account);
  });

  it('clears durable backfill markers for deliberately skipped provider folders', async () => {
    const account = {
      id: 'acct-backfill-all', user_id: 'user-1', email_address: 'me@example.com',
      imap_host: 'imap.gmail.com',
    };
    const ctx = {
      backfillAllRunning: new Set(),
      _bgConnSem: { acquire: vi.fn().mockResolvedValue(undefined), release: vi.fn() },
      backfillMessages: vi.fn().mockResolvedValue(true),
      broadcast: vi.fn(),
      refreshBulkFlags: vi.fn().mockResolvedValue(undefined),
      startSnippetIndexer: vi.fn().mockResolvedValue(undefined),
    };
    query.mockImplementation(async (sql) => {
      if (sql.includes('SELECT path FROM folders')) {
        return { rows: [{ path: '[Gmail]' }, { path: '[Gmail]/All Mail' }, { path: 'Archive' }] };
      }
      return { rowCount: 1, rows: [] };
    });

    await expect(ImapManager.prototype.backfillAllFolders.call(ctx, account)).resolves.toBe(true);

    expect(ctx.backfillMessages.mock.calls.map(([, folder]) => folder)).toEqual(['INBOX', 'Archive']);
    const markerClears = query.mock.calls.filter(([sql]) => sql.includes('backfill_incomplete = false'));
    expect(markerClears.map(([, params]) => params)).toEqual([
      [account.id, '[Gmail]'],
      [account.id, '[Gmail]/All Mail'],
    ]);
  });

  it('defers all-folder completion when a skipped-folder marker cannot be cleared', async () => {
    const account = {
      id: 'acct-backfill-all', user_id: 'user-1', email_address: 'me@example.com',
      imap_host: 'imap.gmail.com',
    };
    const ctx = {
      backfillAllRunning: new Set(),
      _bgConnSem: { acquire: vi.fn().mockResolvedValue(undefined), release: vi.fn() },
      backfillMessages: vi.fn().mockResolvedValue(true),
      broadcast: vi.fn(),
      refreshBulkFlags: vi.fn().mockResolvedValue(undefined),
      startSnippetIndexer: vi.fn().mockResolvedValue(undefined),
    };
    query.mockImplementation(async (sql) => {
      if (sql.includes('SELECT path FROM folders')) return { rows: [{ path: '[Gmail]/All Mail' }] };
      if (sql.includes('backfill_incomplete = false')) throw new Error('marker write failed');
      return { rows: [] };
    });

    await expect(ImapManager.prototype.backfillAllFolders.call(ctx, account)).resolves.toBe(false);
    expect(ctx.broadcast).toHaveBeenCalledWith(
      { type: 'backfill_all_deferred', accountId: account.id }, account.user_id
    );
    expect(ctx.broadcast).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'backfill_all_complete' }), account.user_id
    );
  });
});

describe('_syncSpamFolder — periodic spam poll guards', () => {
  const account = { id: 'a1', user_id: 'u1', folder_mappings: null, imap_host: 'imap.example.com' };

  it('no-ops when the account has no resolvable spam folder', async () => {
    query.mockReset();
    query.mockResolvedValue({ rows: [] }); // resolveSpamFolder finds nothing
    const ctx = { onDemandSyncing: new Set(), broadcast: vi.fn(), syncMessages: vi.fn() };
    await ImapManager.prototype._syncSpamFolder.call(ctx, account);
    expect(ctx.syncMessages).not.toHaveBeenCalled();
    expect(ctx.broadcast).not.toHaveBeenCalled();
  });

  it('skips when an on-demand sync of that spam folder is already running (no collision)', async () => {
    query.mockReset();
    // resolveSpamFolder's special-use lookup (identified by its name-regex clause) yields "Junk".
    query.mockImplementation((sql) =>
      sql.includes('lower(name) ~') ? Promise.resolve({ rows: [{ path: 'Junk' }] }) : Promise.resolve({ rows: [] }));
    const ctx = { onDemandSyncing: new Set(['a1:Junk']), broadcast: vi.fn(), syncMessages: vi.fn() };
    await ImapManager.prototype._syncSpamFolder.call(ctx, account);
    expect(ctx.syncMessages).not.toHaveBeenCalled();
    expect(ctx.broadcast).not.toHaveBeenCalled();
    expect(ctx.onDemandSyncing.has('a1:Junk')).toBe(true); // guard left intact for the running sync
  });
});

describe('walkStructure attachment classification', () => {
  const walk = (node) => {
    const results = { textParts: [], attachments: [] };
    walkStructure(node, results);
    return results;
  };

  it('treats an attached HTML file as an attachment, not body text', () => {
    const results = walk({
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'text/plain', encoding: 'quoted-printable', parameters: { charset: 'utf-8' } },
        {
          part: '2', type: 'text/html', encoding: 'base64',
          disposition: 'attachment',
          dispositionParameters: { filename: 'report.html' },
          size: 2048,
        },
      ],
    });
    expect(results.textParts).toHaveLength(1);
    expect(results.textParts[0].type).toBe('text/plain');
    expect(results.attachments).toHaveLength(1);
    expect(results.attachments[0]).toMatchObject({
      part: '2', filename: 'report.html', type: 'text/html', encoding: 'base64',
    });
  });

  it('treats an attached text file as an attachment', () => {
    const results = walk({
      part: '2', type: 'text/plain', encoding: 'base64',
      disposition: 'attachment',
      dispositionParameters: { filename: 'server.log' },
    });
    expect(results.textParts).toHaveLength(0);
    expect(results.attachments).toHaveLength(1);
    expect(results.attachments[0].filename).toBe('server.log');
  });

  it('still treats undisposed HTML parts as the message body', () => {
    const results = walk({
      type: 'multipart/alternative',
      childNodes: [
        { part: '1', type: 'text/plain', encoding: '7bit' },
        { part: '2', type: 'text/html', encoding: 'quoted-printable' },
      ],
    });
    expect(results.textParts.map(p => p.type)).toEqual(['text/plain', 'text/html']);
    expect(results.attachments).toHaveLength(0);
  });

  it('attachment-disposed images are attachments; cid images stay inline', () => {
    const results = walk({
      type: 'multipart/related',
      childNodes: [
        { part: '1', type: 'text/html', encoding: '7bit' },
        { part: '2', type: 'image/png', encoding: 'base64', id: '<logo@x>' },
        {
          part: '3', type: 'image/jpeg', encoding: 'base64',
          disposition: 'attachment', dispositionParameters: { filename: 'photo.jpg' },
        },
      ],
    });
    expect(results.inlineImages).toHaveLength(1);
    expect(results.inlineImages[0].cid).toBe('logo@x');
    expect(results.attachments).toHaveLength(1);
    expect(results.attachments[0].filename).toBe('photo.jpg');
  });

  it('named non-text parts without a disposition are still attachments', () => {
    const results = walk({
      part: '2', type: 'application/pdf', encoding: 'base64',
      parameters: { name: 'invoice.pdf' },
    });
    expect(results.attachments).toHaveLength(1);
    expect(results.attachments[0].filename).toBe('invoice.pdf');
  });
});

// ── _shouldAutoBackfillOnConnect — auto-backfill gate (#354) ──────────────────
// The gate itself was always correct; #354 was the connect flow evaluating it
// AFTER the initial INBOX sync inserted rows. These lock the gate contract:
// providers without the flag always backfill; PurelyMail backfills when the account
// is empty or any folder still owes a durable exact-diff retry.

describe('_shouldAutoBackfillOnConnect (#354)', () => {
  const gate = acct => ImapManager.prototype._shouldAutoBackfillOnConnect.call({}, acct);
  beforeEach(() => vi.clearAllMocks());

  it('always backfills a provider without autoBackfillExistingOnConnect:false, without a DB check', async () => {
    await expect(gate({ imap_host: 'mail.example.com', id: 'a1' })).resolves.toBe(true);
    expect(query).not.toHaveBeenCalled();
  });

  it('backfills a fresh PurelyMail account with no cached messages', async () => {
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    await expect(gate({ imap_host: 'imap.purelymail.com', id: 'a1' })).resolves.toBe(true);
  });

  it('skips backfill for a PurelyMail account that already has cached messages', async () => {
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ exists: 1 }] });
    await expect(gate({ imap_host: 'imap.purelymail.com', id: 'a1' })).resolves.toBe(false);
  });

  it('retries a deferred PurelyMail folder even when the account already has messages', async () => {
    query.mockResolvedValueOnce({ rows: [{ exists: 1 }] });
    await expect(gate({ imap_host: 'imap.purelymail.com', id: 'a1' })).resolves.toBe(true);
    expect(query.mock.calls[0][0]).toContain('backfill_incomplete = true');
  });
});

// ── #360: 'error' listener attached before connect() ─────────────────────────
// An ImapFlow 'error' emitted during the connection handshake (e.g. a socket timeout,
// raised from a detached timer callback) with no listener is an unhandled EventEmitter
// error — Node throws and the whole process dies, taking every account down, not just the
// one connecting. connectAccount must therefore register its 'error' handler BEFORE it
// awaits connect(). This test locks in that ordering: it inspects listenerCount('error')
// at the exact moment connect() is invoked and confirms a handshake-time emission is
// absorbed rather than thrown.
describe("connectAccount attaches 'error' before connect (#360)", () => {
  beforeEach(() => vi.clearAllMocks());

  it('has an error listener at connect() time and absorbs a handshake error', async () => {
    let errorListenersAtConnect = -1;
    let emitThrew = false;

    ImapFlow.mockImplementation(function () {
      const client = new EventEmitter();
      client.connect = vi.fn(() => {
        errorListenersAtConnect = client.listenerCount('error');
        // Simulate a transport 'error' during the handshake. With the listener already
        // attached this is a logged no-op; without it, emit() throws synchronously —
        // which is exactly the process-killing #360 crash.
        try { client.emit('error', new Error('Socket timeout')); } catch { emitThrew = true; }
        return Promise.resolve();
      });
      client.logout = vi.fn(() => Promise.resolve());
      client.close = vi.fn();
      return client;
    });

    // PurelyMail host: preferFreshBodyFetch skips the pool pre-warm and its private
    // acquirePooledClient (which would build a second mock client), keeping this test to
    // the single connectAccount code path under test.
    getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: true, allowInsecureTls: true });
    resolveForConnection.mockResolvedValue({ host: '127.0.0.1', addresses: ['127.0.0.1'], servername: null });
    query.mockResolvedValue({ rows: [] });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const mgr = new ImapManager(null);
    clearInterval(mgr._healthCheckTimer);
    clearInterval(mgr._snippetSchedulerTimer);
    // Stub the post-connect fan-out — this test asserts only the listener-ordering
    // invariant, not folder/message sync behavior.
    mgr.disconnectAccount = vi.fn(() => Promise.resolve());
    mgr._attachIdleListeners = vi.fn();
    mgr.syncFolders = vi.fn(() => Promise.resolve());
    mgr.syncMessages = vi.fn(() => Promise.resolve());
    mgr._shouldAutoBackfillOnConnect = vi.fn(() => Promise.resolve(false));
    mgr.backfillAllFolders = vi.fn(() => Promise.resolve());
    mgr._startSyncInterval = vi.fn();
    mgr.broadcast = vi.fn();

    const acct = { id: 1, user_id: 1, imap_host: 'imap.purelymail.com', imap_port: 993, imap_tls: true, auth_user: 'u', auth_pass: 'enc' };
    const ok = await mgr.connectAccount(acct);

    expect(ok).toBe(true);
    expect(ImapFlow).toHaveBeenCalledTimes(1);
    expect(errorListenersAtConnect).toBeGreaterThanOrEqual(1);
    expect(emitThrew).toBe(false);
  });
});

describe('syncFolders pruning', () => {
  beforeEach(() => {
    query.mockReset();
    query.mockResolvedValue({ rows: [] });
    claimMailboxTopology.mockClear();
    commitMailboxTopology.mockClear();
  });

  const account = { id: 'acct-1', email_address: 'a@example.com' };

  it('claims topology before LIST and commits the complete buffered result atomically', async () => {
    const client = {
      list: vi.fn().mockResolvedValue([
        { path: 'INBOX', name: 'INBOX', delimiter: '/' },
        { path: 'Projects-Renamed', name: 'Projects-Renamed', delimiter: '/' },
        { path: 'Projects-Renamed/Sub', name: 'Sub', delimiter: '/' },
      ]),
    };
    await ImapManager.prototype.syncFolders.call({}, account, client);

    expect(claimMailboxTopology).toHaveBeenCalledWith('acct-1');
    expect(client.list).toHaveBeenCalledOnce();
    expect(commitMailboxTopology).toHaveBeenCalledWith(
      'acct-1',
      { accountId: 'acct-1', generation: '1' },
      [
        expect.objectContaining({ path: 'INBOX' }),
        expect.objectContaining({ path: 'Projects-Renamed' }),
        expect.objectContaining({ path: 'Projects-Renamed/Sub' }),
      ],
    );
    expect(query).not.toHaveBeenCalled();
  });

  it('fails closed without a topology commit when LIST fails', async () => {
    const client = { list: vi.fn().mockRejectedValue(new Error('LIST interrupted')) };
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(ImapManager.prototype.syncFolders.call({}, account, client))
      .rejects.toThrow('LIST interrupted');

    expect(claimMailboxTopology).toHaveBeenCalledWith('acct-1');
    expect(commitMailboxTopology).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects an empty LIST before synthesizing INBOX or committing topology', async () => {
    const client = { list: vi.fn().mockResolvedValue([]) };
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(ImapManager.prototype.syncFolders.call({}, account, client))
      .rejects.toThrow(/empty LIST/i);

    expect(claimMailboxTopology).toHaveBeenCalledWith('acct-1');
    expect(commitMailboxTopology).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects a malformed partial LIST before committing any folder state', async () => {
    const client = {
      list: vi.fn().mockResolvedValue([
        { path: 'Archive', name: 'Archive', delimiter: '/', specialUse: '\\Archive' },
        { name: 'truncated-entry', delimiter: '/' },
      ]),
    };
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(ImapManager.prototype.syncFolders.call({}, account, client))
      .rejects.toThrow(/invalid mailbox entry/i);

    expect(commitMailboxTopology).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects a nonempty partial LIST that omits mandatory INBOX', async () => {
    const client = { list: vi.fn().mockResolvedValue([
      { path: 'Archive', name: 'Archive', delimiter: '/', specialUse: '\\Archive' },
    ]) };
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(ImapManager.prototype.syncFolders.call({}, account, client))
      .rejects.toThrow(/missing mandatory INBOX/i);

    expect(commitMailboxTopology).not.toHaveBeenCalled();
  });
});

describe('background body prefetch exact publication', () => {
  it('carries the captured row and folder epoch through the post-fetch cache CAS', async () => {
    query.mockReset();
    query
      .mockResolvedValueOnce({ rows: [{
        id: '11111111-1111-4111-8111-111111111111', account_id: 'acct-1',
        uid: '7', folder: 'INBOX', read_revision: '2', star_revision: '3',
        folder_uid_validity: '101', folder_observation_generation: '9', cached: false,
      }] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const manager = {
      fetchMessageBody: vi.fn().mockResolvedValue({ html: null, text: 'body', attachments: [] }),
    };

    await ImapManager.prototype.prefetchNewMessageBodies.call(
      manager,
      { id: 'acct-1' },
      [{ id: '11111111-1111-4111-8111-111111111111', uid: 7 }],
    );

    expect(manager.fetchMessageBody).toHaveBeenCalledWith(
      { id: 'acct-1' }, '7', 'INBOX',
      { snapshot: expect.objectContaining({ uidValidity: '101', folderGeneration: '9' }) },
    );
    const [publishSql, publishParams] = query.mock.calls[1];
    expect(publishSql).toMatch(/f\.uid_validity = \$9/);
    expect(publishSql).toMatch(/f\.observation_generation = \$10/);
    expect(publishParams.slice(-2)).toEqual(['101', '9']);
  });
});

describe('mailbox topology mutations', () => {
  beforeEach(() => {
    claimMailboxTopology.mockClear();
    commitMailboxTopology.mockClear();
    claimFolderObservation.mockClear();
    readFolderObservation.mockClear();
    seedFolderUidValidity.mockClear();
  });

  it('claims topology before a provider mutation and commits a fresh complete LIST afterward', async () => {
    const account = { id: 'acct-1' };
    const providerMutation = vi.fn().mockResolvedValue({ path: 'Archive', created: true });
    const client = {
      list: vi.fn().mockResolvedValue([
        { path: 'INBOX', name: 'INBOX', delimiter: '/' },
        { path: 'Archive', name: 'Archive', delimiter: '/', specialUse: '\\Archive' },
      ]),
    };

    const result = await imapModule.mutateMailboxTopology?.(account, client, providerMutation);

    expect(result).toEqual({ path: 'Archive', created: true });
    expect(claimMailboxTopology).toHaveBeenCalledWith('acct-1');
    expect(providerMutation).toHaveBeenCalledWith(client);
    expect(commitMailboxTopology).toHaveBeenCalledWith(
      'acct-1',
      { accountId: 'acct-1', generation: '1' },
      [
        expect.objectContaining({ path: 'INBOX' }),
        expect.objectContaining({ path: 'Archive', specialUse: '\\Archive' }),
      ],
    );
    expect(claimMailboxTopology.mock.invocationCallOrder[0])
      .toBeLessThan(providerMutation.mock.invocationCallOrder[0]);
    expect(providerMutation.mock.invocationCallOrder[0])
      .toBeLessThan(client.list.mock.invocationCallOrder[0]);
  });

  it('routes create, delete, and rename through topology-fenced provider mutations', async () => {
    const account = { id: 'acct-1' };
    const listed = [{ path: 'INBOX', name: 'INBOX', delimiter: '/' }];
    const client = {
      mailboxCreate: vi.fn().mockResolvedValue({ path: 'New', created: true }),
      mailboxDelete: vi.fn().mockResolvedValue(true),
      mailboxRename: vi.fn().mockResolvedValue(true),
      list: vi.fn().mockResolvedValue(listed),
    };

    await imapModule.createMailboxTopology?.(account, client, 'New');
    await imapModule.deleteMailboxTopology?.(account, client, 'Old');
    await imapModule.renameMailboxTopology?.(account, client, 'Old', 'New');

    expect(client.mailboxCreate).toHaveBeenCalledWith('New');
    expect(client.mailboxDelete).toHaveBeenCalledWith('Old');
    expect(client.mailboxRename).toHaveBeenCalledWith('Old', 'New');
    expect(claimMailboxTopology).toHaveBeenCalledTimes(3);
    expect(commitMailboxTopology).toHaveBeenCalledTimes(3);
  });

  it('establishes the UIDVALIDITY observation before a newly ensured folder can be used', async () => {
    const account = { id: 'acct-1' };
    const release = vi.fn();
    readFolderObservation.mockResolvedValueOnce({
      folder: 'Todo', uidValidity: null, generation: '1', isPresent: true,
    });
    claimFolderObservation.mockResolvedValueOnce({
      folder: 'Todo', uidValidity: null, generation: '2', isPresent: true,
    });
    const client = {
      mailbox: null,
      mailboxCreate: vi.fn().mockResolvedValue({ path: 'Todo', created: true }),
      list: vi.fn().mockResolvedValue([
        { path: 'INBOX', name: 'INBOX', delimiter: '/' },
        { path: 'Todo', name: 'Todo', delimiter: '/' },
      ]),
      getMailboxLock: vi.fn(async folder => {
        client.mailbox = { path: folder, uidValidity: 303 };
        return { release };
      }),
    };

    await expect(imapModule.ensureMailboxTopology(account, client, 'Todo'))
      .resolves.toEqual({ path: 'Todo', created: true });

    expect(readFolderObservation).toHaveBeenCalledWith('acct-1', 'Todo');
    expect(claimFolderObservation).toHaveBeenCalledWith('acct-1', 'Todo');
    expect(client.getMailboxLock).toHaveBeenCalledWith('Todo');
    expect(seedFolderUidValidity).toHaveBeenCalledWith(
      expect.anything(),
      'acct-1',
      expect.objectContaining({ folder: 'Todo' }),
      303,
    );
    expect(seedFolderUidValidity.mock.invocationCallOrder[0])
      .toBeLessThan(release.mock.invocationCallOrder[0]);
  });
});

// ── _deleteAllInFolder — chunked, throttle-tolerant empty ─────────────────────
describe('setDesiredFlag — structured local acceptance', () => {
  it('fences provider STORE with the accepted flag revision, not revision zero', () => {
    const delivery = {
      messageId: 'row-1', accountId: 'acct-1', uid: 7, folder: 'INBOX',
      uidValidity: '101', folderGeneration: '4', revision: 9,
    };
    expect(desiredFlagDeliverySnapshot({ ...delivery, flag: 'read' })).toMatchObject({
      readRevision: 9, starRevision: null,
    });
    expect(desiredFlagDeliverySnapshot({ ...delivery, flag: 'star' })).toMatchObject({
      readRevision: null, starRevision: 9,
    });
  });

  it('attaches committed acceptance when provider delivery rejects', async () => {
    const accepted = {
      changed: true,
      delivery: { messageId: 'row-1', flag: 'read', desiredValue: true, state: 'pending' },
    };
    const deliveryError = new Error('provider unavailable');
    const accept = vi.spyOn(desiredFlagExecutor, 'accept').mockResolvedValue(accepted);
    const deliver = vi.spyOn(desiredFlagExecutor, 'deliver').mockRejectedValue(deliveryError);
    const manager = Object.create(ImapManager.prototype);
    manager._desiredFlagProvider = vi.fn().mockReturnValue({ withSession: vi.fn() });

    try {
      await expect(manager.setDesiredFlag(
        { id: 'acct-1' }, 'row-1', '\\Seen', true,
      )).rejects.toBe(deliveryError);
      expect(deliveryError.desiredFlagAcceptance).toBe(accepted);
    } finally {
      accept.mockRestore();
      deliver.mockRestore();
    }
  });

  it('returns acceptance separately from confirmed provider delivery', async () => {
    const accepted = {
      changed: true,
      delivery: { messageId: 'row-1', flag: 'read', desiredValue: true, state: 'pending' },
    };
    const confirmed = { ...accepted.delivery, state: 'confirmed' };
    const accept = vi.spyOn(desiredFlagExecutor, 'accept').mockResolvedValue(accepted);
    const deliver = vi.spyOn(desiredFlagExecutor, 'deliver').mockResolvedValue(confirmed);
    const manager = Object.create(ImapManager.prototype);
    manager._desiredFlagProvider = vi.fn().mockReturnValue({ withSession: vi.fn() });

    try {
      await expect(manager.setDesiredFlag(
        { id: 'acct-1' }, 'row-1', '\\Seen', true,
      )).resolves.toMatchObject({ acceptance: accepted, delivery: confirmed });
    } finally {
      accept.mockRestore();
      deliver.mockRestore();
    }
  });
});
