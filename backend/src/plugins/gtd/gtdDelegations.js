import {
  applyLabel,
  ensureLabelFolders,
  getOwnedAccount,
  listLabelCopyUids,
  loadOwnedContact,
  loadOwnedMessages,
  reconcileLabelApply,
  removeExactLabelCopy,
} from '../api.js';
import { setThreadAnnotation } from '../gtdApi.js';
import { getGtdConfig, resolveGtdStateFolder } from './gtdConfig.js';
import { withGtdDelegationLock } from './gtdDelegationLock.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    contactId: contact?.id ?? null,
    displayName: contact
      ? contact.display_name || contact.primary_email || 'Unknown contact'
      : null,
    primaryEmail: contact?.primary_email || null,
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

  const byAccount = new Map();
  for (const group of threads.values()) {
    const groups = byAccount.get(group.message.account_id) || [];
    groups.push(group);
    byAccount.set(group.message.account_id, groups);
  }

  await Promise.all([...byAccount.entries()].map(async ([accountId, groups]) => {
    let account;
    let folder;
    try {
      account = await getOwnedAccount(userId, accountId);
      if (!account?.enabled) throw new Error('account_unavailable');
      const config = await getGtdConfig(accountId);
      folder = config.enabled ? resolveGtdStateFolder('delegated', config.folders) : null;
      if (!folder) throw new Error('delegation_disabled');
    } catch {
      for (const { ids: threadIds } of groups) {
        for (const messageId of threadIds) outcomes.set(messageId, failure(messageId, 'operation_failed'));
      }
      return;
    }

    let ensureFolderPromise;
    const ensureDelegatedFolder = () => {
      ensureFolderPromise ??= ensureLabelFolders(account, [folder]).then(([ensured]) => {
        if (ensured?.error) throw new Error('delegation_folder_unavailable');
      });
      return ensureFolderPromise;
    };

    let cursor = 0;
    const runNext = async () => {
      while (cursor < groups.length) {
        const group = groups[cursor++];
        await withGtdDelegationLock(accountId, group.message.thread_key, async () => {
          const { message, ids: threadIds } = group;
          let createdUid = null;
          let created = false;
          try {
            const beforeUids = await listLabelCopyUids(accountId, message.thread_key, folder);
            if (beforeUids.length === 0) {
              await ensureDelegatedFolder();
              let applied;
              try {
                applied = await applyLabel(account, message, folder, {
                  folderEnsured: true,
                  skipPostCopyTransitions: true,
                });
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

            // Keep a durable start boundary even for a personless delegation. The public API
            // still returns null in that case, but the transition engine needs delegatedAt to
            // distinguish the reply that was already newest when the user delegated from a
            // genuinely newer inbound reply that should clear the state.
            const storedDelegation = snapshotContact(contact);
            const delegation = contact ? storedDelegation : null;
            await setThreadAnnotation(
              accountId, message.thread_key, 'delegation', storedDelegation,
            );
            for (const messageId of threadIds) outcomes.set(messageId, {
              messageId,
              ok: true,
              accountId,
              threadKey: message.thread_key,
              delegation,
            });
          } catch (error) {
            const ambiguous = error instanceof GtdDelegationError && error.code === 'operation_ambiguous';
            let compensated = false;
            if (!ambiguous && created && createdUid != null) {
              try {
                compensated = (await removeExactLabelCopy(message, folder, createdUid)).removed;
              } catch { /* best effort; report uncompensated */ }
            }
            const code = error instanceof GtdDelegationError ? error.code : 'operation_failed';
            for (const messageId of threadIds) outcomes.set(messageId, failure(messageId, code, compensated));
          }
        });
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, groups.length) }, runNext));
  }));

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
