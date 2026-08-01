export async function handleComposeRequest(request, {
  addNotification,
  t,
  logError = console.error,
} = {}) {
  try {
    return await request();
  } catch {
    logError('Compose request failed', {
      code: 'compose_request_failed',
      context: 'event_boundary',
    });
    addNotification?.({
      type: 'error',
      title: t
        ? t('compose.requestFailed')
        : 'Could not open the draft.',
    });
    return null;
  }
}
