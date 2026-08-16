import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api.js', () => ({
  applyLabel: vi.fn(),
  getOwnedAccount: vi.fn(),
  listLabelCopyUids: vi.fn(),
  loadOwnedContact: vi.fn(),
  loadOwnedMessages: vi.fn(),
  reconcileLabelApply: vi.fn(),
  removeExactLabelCopy: vi.fn(),
  setThreadAnnotation: vi.fn(),
}));
vi.mock('./gtdConfig.js', () => ({
  getGtdConfig: vi.fn(),
  resolveGtdStateFolder: vi.fn((_state, folders) => folders.delegated),
}));

import * as api from '../api.js';
import { getGtdConfig } from './gtdConfig.js';
import { delegateMessages, GtdDelegationError } from './gtdDelegations.js';

const USER = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = '22222222-2222-4222-8222-222222222222';
const MESSAGE_A = '33333333-3333-4333-8333-333333333333';
const MESSAGE_B = '44444444-4444-4444-8444-444444444444';
const CONTACT = '55555555-5555-4555-8555-555555555555';
const contact = { id: CONTACT, display_name: 'Casey Rivera', primary_email: 'casey@example.test' };
const row = id => ({
  id,
  account_id: ACCOUNT,
  uid: id === MESSAGE_A ? 10 : 11,
  folder: 'INBOX',
  message_id: `<${id}@example.test>`,
  thread_key: 'thread-1',
});

beforeEach(() => {
  vi.clearAllMocks();
  api.loadOwnedContact.mockResolvedValue(contact);
  api.loadOwnedMessages.mockResolvedValue([row(MESSAGE_A)]);
  api.getOwnedAccount.mockResolvedValue({ id: ACCOUNT, user_id: USER, enabled: true });
  getGtdConfig.mockResolvedValue({ enabled: true, folders: { delegated: 'Delegated' } });
  api.listLabelCopyUids.mockResolvedValue([]);
  api.applyLabel.mockResolvedValue({ applied: true, uid: 77 });
  api.reconcileLabelApply.mockResolvedValue({ uid: 78, ambiguous: false });
  api.setThreadAnnotation.mockResolvedValue(2);
  api.removeExactLabelCopy.mockResolvedValue({ removed: true });
});

describe('delegateMessages', () => {
  it('deduplicates IDs and labels one logical thread once', async () => {
    api.loadOwnedMessages.mockResolvedValue([row(MESSAGE_A), row(MESSAGE_B)]);
    const result = await delegateMessages({ userId: USER, messageIds: [MESSAGE_A, MESSAGE_A, MESSAGE_B], contactId: CONTACT });
    expect(result).toMatchObject({ status: 'success', successCount: 2, failureCount: 0 });
    expect(result.results.map(item => item.messageId)).toEqual([MESSAGE_A, MESSAGE_B]);
    expect(api.applyLabel).toHaveBeenCalledTimes(1);
    expect(api.setThreadAnnotation).toHaveBeenCalledTimes(1);
    expect(result.results[0].delegation).toMatchObject({
      contactId: CONTACT,
      displayName: contact.display_name,
      primaryEmail: contact.primary_email,
    });
  });

  it('clears the contact snapshot while retaining the Delegated label', async () => {
    api.listLabelCopyUids.mockResolvedValue([88]);
    const result = await delegateMessages({ userId: USER, messageIds: [MESSAGE_A], contactId: null });
    expect(result.results[0]).toMatchObject({ ok: true, delegation: null });
    expect(api.applyLabel).not.toHaveBeenCalled();
    expect(api.setThreadAnnotation).toHaveBeenCalledWith(ACCOUNT, 'thread-1', 'gtd', 'delegation', null);
  });

  it('rejects a contact outside the owning user', async () => {
    api.loadOwnedContact.mockResolvedValue(null);
    await expect(delegateMessages({ userId: USER, messageIds: [MESSAGE_A], contactId: CONTACT }))
      .rejects.toMatchObject({ code: 'contact_not_found', status: 404 });
  });

  it('reports requested rows the user does not own without exposing them', async () => {
    api.loadOwnedMessages.mockResolvedValue([]);
    const result = await delegateMessages({ userId: USER, messageIds: [MESSAGE_A], contactId: null });
    expect(result).toMatchObject({ status: 'failed', successCount: 0, failureCount: 1 });
    expect(result.results[0]).toMatchObject({ messageId: MESSAGE_A, ok: false, error: 'not_found' });
  });

  it('compensates only the exact copy created by this call when annotation fails', async () => {
    api.setThreadAnnotation.mockRejectedValue(new Error('write failed'));
    const result = await delegateMessages({ userId: USER, messageIds: [MESSAGE_A], contactId: CONTACT });
    expect(api.removeExactLabelCopy).toHaveBeenCalledWith(row(MESSAGE_A), 'Delegated', 77);
    expect(result.results[0]).toMatchObject({ ok: false, compensated: true });
  });

  it('never compensates a pre-existing label', async () => {
    api.listLabelCopyUids.mockResolvedValue([88]);
    api.setThreadAnnotation.mockRejectedValue(new Error('write failed'));
    await delegateMessages({ userId: USER, messageIds: [MESSAGE_A], contactId: CONTACT });
    expect(api.removeExactLabelCopy).not.toHaveBeenCalled();
  });

  it('serializes concurrent calls for one thread so only one copy is created', async () => {
    let labelled = false;
    api.listLabelCopyUids.mockImplementation(async () => labelled ? [77] : []);
    api.applyLabel.mockImplementation(async () => { labelled = true; return { applied: true, uid: 77 }; });
    const [first, second] = await Promise.all([
      delegateMessages({ userId: USER, messageIds: [MESSAGE_A], contactId: CONTACT }),
      delegateMessages({ userId: USER, messageIds: [MESSAGE_A], contactId: CONTACT }),
    ]);
    expect(first.status).toBe('success');
    expect(second.status).toBe('success');
    expect(api.applyLabel).toHaveBeenCalledTimes(1);
  });

  it('reconciles a non-UIDPLUS copy before writing annotations', async () => {
    api.applyLabel.mockResolvedValue({ applied: true, uid: null });
    await delegateMessages({ userId: USER, messageIds: [MESSAGE_A], contactId: CONTACT });
    expect(api.reconcileLabelApply).toHaveBeenCalledWith(
      { id: ACCOUNT, user_id: USER, enabled: true }, row(MESSAGE_A), 'Delegated', [],
    );
    expect(api.setThreadAnnotation).toHaveBeenCalled();
  });

  it('reports ambiguous non-UIDPLUS reconciliation without guessing or annotating', async () => {
    api.applyLabel.mockResolvedValue({ applied: true, uid: null });
    api.reconcileLabelApply.mockResolvedValue({ uid: null, ambiguous: true });
    const result = await delegateMessages({ userId: USER, messageIds: [MESSAGE_A], contactId: CONTACT });
    expect(result.results[0]).toMatchObject({ ok: false, error: 'operation_ambiguous', compensated: false });
    expect(api.setThreadAnnotation).not.toHaveBeenCalled();
    expect(api.removeExactLabelCopy).not.toHaveBeenCalled();
  });

  it('rejects invalid and oversized requests before reading data', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`);
    await expect(delegateMessages({ userId: USER, messageIds: ids, contactId: null })).rejects.toBeInstanceOf(GtdDelegationError);
    expect(api.loadOwnedMessages).not.toHaveBeenCalled();
  });
});
