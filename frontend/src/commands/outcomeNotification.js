const errorText = error => error instanceof Error ? error.message : error == null ? '' : String(error);

export function commandOutcomeNotification(outcome, t) {
  if (outcome.status === 'failed') {
    return {
      type: 'error',
      title: t('commandPalette.outcome.failedTitle'),
      body: errorText(outcome.error) || errorText(outcome.failed?.[0]?.error),
    };
  }
  if (outcome.status === 'partial') {
    return {
      title: t('commandPalette.outcome.partialTitle'),
      body: t('commandPalette.outcome.partialBody', {
        succeeded: outcome.succeededIds?.length || 0,
        failed: (outcome.failed?.length || 0) + (outcome.missingTargetIds?.length || 0),
      }),
    };
  }
  return null;
}
