import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../../store/index.js';
import { gtdActiveForContext } from '../../utils/gtd.js';
import { api } from '../../utils/api.js';
import { shortcutBus } from '../../utils/shortcutBus.js';
import { classifyWithUndo, undoLatestGtdNotification } from './classification.js';

// GTD's headless runtime: the single owner of the GTD sections fetch. Reloads whenever the context
// (unified vs a single account) changes and GTD is active there; both the rail and the tab list read
// the resulting store slice, and live updates arrive via the WS handler (plugins/events). Mounted by
// <PluginRuntime/> only while GTD is activated, so activation is already gated — pass `true` here.
export default function GtdRuntime() {
  const { t } = useTranslation();
  const accounts = useStore(s => s.accounts);
  const selectedAccountId = useStore(s => s.selectedAccountId);
  const fetchGtdSections = useStore(s => s.fetchGtdSections);

  const gtdActive = gtdActiveForContext(accounts, selectedAccountId, true);
  // Also key on the set of GTD-enabled accounts so enabling a second account refetches the unified
  // sections — gtdActive alone stays true and wouldn't retrigger the one→two flip.
  const gtdEnabledKey = accounts.filter(a => a.gtd_enabled).map(a => a.id).sort().join(',');
  useEffect(() => {
    if (gtdActive) fetchGtdSections();
  }, [gtdActive, selectedAccountId, gtdEnabledKey, fetchGtdSections]);

  // GTD classify keys (t/w/d): COPY the selected message into a state's label folder. Silent no-op
  // unless the selected message's account has GTD enabled. Only wired while GTD is activated (this
  // runtime mounts only then) — replaces the former inline handling in MessageList.
  useEffect(() => {
    const classifySelected = (state) => () => {
      const { messages, searchResults, searchQuery, selectedMessageId, accounts: accts, scheduleGtdSectionsFetch, addNotification } = useStore.getState();
      if (!selectedMessageId) return;
      const pool = searchQuery.trim() ? searchResults : messages;
      const msg = pool.find(m => m.id === selectedMessageId);
      if (!msg) return;
      if (!accts.find(a => a.id === msg.account_id)?.gtd_enabled) return;
      void classifyWithUndo(msg.id, state, {
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
    shortcutBus.on('gtdTodo', onTodo);
    shortcutBus.on('gtdWatch', onWatch);
    shortcutBus.on('gtdDelegated', onDelegated);
    shortcutBus.on('gtdUndo', onUndo);
    return () => {
      shortcutBus.off('gtdTodo', onTodo);
      shortcutBus.off('gtdWatch', onWatch);
      shortcutBus.off('gtdDelegated', onDelegated);
      shortcutBus.off('gtdUndo', onUndo);
    };
  }, [t]);

  return null;
}
