function conclusiveArchive(outcome) {
  return outcome?.archived === true || outcome?.alreadyGone === true;
}

function conclusiveRemoval(outcome) {
  return outcome?.removed === true || outcome?.alreadyGone === true;
}

function classifyStructuralSupersession(error) {
  const terminalCodes = new Set([
    'MESSAGE_SNAPSHOT_SUPERSEDED',
    'MESSAGE_SNAPSHOT_NOT_ACTIONABLE',
    'DESIRED_FLAG_ROW_SUPERSEDED',
    'SNAPSHOT_UIDVALIDITY_CHANGED',
    'FOLDER_OBSERVATION_SUPERSEDED',
    'FOLDER_OBSERVATION_UIDVALIDITY_CHANGED',
    'FOLDER_OBSERVATION_UNSAFE',
    'PROVIDER_MAILBOX_SUPERSEDED',
    'PROVIDER_NATIVE_MOVE_UNSUPPORTED',
    'PROVIDER_RECOVERY_MARKER_UNSUPPORTED',
  ]);
  if (terminalCodes.has(error?.code)) {
    error.retryable = false;
  }
  return error;
}

async function persist(operation, actions, phase, itemIndex, outcome = null, metadata = {}, plan) {
  try {
    return await actions.advance(operation, phase, itemIndex, outcome, plan);
  } catch (error) {
    error.gtdDonePhase = metadata.phase || phase;
    error.inboxCleared = metadata.inboxCleared === true;
    error.gtdDoneOperation = operation;
    throw error;
  }
}

function rebasePlanRows(plan, postSeenRows) {
  const byId = new Map(postSeenRows.map(row => [row.id, row]));
  const replace = rows => (rows || []).map(row => byId.get(row.id) || row);
  return {
    ...plan,
    rows: replace(plan.rows),
    inboxRows: replace(plan.inboxRows),
    labelRows: replace(plan.labelRows),
  };
}

// Execute one durable GTD Done plan. The repository-backed `advance` callback records each
// conclusive item before the next provider mutation starts. Re-entry therefore resumes the first
// unrecorded item; the exact row primitives make a provider-success/ledger-crash replay safe.
export async function executeGtdDonePhases(initialOperation, actions) {
  if (initialOperation.phase === 'completed') {
    return {
      complete: true,
      phase: 'completed',
      seenFailedCount: 0,
      archiveUnconfirmedCount: 0,
      operation: initialOperation,
    };
  }
  let operation = actions.claim ? await actions.claim(initialOperation) : initialOperation;
  const result = {
    complete: false,
    phase: operation.phase,
    seenFailedCount: 0,
    archiveUnconfirmedCount: 0,
  };

  try {
    if (operation.phase === 'seen') {
      const postSeenRows = [];
      for (const current of operation.plan.rows) {
        operation = actions.renew ? await actions.renew(operation) : operation;
        let seen;
        try {
          seen = await actions.markSeen([current]);
        } catch (error) {
          classifyStructuralSupersession(error);
          error.gtdDonePhase = 'seen';
          error.inboxCleared = false;
          throw error;
        }
        const confirmedRows = seen?.postSeenRows || [];
        const failedCount = Number(seen?.seenFailedCount || 0);
        if (failedCount > 0 || confirmedRows.length !== 1) {
          result.seenFailedCount += Math.max(failedCount, 1 - confirmedRows.length);
          return { ...result, operation };
        }
        postSeenRows.push(...confirmedRows);
      }
      const postSeenPlan = rebasePlanRows(operation.plan, postSeenRows);
      operation = await persist(
        operation, actions, 'archive', 0,
        { phase: 'seen', seen: 'confirmed' },
        { phase: 'seen', inboxCleared: false },
        postSeenPlan,
      );
    }

    if (operation.phase === 'archive') {
      const inboxRows = operation.plan.inboxRows || [];
      for (let index = Number(operation.itemIndex || 0); index < inboxRows.length; index++) {
        let outcome;
        try {
          operation = actions.renew ? await actions.renew(operation) : operation;
          outcome = await actions.archive(inboxRows[index]);
        } catch (error) {
          classifyStructuralSupersession(error);
          error.gtdDonePhase = 'archive';
          error.inboxCleared = false;
          error.gtdDoneOperation = operation;
          throw error;
        }
        if (!conclusiveArchive(outcome)) {
          return {
            ...result,
            phase: 'archive',
            archiveUnconfirmedCount: 1,
            noArchiveFolder: outcome?.noArchiveFolder === true,
            operation,
          };
        }
        const inboxCleared = index + 1 === inboxRows.length;
        operation = await persist(
          operation, actions, 'archive', index + 1,
          { phase: 'archive', itemIndex: index, rowId: inboxRows[index].id, ...outcome },
          { phase: 'archive', inboxCleared },
        );
      }
      operation = await persist(
        operation, actions, 'labels', 0,
        { phase: 'archive', inboxCleared: true },
        { phase: 'labels', inboxCleared: true },
      );
    }

    if (operation.phase === 'labels') {
      const labelRows = operation.plan.labelRows || [];
      for (let index = Number(operation.itemIndex || 0); index < labelRows.length; index++) {
        let outcome;
        try {
          operation = actions.renew ? await actions.renew(operation) : operation;
          outcome = await actions.removeLabel(labelRows[index]);
        } catch (error) {
          classifyStructuralSupersession(error);
          error.gtdDonePhase = 'labels';
          error.inboxCleared = true;
          error.gtdDoneOperation = operation;
          throw error;
        }
        if (!conclusiveRemoval(outcome)) {
          return { ...result, phase: 'labels', labelUnconfirmedCount: 1, operation };
        }
        operation = await persist(
          operation, actions, 'labels', index + 1,
          { phase: 'labels', itemIndex: index, rowId: labelRows[index].id, ...outcome },
          { phase: 'labels', inboxCleared: true },
        );
      }
      operation = await persist(
        operation, actions, 'completed', 0,
        { phase: 'labels', complete: true },
        { phase: 'labels', inboxCleared: true },
      );
    }

    return {
      ...result,
      complete: operation.phase === 'completed',
      phase: operation.phase,
      operation,
    };
  } finally {
    if (operation.phase !== 'completed') {
      try {
        await actions.release?.(operation);
      } catch (error) {
        console.warn(`GTD Done claim release failed for ${operation.key}:`, error.message);
      }
    }
  }
}
