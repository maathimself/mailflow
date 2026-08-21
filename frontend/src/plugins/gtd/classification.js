export async function classifyWithUndo(messageId, state, {
  api,
  store,
  t,
}) {
  try {
    const result = await api.gtdClassify(messageId, state);
    store.scheduleGtdSectionsFetch();

    const notification = {
      pluginId: 'gtd',
      title: t('gtd.classified'),
      body: t(`gtd.state.${state}`),
    };

    if (result?.applied && result.undoToken) {
      let consumed = false;
      notification.onUndo = async () => {
        if (consumed) return false;
        consumed = true;
        try {
          await api.gtdUndoClassify(result.undoToken);
          store.scheduleGtdSectionsFetch();
          return true;
        } catch (err) {
          console.error('GTD classification undo failed:', err);
          store.addNotification({
            pluginId: 'gtd',
            type: 'error',
            title: t('gtd.undoFailed'),
            body: t(`gtd.state.${state}`),
          });
          return false;
        }
      };
    }

    store.addNotification(notification);
    return result;
  } catch (err) {
    console.error('GTD classify failed:', err);
    store.addNotification({
      pluginId: 'gtd',
      type: 'error',
      title: t('gtd.classifyFailed'),
      body: t(`gtd.state.${state}`),
    });
    return null;
  }
}

export function undoLatestGtdNotification(notifications, removeNotification) {
  const notification = notifications.find(item => (
    item.pluginId === 'gtd' && typeof item.onUndo === 'function'
  ));
  if (!notification) return false;

  removeNotification(notification.id);
  void notification.onUndo();
  return true;
}
