import {
  applyLabel,
  getOwnedAccount,
  listLabelCopyUids,
  loadOwnedContact,
  loadOwnedMessages,
  reconcileLabelApply,
  removeExactLabelCopy,
  setThreadAnnotation,
} from '../api.js';
import { getGtdConfig, resolveGtdStateFolder } from './gtdConfig.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const queues = new Map();

async function serialize(key, work) {
  const previous = queues.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(work);
  queues.set(key, current);
  try {
    return await current;
  } finally {
    if (queues.get(key) === current) queues.delete(key);
  }
}

export class GtdDelegationError extends Error {
  constructor(code, status) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

function failure(messageId, error, compensated = false) {
  return { messageId, ok: false, error, compensated };
}

function snapshotContact(contact, now = new Date()) {
  const timestamp = now.toISOString();
  return {
    contactId: contact.id,
    displayName: contact.display_name || contact.primary_email || 'Unknown contact',
    primaryEmail: contact.primary_email || null,
    delegatedAt: timestamp,
    updatedAt: timestamp,
  };
}

export async function delegateMessages({ userId, messageIds, contactId }) {
  if (!Array.isArray(messageIds)) throw new GtdDelegationError('invalid_request', 400);
  const ids = [...new Set(messageIds)];
  if (ids.length < 1 || ids.length > 100 || ids.some(id => !UUID_RE.test(id))) {
    throw new GtdDelegationError('invalid_request', 400);
  }
  if (contactId !== null && !UUID_RE.test(contactId || '')) {
    throw new GtdDelegationError('invalid_request', 400);
  }

  const contact = contactId === null ? null : await loadOwnedContact(userId, contactId);
  if (contactId !== null && !contact) throw new GtdDelegationError('contact_not_found', 404);

  const owned = await loadOwnedMessages(userId, ids);
  const byId = new Map(owned.map(message => [message.id, message]));
  const outcomes = new Map(ids.filter(id => !byId.has(id)).map(id => [id, failure(id, 'not_found')]));
  const threads = new Map();

  for (const id of ids) {
    const message = byId.get(id);
    if (!message) continue;
    if (!message.thread_key) {
      outcomes.set(id, failure(id, 'operation_failed'));
      continue;
    }
    const key = `${message.account_id}\0${message.thread_key}`;
    const group = threads.get(key) || { message, ids: [] };
    group.ids.push(id);
    threads.set(key, group);
  }

  await Promise.all([...threads.entries()].map(([key, group]) => serialize(key, async () => {
    const { message, ids: threadIds } = group;
    let createdUid = null;
    let created = false;
    let folder = null;
    try {
      const account = await getOwnedAccount(userId, message.account_id);
      if (!account?.enabled) throw new Error('account_unavailable');
      const config = await getGtdConfig(message.account_id);
      folder = config.enabled ? resolveGtdStateFolder('delegated', config.folders) : null;
      if (!folder) throw new Error('delegation_disabled');

      const beforeUids = await listLabelCopyUids(message.account_id, message.thread_key, folder);
      if (beforeUids.length === 0) {
        let applied;
        try {
          applied = await applyLabel(account, message, folder);
        } catch (error) {
          if (error?.copiedUid != null) {
            created = true;
            createdUid = error.copiedUid;
          }
          throw error;
        }
        created = applied.applied;
        createdUid = applied.uid;
        if (created && createdUid == null) {
          const reconciled = await reconcileLabelApply(account, message, folder, beforeUids);
          if (reconciled.ambiguous) throw new GtdDelegationError('operation_ambiguous', 409);
          createdUid = reconciled.uid;
        }
      }

      const delegation = contact ? snapshotContact(contact) : null;
      await setThreadAnnotation(message.account_id, message.thread_key, 'gtd', 'delegation', delegation);
      for (const messageId of threadIds) outcomes.set(messageId, {
        messageId,
        ok: true,
        accountId: message.account_id,
        threadKey: message.thread_key,
        delegation,
      });
    } catch (error) {
      const ambiguous = error instanceof GtdDelegationError && error.code === 'operation_ambiguous';
      let compensated = false;
      if (!ambiguous && created && createdUid != null && folder) {
        try {
          compensated = (await removeExactLabelCopy(message, folder, createdUid)).removed;
        } catch { /* best effort; report uncompensated */ }
      }
      const code = error instanceof GtdDelegationError ? error.code : 'operation_failed';
      for (const messageId of threadIds) outcomes.set(messageId, failure(messageId, code, compensated));
    }
  })));

  const results = ids.map(id => outcomes.get(id));
  const successCount = results.filter(result => result.ok).length;
  const failureCount = results.length - successCount;
  return {
    status: failureCount === 0 ? 'success' : successCount === 0 ? 'failed' : 'partial',
    successCount,
    failureCount,
    results,
  };
}
