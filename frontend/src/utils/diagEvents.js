// In-memory (+ localStorage-persisted) diagnostic event ring for the diagnostics
// report (Phase 2).
//
// Records a small trace of unread-count / new-mail / reconnect activity so a
// shared report can show recent client-side sync behavior — and survives a page
// reload so a report generated after a refresh still has context. PII-free by
// construction: causes, counts, and a raw account id that the report hashes with
// the per-report salt before it ever leaves the browser. Never sent anywhere on
// its own. Per-viewer, local-only.

const CAP = 200;
const STORE_KEY = 'mailexpert_diag_events';

let events = [];
try {
  const saved = localStorage.getItem(STORE_KEY);
  if (saved) events = JSON.parse(saved).slice(-CAP);
} catch { /* private mode / cleared storage — start empty */ }

let saveTimer = null;
function persist() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { localStorage.setItem(STORE_KEY, JSON.stringify(events)); } catch { /* quota / private mode */ }
  }, 2000);
  saveTimer?.unref?.(); // don't keep a Node test process alive
}

export function recordDiagEvent(entry) {
  if (!entry || typeof entry !== 'object') return;
  events.push({ t: new Date().toISOString(), ...entry });
  if (events.length > CAP) events.shift();
  persist();
}

export function getDiagEvents() {
  return events.slice();
}

export function _resetDiagEvents() {
  events.length = 0;
  try { localStorage.removeItem(STORE_KEY); } catch { /* ignore */ }
}
