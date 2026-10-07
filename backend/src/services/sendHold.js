import { randomUUID } from 'crypto';
import { redisClient } from './redis.js';

// Sends held back for a few seconds so the user can undo them. The hold lives on the server,
// not in the browser: closing the tab during the window still sends.
//
// A held send exists only in this process, so a restart during the window could lose it. Two
// things keep that from being silent:
// - A graceful shutdown (SIGTERM, which every update and restart sends) delivers held sends
//   before the process exits (flushHeldSends).
// - Each send's state is mirrored to Redis. After a crash, a client asking about a send that was
//   still held is told it was 'lost', so it reopens the message instead of assuming it went.

const STATUS_TTL_S = 3600;
const jobs = new Map(); // id -> { userId, run, onCancel, state, timer, promise }

const statusKey = (userId, id) => `send_hold:${userId}:${id}`;

async function writeStatus(userId, id, status) {
  try {
    await redisClient.set(statusKey(userId, id), JSON.stringify(status), { EX: STATUS_TTL_S });
  } catch (err) {
    console.warn('[sendHold] could not record status:', err.message);
  }
}

// Holds `run` for delayMs, then calls it. `run` resolves with the send result, or rejects with an
// error whose publicMessage is safe to show the user. It is passed a callback to call, with what
// is known of the result so far, as soon as the SMTP server has accepted the message, which records the send as delivered before the slower
// bookkeeping after it (the Sent copy), so a restart during that part cannot make a delivered
// message look like one that may never have left. Resolves { id, sendAt }.
export async function holdSend({ userId, delayMs, run, onCancel }) {
  const id = randomUUID();
  const sendAt = new Date(Date.now() + delayMs).toISOString();
  // Recorded before the timer exists, so a crash at any later point reads as 'pending'.
  await writeStatus(userId, id, { status: 'pending', sendAt });
  const job = { userId, run, onCancel, state: 'pending', timer: null, promise: null };
  job.timer = setTimeout(() => { start(id); }, delayMs);
  jobs.set(id, job);
  return { id, sendAt };
}

function start(id) {
  const job = jobs.get(id);
  if (!job) return null;
  if (job.state !== 'pending') return job.promise;
  job.state = 'sending';
  clearTimeout(job.timer);
  job.promise = (async () => {
    await writeStatus(job.userId, id, { status: 'sending' });
    try {
      const result = await job.run(early => writeStatus(job.userId, id, { status: 'sent', result: early || { ok: true } }));
      await writeStatus(job.userId, id, { status: 'sent', result });
    } catch (err) {
      await writeStatus(job.userId, id, {
        status: 'failed',
        error: err?.publicMessage || 'Failed to send message. Please try again.',
      });
    } finally {
      jobs.delete(id);
    }
  })();
  return job.promise;
}

// Cancels a send that has not started. Once delivery has begun it can no longer be taken back,
// and the caller gets the current status instead.
export async function cancelSend(userId, id) {
  const job = jobs.get(id);
  if (job && job.userId === userId && job.state === 'pending') {
    clearTimeout(job.timer);
    job.state = 'cancelled';
    jobs.delete(id);
    await writeStatus(userId, id, { status: 'cancelled' });
    try { await job.onCancel?.(); } catch (err) { console.warn('[sendHold] cancel cleanup failed:', err.message); }
    return { cancelled: true };
  }
  return { cancelled: false, ...(await getSendStatus(userId, id)) };
}

// { status: 'pending' | 'sending' | 'sent' | 'failed' | 'cancelled' | 'lost' | 'unknown', ... }
export async function getSendStatus(userId, id) {
  const job = jobs.get(id);
  if (job && job.userId === userId) return { status: job.state };
  let stored;
  try {
    const raw = await redisClient.get(statusKey(userId, id));
    stored = raw ? JSON.parse(raw) : null;
  } catch {
    return { status: 'unknown' };
  }
  if (!stored) return { status: 'unknown' };
  // Recorded but no longer held here: the process that held it is gone. A send that never
  // started was certainly not delivered; one that had started may or may not have been.
  if (stored.status === 'pending') return { status: 'lost' };
  if (stored.status === 'sending') return { status: 'unknown' };
  return stored;
}

// Delivers every held send now, for a graceful shutdown. Resolves with how many there were,
// once they have finished or timeoutMs has passed.
export async function flushHeldSends(timeoutMs = 8000) {
  const running = [...jobs.keys()].map(id => start(id)).filter(Boolean);
  if (!running.length) return 0;
  console.log(`[sendHold] delivering ${running.length} held send(s) before shutdown`);
  let timer;
  await Promise.race([
    Promise.allSettled(running),
    new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); }),
  ]);
  clearTimeout(timer);
  return running.length;
}

export function heldSendCount() {
  return jobs.size;
}
