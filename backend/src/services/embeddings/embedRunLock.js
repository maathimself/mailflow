// Process-wide single-flight guard for the embed worker. Both the periodic scheduler
// tick and the manual admin build acquire this before running a worker, so at most one
// runs at a time in-process — a scheduler tick skips while a manual build is active, and
// a manual build defers while a scheduler tick is mid-run (C1). It is a plain in-memory
// flag: it does not coordinate across processes (a multi-instance deploy relies on the
// idempotent upsert + CAS + coverage gate for cross-process safety, not this lock).
let _active = false;

// Returns true and takes the lock when free; returns false when already held.
export function tryAcquireEmbedRun() {
  if (_active) return false;
  _active = true;
  return true;
}

export function releaseEmbedRun() { _active = false; }

export function isEmbedRunActive() { return _active; }
