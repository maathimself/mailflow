import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../index.js', () => ({ imapManager: {
  _guardMoveUid: vi.fn(),
  _unguardMoveUid: vi.fn(),
  bulkMoveMessages: vi.fn(),
  broadcast: vi.fn(),
  syncFolderOnDemand: vi.fn().mockResolvedValue(undefined),
} }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => {
    req.session = { userId: 'user-1' };
    next();
  },
}));
vi.mock('../services/senderResolver.js', () => ({ resolveMessageSender: vi.fn() }));
vi.mock('../utils/mailUtils.js', async importOriginal => ({
  ...await importOriginal(),
  adjustFolderCounts: vi.fn(),
  isAllMailFolder: vi.fn().mockResolvedValue(false),
  resolveAllDraftsPaths: vi.fn().mockResolvedValue(new Set()),
  resolveAllTrashPaths: vi.fn().mockResolvedValue(new Set()),
  resolveArchiveFolder: vi.fn().mockResolvedValue('Archive'),
  resolveTrashFolder: vi.fn().mockResolvedValue('Trash'),
}));

import express from 'express';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';
import { resolveMessageSender } from '../services/senderResolver.js';
import mailRoutes from './mail.js';

const messageId = '11111111-1111-4111-8111-111111111111';
let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/mail', mailRoutes);
  await new Promise(resolve => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
});

beforeEach(() => {
  query.mockReset();
  imapManager.bulkMoveMessages.mockReset();
  imapManager.bulkMoveMessages.mockResolvedValue({
    uidMap: new Map([[7, 70]]),
    succeeded: [7],
    failed: [],
  });
  resolveMessageSender.mockReset();
  resolveMessageSender.mockResolvedValue({
    sender: { accountId: 'a1', aliasId: null, fromEmail: null, displayEmail: 'owner@example.com' },
    requiresSelection: false,
  });
});

const movedMessage = {
  id: messageId,
  account_id: 'a1',
  uid: 7,
  folder: 'INBOX',
  folder_mappings: {},
  message_id: '<message@example.com>',
  delivery_addresses: ['mask@example.com'],
  is_read: false,
};

const postJson = (path, body) => fetch(`${base}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const post = (id, body) => fetch(`${base}/mail/messages/${id}/resolve-sender`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe('POST /mail/messages/:id/resolve-sender', () => {
  it.each(['reply', 'draft'])('resolves an owned message for purpose %s', async purpose => {
    const res = await post(messageId, { purpose });

    expect(res.status).toBe(200);
    expect(resolveMessageSender).toHaveBeenCalledWith({
      messageId,
      userId: 'user-1',
      purpose,
    });
    expect(await res.json()).toMatchObject({ requiresSelection: false });
  });

  it('rejects an invalid message ID', async () => {
    const res = await post('not-a-uuid', { purpose: 'reply' });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid message ID' });
    expect(resolveMessageSender).not.toHaveBeenCalled();
  });

  it.each([undefined, null, 'send', ''])('rejects invalid purpose %s', async purpose => {
    const res = await post(messageId, purpose === undefined ? {} : { purpose });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'purpose must be reply or draft' });
    expect(resolveMessageSender).not.toHaveBeenCalled();
  });

  it('returns 404 for a missing or unowned message', async () => {
    resolveMessageSender.mockRejectedValue(Object.assign(new Error('Message not found'), { status: 404 }));

    const res = await post(messageId, { purpose: 'reply' });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Message not found' });
  });

  it('does not log aliases or private details from unexpected reply-time failures', async () => {
    const sensitiveAlias = 'complete-private-alias@masked.example';
    const privateDetail = 'private-reconciliation-marker-9137';
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    resolveMessageSender.mockRejectedValue(new Error(`${privateDetail} ${sensitiveAlias}`));

    const res = await post(messageId, { purpose: 'reply' });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to resolve sender' });
    const logs = errorLog.mock.calls.flat().join(' ');
    expect(logs).not.toContain(sensitiveAlias);
    expect(logs).not.toContain(privateDetail);
    errorLog.mockRestore();
  });
});

describe('bulk message relocation persistence', () => {
  it.each([
    ['move', '/mail/messages/bulk-move', { ids: [messageId], folder: 'Archive' }, [
      { rows: [movedMessage] }, { rows: [{ exists: true }] }, { rows: [{ id: 'a1' }] }, { rows: [] },
    ]],
    ['trash', '/mail/messages/bulk-delete', { ids: [messageId] }, [
      { rows: [movedMessage] }, { rows: [{ id: 'a1' }] }, { rows: [] },
    ]],
    ['archive', '/mail/messages/bulk-archive', { ids: [messageId] }, [
      { rows: [movedMessage] }, { rows: [{ id: 'a1' }] }, { rows: [] },
    ]],
  ])('preserves delivery addresses when messages %s folders', async (_label, path, body, results) => {
    for (const result of results) query.mockResolvedValueOnce(result);

    const res = await postJson(path, body);

    expect(res.status).toBe(200);
    const relocation = query.mock.calls.find(([sql]) => sql.includes('WITH deleted AS'));
    expect(relocation?.[0]).toMatch(/to_addresses, cc_addresses,\s+delivery_addresses/);
    expect(relocation?.[0]).toMatch(/d\.to_addresses, d\.cc_addresses,\s+d\.delivery_addresses/);
  });
});
