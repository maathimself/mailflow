import { query } from './db.js';

// Default GTD state → folder-path map. An account's gtd_folders JSONB overrides
// individual entries; any state it omits falls back to the value here. An empty
// gtd_folders object therefore means "use all defaults".
export const DEFAULT_GTD_FOLDERS = {
  todo: 'Todo',
  watch: 'Watch',
  delegated: 'Delegated',
  someday: 'Someday',
  reference: 'Reference',
};

// The five valid GTD states. A classify request's `state` must be one of these.
export const GTD_STATES = ['todo', 'watch', 'delegated', 'someday', 'reference'];

// Resolve a GTD state name to its destination folder path using a resolved
// folders map (DEFAULT_GTD_FOLDERS merged with the account's overrides). Returns
// null for an unknown state so the classify route can reject it with a 400.
// Pure — no DB — so it is unit-testable without standing up an account.
export function resolveGtdStateFolder(state, folders) {
  if (!GTD_STATES.includes(state)) return null;
  const path = folders?.[state];
  return typeof path === 'string' && path.trim() ? path : null;
}

// Upper bound on a stored folder path. imapflow quoting and parameterized SQL
// already neutralize the sharp edges, but the sanitizer enforces a sane cap itself
// so a crafted payload can't bloat the JSONB or the mailbox name.
const MAX_GTD_FOLDER_LEN = 255;

// A `..` path segment (split on the standard IMAP hierarchy separator) is rejected
// as path-traversal defense-in-depth. A folder whose name merely contains dots
// (e.g. "a..b", a single segment) is left alone.
function hasTraversalSegment(path) {
  return path.split('/').includes('..');
}

// Full paths a GTD state may NOT map to. /done's label strip is a permanent delete of the
// label-folder copy, so mapping a state onto a live system folder (INBOX, Sent, …) would
// permanently delete real mail on every done. Reject them outright rather than silently
// falling back — a nested "Work/Todo" or a plain "Todo" is fine; only these exact full
// paths (case-insensitive) and Gmail's special "[Gmail]/…" tree are denied.
const RESERVED_GTD_FOLDER_NAMES = new Set(['inbox', 'sent', 'drafts', 'trash', 'junk', 'spam', 'archive']);
function isReservedFolderPath(path) {
  const lower = path.toLowerCase();
  return RESERVED_GTD_FOLDER_NAMES.has(lower) || lower.startsWith('[gmail]/');
}

// Validate a client-supplied gtd_folders map down to a clean overrides object AND
// report which provided values were rejected. Only the five known GTD states are
// considered; each must be a non-empty trimmed string within the length cap, free of
// `..` segments, and not a reserved system-folder path. Unknown keys, blank values, and
// non-string values fall back to the default silently (not reported). A provided-but-invalid
// value drops to the default and its state name is reported: over-long/traversal in
// `rejected` (a settings-form hint), a reserved system folder in `reserved` (the caller
// turns this into a 400, since /done's label strip would otherwise permanently delete mail
// in a live system folder). Every value is dropped from `folders`, so a reserved mapping
// can never be persisted even by a caller that ignores `reserved`. Pure.
export function sanitizeGtdFoldersDetailed(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { folders: {}, rejected: [], reserved: [] };
  const folders = {};
  const rejected = [];
  const reserved = [];
  for (const state of GTD_STATES) {
    const val = input[state];
    if (typeof val !== 'string') continue; // absent/non-string → default, silent
    const trimmed = val.trim();
    if (!trimmed) continue; // blank → default, silent
    if (trimmed.length > MAX_GTD_FOLDER_LEN || hasTraversalSegment(trimmed)) {
      rejected.push(state); // provided but invalid → default, reported
      continue;
    }
    if (isReservedFolderPath(trimmed)) {
      reserved.push(state); // provided but reserved → default, reported as a hard rejection
      continue;
    }
    folders[state] = trimmed;
  }
  return { folders, rejected, reserved };
}

// Overrides-only view of the above, used where the rejection report isn't needed
// (the "create missing folders" route). Same clean overrides object as before.
export function sanitizeGtdFolders(input) {
  return sanitizeGtdFoldersDetailed(input).folders;
}

// Detect GTD states that resolve to the SAME folder path. Two states sharing a
// folder makes the gtd_sections CTE join that folder against both state rows,
// double-listing every thread there across two rail/tab sections — so the save
// path rejects such a mapping. Expects a fully-resolved five-state map (defaults
// already merged in). Returns collision groups [{ folder, states }] (empty when
// every state is distinct). Pure.
export function findGtdFolderCollisions(folders) {
  const byFolder = new Map();
  for (const state of GTD_STATES) {
    const path = folders?.[state];
    if (typeof path !== 'string' || !path.trim()) continue;
    const key = path.trim();
    if (!byFolder.has(key)) byFolder.set(key, []);
    byFolder.get(key).push(state);
  }
  const collisions = [];
  for (const [folder, states] of byFolder) {
    if (states.length > 1) collisions.push({ folder, states });
  }
  return collisions;
}

// Reconcile the account's stored gtd_folders against the effective server paths that
// /folders/ensure just observed. On a prefixed-namespace server the configured bare name
// ('Todo') lands at a different real path ('INBOX.Todo'); the GTD pipeline must key on the
// real path or it drifts from the folder-list row (the residual from the namespace-aware
// creation work). Given `merged` (the configured five-state map ensure ran against), the
// account's `stored` gtd_folders overrides, and the ensure `results` ([{ folder, path,
// error? }]), overlay each state whose server path differs from its configured name onto
// the current overrides. Returns exactly one of:
//   { changed: false }             — every folder landed where configured; no write
//   { changed: false, collisions } — persisting would point two states at one folder
//   { changed: true, folders }     — the overrides map to persist (sanitised)
// The candidate map is re-sanitised (255-cap / traversal) and collision-checked with the
// same contract the save path uses, so a server-returned path can't smuggle in an invalid
// or double-listing mapping. Pure — no DB — so it is unit-testable without an account.
export function planGtdFolderPersist({ merged, stored, results } = {}) {
  const effective = new Map();
  for (const r of Array.isArray(results) ? results : []) {
    if (r && !r.error && typeof r.path === 'string' && r.path) effective.set(r.folder, r.path);
  }
  // Start from the account's current sanitised overrides and overlay only the states the
  // server relocated (effective path present and differing from the configured name).
  const current = sanitizeGtdFolders(stored);
  const next = { ...current };
  for (const state of GTD_STATES) {
    const configured = merged?.[state];
    const eff = effective.get(configured);
    if (eff && eff !== configured) next[state] = eff;
  }
  // Re-sanitise so a server-returned path over the cap or with a `..` segment falls back to
  // the default (same contract as save) rather than being stored. Canonical key order from
  // sanitizeGtdFolders makes the stringify comparison order-stable.
  const folders = sanitizeGtdFolders(next);
  if (JSON.stringify(folders) === JSON.stringify(current)) return { changed: false };
  const collisions = findGtdFolderCollisions({ ...DEFAULT_GTD_FOLDERS, ...folders });
  if (collisions.length) return { changed: false, collisions };
  return { changed: true, folders };
}

// Per-account GTD config cache. Structure: Map<accountId, { value, expiry }>
// where value = { enabled, folders }. Short TTL mirrors the social-domain cache
// in categorizer.js. Invalidated by invalidateGtdConfigCache() below, which the
// account settings route (PUT /api/accounts/:id) calls whenever gtd_enabled or
// gtd_folders changes.
const gtdConfigCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function invalidateGtdConfigCache(accountId) {
  gtdConfigCache.delete(accountId);
}

// Returns { enabled, folders } for an account. `folders` is the full five-state
// map with the account's stored gtd_folders merged over DEFAULT_GTD_FOLDERS.
// Cached with a short TTL; a missing account row reads as disabled + defaults.
export async function getGtdConfig(accountId) {
  const cached = gtdConfigCache.get(accountId);
  if (cached && cached.expiry > Date.now()) return cached.value;

  const result = await query(
    'SELECT gtd_enabled, gtd_folders FROM email_accounts WHERE id = $1',
    [accountId]
  );
  const row = result.rows[0];
  const enabled = row?.gtd_enabled === true;
  // gtd_folders is JSONB; the pg driver parses it into an object already.
  const stored = row?.gtd_folders && typeof row.gtd_folders === 'object' ? row.gtd_folders : {};
  // Legacy hardening: a mapping saved before the reserved-folder denylist existed
  // could point a state at a system folder. /done would then permanently delete real
  // mail, so drop only reserved values on read and fall back to the safe default;
  // length/traversal values retain their existing read-through behavior.
  const safeStored = {};
  for (const [state, val] of Object.entries(stored)) {
    if (typeof val === 'string' && isReservedFolderPath(val.trim())) continue;
    safeStored[state] = val;
  }
  // Falling back to the default can synthesize a collision the stored config
  // didn't have (legacy {todo:'INBOX', watch:'Todo'} → both 'Todo'), so that
  // folder lists under two rail sections. Cosmetic, and strictly better than
  // acting on a reserved folder.
  const folders = { ...DEFAULT_GTD_FOLDERS, ...safeStored };

  const value = { enabled, folders };
  gtdConfigCache.set(accountId, { value, expiry: Date.now() + CACHE_TTL_MS });
  return value;
}

// Set of the account's designated GTD folder paths, or an empty Set when GTD is
// disabled. Used to exempt these folders from the move-detector relocate guard.
export async function getGtdFolderSet(accountId) {
  const { enabled, folders } = await getGtdConfig(accountId);
  if (!enabled) return new Set();
  return new Set(Object.values(folders));
}

// Pure schedule decision for the periodic GTD sync tick: given a config
// ({ enabled, folders }), return the distinct folder paths the tick should sync,
// or an empty array when GTD is disabled. Kept pure and exported so the tick's
// "inert when disabled" contract is unit-testable without standing up a manager.
export function gtdTickFolders({ enabled, folders } = {}) {
  if (!enabled || !folders) return [];
  return [...new Set(Object.values(folders))];
}
