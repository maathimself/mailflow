// Plugin registry — the backbone of the MailExpert plugin platform (v3.0).
//
// This module holds registered plugin manifests and exposes the primitives core
// uses to consult them. It is intentionally inert until plugins are registered and
// until core hook-sites call `runHook`/`collectHook`; on its own it changes no
// behavior. See project_plugin_system for the extraction design.
//
// A plugin manifest (all fields optional except `id`, `name`, `version`, `tier`):
//   {
//     id:      'gtd',                       // unique, stable, [a-z0-9-]
//     name:    'Getting Things Done',
//     version: '1.0.0',
//     tier:    1,                           // 1 = trusted/in-repo, 2 = sandboxed/third-party
//     migrations?: '/abs/path/to/dir',      // plugin-owned SQL migrations (run by the migrator)
//     router?:  { base: '/api/gtd', handler, json?: { limit } }, // Express router to mount
//     hooks?:   { [hookName]: handler },     // event/collect handlers — see below
//     isActive?: (ctx) => boolean,          // gate ALL of this plugin's handlers per call
//   }
//
// A hook entry is either a bare handler function `async (ctx) => value | void`, or an object
// `{ handler, isActive }` whose per-hook `isActive(ctx)` gates just THAT hook (in addition to
// the manifest-level isActive). Per-hook gating lets one plugin expose, say, an always-on
// value-contribution hook alongside an event hook that only fires for accounts where the
// feature is enabled — without the two gates interfering.
//
// `hooks` is where core consults plugins:
//   - runHook(name, ctx)     — fire every active plugin's handler, await all, SWALLOW errors.
//                              For side-effect events (sectionsChanged, inboxIngest…).
//                              A throwing plugin can never break a core request or a sync tick.
//   - collectHook(name, ctx) — call every active plugin's handler and return the defined
//                              results as an array (for value contributions, e.g. the set of
//                              relocate-exempt label folders). Errors are swallowed per-plugin
//                              and simply contribute nothing.
//   - hasActive(name, ctx)   — whether any plugin has an active handler for `name` in this ctx.
//                              A cheap synchronous gate core uses to skip collecting work when no
//                              plugin would consume it (e.g. inbox-ingest candidate tracking).

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function createPluginRegistry() {
  /** @type {Map<string, object>} id -> manifest */
  const plugins = new Map();

  function register(manifest) {
    if (!manifest || typeof manifest !== 'object') {
      throw new Error('plugin manifest must be an object');
    }
    const { id, name, version, tier } = manifest;
    if (!ID_RE.test(id || '')) {
      throw new Error(`plugin id must match ${ID_RE} (got ${JSON.stringify(id)})`);
    }
    if (plugins.has(id)) throw new Error(`plugin "${id}" is already registered`);
    if (!name || typeof name !== 'string') throw new Error(`plugin "${id}" needs a name`);
    if (!version || typeof version !== 'string') throw new Error(`plugin "${id}" needs a version`);
    if (tier !== 1 && tier !== 2) throw new Error(`plugin "${id}" tier must be 1 or 2 (got ${tier})`);
    if (manifest.hooks && typeof manifest.hooks !== 'object') {
      throw new Error(`plugin "${id}" hooks must be an object`);
    }
    for (const [hookName, entry] of Object.entries(manifest.hooks || {})) {
      const ok = typeof entry === 'function' || (entry && typeof entry.handler === 'function');
      if (!ok) throw new Error(`plugin "${id}" hook "${hookName}" must be a function or { handler }`);
    }
    plugins.set(id, manifest);
    return manifest;
  }

  const get = (id) => plugins.get(id);
  const list = () => [...plugins.values()];
  const has = (id) => plugins.has(id);

  // Normalize a hook entry to { handler, isActive } (isActive null when the entry is a bare
  // function). Returns null for a malformed/absent entry so activeHandlers can skip it.
  function resolveHook(entry) {
    if (typeof entry === 'function') return { handler: entry, isActive: null };
    if (entry && typeof entry.handler === 'function') {
      return { handler: entry.handler, isActive: typeof entry.isActive === 'function' ? entry.isActive : null };
    }
    return null;
  }

  // Every active plugin that declares `hookName`. A plugin is active for a call when neither its
  // manifest-level isActive nor the hook's own isActive rejects this ctx (a missing predicate is
  // treated as always-active). A throwing predicate excludes the plugin rather than breaking the
  // dispatch.
  function activeHandlers(hookName, ctx) {
    const out = [];
    for (const p of plugins.values()) {
      const resolved = resolveHook(p.hooks?.[hookName]);
      if (!resolved) continue;
      try {
        if (p.isActive && !p.isActive(ctx)) continue;
        if (resolved.isActive && !resolved.isActive(ctx)) continue;
      } catch {
        continue;
      }
      out.push([p, resolved.handler]);
    }
    return out;
  }

  // Cheap synchronous check: does any plugin have an active handler for `hookName` in this ctx?
  const hasActive = (hookName, ctx) => activeHandlers(hookName, ctx).length > 0;

  // Async variant of hasActive: awaits each plugin's (possibly async) isActive predicate. Needed
  // when a hook's gate reads state asynchronously — e.g. GTD's per-account config now lives in the
  // plugin_account_config table, so `gtdEnabledForAccount` is async. activeHandlers (sync) can't
  // await it, so any core gate that must know "is this hook actually active for this ctx" ahead of
  // running it (the inbox-ingest gate in syncMessages, the per-account sync-timer arm) uses this.
  async function hasActiveAsync(hookName, ctx) {
    for (const p of plugins.values()) {
      const resolved = resolveHook(p.hooks?.[hookName]);
      if (!resolved) continue;
      try {
        if (p.isActive && !(await p.isActive(ctx))) continue;
        if (resolved.isActive && !(await resolved.isActive(ctx))) continue;
      } catch {
        continue;
      }
      return true;
    }
    return false;
  }

  // Fire-and-forget: run all active handlers, await them, never throw. Individual failures
  // are swallowed (and returned for optional logging) so one plugin can't break core.
  async function runHook(hookName, ctx) {
    const handlers = activeHandlers(hookName, ctx);
    const errors = [];
    await Promise.all(handlers.map(async ([p, fn]) => {
      try { await fn(ctx); }
      catch (err) { errors.push({ pluginId: p.id, error: err }); }
    }));
    return errors;
  }

  // Value collection: return each active handler's defined result. Errors contribute nothing.
  async function collectHook(hookName, ctx) {
    const handlers = activeHandlers(hookName, ctx);
    const results = await Promise.all(handlers.map(async ([, fn]) => {
      try { return await fn(ctx); }
      catch { return undefined; }
    }));
    return results.filter((r) => r !== undefined);
  }

  return { register, get, list, has, runHook, collectHook, hasActive, hasActiveAsync };
}

// The process-wide registry. Core imports this; plugins register into it at boot.
export const pluginRegistry = createPluginRegistry();
