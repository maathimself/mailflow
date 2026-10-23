import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../../store/index.js';
import { gtdActiveForContext } from '../../utils/gtd.js';
import { api } from '../../utils/api.js';
import { shortcutBus } from '../../utils/shortcutBus.js';
import { classifyWithUndo } from '../../utils/gtdClassification.js';
import { resolveGtdHotkeyTarget, runGtdHotkey } from '../../utils/gtdHotkeys.js';
import { doneInboxGtdMessage } from './inboxDone.js';
import { doneGtdRow } from '../../utils/gtdDone.js';
import { advanceSelectionAfterRemoval } from '../../utils/listSelection.js';
import { cancelAutoMarkReadFor } from '../../hooks/useGtdTriage.js';
import { shouldShowInboxGtdMetadata } from './indicators.js';
import { clearGtdMetadata, getGtdMetadataRefreshGeneration, selectGtdMetadataTargets, subscribeGtdMetadataRefresh, startGtdMetadataFetch, tickGtdMetadataClock } from './metadataStore.js';
import DelegateContactPicker from './DelegateContactPicker.jsx';
import { closeDelegation, getDelegationSnapshot, subscribeDelegation } from './delegationController.js';
import { findDelegationTarget, findMessageWindowTargets, runDelegation, submitOpenDelegation } from './delegation.js';

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
  const gtdSections = useStore(s => s.gtdSections);
  const delegation = useSyncExternalStore(subscribeDelegation, getDelegationSnapshot, getDelegationSnapshot);
  const metadataRefreshGeneration = useSyncExternalStore(
    subscribeGtdMetadataRefresh, getGtdMetadataRefreshGeneration,
  );
  // Read-state and preview updates replace row objects without changing label identity. Keep the
  // fetch pool stable across that churn; account/config changes and explicit invalidation still fetch.
  const metadataAccountsKey = JSON.stringify(accounts.filter(account => account.gtd_enabled)
    .map(account => [account.id, account.gtd_folders]));
  // Delegate pills also render in the GTD rail, the reading pane and message windows, so their
  // messages join the inbox rows in the fetch pool.
  const showRowMetadata = shouldShowInboxGtdMetadata({ selectedFolder, searchQuery, activeGtdTab });
  const metadataRowsKey = JSON.stringify(selectGtdMetadataTargets({
    rows: showRowMetadata ? (searchQuery.trim() ? searchResults : messages) : [],
    sectionMessages: Object.values(gtdSections || {}).flatMap(section => section?.threads || []),
    selectedMessage: findDelegationTarget({ selectedMessageId, searchQuery, messages, searchResults, threadMessages }),
    windowMessages: findMessageWindowTargets({ messageWindows, searchQuery, messages, searchResults, threadMessages }),
  }).map(message => ({
    id: message.id, account_id: message.account_id,
    thread_key: message.thread_key ?? message.thread_id, message_id: message.message_id,
  })));
  const metadataMessages = useMemo(() => {
    if (!userId) return [];
    const enabled = new Set(JSON.parse(metadataAccountsKey).map(([id]) => id));
    return JSON.parse(metadataRowsKey).filter(message => enabled.has(message.account_id));
  }, [userId, metadataAccountsKey, metadataRowsKey]);

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
    };
  }, []);

  useEffect(() => startGtdMetadataFetch(metadataMessages, { api }), [metadataMessages, metadataRefreshGeneration]);

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
    const onDelegateContact = () => {
      const state = useStore.getState();
      // Same target as the other GTD keys, so a rail-only selection works too.
      const target = resolveGtdHotkeyTarget(state);
      if (!target) return;
      void runDelegation([target.message.id], {
        api,
        store: {
          addNotification: state.addNotification,
          scheduleGtdSectionsFetch: state.scheduleGtdSectionsFetch,
        },
        t,
      });
    };
    shortcutBus.on('gtdDelegateContact', onDelegateContact);
    return () => {
      shortcutBus.off('gtdTodo', onTodo);
      shortcutBus.off('gtdWatch', onWatch);
      shortcutBus.off('gtdDelegated', onDelegated);
      shortcutBus.off('gtdReference', onReference);
      shortcutBus.off('gtdSomeday', onSomeday);
      shortcutBus.off('gtdDone', onDone);
      shortcutBus.off('gtdDelegateContact', onDelegateContact);
    };
  }, [t]);

  if (delegation.phase !== 'picker' && delegation.phase !== 'submitting') return null;
  return (
    <DelegateContactPicker
      targetCount={delegation.messageIds.length}
      initialError={delegation.error}
      submitting={delegation.phase === 'submitting'}
      onCancel={closeDelegation}
      onSelect={contactId => void submitOpenDelegation(contactId, {
        api,
        store: {
          addNotification: useStore.getState().addNotification,
          scheduleGtdSectionsFetch: useStore.getState().scheduleGtdSectionsFetch,
        },
        t,
      })}
    />
  );
}
