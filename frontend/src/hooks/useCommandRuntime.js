import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store/index.js';
import { THEMES } from '../themes.js';
import { api } from '../utils/api.js';
import { clearDeleteGuard, setCompletedDelete, setPendingDelete } from '../utils/pendingDeletes.js';
import { clearReadGuard, setCompleted, setPending } from '../utils/pendingReads.js';
import { shortcutBus } from '../utils/shortcutBus.js';
import { buildAppCommandContext, detectCommandPlatform } from '../commands/appContext.js';
import { createAppCommandDefinitions, createAppCommandExecutors } from '../commands/appCommands.js';
import { createCommandRegistry } from '../commands/registry.js';
import { createCommandController } from '../commands/controller.js';
import { createMailActionExecutors } from '../commands/mailActions.js';
import { commandOutcomeNotification } from '../commands/outcomeNotification.js';
import { delegationCacheIds } from '../utils/delegation.js';
import { createPendingOperationManager } from '../commands/pendingOperationManager.js';
import { createShortcutDispatcher } from '../commands/shortcutDispatcher.js';
import { createShortcutCommandExecutors } from '../commands/shortcutCommands.js';
import { getEffectiveCommandBindings } from '../commands/shortcuts.js';
import { stableConversationId } from '../commands/contracts.js';

export function useCommandRuntime({ t, shortcutHelpOpen = false, paletteOpen = false }) {
  const accounts = useStore(state => state.accounts);
  const folders = useStore(state => state.folders);
  const user = useStore(state => state.user);
  const [continuation, setContinuation] = useState(null);
  const autoMarkReadTimerRef = useRef(null);
  const [pendingRemovalManager] = useState(() => createPendingOperationManager({ clearTimeout }));
  const platform = useMemo(() => detectCommandPlatform(navigator), []);
  const commandDefinitions = useMemo(() => createAppCommandDefinitions({
    accounts, folders, themes: THEMES, user,
  }), [accounts, folders, user]);
  const registry = useMemo(() => createCommandRegistry(commandDefinitions), [commandDefinitions]);
  const executors = useMemo(() => ({
    ...createAppCommandExecutors({
      getState: useStore.getState,
      emitShortcut: action => shortcutBus.emit(action),
    }),
    ...createMailActionExecutors({
      api,
      accounts: () => useStore.getState().accounts,
      openCompose: payload => useStore.getState().openCompose(payload),
      openExternal: url => window.open(url, '_blank', 'noopener,noreferrer'),
      patchMessages: (targets, patch) => {
        const state = useStore.getState();
        targets.forEach(target => {
          const ids = Object.hasOwn(patch, 'delegation')
            ? delegationCacheIds(state, target.message)
            : [target.message.id];
          ids.forEach(id => state.updateMessage(id, patch));
        });
      },
      removeMessages: targets => {
        const state = useStore.getState();
        state.removeMessages(targets.map(target => target.message.id));
        state.clearSelectedMessageIds();
      },
      restoreMessages: targets => useStore.getState().restoreMessages(
        targets.map(target => target.message),
      ),
      adjustUnread: (targets, read) => {
        const byAccount = new Map();
        const byCategory = new Map();
        const byFolder = new Map();
        targets.forEach(target => {
          const message = target.message;
          byAccount.set(message.account_id, (byAccount.get(message.account_id) ?? 0) + 1);
          const category = message.category || 'primary';
          byCategory.set(category, (byCategory.get(category) ?? 0) + 1);
          if (message.folder) {
            const key = `${message.account_id}\u0000${message.folder}`;
            byFolder.set(key, (byFolder.get(key) ?? 0) + 1);
          }
        });
        const state = useStore.getState();
        byAccount.forEach((count, accountId) => {
          if (read) state.decrementUnread(accountId, count);
          else state.incrementUnread(accountId, count);
        });
        byCategory.forEach((count, category) => {
          state.adjustCategoryCount(category, read ? -count : count);
        });
        byFolder.forEach((count, key) => {
          const [accountId, folder] = key.split('\u0000');
          state.adjustFolderUnread(accountId, folder, read ? -count : count);
        });
      },
      guardReadPending: targets => targets.forEach(target => {
        setPending(target.message.id, target.message.account_id);
      }),
      guardReadCompleted: targets => targets.forEach(target => {
        setCompleted(target.message.id, target.message.account_id);
      }),
      clearReadGuards: targets => targets.forEach(target => clearReadGuard(target.message.id)),
      guardPending: ids => ids.forEach(setPendingDelete),
      guardCompleted: ids => ids.forEach(setCompletedDelete),
      clearGuards: ids => ids.forEach(clearDeleteGuard),
      recordRecentFolder: (accountId, folder) => useStore.getState().recordRecentFolder({
        accountId,
        path: folder,
      }),
      scheduleGtdRefresh: () => useStore.getState().scheduleGtdSectionsFetch(),
      refreshCarddavStatus: () => useStore.getState().refreshCarddavStatus(),
      refreshMessages: () => window.dispatchEvent(new Event('mailflow:refresh')),
      refreshGtdSections: () => useStore.getState().fetchGtdSections(),
      moveOptions: (accountId, targets) => {
        const currentFolders = new Set(targets.map(target => target.message.folder).filter(Boolean));
        return (useStore.getState().folders[accountId] || [])
          .filter(folder => folder.path && !currentFolders.has(folder.path))
          .map(folder => ({ id: folder.path, label: folder.name || folder.path }));
      },
      snoozeOptions: () => {
        const threeHours = new Date();
        threeHours.setHours(threeHours.getHours() + 3);
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(9, 0, 0, 0);
        const nextWeek = new Date();
        nextWeek.setDate(nextWeek.getDate() + 7);
        nextWeek.setHours(9, 0, 0, 0);
        return [
          { id: threeHours.toISOString(), label: t('contextMenu.snooze.threeHours') },
          { id: tomorrow.toISOString(), label: t('contextMenu.snooze.tomorrowMorning') },
          { id: nextWeek.toISOString(), label: t('contextMenu.snooze.nextWeek') },
        ];
      },
      notify: notification => {
        const { titleKey, succeededCount, failedCount, count, ...rest } = notification;
        useStore.getState().addNotification({
          ...rest,
          title: titleKey ? t(titleKey, { count, succeeded: succeededCount, failed: failedCount }) : rest.title,
          body: rest.body || (failedCount
            ? t('commands.mail.partial', { succeeded: succeededCount, failed: failedCount })
            : rest.body),
        });
      },
      registerPendingRemoval: operation => pendingRemovalManager.register(operation),
      keepaliveDelete: ids => {
        const headers = { 'X-Requested-With': 'MailFlow' };
        if (ids.length === 1) {
          return fetch(`/api/mail/messages/${encodeURIComponent(ids[0])}`, {
            method: 'DELETE', credentials: 'include', headers, keepalive: true,
          });
        }
        return fetch('/api/mail/messages/bulk-delete', {
          method: 'POST',
          credentials: 'include',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids }),
          keepalive: true,
        });
      },
      timers: { setTimeout, clearTimeout },
    }),
    ...createShortcutCommandExecutors({
      selection: {
        toggle: (targetId, context) => {
          const rowId = context.conversationsById[targetId]?.rowId;
          if (!rowId) return;
          useStore.getState().setSelectedMessageIds(current => {
            const next = new Set(current);
            if (next.has(rowId)) next.delete(rowId); else next.add(rowId);
            return next;
          });
        },
        extend: (direction, context) => {
          const ids = context.visibleConversationIds;
          if (!ids.length) return;
          const activeIndex = ids.indexOf(context.activeConversationId);
          const anchorIndex = activeIndex < 0 ? (direction > 0 ? 0 : ids.length - 1) : activeIndex;
          const nextIndex = Math.max(0, Math.min(ids.length - 1, anchorIndex + direction));
          const anchorId = ids[anchorIndex];
          const nextId = ids[nextIndex];
          const rowIds = [anchorId, nextId]
            .map(id => context.conversationsById[id]?.rowId).filter(Boolean);
          useStore.getState().setSelectedMessageIds(current => new Set([...current, ...rowIds]));
          const nextRowId = context.conversationsById[nextId]?.rowId;
          if (nextRowId) useStore.setState({ lastViewedMessageId: nextRowId });
        },
        selectFocusedAndOlder: context => {
          const index = Math.max(0, context.visibleConversationIds.indexOf(context.activeConversationId));
          const rowIds = context.visibleConversationIds.slice(index)
            .map(id => context.conversationsById[id]?.rowId).filter(Boolean);
          useStore.getState().setSelectedMessageIds(new Set(rowIds));
        },
        selectAllVisible: context => useStore.getState().setSelectedMessageIds(new Set(
          context.visibleConversationIds.map(id => context.conversationsById[id]?.rowId).filter(Boolean),
        )),
        clear: () => useStore.getState().clearSelectedMessageIds(),
      },
      selectTarget: (targetId, context) => {
        const currentState = useStore.getState();
        const currentMessage = [
          ...(currentState.messages || []),
          ...Object.values(currentState.threadMessages || {}).flat(),
        ].find(message => stableConversationId(message) === targetId);
        const target = context.conversationsById[targetId] || (currentMessage && {
          rowId: currentMessage.id,
          message: currentMessage,
        });
        if (!target?.rowId) return;
        const message = target.message;
        const state = currentState;
        api.getMessageBody(message.id).catch(() => {});
        state.setSelectedMessage(target.rowId);
        clearTimeout(autoMarkReadTimerRef.current);
        autoMarkReadTimerRef.current = null;
        if (message.is_read || state.markReadBehavior === 'manual') return;
        const markRead = () => {
          const current = useStore.getState();
          current.updateMessage(message.id, { is_read: true });
          current.decrementUnread(message.account_id);
          current.adjustCategoryCount(message.category || 'primary', -1);
          if (message.folder) current.adjustFolderUnread(message.account_id, message.folder, -1);
          setPending(message.id, message.account_id);
          api.bulkRead([message.id], true).then(() => {
            setCompleted(message.id, message.account_id);
          }).catch(() => {
            const latest = useStore.getState();
            latest.updateMessage(message.id, { is_read: false });
            latest.incrementUnread(message.account_id);
            latest.adjustCategoryCount(message.category || 'primary', 1);
            if (message.folder) latest.adjustFolderUnread(message.account_id, message.folder, 1);
            clearReadGuard(message.id);
          });
        };
        if (state.markReadBehavior === 'delay') {
          autoMarkReadTimerRef.current = setTimeout(() => {
            autoMarkReadTimerRef.current = null;
            markRead();
          }, state.markReadDelay * 1000);
        }
        else markRead();
      },
      loadThreadTargets: async context => {
        const message = context.activeMessage;
        if (!message) return [];
        const threadId = message.thread_id || message.id;
        let thread = useStore.getState().threadMessages[threadId] || [];
        if (!thread.length && message.thread_id) {
          const data = await api.getThread(threadId, context.folder || 'INBOX', !context.accountId);
          thread = data.messages?.length ? data.messages : [message];
          if (thread.length > 1) useStore.getState().setThreadMessages(threadId, thread);
        }
        return thread.map(stableConversationId).filter(Boolean);
      },
      scrollConversation: direction => window.dispatchEvent(new CustomEvent(
        'mailflow:scroll-conversation', { detail: { direction } },
      )),
      navigate: destination => {
        const state = useStore.getState();
        if (destination.contacts) {
          state.setSelectedMessage(null);
          state.clearSelectedMessageIds();
          state.setShowContacts(true);
        }
        else state.setSelectedAccount(destination.accountId, destination.folder);
      },
      getFolders: async accountId => {
        const data = await api.getFolders(accountId);
        return Array.isArray(data) ? data : (data.folders || []);
      },
      undoLatest: () => {
        const notification = useStore.getState().notifications.find(item => item.onUndo);
        notification?.onUndo();
        if (notification) useStore.getState().removeNotification(notification.id);
      },
      goBack: () => useStore.getState().setSelectedMessage(null),
      emitShortcut: action => shortcutBus.emit(action),
    }),
  }), [pendingRemovalManager, t]);
  useEffect(() => {
    const flushOnUnload = () => { pendingRemovalManager.flush('unload'); };
    window.addEventListener('beforeunload', flushOnUnload);
    return () => {
      window.removeEventListener('beforeunload', flushOnUnload);
      pendingRemovalManager.flush('normal');
    };
  }, [pendingRemovalManager]);
  useEffect(() => () => clearTimeout(autoMarkReadTimerRef.current), []);
  const getContext = useCallback(() => buildAppCommandContext(useStore.getState(), {
    translate: (key, values) => t(key, values),
    platform,
    modal: continuation ? { kind: continuation.kind } : null,
  }), [continuation, platform, t]);
  const onOutcome = useCallback(outcome => {
    const notification = commandOutcomeNotification(outcome, t);
    if (notification) useStore.getState().addNotification(notification);
  }, [t]);
  const controller = useMemo(() => createCommandController({
    registry,
    getContext,
    executors,
    onContinuation: setContinuation,
    onOutcome,
  }), [registry, getContext, executors, onOutcome]);
  useEffect(() => {
    if (paletteOpen || shortcutHelpOpen
      || (navigator.maxTouchPoints > 0 && window.innerWidth <= 768)) return undefined;
    const dispatcher = createShortcutDispatcher({
      registry,
      getContext,
      getBindings: () => getEffectiveCommandBindings(commandDefinitions, getContext()),
      execute: (commandId, options) => controller.execute(commandId, options),
      timers: { setTimeout, clearTimeout },
    });
    document.addEventListener('keydown', dispatcher.handleKeyDown);
    return () => {
      document.removeEventListener('keydown', dispatcher.handleKeyDown);
      dispatcher.reset();
    };
  }, [commandDefinitions, controller, getContext, paletteOpen, registry, shortcutHelpOpen]);
  const clearContinuation = useCallback(() => setContinuation(null), []);

  return useMemo(() => ({
    registry, controller, getContext, commandDefinitions, continuation, clearContinuation,
  }), [registry, controller, getContext, commandDefinitions, continuation, clearContinuation]);
}
