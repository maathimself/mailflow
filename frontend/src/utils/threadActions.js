import { useStore } from '../store/index.js';
import { api } from './api.js';
import { normalizeConversation, newestConversationMessage } from './conversation.js';
import { conversationActionIds, conversationSpamTargets, newestSnoozeTarget, keepDraftsApart } from './conversationActions.js';
import { setPendingDelete, setCompletedDelete, clearDeleteGuard, clearPendingDelete } from './pendingDeletes.js';
import { archiveTargetsForFolder } from './threadedArchive.js';

// Which messages a thread-wide action should actually operate on.
//
// A thread row stands for several messages, so acting on one means resolving the rest. The
// obvious place to get them is the cache populated when the thread was last expanded, and that
// is the trap: the cache is a snapshot, and a thread gains messages while you are looking at it.
//
// The observed failure: a GitHub thread received a reply after the thread was opened. Marking it
// read sent the bulk-read call for the CACHED ids, so the newer message was never included and
// stayed unread on the server. The UI then marked the cached copies read, so the row rendered as
// read with the unread message hidden inside it. The account badge showed 1 unread that could
// not be cleared by any amount of clicking, because the message was unreachable.
//
// The same staleness is worse for the destructive paths. A thread-wide delete or move built from
// a stale list silently leaves the newest messages behind, which is the bug the bulk-delete
// comment in MessageList already describes having fixed once.
//
// So the cache renders; the server decides what to act on. `allowCache` has to be asked for
// explicitly, and nothing currently asks, which is the point: a future caller has to think about
// staleness rather than inherit it by default.
//
// The thread also spans accounts. One email delivered to two of the reader's accounts is two
// mailbox items, and the thread route returns both so the conversation can show them (#476),
// while the bulk endpoints check only the user. Outside the unified inbox a row stands for its
// own account's copies, so an action on it takes only those. `accountId` is the account whose
// copies an action takes, and null takes every copy, as a unified-inbox row counts every
// unified account's.
export const inAccount = (messages, accountId) => (accountId
  ? messages.filter(message => message?.account_id === accountId)
  : messages);

/**
 * @param message      the row the action was invoked on
 * @param isThreadRow  false for an ordinary message row, which is already the whole action
 * @param cached       previously fetched sub-messages, used only when allowCache is true
 * @param fetchThread  () => Promise<{ messages }> — authoritative fetch
 * @param allowCache   opt in to the snapshot; only safe when staleness cannot change the outcome
 * @param accountId    the account whose copies to take; null takes every account's
 */
export async function resolveThreadMessages({ message, isThreadRow, cached, fetchThread, allowCache = false, accountId = null }) {
  if (!isThreadRow) return [message];
  const listed = allowCache && Array.isArray(cached) && cached.length > 0
    ? cached
    : (await fetchThread())?.messages;
  const messages = inAccount(Array.isArray(listed) ? listed : [], accountId);
  // An empty or malformed response must not silently reduce the action to nothing: fall back to
  // the row itself, which is the same conservative choice the previous implementation made.
  return messages.length ? messages : [message];
}

// ---------------------------------------------------------------------------
// Performing a thread-wide action.
//
// Every one of these follows the shape MessagePane established for a single message:
// remove optimistically so the list responds immediately, hold the real request for the
// length of the undo window, and put everything back if the user undoes it or the
// request fails. Acting on a conversation only changes how many messages move together,
// which is why it is one runner and a few thin callers.
//
// The optimistic removal uses the messages the pane is showing, because that is what the
// reader can see. The request does not: at commit time it re-resolves the thread from the
// server, for the staleness reason documented at the top of this file. A reply that landed
// while the conversation was open must be archived along with the rest of it, not left
// behind to resurrect the thread.
//
// Each returns whether it took anything, since a filter can leave nothing to act on (Spam spares
// the reader's own mail, Snooze takes only an inbox copy, accountId can match no copy at all, the
// anchor can be another account's draft, which Archive and Move leave alone), and the pane moves on
// only when one did. beforeRemove runs once there is something to take, before anything leaves the
// list: that is when the pane opens what takes the conversation's place.

const UNDO_WINDOW_MS = 4500;

export function runThreadAction({ messages, commit, resolve, notification, addNotification, beforeRemove, onRemove, onRestore }) {
  const targets = normalizeConversation(messages);
  if (!targets.length) return false;
  beforeRemove?.();

  const unread = targets.filter(message => !message.is_read);
  const store = useStore.getState();
  targets.forEach(message => store.removeMessage(message.id));
  unread.forEach(message => store.decrementUnread(message.account_id));
  onRemove?.(targets);

  const restore = () => {
    const state = useStore.getState();
    state.restoreMessages(targets);
    unread.forEach(message => state.incrementUnread(message.account_id));
    onRestore?.(targets);
  };

  let undone = false;
  const timer = setTimeout(async () => {
    if (undone) return;
    try {
      // Resolve last, so a message that arrived during the undo window is included.
      const live = resolve ? normalizeConversation(await resolve(targets)) : targets;
      await commit(live.length ? live : targets);
    } catch (err) {
      console.error('Thread action failed:', err);
      restore();
      addNotification({
        type: 'error',
        title: notification.failTitle,
        body: err.message || notification.failBody,
      });
    }
  }, UNDO_WINDOW_MS);

  addNotification({
    title: notification.title,
    body: notification.body,
    onUndo: () => {
      undone = true;
      clearTimeout(timer);
      restore();
    },
  });
  return true;
}

const subjectOf = (messages, t) =>
  newestConversationMessage(messages)?.subject || t('common.noSubject');

// fetchThread is the authoritative lookup, supplied by the pane that knows the thread id
// and folder. Omitting it falls back to the messages on screen.
const liveThread = (fetchThread) => fetchThread
  ? (targets) => resolveThreadMessages({
      message: targets[0],
      isThreadRow: true,
      fetchThread,
    })
  : null;

// Archive, delete and move each move or expunge every message they are given, so they act on the
// conversation's drafts or on the rest of it, never both, by the anchor (the selected message); see
// keepDraftsApart. Of those they take accountId's copies. Drafts are told apart among every
// account's copies first, because the anchor can be the other account's copy picked under the row.
// The other account's draft is not a copy of anything accountId holds, though: it is mail saved in
// that account alone, and picked under the row it stands for none of accountId's mail. Archive and
// Move take nothing then: taking accountId's drafts in its place would move those and leave the
// draft the reader picked. Delete takes the picked draft itself (deleteThread). Exported for the
// pane, which names the draft when Archive or Move take nothing, and says so before Move's picker.
export const otherAccountsDraft = (list, anchorId, accountId) => {
  const anchor = list.find(message => message?.id === anchorId);
  return accountId && anchor?.is_draft && anchor.account_id !== accountId ? anchor : null;
};

const takenCopies = (list, anchorId, accountId) => (otherAccountsDraft(list, anchorId, accountId)
  ? []
  : inAccount(keepDraftsApart(list, anchorId), accountId));

const sparingDrafts = (resolve, anchorId, accountId) => resolve
  ? async (targets) => takenCopies(await resolve(targets), anchorId, accountId)
  : null;

// Archive takes the conversation out of the folder it is shown in, as the list's archive does
// (archiveTargetsForFolder): your replies stay in Sent rather than moving to Archive with it. With
// no folder given, every message goes, as before.
const inArchiveScope = (list, { anchorId, folder, accountId }) => {
  if (!folder) return list;
  const anchor = list.find(message => message?.id === anchorId) || newestConversationMessage(list);
  return anchor ? archiveTargetsForFolder(anchor, list, folder, true, accountId) : list;
};

export function archiveThread(messages, { t, addNotification, fetchThread, anchorId, folder, accountId, beforeRemove }) {
  const scope = { anchorId, folder, accountId };
  const resolveSpared = sparingDrafts(liveThread(fetchThread), anchorId, accountId);
  return runThreadAction({
    messages: inArchiveScope(takenCopies(messages, anchorId, accountId), scope),
    addNotification,
    beforeRemove,
    resolve: resolveSpared ? async (targets) => inArchiveScope(await resolveSpared(targets), scope) : null,
    commit: async (targets) => {
      const result = await api.bulkArchive(conversationActionIds(targets));
      // Not an error: the account simply has no archive folder mapped, and the user
      // needs telling, because nothing moved.
      if (result?.noArchiveFolder?.length) {
        addNotification({ title: t('message.archived.noFolderTitle'), body: t('message.archived.noFolderBody') });
      }
    },
    notification: {
      title: t('message.archived.conversationTitle'),
      body: subjectOf(messages, t),
      failTitle: t('message.archived.failTitle'),
      failBody: t('message.archived.failBody'),
    },
  });
}

export function deleteThread(messages, { t, addNotification, fetchThread, anchorId, accountId, beforeRemove }) {
  // Picked under the row, the other account's draft is the one message outside accountId that Delete
  // takes: the reader opened it and asked. That draft alone, since a deleted draft is expunged and its
  // account's other drafts were not asked for, and by its id alone at commit, with no re-read: there
  // is nothing to add to one message, and a draft gone by then (sent, discarded, saved again under a
  // new id) would leave the re-read to take the rest of the conversation in its place.
  const draft = otherAccountsDraft(messages, anchorId, accountId);
  return runThreadAction({
    messages: draft ? [draft] : takenCopies(messages, anchorId, accountId),
    addNotification,
    beforeRemove,
    resolve: draft ? null : sparingDrafts(liveThread(fetchThread), anchorId, accountId),
    // The delete guards stop a sync already in flight from resurrecting the rows
    // between the optimistic removal and the commit.
    onRemove: targets => targets.forEach(message => setPendingDelete(message.id)),
    onRestore: targets => targets.forEach(message => { clearPendingDelete(message.id); clearDeleteGuard(message.id); }),
    commit: async (targets) => {
      await api.bulkDelete(conversationActionIds(targets));
      targets.forEach(message => setCompletedDelete(message.id));
    },
    notification: {
      title: t('messageList.deleted.conversationTitle'),
      body: t('messageList.deleted.body'),
      failTitle: t('messageList.deleted.failTitle'),
      failBody: t('messageList.deleted.failBody'),
    },
  });
}

export function moveThread(messages, folder, { t, addNotification, fetchThread, anchorId, accountId, beforeRemove }) {
  return runThreadAction({
    messages: takenCopies(messages, anchorId, accountId),
    addNotification,
    beforeRemove,
    resolve: sparingDrafts(liveThread(fetchThread), anchorId, accountId),
    commit: async (targets) => {
      await api.bulkMove(conversationActionIds(targets), folder);
      // Recorded per account, since a thread can span several.
      const seen = new Set();
      targets.forEach(message => {
        if (seen.has(message.account_id)) return;
        seen.add(message.account_id);
        useStore.getState().recordRecentFolder({ accountId: message.account_id, path: folder });
      });
    },
    notification: {
      title: t('message.moved.conversationTitle'),
      body: folder,
      failTitle: t('message.moved.failTitle'),
      failBody: t('message.moved.failBody'),
    },
  });
}

// Reporting spam acts on the correspondent's messages only. Sweeping the reader's own
// replies into the spam folder would train the filter on their own address.
export function spamThread(messages, { t, addNotification, accounts = [], fetchThread, accountId, beforeRemove }) {
  const visible = conversationSpamTargets(inAccount(messages, accountId), accounts);
  const resolveLive = liveThread(fetchThread);
  return runThreadAction({
    messages: visible,
    addNotification,
    beforeRemove,
    // Re-apply the same exclusion to whatever the server returns, so a reply sent during
    // the undo window is not reported as spam either.
    resolve: resolveLive ? async (targets) => conversationSpamTargets(inAccount(await resolveLive(targets), accountId), accounts) : null,
    commit: async (list) => { await Promise.all(list.map(message => api.markSpam(message.id))); },
    notification: {
      title: t('spam.conversationMovedToSpam'),
      body: subjectOf(visible, t),
      failTitle: t('spam.failTitle'),
      failBody: t('spam.failBody'),
    },
  });
}

// Snooze takes the newest inbox message rather than the thread: the others are already
// filed or sent, and re-delivering them would duplicate the conversation on return.
export function snoozeThread(messages, until, { t, addNotification, accountId, beforeRemove }) {
  const target = newestSnoozeTarget(inAccount(messages, accountId));
  if (!target) return false;
  return runThreadAction({
    messages: [target],
    addNotification,
    beforeRemove,
    commit: async (list) => { await api.snoozeMessage(list[0].id, until); },
    notification: {
      title: t('message.snoozed.conversationTitle'),
      body: subjectOf([target], t),
      failTitle: t('message.snoozed.failTitle'),
      failBody: t('message.snoozed.failBody'),
    },
  });
}
