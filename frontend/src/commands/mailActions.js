import { openForwardFromMessage, openReplyFromMessage } from '../utils/composeFromMessage.js';

const DEFAULT_KEYS = Object.freeze({
  'mail.archive': { primary: 'e', secondary: [] },
  'mail.snooze': { primary: 'h', secondary: [] },
  'mail.move': { primary: 'v', secondary: [] },
  'mail.toggleRead': { primary: 'u', secondary: ['m'] },
  'mail.toggleStar': { primary: 's', secondary: [] },
  'mail.trash': { primary: '#', secondary: [] },
  'mail.spam': { primary: '!', secondary: [] },
  'mail.reply': { primary: 'r', secondary: [] },
  'mail.replyAll': { primary: 'enter', secondary: ['a'] },
  'mail.forward': { primary: 'f', secondary: [] },
  'gtd.todo': { primary: 't', secondary: [] },
  'gtd.watch': { primary: 'w', secondary: [] },
  'gtd.delegate': { primary: 'd', secondary: [] },
});

const definition = (id, titleKey, aliasKeys, icon, group, targetMode, executorId, rank = 50) => ({
  id,
  titleKey,
  aliasKeys,
  icon,
  group,
  defaultKeys: DEFAULT_KEYS[id] || { primary: null, secondary: [] },
  rank: { base: rank },
  targetMode,
  executorId,
  isAvailable: () => true,
});

const baseMailCommandDefinitions = [
  definition('mail.archive', 'shortcuts.actions.archive.label', ['commands.mail.archive.aliasDone'], 'archive', 'mail', 'bulk_safe', 'mail.archive', 90),
  definition('mail.snooze', 'contextMenu.snooze.label', ['commands.mail.snooze.aliasRemind'], 'clock', 'mail', 'bulk_safe', 'mail.snooze', 85),
  definition('mail.move', 'contextMenu.moveToFolder', [], 'folder', 'mail', 'bulk_safe', 'mail.move', 75),
  definition('mail.read', 'contextMenu.markRead', [], 'mail-open', 'mail', 'bulk_safe', 'mail.read'),
  definition('mail.unread', 'contextMenu.markUnread', [], 'mail', 'mail', 'bulk_safe', 'mail.unread'),
  definition('mail.toggleRead', 'shortcuts.actions.toggleRead.label', [], 'mail', 'mail', 'bulk_safe', 'mail.toggleRead', 80),
  definition('mail.star', 'message.star', [], 'star', 'mail', 'bulk_safe', 'mail.star'),
  definition('mail.unstar', 'message.unstar', [], 'star', 'mail', 'bulk_safe', 'mail.unstar'),
  definition('mail.toggleStar', 'shortcuts.actions.toggleStar.label', [], 'star', 'mail', 'bulk_safe', 'mail.toggleStar', 80),
  definition('mail.trash', 'shortcuts.actions.delete.label', ['commands.mail.trash.aliasDelete'], 'trash', 'mail', 'bulk_safe', 'mail.trash', 80),
  definition('mail.spam', 'contextMenu.markAsSpam', ['commands.mail.spam.aliasJunk'], 'shield', 'mail', 'bulk_safe', 'mail.spam'),
  definition('mail.notSpam', 'contextMenu.markAsNotSpam', [], 'shield-check', 'mail', 'bulk_safe', 'mail.notSpam'),
  definition('mail.reply', 'shortcuts.actions.reply.label', [], 'reply', 'respond', 'single_conversation', 'mail.reply', 80),
  definition('mail.replyAll', 'shortcuts.actions.replyAll.label', [], 'reply-all', 'respond', 'single_conversation', 'mail.replyAll', 80),
  definition('mail.forward', 'shortcuts.actions.forward.label', [], 'forward', 'respond', 'single_conversation', 'mail.forward', 70),
  definition('gtd.todo', 'shortcuts.actions.gtdTodo.label', [], 'check-square', 'gtd', 'bulk_safe', 'gtd.todo'),
  definition('gtd.watch', 'shortcuts.actions.gtdWatch.label', [], 'eye', 'gtd', 'bulk_safe', 'gtd.watch'),
  definition('gtd.delegate', 'shortcuts.actions.gtdDelegated.label', [], 'user-check', 'gtd', 'bulk_safe', 'gtd.delegate'),
  definition('gtd.someday', 'gtd.states.someday', [], 'calendar', 'gtd', 'bulk_safe', 'gtd.someday'),
  definition('gtd.reference', 'gtd.states.reference', [], 'bookmark', 'gtd', 'bulk_safe', 'gtd.reference'),
].map(command => Object.freeze({
  ...command,
  isAvailable: context => command.id.startsWith('gtd.') ? context.gtdAvailable === true : true,
}));

export const mailCommandDefinitions = Object.freeze([...baseMailCommandDefinitions, Object.freeze({
  id: 'mail.unsubscribe',
  titleKey: 'message.unsubscribe.button',
  aliasKeys: [],
  icon: 'mail',
  group: 'mail',
  defaultKeys: {
    primary: { mac: 'meta+u', windows: 'ctrl+u', linux: 'ctrl+u', default: 'ctrl+u' },
    secondary: [],
  },
  rank: { base: 60 },
  targetMode: 'single_conversation',
  executorId: 'mail.unsubscribe',
  isAvailable: context => context.surface === 'conversation'
    && !!context.activeMessage?.list_unsubscribe
    && !context.activeMessage?.unsubscribed_at,
})]);

const idOf = target => target.id;
const idsOf = targets => targets.map(idOf);
const errorText = error => error instanceof Error ? error.message : String(error);
const failedOutcome = (targets, error) => ({
  status: 'failed',
  succeededIds: [],
  failed: targets.map(target => ({ id: idOf(target), error: errorText(error) })),
});
const settledOutcome = (targets, results) => {
  const succeededIds = [];
  const failed = [];
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') succeededIds.push(idOf(targets[index]));
    else failed.push({ id: idOf(targets[index]), error: errorText(result.reason) });
  });
  return {
    status: failed.length === 0 ? 'success' : succeededIds.length === 0 ? 'failed' : 'partial',
    succeededIds,
    failed,
  };
};

const continuation = (commandId, kind, targets, props) => ({
  status: 'needs_input',
  continuation: { commandId, kind, targetIds: idsOf(targets), props },
});

function scheduleOptimisticRemoval(deps, {
  targets,
  call,
  successIds,
  onSuccess,
  successNotice,
  failureNotice,
  flushOnUnload,
}) {
  const rowIds = targets.map(target => target.message.id);
  const unreadTargets = targets.filter(target => !target.message.is_read);
  deps.guardPending(rowIds);
  deps.removeMessages(targets);
  deps.adjustUnread(unreadTargets, true);
  let undone = false;

  let unregisterPendingRemoval = () => {};
  const run = async () => {
    unregisterPendingRemoval();
    if (undone) return;
    try {
      const response = await call();
      const succeededRowIds = new Set(successIds(response));
      const succeededTargets = targets.filter(target => succeededRowIds.has(target.message.id));
      const failedTargets = targets.filter(target => !succeededRowIds.has(target.message.id));
      deps.guardCompleted(succeededTargets.map(target => target.message.id));
      deps.clearGuards(failedTargets.map(target => target.message.id));
      if (failedTargets.length > 0) {
        deps.restoreMessages(failedTargets);
        deps.adjustUnread(failedTargets.filter(target => !target.message.is_read), false);
        deps.notify({
          type: 'error',
          titleKey: failureNotice,
          succeededCount: succeededTargets.length,
          failedCount: failedTargets.length,
        });
      }
      onSuccess?.(response, succeededTargets);
    } catch (error) {
      deps.clearGuards(rowIds);
      deps.restoreMessages(targets);
      deps.adjustUnread(unreadTargets, false);
      deps.notify({
        type: 'error',
        titleKey: failureNotice,
        body: errorText(error),
        succeededCount: 0,
        failedCount: targets.length,
      });
    }
  };
  const timer = deps.timers.setTimeout(run, 4500);
  if (flushOnUnload) {
    unregisterPendingRemoval = deps.registerPendingRemoval({
      timer,
      run,
      unload: () => flushOnUnload(rowIds),
    });
  }

  deps.notify({
    titleKey: successNotice,
    count: targets.length,
    onUndo: () => {
      undone = true;
      unregisterPendingRemoval();
      deps.timers.clearTimeout(timer);
      deps.clearGuards(rowIds);
      deps.restoreMessages(targets);
      deps.adjustUnread(unreadTargets, false);
    },
  });

  return { status: 'success', succeededIds: idsOf(targets), failed: [] };
}

export function createMailActionExecutors(deps) {
  const resolveTargets = ({ context, targetIds }) => targetIds
    .map(targetId => context.conversationsById[targetId])
    .filter(Boolean);
  const setRead = async (targets, read) => {
    const changedTargets = targets.filter(target => target.message.is_read !== read);
    if (read) deps.guardReadPending(changedTargets);
    else deps.clearReadGuards(changedTargets);
    deps.patchMessages(targets, { is_read: read });
    deps.adjustUnread(changedTargets, read);
    try {
      await deps.api.bulkRead(targets.map(target => target.message.id), read);
      if (read) deps.guardReadCompleted(changedTargets);
      return { status: 'success', succeededIds: idsOf(targets), failed: [] };
    } catch (error) {
      deps.clearReadGuards(changedTargets);
      changedTargets.forEach(target => deps.patchMessages([target], { is_read: target.message.is_read }));
      deps.restoreMessages(targets);
      deps.adjustUnread(changedTargets, !read);
      return failedOutcome(targets, error);
    }
  };
  const setStarred = async (targets, starred) => {
    deps.patchMessages(targets, { is_starred: starred });
    const results = await Promise.allSettled(
      targets.map(target => deps.api.markStarred(target.message.id, starred)),
    );
    const outcome = settledOutcome(targets, results);
    const failedIds = new Set(outcome.failed.map(item => item.id));
    const failedTargets = targets.filter(target => failedIds.has(idOf(target)));
    failedTargets.forEach(target => deps.patchMessages([target], { is_starred: target.message.is_starred }));
    deps.restoreMessages(failedTargets);
    return outcome;
  };
  const classify = state => async ({ targets }) => {
    const results = await Promise.allSettled(
      targets.map(target => deps.api.gtdClassify(target.message.id, state)),
    );
    deps.scheduleGtdRefresh();
    return settledOutcome(targets, results);
  };

  const handlers = {
    'mail.archive': ({ targets }) => scheduleOptimisticRemoval(deps, {
      targets,
      call: () => deps.api.bulkArchive(targets.map(target => target.message.id)),
      successIds: response => response.archived ?? [],
      successNotice: 'messageList.bulkArchived.title',
      failureNotice: 'messageList.bulkArchived.failTitle',
    }),
    'mail.trash': ({ targets }) => scheduleOptimisticRemoval(deps, {
      targets,
      call: () => deps.api.bulkDelete(targets.map(target => target.message.id)),
      successIds: response => response.deleted ?? [],
      successNotice: 'messageList.bulkDeleted.title',
      failureNotice: 'messageList.bulkDeleted.failTitle',
      flushOnUnload: ids => deps.keepaliveDelete(ids),
    }),
    'mail.move': ({ targets, input }) => {
      const folder = input?.folder ?? input?.value;
      if (!folder) {
        return continuation('mail.move', 'move', targets, {
          accountId: targets[0]?.message.account_id,
          targetCount: targets.length,
          titleKey: 'contextMenu.moveToFolder',
          inputKey: 'folder',
          items: deps.moveOptions(targets[0]?.message.account_id, targets),
        });
      }
      return scheduleOptimisticRemoval(deps, {
        targets,
        call: () => deps.api.bulkMove(targets.map(target => target.message.id), folder),
        successIds: response => response.moved ?? [],
        onSuccess: (_response, succeededTargets) => {
          if (succeededTargets.length > 0) {
            deps.recordRecentFolder(targets[0].message.account_id, folder);
          }
        },
        successNotice: 'messageList.bulkMoved.title',
        failureNotice: 'messageList.bulkMoved.failTitle',
      });
    },
    'mail.snooze': ({ targets, input }) => {
      const until = input?.until ?? input?.value;
      if (!until) {
        return continuation('mail.snooze', 'snooze', targets, {
          targetCount: targets.length,
          titleKey: 'contextMenu.snooze.label',
          inputKey: 'until',
          items: deps.snoozeOptions(),
        });
      }
      return scheduleOptimisticRemoval(deps, {
        targets,
        call: async () => {
          const results = await Promise.allSettled(
            targets.map(target => deps.api.snoozeMessage(target.message.id, until)),
          );
          return {
            snoozed: targets
              .filter((_target, index) => results[index].status === 'fulfilled')
              .map(target => target.message.id),
          };
        },
        successIds: response => response.snoozed,
        successNotice: 'message.snoozed.title',
        failureNotice: 'message.snoozed.failTitle',
      });
    },
    'mail.spam': ({ targets }) => scheduleOptimisticRemoval(deps, {
      targets,
      call: async () => {
        const results = await Promise.allSettled(
          targets.map(target => deps.api.markSpam(target.message.id)),
        );
        return {
          moved: targets
            .filter((_target, index) => results[index].status === 'fulfilled')
            .map(target => target.message.id),
        };
      },
      successIds: response => response.moved,
      successNotice: 'spam.movedToSpamBulk',
      failureNotice: 'spam.failTitle',
    }),
    'mail.notSpam': ({ targets }) => scheduleOptimisticRemoval(deps, {
      targets,
      call: async () => {
        const results = await Promise.allSettled(
          targets.map(target => deps.api.markHam(target.message.id)),
        );
        return {
          moved: targets
            .filter((_target, index) => results[index].status === 'fulfilled')
            .map(target => target.message.id),
        };
      },
      successIds: response => response.moved,
      successNotice: 'spam.movedToInboxBulk',
      failureNotice: 'spam.failHamTitle',
    }),
    'mail.read': ({ targets }) => setRead(targets, true),
    'mail.unread': ({ targets }) => setRead(targets, false),
    'mail.toggleRead': ({ targets }) => setRead(targets, targets.some(target => !target.message.is_read)),
    'mail.star': ({ targets }) => setStarred(targets, true),
    'mail.unstar': ({ targets }) => setStarred(targets, false),
    'mail.toggleStar': ({ targets }) => setStarred(targets, targets.some(target => !target.message.is_starred)),
    'mail.reply': async ({ targets }) => {
      await openReplyFromMessage(targets[0].message, {
        accounts: deps.accounts(),
        openCompose: deps.openCompose,
        getMessageBody: deps.api.getMessageBody,
        replyAll: false,
      });
      return { status: 'success', succeededIds: idsOf(targets), failed: [] };
    },
    'mail.replyAll': async ({ targets }) => {
      await openReplyFromMessage(targets[0].message, {
        accounts: deps.accounts(),
        openCompose: deps.openCompose,
        getMessageBody: deps.api.getMessageBody,
        replyAll: true,
      });
      return { status: 'success', succeededIds: idsOf(targets), failed: [] };
    },
    'mail.forward': async ({ targets }) => {
      await openForwardFromMessage(targets[0].message, {
        openCompose: deps.openCompose,
        getMessageBody: deps.api.getMessageBody,
      });
      return { status: 'success', succeededIds: idsOf(targets), failed: [] };
    },
    'mail.unsubscribe': async ({ targets }) => {
      try {
        const result = await deps.api.unsubscribeMessage(targets[0].message.id);
        const isHandled = result?.type === 'one-click'
          || (result?.type === 'url' && result.url)
          || (result?.type === 'mailto' && result.mailto);
        if (!isHandled) throw new Error('Unsupported unsubscribe response');
        if (result.type === 'url' && result.url) deps.openExternal(result.url);
        if (result.type === 'mailto' && result.mailto) deps.openExternal(result.mailto);
        deps.patchMessages(targets, { unsubscribed_at: new Date().toISOString() });
        deps.notify({ titleKey: 'message.unsubscribe.done' });
        return { status: 'success', succeededIds: idsOf(targets), failed: [] };
      } catch (error) {
        deps.notify({ type: 'error', titleKey: 'message.unsubscribe.error' });
        return failedOutcome(targets, error);
      }
    },
    'gtd.todo': classify('todo'),
    'gtd.watch': classify('watch'),
    'gtd.delegate': classify('delegated'),
    'gtd.someday': classify('someday'),
    'gtd.reference': classify('reference'),
  };

  return Object.fromEntries(Object.entries(handlers).map(([id, handler]) => [
    id,
    args => handler({ ...args, targets: resolveTargets(args) }),
  ]));
}
