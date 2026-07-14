// Per-key async serializer: operations submitted for a given key run strictly one
// at a time, in submission order, so they can never overlap. Operations for
// different keys run independently.
//
// Used by the account update route to serialize a single account's reconnect
// triggers. A rapid gtd_enabled double-toggle would otherwise fire two overlapping
// disconnect→connect chains; connectAccount's in-progress guard silently drops the
// second, which can leave the GTD sync tick's armed state out of sync with the
// final DB value. Queuing the reconnects per account id makes the last-scheduled
// reconnect run last, so the armed state reflects the final row.
//
// Each key's chained tail is dropped once idle, so keys don't leak.
export function createKeyedSerializer() {
  const tails = new Map();
  return function run(key, op) {
    const prev = tails.get(key) || Promise.resolve();
    // Chain off the previous op regardless of how it settled; the caller still gets
    // this op's own outcome via `result`.
    const result = prev.then(() => op(), () => op());
    // The tail never rejects, so a failed op doesn't break the next queued one.
    const tail = result.then(() => {}, () => {});
    tails.set(key, tail);
    tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
    return result;
  };
}
