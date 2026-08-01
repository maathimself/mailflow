import { useCallback, useMemo, useState } from 'react';
import { useStore } from '../store/index.js';
import { THEMES } from '../themes.js';
import { shortcutBus } from '../utils/shortcutBus.js';
import { buildAppCommandContext, detectCommandPlatform } from '../commands/appContext.js';
import { createAppCommandDefinitions, createAppCommandExecutors } from '../commands/appCommands.js';
import { createCommandRegistry } from '../commands/registry.js';
import { createCommandController } from '../commands/controller.js';

export function useCommandRuntime({ t }) {
  const accounts = useStore(state => state.accounts);
  const folders = useStore(state => state.folders);
  const user = useStore(state => state.user);
  const [continuation, setContinuation] = useState(null);
  const platform = useMemo(() => detectCommandPlatform(navigator), []);
  const commandDefinitions = useMemo(() => createAppCommandDefinitions({
    accounts, folders, themes: THEMES, user,
  }), [accounts, folders, user]);
  const registry = useMemo(() => createCommandRegistry(commandDefinitions), [commandDefinitions]);
  const executors = useMemo(() => createAppCommandExecutors({
    getState: useStore.getState,
    emitShortcut: action => shortcutBus.emit(action),
  }), []);
  const getContext = useCallback(() => buildAppCommandContext(useStore.getState(), {
    translate: (key, values) => t(key, values),
    platform,
    modal: continuation ? { kind: continuation.kind } : null,
  }), [continuation, platform, t]);
  const onOutcome = useCallback(outcome => {
    if (outcome.status === 'failed') {
      useStore.getState().addNotification({
        type: 'error', title: t('commandPalette.outcome.failedTitle'), body: outcome.error.message,
      });
    }
    if (outcome.status === 'partial') {
      useStore.getState().addNotification({
        title: t('commandPalette.outcome.partialTitle'),
        body: t('commandPalette.outcome.partialBody', {
          succeeded: outcome.succeededIds?.length || 0,
          failed: (outcome.failed?.length || 0) + (outcome.missingTargetIds?.length || 0),
        }),
      });
    }
  }, [t]);
  const controller = useMemo(() => createCommandController({
    registry,
    getContext,
    executors,
    onContinuation: setContinuation,
    onOutcome,
  }), [registry, getContext, executors, onOutcome]);
  const clearContinuation = useCallback(() => setContinuation(null), []);

  return useMemo(() => ({
    registry, controller, getContext, continuation, clearContinuation,
  }), [registry, controller, getContext, continuation, clearContinuation]);
}
