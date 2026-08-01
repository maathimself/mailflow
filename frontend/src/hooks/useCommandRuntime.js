import { useCallback, useEffect, useMemo, useState } from 'react';
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
import { createPendingOperationManager } from '../commands/pendingOperationManager.js';

export function useCommandRuntime({ t }) {
  const accounts = useStore(state => state.accounts);
  const folders = useStore(state => state.folders);
  const user = useStore(state => state.user);
  const [continuation, setContinuation] = useState(null);
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
      patchMessages: (targets, patch) => {
        const state = useStore.getState();
        targets.forEach(target => state.updateMessage(target.message.id, patch));
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
  }), [pendingRemovalManager, t]);
  useEffect(() => {
    const flushOnUnload = () => { pendingRemovalManager.flush('unload'); };
    window.addEventListener('beforeunload', flushOnUnload);
    return () => {
      window.removeEventListener('beforeunload', flushOnUnload);
      pendingRemovalManager.flush('normal');
    };
  }, [pendingRemovalManager]);
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
    const execute = commandId => () => controller.execute(commandId, { source: 'shortcut' });
    const onArchive = execute('mail.archive');
    const onDelete = execute('mail.trash');
    const onToggleRead = execute('mail.toggleRead');
    const onToggleStar = execute('mail.toggleStar');
    const onReply = execute('mail.reply');
    const onReplyAll = execute('mail.replyAll');
    const onForward = execute('mail.forward');
    const onGtdTodo = execute('gtd.todo');
    const onGtdWatch = execute('gtd.watch');
    const onGtdDelegated = execute('gtd.delegate');
    shortcutBus.on('archive', onArchive);
    shortcutBus.on('delete', onDelete);
    shortcutBus.on('toggleRead', onToggleRead);
    shortcutBus.on('toggleStar', onToggleStar);
    shortcutBus.on('reply', onReply);
    shortcutBus.on('replyAll', onReplyAll);
    shortcutBus.on('forward', onForward);
    shortcutBus.on('gtdTodo', onGtdTodo);
    shortcutBus.on('gtdWatch', onGtdWatch);
    shortcutBus.on('gtdDelegated', onGtdDelegated);
    return () => {
      shortcutBus.off('archive', onArchive);
      shortcutBus.off('delete', onDelete);
      shortcutBus.off('toggleRead', onToggleRead);
      shortcutBus.off('toggleStar', onToggleStar);
      shortcutBus.off('reply', onReply);
      shortcutBus.off('replyAll', onReplyAll);
      shortcutBus.off('forward', onForward);
      shortcutBus.off('gtdTodo', onGtdTodo);
      shortcutBus.off('gtdWatch', onGtdWatch);
      shortcutBus.off('gtdDelegated', onGtdDelegated);
    };
  }, [controller]);
  const clearContinuation = useCallback(() => setContinuation(null), []);

  return useMemo(() => ({
    registry, controller, getContext, continuation, clearContinuation,
  }), [registry, controller, getContext, continuation, clearContinuation]);
}
