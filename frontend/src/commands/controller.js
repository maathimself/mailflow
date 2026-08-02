import { hasTargets, resolveTargetIds } from './targets.js';

function failed(commandId, error, targetIds = []) {
  return { status: 'failed', commandId, targetIds, error: error instanceof Error ? error : new Error(String(error)) };
}

function terminalOutcome(commandId, targetIds, result) {
  if (!['success', 'cancelled', 'partial', 'failed'].includes(result?.status)) {
    return failed(commandId, new Error(`Invalid executor outcome for "${commandId}"`), targetIds);
  }
  return { commandId, targetIds, ...result };
}

export function createCommandController({
  registry,
  getContext,
  executors,
  onContinuation = () => {},
  onOutcome = () => {},
}) {
  const inFlight = new Map();

  function execute(commandId, { source = 'unknown', input, frozenTargetIds } = {}) {
    const initialContext = getContext();
    const command = registry.get(commandId);
    if (!command) {
      const outcome = failed(commandId, new Error(`Unknown command "${commandId}"`));
      onOutcome(outcome);
      return Promise.resolve(outcome);
    }
    const resumingFrozenTargets = frozenTargetIds != null && input !== undefined;
    if ((!resumingFrozenTargets && !command.isAvailable(initialContext))
      || (!frozenTargetIds && !hasTargets(command, initialContext))) {
      const outcome = failed(commandId, new Error(`Command "${commandId}" is not available`));
      onOutcome(outcome);
      return Promise.resolve(outcome);
    }

    const frozen = frozenTargetIds == null
      ? resolveTargetIds(command, initialContext).targetIds
      : [...new Set(frozenTargetIds)];
    if (command.targetMode === 'single_conversation' && frozen.length !== 1) {
      const outcome = failed(
        commandId,
        new Error(`Command "${commandId}" requires exactly one conversation`),
        frozen,
      );
      onOutcome(outcome);
      return Promise.resolve(outcome);
    }
    const dedupeKey = `${commandId}:${[...frozen].sort().join('|')}`;
    if (inFlight.has(dedupeKey)) return inFlight.get(dedupeKey);

    const promise = (async () => {
      const context = getContext();
      const { targetIds, missingTargetIds } = resolveTargetIds(command, context, frozen);
      const executor = executors[command.executorId];
      if (!executor) return failed(commandId, new Error(`Missing executor "${command.executorId}"`), targetIds);
      if (frozen.length && !targetIds.length) {
        return { status: 'partial', commandId, targetIds, missingTargetIds, succeededIds: [], failed: [] };
      }
      try {
        const result = await executor({ command, context, source, input, targetIds });
        if (result?.status === 'needs_input') {
          const continuation = Object.freeze({
            commandId,
            kind: result.continuation.kind,
            targetIds: Object.freeze([...frozen]),
            props: Object.freeze({ ...(result.continuation.props || {}) }),
          });
          onContinuation(continuation);
          return { status: 'needs_input', continuation };
        }
        const outcome = terminalOutcome(commandId, targetIds, result);
        if (missingTargetIds.length && outcome.status === 'success') {
          return {
            status: 'partial', commandId, targetIds, missingTargetIds,
            succeededIds: [...targetIds], failed: [], value: outcome.value,
          };
        }
        return missingTargetIds.length ? { ...outcome, missingTargetIds } : outcome;
      } catch (error) {
        return failed(commandId, error, targetIds);
      }
    })().then(outcome => {
      if (outcome.status !== 'needs_input') onOutcome(outcome);
      return outcome;
    }).finally(() => inFlight.delete(dedupeKey));

    inFlight.set(dedupeKey, promise);
    return promise;
  }

  return Object.freeze({ execute });
}
