import { applyLabel, getMessageCopyFolders, getMessagesByThreadKeys, hasMessageCopy, removeLabel, resolveLabelCopyUid } from '../api.js';

// The thread's copies in the other GTD state folders, which a switch to `state` removes.
export async function findOldStateCopies(msg, folders, state, toFolder) {
  let oldCopies = [];
  const oldStateFolders = new Set(Object.entries(folders)
    .filter(([otherState, folder]) => otherState !== state && folder !== toFolder)
    .map(([, folder]) => folder));
  const threadCopies = msg.thread_key
    ? await getMessagesByThreadKeys(msg.account_id, [msg.thread_key])
    : [];
  if (threadCopies.length) {
    oldCopies = threadCopies
      .filter(copy => oldStateFolders.has(copy.folder))
      .map(copy => ({ message: { ...copy, account_id: msg.account_id }, folder: copy.folder }));
    if (oldStateFolders.has(msg.folder) && !oldCopies.some(copy => copy.message.uid === msg.uid && copy.folder === msg.folder)) {
      oldCopies.push({ message: msg, folder: msg.folder });
    }
  } else {
    // A missing thread key or unindexed thread still gets the same-message
    // labels. The selected row's folder remains known without Message-ID.
    const present = new Set(msg.message_id
      ? await getMessageCopyFolders(msg.account_id, msg.message_id)
      : []);
    present.add(msg.folder);
    for (const folder of oldStateFolders) {
      if (!present.has(folder)) continue;
      const uid = await resolveLabelCopyUid(msg, folder);
      if (uid != null) oldCopies.push({ message: { ...msg, uid, folder }, folder });
    }
  }

  // A failed later removal must leave the selected message id available for
  // retry. The selected old-state row is the last copy we strip.
  const isSelectedCopy = copy => copy.folder === msg.folder && copy.message.uid === msg.uid;
  return [
    ...oldCopies.filter(copy => !isSelectedCopy(copy)),
    ...oldCopies.filter(isSelectedCopy),
  ];
}

// Put a message's thread in one GTD state: COPY it into `toFolder`, then remove its copies from
// the other state folders. Shared by /classify and explicit delegation, so a thread never ends up
// in two states. `msg` needs { account_id, uid, folder, message_id, thread_key }. A caller that
// already looked up the old copies passes them as `knownOldCopies`.
export async function switchGtdState(account, msg, folders, state, toFolder, knownOldCopies = null) {
  const oldCopies = knownOldCopies ?? await findOldStateCopies(msg, folders, state, toFolder);
  const isSelectedCopy = copy => copy.folder === msg.folder && copy.message.uid === msg.uid;
  let sourceRemoved = false;
  const result = await applyLabel(account, msg, toFolder, { forceCopy: oldCopies.length > 0 });
  // A cache-only destination can already be gone on IMAP. Confirm a fresh
  // COPY for each email before expunging any old state, accepting duplicates.
  // An arbitrary stored Message-ID must not collide with a headerless source.
  const identity = message => message.message_id
    ? `rfc:${message.message_id}`
    : `physical:${message.folder}:${message.uid}`;
  const confirmsIdentity = async (message, uid, folder) => {
    if (!message.message_id) return true;
    try {
      return await hasMessageCopy(account, uid, folder, message.message_id);
    } catch (err) {
      console.warn(`GTD classify could not verify copy ${folder}: ${err.message}`);
      return false;
    }
  };
  const preserved = new Set();
  // COPYUID confirms a physical copy, but cached Message-ID metadata may be
  // stale. Reusing that copy for another source requires live identity proof
  // on both sides; unavailable proof falls back to copying each source.
  if (oldCopies.length && result.applied && result.uid != null && await confirmsIdentity(msg, result.uid, toFolder)) {
    preserved.add(identity(msg));
  }
  for (const copy of oldCopies) {
    const key = identity(copy.message);
    if (preserved.has(key) && await confirmsIdentity(copy.message, copy.message.uid, copy.folder)) continue;
    const copied = await applyLabel(account, copy.message, toFolder, { forceCopy: true });
    // Without COPYUID, an OK response may have copied no stale source UID.
    // Copy each physical sibling unless this request confirmed a destination.
    if (copied.uid != null && await confirmsIdentity(copy.message, copied.uid, toFolder)) preserved.add(key);
  }
  // Removal can throw after EXPUNGE. Keep every confirmed target copy;
  // compensation by deletion could erase the last surviving email.
  for (const copy of oldCopies) {
    const { removed } = await removeLabel(copy.message, copy.folder);
    if (removed && isSelectedCopy(copy)) sourceRemoved = true;
  }
  return { result, oldCopies, sourceRemoved };
}
