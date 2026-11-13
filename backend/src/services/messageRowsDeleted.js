import { extractImapError } from './imapError.js';
import { pluginRegistry } from '../plugins/registry.js';

// Dispatch only after the statement/transaction commits. Hooks cannot hold up a core response
// or count update, and a handler failure cannot undo the rows already removed.
export function notifyMessageRowsDeleted(account, rows, folder, userId) {
  const groups = new Map();
  for (const row of rows || []) {
    if (!row.thread_key) continue;
    const owner = account ?? { id: row.account_id, ...(userId ? { user_id: userId } : {}) };
    const path = folder ?? row.folder;
    const key = JSON.stringify([owner.id, path]);
    if (!groups.has(key)) groups.set(key, { account: owner, folder: path, threadKeys: new Set() });
    groups.get(key).threadKeys.add(row.thread_key);
  }
  for (const group of groups.values()) {
    pluginRegistry.runHook('messageRowsDeleted', {
      ...group, threadKeys: [...group.threadKeys],
    }).then(errors => {
      for (const { pluginId, error } of errors || []) {
        console.warn(`Message deletion hook failed (${pluginId}):`, extractImapError(error));
      }
    });
  }
}
