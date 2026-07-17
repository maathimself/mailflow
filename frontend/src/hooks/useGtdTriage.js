import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';
import {
  openDeepLinkMessage, collectThreadReadIds, openGtdThreadWithAutoRead,
  classifyThread, unclassifyThread,
} from '../utils/gtd.js';
import { openReplyFromMessage, openForwardFromMessage } from '../utils/composeFromMessage.js';
import { resolveContextMenuMessage } from '../utils/contextMenuPolicy.js';

// One pending delayed auto-read across ALL GTD surfaces (module scope, not per hook
// instance): the sidebar and the tab browse list are mounted together in desktop row
// layouts, and opening a row on either surface must supersede a pending read the other
// scheduled — per-instance timers would let a stale timer mark a left-behind thread
// read, or double-fire bulkRead when the same thread is opened from both. `owner`
// remembers which hook instance scheduled the timer so an unmounting surface cancels
// only its own pending read, never one the still-mounted surface legitimately owns.
let autoMarkRead = { timer: null, identity: null, owner: null };

// Drop the pending delay-mode auto-read outright (handle + owner identity). openRow uses
// this: a fresh open — from ANY GTD surface — genuinely supersedes the prior row's
// pending read.
const cancelAutoMarkRead = () => {
  clearTimeout(autoMarkRead.timer);
  autoMarkRead = { timer: null, identity: null, owner: null };
};

// Cancel the pending auto-read ONLY when it was scheduled for `thread`: an explicit
// mark-unread or a done/delete/move on the just-opened row must not let a stale
// (is_read=false) readThread later revert it or fire a spurious bulkRead — but the same
// action on a DIFFERENT visible row (rapid triage) must leave that other row's
// still-legitimate pending read running.
const cancelAutoMarkReadFor = (thread) => {
  const identity = thread.message_id || thread.id;
  if (autoMarkRead.identity != null && autoMarkRead.identity === identity) {
    cancelAutoMarkRead();
  }
};

// The triage engine behind every GTD row surface: the right-sidebar section rows and
// the tab browse list that replaces the inbox while a GTD pill is active. Each surface
// mounts its own instance (own context-menu state) and wires the returned
// `rowActions`/`openRow` into its rows plus `contextMenu`/`handleGtdAction` into a
// ContextMenu portal — so both surfaces triage identically without either depending on
// the other being mounted.
//
// The actions are standalone equivalents of MessageList's closures, deliberately
// lighter: call the api and let the read/star fan-out + the gtd refetch reconcile,
// with only the cheap optimistic touches (is_read flip, section-row removal) applied
// here.
export function useGtdTriage() {
  const { t } = useTranslation();
  const setThreadMessages = useStore(s => s.setThreadMessages);
  const setSelectedMessage = useStore(s => s.setSelectedMessage);
  const scheduleGtdSectionsFetch = useStore(s => s.scheduleGtdSectionsFetch);
  const removeGtdThread = useStore(s => s.removeGtdThread);
  const markGtdThreadRead = useStore(s => s.markGtdThreadRead);
  const markGtdThreadStarred = useStore(s => s.markGtdThreadStarred);
  const addNotification = useStore(s => s.addNotification);
  const accounts = useStore(s => s.accounts);
  const openCompose = useStore(s => s.openCompose);

  // Right-click / move-picker menu for a GTD row. Carries the row's doneStates so the
  // menu's "done" and "move" stay section-scoped (the row knows which section it's in).
  const [contextMenu, setContextMenu] = useState(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Cancel only a pending read THIS instance scheduled (owner check): tearing down
      // one surface must not kill a read the other, still-mounted surface owns.
      if (autoMarkRead.owner === mountedRef) cancelAutoMarkRead();
    };
  }, []);

  // The GTD "done" action: strip this row's label(s) (`states`), mark read, archive.
  // Optimistically drop the row so it feels instant; the WS refetch reconciles. On
  // failure, restore via a refetch and surface a notification (no undo toast).
  const doneRow = async (thread, states) => {
    cancelAutoMarkReadFor(thread);
    removeGtdThread(thread.message_id || thread.id, states);
    try {
      const res = await api.gtdDone(thread.id, states);
      // Labels stripped but the archive step failed: the optimistic removal is still
      // correct (the row left its GTD sections), yet the email remains in the inbox —
      // tell the user so the missing archive isn't a silent surprise.
      if (res?.archiveFailed) {
        addNotification({ title: t('gtd.doneArchiveFailed'), body: thread.subject || t('common.noSubject') });
      }
      scheduleGtdSectionsFetch();
    } catch (err) {
      console.error('GTD done failed:', err.message);
      addNotification({ title: t('gtd.doneFailed'), body: thread.subject || t('common.noSubject') });
      scheduleGtdSectionsFetch();
    }
  };

  // Read: flip is_read on the section thread instantly. Section rows carry thread-level
  // unread, so marking READ acts on every message in the thread (collectThreadReadIds —
  // the same-message_id fan-out alone can't reach an INBOX-only sibling reply), while
  // marking UNREAD needs only the head copy. On failure, flip back.
  const setRead = async (thread, read) => {
    // Explicit mark-unread wins over a pending auto-read: cancel the timer before the no-op
    // guard so it can't later flip this just-opened thread back to read.
    if (!read) cancelAutoMarkReadFor(thread);
    if (!!thread.is_read === read) return;
    const identity = thread.message_id || thread.id;
    markGtdThreadRead(identity, read);
    try {
      await api.bulkRead(await collectThreadReadIds(thread, read, api.getThread), read);
      // Belt-and-braces under the WS read fan-out: reconcile the sidebar counts (the
      // debounce coalesces this with any gtd_sections_updated the mark triggers).
      scheduleGtdSectionsFetch();
    } catch (err) {
      console.error('GTD read toggle failed:', err.message);
      markGtdThreadRead(identity, !read);
    }
  };

  const openRow = (thread) => {
    cancelAutoMarkRead();
    const identity = thread.message_id || thread.id;
    return openGtdThreadWithAutoRead(thread, {
      openThread: () => openDeepLinkMessage(thread.id, {
        getMessage: api.getMessage,
        getThread: api.getThread,
        setThreadMessages,
        setSelectedMessage,
        thread,
        onMiss: scheduleGtdSectionsFetch,
      }),
      isCancelled: () => !mountedRef.current,
      getPreferences: () => useStore.getState(),
      readThread: setRead,
      publishTimer: timerHandle => {
        // Only a scheduled (delay-mode) timer has an identity/owner to guard;
        // immediate/manual publish null. mountedRef doubles as the per-instance
        // owner token (stable for the instance's lifetime).
        autoMarkRead = timerHandle == null
          ? { timer: null, identity: null, owner: null }
          : { timer: timerHandle, identity, owner: mountedRef };
      },
    });
  };

  // Star: flip is_starred on the section thread instantly (identity-wide, so a merged
  // Waiting row stays consistent across watch+delegated); the star fans out to sibling
  // copies server-side. On failure, flip back.
  const toggleStar = async (thread) => {
    const identity = thread.message_id || thread.id;
    const next = !thread.is_starred;
    markGtdThreadStarred(identity, next);
    try {
      await api.markStarred(thread.id, next);
    } catch (err) {
      console.error('GTD star toggle failed:', err.message);
      markGtdThreadStarred(identity, !next);
    }
  };

  // Delete this row's copy (the label-folder message). Optimistically drop the row from
  // its section(s); the refetch reconciles (and, on failure, restores it) — no undo timer.
  const deleteRow = (thread, states) => {
    cancelAutoMarkReadFor(thread);
    removeGtdThread(thread.message_id || thread.id, states);
    api.deleteMessage(thread.id)
      .then(scheduleGtdSectionsFetch)
      .catch(err => {
        console.error('GTD delete failed:', err.message);
        addNotification({ title: t('messageList.deleted.failTitle'), body: thread.subject || t('common.noSubject') });
        scheduleGtdSectionsFetch();
      });
  };

  // Move this row's copy to another folder — it leaves its GTD label folder, so drop it
  // from its section(s) optimistically; the refetch reconciles.
  const moveRow = (thread, states, folder) => {
    if (!folder) return;
    cancelAutoMarkReadFor(thread);
    removeGtdThread(thread.message_id || thread.id, states);
    api.bulkMove([thread.id], folder)
      .then(() => {
        useStore.getState().recordRecentFolder({ accountId: thread.account_id, path: folder });
        scheduleGtdSectionsFetch();
      })
      .catch(err => {
        console.error('GTD move failed:', err.message);
        addNotification({ title: t('message.moved.failTitle'), body: t('message.moved.failBody') });
        scheduleGtdSectionsFetch();
      });
  };

  // Classify (add a state label) / remove (strip one). The message stays put, so just
  // poke the sidebar store to reconverge — mirrors MessageList's context-menu handlers.
  const classifyRow = (thread, state) => classifyThread(thread.id, state, {
    gtdClassify: api.gtdClassify, addNotification, scheduleGtdSectionsFetch, t,
  });

  const removeStateRow = (thread, state) => unclassifyThread(thread.id, state, {
    gtdUnclassify: api.gtdUnclassify, addNotification, scheduleGtdSectionsFetch, t,
  });

  // ContextMenu's onAction, routed to the primitives above. GTD section heads are
  // intentionally compact, so compose actions hydrate the full message first.
  const handleGtdAction = async (action, menu, data) => {
    const thread = menu.message;
    switch (action) {
      case 'open': openRow(thread); break;
      case 'markRead': setRead(thread, true); break;
      case 'markUnread': setRead(thread, false); break;
      case 'toggleStar': toggleStar(thread); break;
      case 'moveTo': moveRow(thread, menu.doneStates, data); break;
      case 'gtdClassify': classifyRow(thread, data); break;
      case 'gtdRemove': removeStateRow(thread, data); break;
      case 'gtdDone': doneRow(thread, menu.doneStates); break;
      case 'delete': deleteRow(thread, menu.doneStates); break;
      case 'reply':
      case 'replyAll':
      case 'forward': {
        try {
          const message = await resolveContextMenuMessage(thread, 'gtdSidebar', api.resolveMessage);
          if (action === 'forward') {
            await openForwardFromMessage(message, {
              openCompose,
              getMessageBody: api.getMessageBody,
            });
          } else {
            await openReplyFromMessage(message, {
              accounts,
              openCompose,
              getMessageBody: api.getMessageBody,
              replyAll: action === 'replyAll',
            });
          }
        } catch (err) {
          console.error('GTD compose prefill failed:', err.message);
          scheduleGtdSectionsFetch();
        }
        break;
      }
      case 'createRuleFromMessage': {
        const store = useStore.getState();
        store.setRulesPreFill({ fromEmail: thread.from_email, fromName: thread.from_name });
        store.setAdminTab('rules');
        store.setShowAdmin(true);
        break;
      }
      case 'addToBlockList':
        if (thread.from_email) {
          api.addToBlockList(thread.from_email)
            .then(() => addNotification({ title: t('blockList.blocked'), body: thread.from_email }))
            .catch(() => addNotification({ title: t('blockList.errorAdd'), body: thread.from_email }));
        }
        break;
      default: break;
    }
  };

  // Bundle passed down to each row for its hover cluster + right-click menu.
  const rowActions = { setRead, toggleStar, deleteRow, done: doneRow, openMenu: setContextMenu };

  return { contextMenu, setContextMenu, handleGtdAction, openRow, rowActions };
}
