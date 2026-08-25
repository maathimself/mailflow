import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const imapManager = vi.hoisted(() => ({
  setFlag: vi.fn(),
  setDesiredFlag: vi.fn(),
  bulkMoveMessages: vi.fn(),
  moveMessage: vi.fn(),
  permanentDeleteMessage: vi.fn(),
  removeMessageCopy: vi.fn(),
  ensureFolder: vi.fn(),
  _guardMoveUid: vi.fn(),
  _unguardMoveUid: vi.fn(),
  _enqueueFlagPush: vi.fn(),
  _resolveFlagPush: vi.fn(),
  broadcast: vi.fn(),
}));

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => {
    req.session = { userId: 'user-1' };
    next();
  },
}));
vi.mock('../index.js', () => ({ imapManager }));

import express from 'express';
import mailRoutes from './mail.js';
import { query } from '../services/db.js';
import { pluginRegistry } from '../plugins/registry.js';

const MESSAGE_ID = '11111111-1111-4111-8111-111111111111';
const MESSAGE_ID_2 = '22222222-2222-4222-8222-222222222222';
const UPPER_MESSAGE_ID = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
const LOWER_MESSAGE_ID = UPPER_MESSAGE_ID.toLowerCase();

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/mail', mailRoutes);
  return app;
}

async function request(base, method, path, body) {
  const requestBody = path.includes('/bulk-') && Array.isArray(body?.ids)
    ? {
        ...body,
        operationKeys: Object.fromEntries(body.ids.map(id => [id, `row-key:${id}`])),
      }
    : body;
  return fetch(`${base}${path}`, {
    method,
    headers: body ? {
      'Content-Type': 'application/json',
      ...(path.includes('/bulk-') ? { 'X-Idempotency-Key': 'test-action-1' } : {}),
    } : undefined,
    body: requestBody ? JSON.stringify(requestBody) : undefined,
  });
}

describe('message action ownership boundaries', () => {
  let server;
  let base;

  beforeAll(async () => {
    await new Promise(resolve => {
      server = buildApp().listen(0, resolve);
    });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  beforeEach(() => {
    query.mockReset();
    query.mockResolvedValue({ rows: [] });
    for (const method of Object.values(imapManager)) method.mockReset();
    vi.restoreAllMocks();
  });

  it('creates an independent desired Seen record for every exact live sibling row', async () => {
    const acted = {
      id: MESSAGE_ID, account_id: 'acct-1', uid: 7, folder: 'INBOX', message_id: '<m>',
      is_read: false, sibling_count: 2,
      folder_uid_validity: '101', folder_observation_generation: '9',
      read_revision: '3', star_revision: '5',
    };
    const sibling = {
      ...acted, id: MESSAGE_ID_2, uid: 70, folder: 'Todo',
      folder_uid_validity: '102', folder_observation_generation: '10', read_revision: '8',
    };
    vi.spyOn(pluginRegistry, 'hasActiveAsync').mockResolvedValue(true);
    query.mockImplementation(async sql => {
      if (sql.includes('FROM messages m') && sql.includes('sibling_count')) return { rows: [acted] };
      if (sql.includes('SELECT * FROM email_accounts')) return { rows: [{ id: 'acct-1' }] };
      if (sql.includes('m.message_id = $2') && sql.includes('m.id <> $3')) return { rows: [sibling] };
      return { rows: [] };
    });
    imapManager.setDesiredFlag.mockResolvedValue({ changed: true });

    const response = await request(
      base, 'PATCH', `/api/mail/messages/${MESSAGE_ID}/read`, { read: true },
    );

    expect(response.status).toBe(200);
    expect(imapManager.setDesiredFlag).toHaveBeenCalledTimes(2);
    expect(imapManager.setDesiredFlag).toHaveBeenNthCalledWith(
      2, { id: 'acct-1' }, MESSAGE_ID_2, '\\Seen', true,
      { snapshot: expect.objectContaining({
        id: MESSAGE_ID_2, uid: 70, folder: 'Todo', uidValidity: '102', folderGeneration: '10',
      }) },
    );
  });

  it.each([
    ['mark read', 'PATCH', `/api/mail/messages/${MESSAGE_ID}/read`, { read: true }, 404],
    ['star', 'PATCH', `/api/mail/messages/${MESSAGE_ID}/star`, { starred: true }, 404],
    ['bulk read', 'POST', '/api/mail/messages/bulk-read', { ids: [MESSAGE_ID], read: true }, 200],
    ['bulk delete', 'POST', '/api/mail/messages/bulk-delete', { ids: [MESSAGE_ID] }, 200],
    ['bulk move', 'POST', '/api/mail/messages/bulk-move', { ids: [MESSAGE_ID], folder: 'Archive' }, 200],
    ['bulk archive', 'POST', '/api/mail/messages/bulk-archive', { ids: [MESSAGE_ID] }, 200],
    ['snooze', 'POST', `/api/mail/messages/${MESSAGE_ID}/snooze`, { until: new Date(Date.now() + 86_400_000).toISOString() }, 404],
    ['delete', 'DELETE', `/api/mail/messages/${MESSAGE_ID}`, undefined, 404],
    ['mark spam', 'POST', `/api/mail/messages/${MESSAGE_ID}/spam`, {}, 404],
    ['mark ham', 'POST', `/api/mail/messages/${MESSAGE_ID}/ham`, {}, 404],
    ['set category', 'PATCH', `/api/mail/messages/${MESSAGE_ID}/category`, { category: 'primary' }, 404],
    ['unsubscribe', 'POST', `/api/mail/messages/${MESSAGE_ID}/unsubscribe`, {}, 404],
  ])('rejects an incomplete or deleted row before %s', async (_name, method, path, body, status) => {
    const response = await request(base, method, path, body);

    expect(response.status).toBe(status);
    expect(query).toHaveBeenCalledTimes(1);
    const sql = query.mock.calls[0][0];
    expect(sql).toMatch(/(?:m|messages)\.is_deleted\s*=\s*false/);
    expect(sql).toMatch(/(?:m|messages)\.metadata_complete\s*=\s*true/);
    expect(sql).toMatch(/JOIN folders live_folder/);
    expect(sql).toMatch(/live_folder\.is_present\s*=\s*true/);
    expect(sql).toMatch(/live_folder\.uid_validity IS NOT NULL/);
    for (const imapMethod of Object.values(imapManager)) {
      expect(imapMethod).not.toHaveBeenCalled();
    }
  });

  it('creates an independent exact-row desired Seen delivery for every bulk-read row', async () => {
    const rows = [
      {
        id: MESSAGE_ID, account_id: 'acct-1', uid: 7, folder: 'INBOX', is_read: false,
        folder_uid_validity: '101', folder_observation_generation: '9',
        read_revision: '3', star_revision: '5',
      },
      {
        id: MESSAGE_ID_2, account_id: 'acct-1', uid: 8, folder: 'INBOX', is_read: false,
        folder_uid_validity: '101', folder_observation_generation: '9',
        read_revision: '4', star_revision: '6',
      },
    ];
    query.mockImplementation(async sql => {
      if (sql.includes('m.id = ANY($2::uuid[])') && sql.includes('m.is_read')) return { rows };
      if (sql.includes('SELECT * FROM email_accounts')) return { rows: [{ id: 'acct-1' }] };
      return { rows: [], rowCount: 1 };
    });
    imapManager.setDesiredFlag.mockResolvedValue({ changed: true, delivery: { state: 'confirmed' } });

    const response = await request(
      base, 'POST', '/api/mail/messages/bulk-read', { ids: [MESSAGE_ID, MESSAGE_ID_2], read: true },
    );

    expect(response.status).toBe(200);
    expect(imapManager.setDesiredFlag).toHaveBeenCalledTimes(2);
    expect(imapManager.setDesiredFlag).toHaveBeenNthCalledWith(
      1, { id: 'acct-1' }, MESSAGE_ID, '\\Seen', true,
      { snapshot: expect.objectContaining({ id: MESSAGE_ID, uid: 7, readRevision: 3 }) },
    );
    expect(imapManager.setDesiredFlag).toHaveBeenNthCalledWith(
      2, { id: 'acct-1' }, MESSAGE_ID_2, '\\Seen', true,
      { snapshot: expect.objectContaining({ id: MESSAGE_ID_2, uid: 8, readRevision: 4 }) },
    );
    expect(query.mock.calls.some(([sql]) => sql.includes('UPDATE messages SET is_read'))).toBe(false);
  });

  it.each([
    ['read', 'read', true, '\\Seen'],
    ['star', 'starred', true, '\\Flagged'],
  ])('records %s as one exact revisioned desired delivery before provider work', async (route, field, value, flag) => {
    const message = {
      id: MESSAGE_ID, account_id: 'acct-1', uid: 7, folder: 'INBOX',
      is_read: false, is_starred: false, sibling_count: 1,
      folder_uid_validity: '101', folder_observation_generation: '9',
      read_revision: '3', star_revision: '5',
    };
    query.mockImplementation(async sql => {
      if (sql.includes('FROM messages m') && sql.includes('sibling_count')) return { rows: [message] };
      if (sql.includes('SELECT * FROM email_accounts')) return { rows: [{ id: 'acct-1' }] };
      return { rows: [], rowCount: 1 };
    });
    imapManager.setDesiredFlag.mockResolvedValue({
      changed: true, delivery: { state: 'confirmed' },
    });

    const response = await request(
      base, 'PATCH', `/api/mail/messages/${MESSAGE_ID}/${route}`, { [field]: value },
    );

    expect(response.status).toBe(200);
    expect(imapManager.setDesiredFlag).toHaveBeenCalledWith(
      { id: 'acct-1' }, MESSAGE_ID, flag, true,
      { snapshot: {
        id: MESSAGE_ID, accountId: 'acct-1', uid: 7, folder: 'INBOX',
        uidValidity: '101', folderGeneration: '9', readRevision: 3, starRevision: 5,
      } },
    );
    expect(imapManager.setFlag).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]) => sql.includes('UPDATE messages SET is_'))).toBe(false);
  });

  it('gives legacy bulk requests stable server compatibility identities', async () => {
    const rows = [{
      id: MESSAGE_ID, account_id: 'acct-1', folder: 'INBOX', uid: 7, is_read: false,
      folder_uid_validity: '101', folder_observation_generation: '4',
    }];
    query.mockImplementation(async sql => {
      if (/SELECT m\.\*, a\.user_id[\s\S]*FROM messages/.test(sql)) return { rows };
      if (/SELECT 1 FROM folders/.test(sql)) return { rows: [{ '?column?': 1 }] };
      if (/SELECT \* FROM email_accounts/.test(sql)) return { rows: [{ id: 'acct-1' }] };
      return { rows: [], rowCount: 1 };
    });
    imapManager.bulkMoveMessages.mockResolvedValue({
      succeeded: [7], failed: [], uidMap: new Map([[7, 70]]),
    });
    const response = await fetch(`${base}/api/mail/messages/bulk-move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': 'legacy-batch-key' },
      body: JSON.stringify({ ids: [MESSAGE_ID], folder: 'Archive' }),
    });

    expect(response.status).toBe(200);
    const options = imapManager.bulkMoveMessages.mock.calls[0][4];
    expect(options.operationKeys.get(7)).toMatch(/^compat:[a-f0-9]{64}$/);
  });

  it('uses the client exact row-key map across a mixed bulk-move subset', async () => {
    const rows = [
      { id: MESSAGE_ID, account_id: 'acct-1', folder: 'INBOX', uid: 7, is_read: false,
        folder_uid_validity: '101', folder_observation_generation: '4' },
      { id: MESSAGE_ID_2, account_id: 'acct-1', folder: 'INBOX', uid: 8, is_read: true,
        folder_uid_validity: '101', folder_observation_generation: '4' },
    ];
    query.mockImplementation(async sql => {
      if (/SELECT m\.\*, a\.user_id[\s\S]*FROM messages/.test(sql)) return { rows };
      if (/SELECT 1 FROM folders/.test(sql)) return { rows: [{ '?column?': 1 }] };
      if (/SELECT \* FROM email_accounts/.test(sql)) return { rows: [{ id: 'acct-1' }] };
      return { rows: [], rowCount: 1 };
    });
    imapManager.bulkMoveMessages.mockResolvedValue({
      succeeded: [7, 8], failed: [], uidMap: new Map([[7, 70], [8, 80]]),
    });
    const operationKeys = {
      [MESSAGE_ID]: 'persisted-row-key-1',
      [MESSAGE_ID_2]: 'new-row-key-2',
    };

    const response = await fetch(`${base}/api/mail/messages/bulk-move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [MESSAGE_ID, MESSAGE_ID_2], folder: 'Archive', operationKeys }),
    });

    expect(response.status).toBe(200);
    expect(imapManager.bulkMoveMessages).toHaveBeenCalledWith(
      { id: 'acct-1' }, [7, 8], 'INBOX', 'Archive', expect.objectContaining({
        operationKeys: new Map([[7, 'persisted-row-key-1'], [8, 'new-row-key-2']]),
        sourceSnapshots: expect.any(Map),
      }),
    );
    const options = imapManager.bulkMoveMessages.mock.calls[0][4];
    expect(options.sourceSnapshots.get(7)).toMatchObject({
      id: MESSAGE_ID, uid: 7, uidValidity: '101', folderGeneration: '4',
    });
  });

  it.each([
    ['retained row key', { operationKeys: { [MESSAGE_ID]: 'retained-delete-key' } }],
    ['legacy request shape', {}],
  ])('replays a completed Trash MOVE for %s without expunging the relocated row', async (
    _shape, requestShape,
  ) => {
    const row = {
      id: MESSAGE_ID, account_id: 'acct-1', folder: 'Trash', uid: 70,
      folder_mappings: { trash: 'Trash', drafts: 'Drafts' },
      folder_uid_validity: '202', folder_observation_generation: '8',
      is_read: false, is_deleted: false, metadata_complete: true,
    };
    query.mockImplementation(async (sql, params) => {
      if (/SELECT m\.\*, a\.user_id[\s\S]*FROM messages/.test(sql)) return { rows: [row] };
      if (/FROM provider_operations/.test(sql)) {
        const requestKey = requestShape.operationKeys?.[MESSAGE_ID] || params.at(-1)?.[0];
        return { rows: [{
          operation_key: 'completed-move', account_id: 'acct-1', kind: 'move',
          request_key: requestKey, source_message_id: MESSAGE_ID,
          destination_folder: 'Trash', state: 'completed',
          receipt: { folder: 'Trash', uid: 70, uidValidity: '202' },
        }] };
      }
      if (/SELECT \* FROM email_accounts/.test(sql)) return { rows: [{ id: 'acct-1' }] };
      if (/FROM folders/.test(sql)) {
        return { rows: [{ path: 'Trash', name: 'Trash', special_use: '\\Trash' }] };
      }
      return { rows: [], rowCount: 1 };
    });

    const response = await fetch(`${base}/api/mail/messages/bulk-delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [MESSAGE_ID], ...requestShape }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, deleted: [MESSAGE_ID] });
    expect(imapManager.removeMessageCopy).not.toHaveBeenCalled();
    expect(imapManager.bulkMoveMessages).not.toHaveBeenCalled();
  });

  it.each([
    ['bulk-delete', {}, 'deleted'],
    ['bulk-move', { folder: 'Archive' }, 'moved'],
    ['bulk-archive', {}, 'archived'],
  ])('rejects case-variant duplicate row ids for %s', async (route, extra, resultField) => {
    const response = await fetch(`${base}/api/mail/messages/${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ids: [UPPER_MESSAGE_ID, LOWER_MESSAGE_ID],
        ...extra,
        operationKeys: {
          [UPPER_MESSAGE_ID]: 'upper-row-key',
          [LOWER_MESSAGE_ID]: 'lower-row-key',
        },
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).not.toHaveProperty(resultField);
    expect(query).not.toHaveBeenCalled();
    expect(imapManager.bulkMoveMessages).not.toHaveBeenCalled();
  });

  it.each([
    ['bulk-delete', {}, 'deleted', 'Trash'],
    ['bulk-move', { folder: 'Archive' }, 'moved', 'Archive'],
    ['bulk-archive', {}, 'archived', 'Archive'],
  ])('preserves an uppercase row id exact key through lowercase DB results for %s', async (
    route, extra, resultField, destination,
  ) => {
    const row = {
      id: LOWER_MESSAGE_ID,
      account_id: 'acct-1',
      folder: 'INBOX',
      folder_mappings: route === 'bulk-delete'
        ? { trash: 'Trash', drafts: 'Drafts' }
        : { archive: 'Archive' },
      uid: 7,
      is_read: false,
    };
    query.mockImplementation(async (sql, params) => {
      if (/SELECT m\.\*, a\.user_id/.test(sql)) {
        expect(params[1]).toEqual([LOWER_MESSAGE_ID]);
        return { rows: [row] };
      }
      if (/SELECT 1 FROM folders/.test(sql) && /special_use = '\\All'/.test(sql)) {
        return { rows: [] };
      }
      if (/SELECT 1 FROM folders/.test(sql)) return { rows: [{ '?column?': 1 }] };
      if (/SELECT \* FROM email_accounts/.test(sql)) return { rows: [{ id: 'acct-1' }] };
      return { rows: [], rowCount: 1 };
    });
    imapManager.bulkMoveMessages.mockResolvedValue({
      succeeded: [7], failed: [], uidMap: new Map([[7, 70]]),
    });

    const response = await fetch(`${base}/api/mail/messages/${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ids: [UPPER_MESSAGE_ID],
        ...extra,
        operationKeys: { [UPPER_MESSAGE_ID]: `exact-key:${route}` },
      }),
    });

    expect(response.status).toBe(200);
    expect((await response.json())[resultField]).toEqual([LOWER_MESSAGE_ID]);
    expect(imapManager.bulkMoveMessages).toHaveBeenCalledWith(
      { id: 'acct-1' }, [7], 'INBOX', destination, expect.objectContaining({
        operationKeys: new Map([[7, `exact-key:${route}`]]),
      }),
    );
  });
});
