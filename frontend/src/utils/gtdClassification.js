import { gtdRowSession, gtdRowLabeled, gtdRowChanged, gtdRowsSettled } from './gtdRowEvents.js';
import { clearGtdRailSelection, beginGtdClassification, endGtdClassification } from './gtdHotkeys.js';

function storeAccessor(store) {
  return () => store.getState ? store.getState() : store;
}

// List and rail payloads name the same server thread differently.
function undoScopeFor(messageId, message) {
  return {
    messageId, accountId: message?.account_id,
    threadKey: message?.thread_key ?? message?.thread_id,
  };
}

function scopesOverlap(previous, undoScope) {
  return previous.messageId === undoScope.messageId || (
    undoScope.accountId && undoScope.threadKey
    && previous.accountId === undoScope.accountId && previous.threadKey === undoScope.threadKey
  );
}

// A bulk Undo carries one scope per tag it can undo and ends when any of those threads switches.
function dismissThreadUndo(currentStore, undoScope) {
  currentStore().dismissUndoNotifications(notification => {
    if (notification.pluginId !== 'gtd') return false;
    const scopes = notification.gtdUndoScopes
      || (notification.gtdUndoScope ? [notification.gtdUndoScope] : []);
    return scopes.some(previous => scopesOverlap(previous, undoScope));
  });
}

function clearSourceSelection(currentStore, messageId) {
  const current = currentStore();
  if (current.selectedMessageId === messageId) current.setSelectedMessage(null);
  clearGtdRailSelection(messageId);
}

export async function classifyWithUndo(messageId, state, {
  api,
  store,
  t,
  message,
}) {
  if (!beginGtdClassification(messageId)) return null;
  const metadataSession = gtdRowSession();
  const metadataMessage = message || messageId;
  const currentStore = storeAccessor(store);
  const undoScope = undoScopeFor(messageId, message);
  try {
    const result = await api.gtdClassify(messageId, state);
    const current = currentStore();
    if (result?.switched) gtdRowChanged(metadataMessage, metadataSession);
    else {
      gtdRowLabeled(metadataMessage, state, message?.date, metadataSession);
      gtdRowsSettled(metadataSession);
    }
    current.scheduleGtdSectionsFetch();
    if (result?.switched) dismissThreadUndo(currentStore, undoScope);
    if (result?.sourceRemoved) {
      current.removeMessage(messageId);
      clearSourceSelection(currentStore, messageId);
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
          gtdRowChanged(metadataMessage, metadataSession);
          currentStore().scheduleGtdSectionsFetch();
          return true;
        } catch (err) {
          gtdRowChanged(metadataMessage, metadataSession);
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
    gtdRowChanged(metadataMessage, metadataSession);
    console.error('GTD classify failed:', err);
    // API errors contain only a message, so even a clean rejection cannot be
    // distinguished from an uncertain mutation. End this thread's older GTD Undo.
    dismissThreadUndo(currentStore, undoScope);
    currentStore().scheduleGtdSectionsFetch();
    clearSourceSelection(currentStore, messageId);
    currentStore().addNotification({
      pluginId: 'gtd',
      type: 'error',
      title: t('gtd.classifyFailed'),
      // A switch whose old label row named another message: the new label is on, the old one is not.
      body: err?.changed ? t('gtd.labelChanged') : t(`gtd.state.${state}`),
    });
    return null;
  } finally {
    endGtdClassification(messageId);
  }
}

// Sequential so a bulk tag never floods the account's IMAP connection pool.
export async function classifyManyWithUndo(messages, state, { api, store, t }) {
  const seen = new Set();
  const unique = messages.filter(message => !seen.has(message.id) && seen.add(message.id));
  if (unique.length === 0) return { tagged: 0, total: 0 };
  const metadataSession = gtdRowSession();
  const currentStore = storeAccessor(store);
  const stateLabel = t(`gtd.state.${state}`);
  const undoTokens = [];
  const undoScopes = [];
  const undoMessages = [];
  let tagged = 0;
  let irreversible = false;

  for (const message of unique) {
    const messageId = message.id;
    if (!beginGtdClassification(messageId)) continue;
    const undoScope = undoScopeFor(messageId, message);
    try {
      const result = await api.gtdClassify(messageId, state);
      if (result?.switched) gtdRowChanged(message, metadataSession);
      else gtdRowLabeled(message, state, message.date, metadataSession);
      if (result?.switched) dismissThreadUndo(currentStore, undoScope);
      if (result?.sourceRemoved) {
        currentStore().removeMessage(messageId);
        clearSourceSelection(currentStore, messageId);
      }
      // An already-labelled message answers applied: false; it still ends in this state.
      tagged += 1;
      if (result?.applied && result.undoToken) {
        undoTokens.push(result.undoToken);
        undoScopes.push(undoScope);
        undoMessages.push(message);
      } else if (result?.applied || result?.switched) {
        irreversible = true;
      }
    } catch (err) {
      gtdRowChanged(message, metadataSession);
      console.error('GTD classify failed:', err);
      // Same uncertainty as the single path: the mutation may have happened.
      dismissThreadUndo(currentStore, undoScope);
      clearSourceSelection(currentStore, messageId);
    } finally {
      endGtdClassification(messageId);
    }
  }

  gtdRowsSettled(metadataSession);
  currentStore().scheduleGtdSectionsFetch();
  const total = unique.length;

  if (tagged === 0) {
    currentStore().addNotification({
      pluginId: 'gtd',
      type: 'error',
      title: t('gtd.classifyFailed'),
      body: stateLabel,
    });
    return { tagged, total };
  }

  const notification = {
    pluginId: 'gtd',
    title: tagged === total
      ? t('gtd.classifiedMany', { count: tagged, state: stateLabel })
      : t('gtd.classifiedSome', { count: tagged, total, state: stateLabel }),
  };

  // A switch, or a copy without a token, cannot be undone, so Undo would revert only part of the
  // selection while reading as if it reverted all of it. The single path shows no Undo then either.
  if (undoTokens.length > 0 && !irreversible) {
    notification.gtdUndoScopes = undoScopes;
    let consumed = false;
    notification.onUndo = async () => {
      if (consumed) return false;
      consumed = true;
      let failed = false;
      for (const token of [...undoTokens].reverse()) {
        try {
          await api.gtdUndoClassify(token);
        } catch (err) {
          console.error('GTD classification undo failed:', err);
          failed = true;
        }
      }
      for (const message of undoMessages) gtdRowChanged(message, metadataSession);
      currentStore().scheduleGtdSectionsFetch();
      if (failed) {
        currentStore().addNotification({
          pluginId: 'gtd',
          type: 'error',
          title: t('gtd.undoFailed'),
          body: stateLabel,
        });
      }
      return !failed;
    };
  }

  currentStore().addNotification(notification);
  return { tagged, total };
}
