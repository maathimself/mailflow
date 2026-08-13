import { AsyncLocalStorage } from 'node:async_hooks';

// One process-wide queue per account/thread. Delegation writes and label-removal cleanup must
// share this lock: otherwise a final-copy removal can clear the snapshot after a concurrent
// delegation call has just recreated the label and written a new snapshot.
const queues = new Map();
const ownership = new AsyncLocalStorage();

export async function withGtdDelegationLock(accountId, threadKey, work) {
  const key = `${accountId}\0${threadKey}`;
  const held = ownership.getStore()?.get(key);
  if (held?.active) return work();

  const previous = queues.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(async () => {
    const token = { active: true };
    const context = new Map(ownership.getStore() || []);
    context.set(key, token);
    try {
      return await ownership.run(context, work);
    } finally {
      token.active = false;
    }
  });
  queues.set(key, current);
  try {
    return await current;
  } finally {
    if (queues.get(key) === current) queues.delete(key);
  }
}
