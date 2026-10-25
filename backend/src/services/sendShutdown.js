import { flushHeldSends } from './sendHold.js';
import { stopScheduledSender } from './scheduledSend.js';

// What a shutdown waits for before the process exits, within one budget: held sends are
// delivered (sendHold.js), and the scheduled sender stops claiming at once and lets the sends
// it has in flight finish (scheduledSend.js). A send cut off by the force exit after that is
// left to the scheduler's recovery. Never rejects.
export function flushSendsForShutdown(timeoutMs) {
  return Promise.all([
    flushHeldSends(timeoutMs).catch(err => console.error('Flushing held sends failed:', err.message)),
    stopScheduledSender(timeoutMs).catch(err => console.error('Stopping the scheduled sender failed:', err.message)),
  ]);
}
