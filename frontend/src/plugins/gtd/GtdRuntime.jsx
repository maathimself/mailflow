import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../../store/index.js';
import { gtdActiveForContext } from '../../utils/gtd.js';
import { api } from '../../utils/api.js';
import { shortcutBus } from '../../utils/shortcutBus.js';
import { classifyWithUndo } from '../../utils/gtdClassification.js';
import { runGtdHotkey } from '../../utils/gtdHotkeys.js';
import { doneInboxGtdMessage } from './inboxDone.js';
import { doneGtdRow } from '../../utils/gtdDone.js';
import { advanceSelectionAfterRemoval } from '../../utils/listSelection.js';
import { cancelAutoMarkReadFor } from '../../hooks/useGtdTriage.js';
import { collectGtdMetadataMessages } from './metadataPool.js';
import { clearGtdMetadata, getGtdMetadataRefreshGeneration, subscribeGtdMetadataRefresh, startGtdMetadataFetch, tickGtdMetadataClock } from './metadataStore.js';

// GTD's headless runtime: the single owner of the GTD sections fetch. Reloads whenever the context
// (unified vs a single account) changes and GTD is active there; both the rail and the tab list read
// the resulting store slice, and live updates arrive via the WS handler (plugins/events). Mounted by
// <PluginRuntime/> only while GTD is activated, so activation is already gated — pass `true` here.
export default function GtdRuntime() {
  const { t } = useTranslation();
  const accounts = useStore(s => s.accounts);
  const selectedAccountId = useStore(s => s.selectedAccountId);
  const fetchGtdSections = useStore(s => s.fetchGtdSections);
  const userId = useStore(s => s.user?.id);
  const selectedFolder = useStore(s => s.selectedFolder);
  const activeGtdTab = useStore(s => s.activeGtdTab);
  const messages = useStore(s => s.messages);
  const searchResults = useStore(s => s.searchResults);
  const searchQuery = useStore(s => s.searchQuery);
  const selectedMessageId = useStore(s => s.selectedMessageId);
  const threadMessages = useStore(s => s.threadMessages);
  const messageWindows = useStore(s => s.messageWindows);
  const metadataRefreshGeneration = useSyncExternalStore(
    subscribeGtdMetadataRefresh, getGtdMetadataRefreshGeneration,
  );
  // Read-state and preview updates replace row objects without changing label identity. Keep the
  // fetch pool stable across that churn; account/config changes and explicit invalidation still fetch.
  const metadataAccountsKey = JSON.stringify(accounts.filter(account => account.gtd_enabled)
    .map(account => [account.id, account.gtd_folders]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  const metadataRowsKey = JSON.stringify(collectGtdMetadataMessages({
    user: { id: userId }, accounts, selectedFolder, searchQuery, activeGtdTab,
    messages, searchResults, selectedMessageId, threadMessages, messageWindows,
  }));
  const metadataMessages = useMemo(() => JSON.parse(metadataRowsKey), [metadataRowsKey]);
  const previousMetadataContext = useRef(null);

  useEffect(() => {
    clearGtdMetadata();
    const unsubscribe = useStore.subscribe((state, previous) => {
      if (state.user?.id !== previous.user?.id
        || state.enabledPlugins.includes('gtd') !== previous.enabledPlugins.includes('gtd')) clearGtdMetadata();
    });
    const tick = () => tickGtdMetadataClock();
    tick();
    const timer = setInterval(tick, 60000);
    window.addEventListener('focus', tick);
    return () => {
      unsubscribe();
      clearInterval(timer);
      window.removeEventListener('focus', tick);
      clearGtdMetadata();
      previousMetadataContext.current = null;
    };
  }, []);

  useEffect(() => {
    const previous = previousMetadataContext.current;
    previousMetadataContext.current = { userId, metadataAccountsKey, metadataRefreshGeneration };
    // Initial loads and authoritative invalidations stay immediate; coalesce navigation that
    // changes membership so an expanded-thread keystroke does not refetch the whole list.
    if (!previous || previous.userId !== userId || previous.metadataAccountsKey !== metadataAccountsKey
      || previous.metadataRefreshGeneration !== metadataRefreshGeneration) {
      return startGtdMetadataFetch(metadataMessages, { api });
    }
    let cancelFetch;
    const timer = setTimeout(() => { cancelFetch = startGtdMetadataFetch(metadataMessages, { api }); }, 200);
    return () => { clearTimeout(timer); cancelFetch?.(); };
  }, [metadataMessages, metadataAccountsKey, userId, metadataRefreshGeneration]);

  const gtdActive = gtdActiveForContext(accounts, selectedAccountId, true);
  // Also key on the set of GTD-enabled accounts so enabling a second account refetches the unified
  // sections — gtdActive alone stays true and wouldn't retrigger the one→two flip.
  const gtdEnabledKey = accounts.filter(a => a.gtd_enabled).map(a => a.id).sort().join(',');
  useEffect(() => {
    if (gtdActive) fetchGtdSections();
  }, [gtdActive, selectedAccountId, gtdEnabledKey, fetchGtdSections]);

  // GTD classify keys: COPY the selected message into a state's label folder. Silent no-op
  // unless the selected message's account has GTD enabled. Only wired while GTD is activated (this
  // runtime mounts only then) — replaces the former inline handling in MessageList.
  useEffect(() => {
    const handleAction = action => () => {
      const st = useStore.getState();
      void runGtdHotkey(action, st, {
        classify: (id, state, message) => classifyWithUndo(id, state, {
          api, store: useStore, t, message,
        }),
        doneMain: message => doneInboxGtdMessage(message, {
          advance: advanceSelectionAfterRemoval, remove: st.removeMessage,
          restore: st.restoreMessages, decrementUnread: st.decrementUnread,
          incrementUnread: st.incrementUnread, gtdDone: api.gtdDone,
          notify: st.addNotification, t,
        }),
        doneRail: (thread, states) => {
          cancelAutoMarkReadFor(thread);
          return doneGtdRow(thread, states, {
            gtdDone: api.gtdDone, removeGtdThread: st.removeGtdThread,
            restoreGtdThread: st.restoreGtdThread, addNotification: st.addNotification,
            scheduleGtdSectionsFetch: st.scheduleGtdSectionsFetch, t,
          });
        },
      });
    };
    const onTodo = handleAction('gtdTodo');
    const onWatch = handleAction('gtdWatch');
    const onDelegated = handleAction('gtdDelegated');
    const onReference = handleAction('gtdReference');
    const onSomeday = handleAction('gtdSomeday');
    const onDone = handleAction('gtdDone');
    shortcutBus.on('gtdTodo', onTodo);
    shortcutBus.on('gtdWatch', onWatch);
    shortcutBus.on('gtdDelegated', onDelegated);
    shortcutBus.on('gtdReference', onReference);
    shortcutBus.on('gtdSomeday', onSomeday);
    shortcutBus.on('gtdDone', onDone);
    return () => {
      shortcutBus.off('gtdTodo', onTodo);
      shortcutBus.off('gtdWatch', onWatch);
      shortcutBus.off('gtdDelegated', onDelegated);
      shortcutBus.off('gtdReference', onReference);
      shortcutBus.off('gtdSomeday', onSomeday);
      shortcutBus.off('gtdDone', onDone);
    };
  }, [t]);

  return null;
}
