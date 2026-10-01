import { clearGtdRailSelection, beginGtdClassification, endGtdClassification } from './gtdHotkeys.js';

export async function classifyWithUndo(messageId, state, {
  api,
  store,
  t,
  message,
}) {
  if (!beginGtdClassification(messageId)) return null;
  const currentStore = () => store.getState ? store.getState() : store;
  // List and rail payloads name the same server thread differently.
  const undoScope = {
    messageId, accountId: message?.account_id,
    threadKey: message?.thread_key ?? message?.thread_id,
  };
  const dismissThreadUndo = () => currentStore().dismissUndoNotifications(notification => {
    const previous = notification.gtdUndoScope;
    return notification.pluginId === 'gtd' && previous && (
      previous.messageId === messageId || (
        undoScope.accountId && undoScope.threadKey
        && previous.accountId === undoScope.accountId && previous.threadKey === undoScope.threadKey
      )
    );
  });
  const clearSourceSelection = () => {
    const current = currentStore();
    if (current.selectedMessageId === messageId) current.setSelectedMessage(null);
    clearGtdRailSelection(messageId);
  };
  try {
    const result = await api.gtdClassify(messageId, state);
    const current = currentStore();
    current.scheduleGtdSectionsFetch();
    if (result?.switched) dismissThreadUndo();
    if (result?.sourceRemoved) {
      current.removeMessage(messageId);
      clearSourceSelection();
    }

    const notification = {
      pluginId: 'gtd',
      title: t('gtd.classified'),
      body: t(`gtd.state.${state}`),
    };

    if (result?.applied && result.undoToken) {
      notification.gtdUndoScope = undoScope;
      let consumed = false;
      notification.onUndo = async () => {
        if (consumed) return false;
        consumed = true;
        try {
          await api.gtdUndoClassify(result.undoToken);
          currentStore().scheduleGtdSectionsFetch();
          return true;
        } catch (err) {
          console.error('GTD classification undo failed:', err);
          currentStore().addNotification({
            pluginId: 'gtd',
            type: 'error',
            title: t('gtd.undoFailed'),
            body: t(`gtd.state.${state}`),
          });
          return false;
        }
      };
    }

    currentStore().addNotification(notification);
    return result;
  } catch (err) {
    console.error('GTD classify failed:', err);
    // API errors contain only a message, so even a clean rejection cannot be
    // distinguished from an uncertain mutation. End this thread's older GTD Undo.
    dismissThreadUndo();
    currentStore().scheduleGtdSectionsFetch();
    clearSourceSelection();
    currentStore().addNotification({
      pluginId: 'gtd',
      type: 'error',
      title: t('gtd.classifyFailed'),
      body: t(`gtd.state.${state}`),
    });
    return null;
  } finally {
    endGtdClassification(messageId);
  }
}
