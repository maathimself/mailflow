const RETRYABLE_BODY_ERROR = /not found|Command failed|Command canceled|timed out|ECONNRESET|socket hang up|EPIPE/i;

export async function fetchMessageBodyWithRetry(messageId, {
  load,
  remoteImages = false,
  attempts = 2,
  delay = 500,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
  isCancelled = () => false,
}) {
  try {
    return await load(messageId, remoteImages);
  } catch (error) {
    if (!RETRYABLE_BODY_ERROR.test(error.message) || attempts <= 0 || isCancelled()) throw error;
    await wait(delay);
    if (isCancelled()) throw error;
    return fetchMessageBodyWithRetry(messageId, {
      load,
      remoteImages,
      attempts: attempts - 1,
      delay: delay * 2,
      wait,
      isCancelled,
    });
  }
}
