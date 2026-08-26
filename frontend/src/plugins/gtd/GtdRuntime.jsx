import { useEffect, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../../store/index.js';
import { gtdActiveForContext } from '../../utils/gtd.js';
import { api } from '../../utils/api.js';
import { shortcutBus } from '../../utils/shortcutBus.js';
import { classifyWithUndo, undoLatestGtdNotification } from './classification.js';
import {
  getGtdMetadataRefreshGeneration,
  selectGtdMetadataTargets,
  startGtdMetadataFetch,
  subscribeGtdMetadataRefresh,
} from './metadataStore.js';
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
  const selectedFolder = useStore(s => s.selectedFolder);
  const fetchGtdSections = useStore(s => s.fetchGtdSections);
  const messages = useStore(s => s.messages);
  const searchResults = useStore(s => s.searchResults);
  const searchQuery = useStore(s => s.searchQuery);
  const selectedMessageId = useStore(s => s.selectedMessageId);
  const threadMessages = useStore(s => s.threadMessages);
  const messageWindows = useStore(s => s.messageWindows);
  const gtdSections = useStore(s => s.gtdSections);
  const delegation = useSyncExternalStore(subscribeDelegation, getDelegationSnapshot, getDelegationSnapshot);

  const gtdActive = gtdActiveForContext(accounts, selectedAccountId, true);
  // Also key on the set of GTD-enabled accounts so enabling a second account refetches the unified
  // sections — gtdActive alone stays true and wouldn't retrigger the one→two flip.
  const gtdEnabledKey = accounts.filter(a => a.gtd_enabled).map(a => a.id).sort().join(',');
  useEffect(() => {
    if (gtdActive) fetchGtdSections();
  }, [gtdActive, selectedAccountId, gtdEnabledKey, fetchGtdSections]);

  const sectionMessages = Object.values(gtdSections || {}).flatMap(section => section?.threads || []);
  const selectedMessage = findDelegationTarget({
    selectedMessageId, searchQuery, messages, searchResults, threadMessages,
  });
  const windowMessages = findMessageWindowTargets({
    messageWindows, searchQuery, messages, searchResults, threadMessages,
  });
  const metadataMessages = selectGtdMetadataTargets({
    accounts,
    selectedFolder,
    searchQuery,
    messages,
    searchResults,
    sectionMessages,
    selectedMessage,
    windowMessages,
  });
  const metadataKey = metadataMessages.map(message => `${message.account_id}:${message.id}`).join(',');
  const metadataConfigKey = accounts
    .filter(account => account.gtd_enabled)
    .map(account => `${account.id}:${JSON.stringify(account.gtd_folders || {})}`)
    .sort()
    .join(',');
  const metadataRefreshGeneration = useSyncExternalStore(
    subscribeGtdMetadataRefresh,
    getGtdMetadataRefreshGeneration,
  );
  useEffect(() => {
    if (!gtdActive) return;
    return startGtdMetadataFetch(metadataMessages, { api });
  }, [gtdActive, metadataKey, metadataConfigKey, metadataRefreshGeneration]); // eslint-disable-line react-hooks/exhaustive-deps

  // GTD classify keys (t/w/d): COPY the selected message into a state's label folder. Silent no-op
  // unless the selected message's account has GTD enabled. Only wired while GTD is activated (this
  // runtime mounts only then) — replaces the former inline handling in MessageList.
  useEffect(() => {
    const classifySelected = (gtdState) => () => {
      const storeState = useStore.getState();
      const { accounts: accts, scheduleGtdSectionsFetch, addNotification } = storeState;
      const msg = findDelegationTarget(storeState);
      if (!msg) return;
      if (!accts.find(a => a.id === msg.account_id)?.gtd_enabled) return;
      void classifyWithUndo(msg, gtdState, {
        api,
        store: { addNotification, scheduleGtdSectionsFetch },
        t,
      });
    };
    const onTodo = classifySelected('todo');
    const onWatch = classifySelected('watch');
    const onDelegated = classifySelected('delegated');
    const onUndo = () => {
      const { notifications, removeNotification } = useStore.getState();
      undoLatestGtdNotification(notifications, removeNotification);
    };
    const onDelegateContact = () => {
      const state = useStore.getState();
      const msg = findDelegationTarget(state);
      if (!msg || !state.accounts.find(account => account.id === msg.account_id)?.gtd_enabled) return;
      void runDelegation([msg.id], {
        api,
        store: {
          addNotification: state.addNotification,
          scheduleGtdSectionsFetch: state.scheduleGtdSectionsFetch,
        },
        t,
      });
    };
    shortcutBus.on('gtdTodo', onTodo);
    shortcutBus.on('gtdWatch', onWatch);
    shortcutBus.on('gtdDelegated', onDelegated);
    shortcutBus.on('gtdUndo', onUndo);
    shortcutBus.on('gtdDelegateContact', onDelegateContact);
    return () => {
      shortcutBus.off('gtdTodo', onTodo);
      shortcutBus.off('gtdWatch', onWatch);
      shortcutBus.off('gtdDelegated', onDelegated);
      shortcutBus.off('gtdUndo', onUndo);
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
