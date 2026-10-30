import { beginHeldSendShutdown, flushHeldSends } from './sendHold.js';
import { stopScheduledSender } from './scheduledSend.js';

// What a shutdown waits for before the process exits, within one budget: held sends are
// delivered (sendHold.js), and the scheduled sender stops claiming at once and lets the sends
// it has in flight finish (scheduledSend.js). A send cut off by the force exit after that is
// left to the scheduler's recovery. Never rejects.
export function flushSendsForShutdown(timeoutMs) {
  beginHeldSendShutdown();
  return Promise.all([
    flushHeldSends(timeoutMs).catch(err => console.error('Flushing held sends failed:', err.message)),
    stopScheduledSender(timeoutMs).catch(err => console.error('Stopping the scheduled sender failed:', err.message)),
  ]);
}

// The last wait before the exit, once the HTTP server has closed: a send request that was in
// flight when the shutdown began may have held a send after the first flush looked, which
// holdSend then started at once. Never rejects.
export function finishHeldSendsForShutdown(timeoutMs) {
  return flushHeldSends(timeoutMs).catch(err => console.error('Flushing held sends failed:', err.message));
}

// The process is stopped at FORCE_EXIT_MS whatever is still running, inside the 30 s
// stop_grace_period the compose files give the backend. The first flush has FLUSH_MS; the last
// one, after the HTTP server has closed, has what is left before the forced exit, less a margin
// for the exit itself.
export const FORCE_EXIT_MS = 28_000;
export const FLUSH_MS = 25_000;
const LAST_FLUSH_MARGIN_MS = 500;

// The graceful shutdown (index.js): held sends are delivered and the scheduled sender stopped,
// the HTTP server stops taking connections while its requests in flight finish (a send among
// them), and `closeClients` closes the WebSockets, which would otherwise keep it open. Once it
// has closed, the held sends are flushed once more, then `quit` and `exit(code)`.
export function shutDown({ code, httpServer, closeClients, quit, exit, clock = Date.now, schedule = setTimeout }) {
  const started = clock();
  const sendsFlushed = flushSendsForShutdown(FLUSH_MS);
  httpServer.close(async () => {
    await sendsFlushed;
    await finishHeldSendsForShutdown(Math.max(0, started + FORCE_EXIT_MS - LAST_FLUSH_MARGIN_MS - clock()));
    try { await quit(); } catch { /* ignore */ }
    exit(code);
  });
  closeClients();
  schedule(() => exit(code || 1), FORCE_EXIT_MS).unref?.();
}
