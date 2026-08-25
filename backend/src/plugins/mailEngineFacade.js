// Bounded mail-engine facade handed to plugin hooks (v3.0 plugin platform).
//
// The import boundary (eslint.plugins-boundary + api.js) stops a plugin from importing the mail
// engine, but core still *hands* engine references to plugin hooks at runtime — via the hook ctx
// (ctx.mgr / ctx.imapManager) and the sync-tick descriptor. Passing the real ImapManager there
// would give a plugin the whole engine: disconnectAccount, the live authenticated IMAP clients held
// in `connections`, the shared on-demand sync-lock set, and more. Instead core wraps the engine in
// this frozen facade exposing ONLY the narrow, reviewed sync/label primitives a hook legitimately
// needs. This is the runtime twin of the import boundary: together they mean a plugin reaches the
// engine by neither import nor ctx.
//
// Every method delegates 1:1 to the engine with identical semantics. The two state-bearing members
// (`connections`, `onDemandSyncing`) are narrowed to methods so a plugin can query/coordinate but
// can never read another account's connection object or corrupt core's lock set. The surface is the
// exact union of what the in-repo GTD plugin uses; it grows only as new primitives are reviewed.
export function createPluginMailFacade(engine) {
  return Object.freeze({
    // Realtime broadcast to a user's live sessions.
    broadcast: (payload, userId) => engine.broadcast(payload, userId),

    // Is the account's persistent (IDLE) sync connection live? Replaces raw `connections` access so
    // a plugin can't reach another account's authenticated IMAP client.
    isConnected: (accountId) => engine.connections.has(accountId),

    // Claim / release the on-demand sync lock for one folder, coordinating with core's own
    // user-triggered syncs (same `${accountId}:${folder}` key set). tryClaim returns false when the
    // folder is already being synced. Narrows the raw `onDemandSyncing` Set so a plugin can't clear
    // or inspect core's locks.
    tryClaimFolderSync: (accountId, folder) => {
      const key = `${accountId}:${folder}`;
      if (engine.onDemandSyncing.has(key)) return false;
      engine.onDemandSyncing.add(key);
      return true;
    },
    releaseFolderSync: (accountId, folder) => engine.onDemandSyncing.delete(`${accountId}:${folder}`),

    // Sync-capability primitives — all run on pooled connections, never disturbing the IDLE client.
    folderFingerprint: (accountId, folder) => engine.folderFingerprint(accountId, folder),
    syncFolderViaPool: (account, folder) => engine.syncFolderViaPool(account, folder),
    syncFolderOnDemand: (account, folder) => engine.syncFolderOnDemand(account, folder),

    // Remove a message's copy from a label folder (GTD transition strips).
    removeMessageCopy: (accountId, uid, folder, options) => engine.removeMessageCopy(accountId, uid, folder, options),
  });
}
