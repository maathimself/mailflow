// Frontend plugin slot registry (v3.0 plugin platform — frontend half).
//
// The backend gives each plugin a bounded capability surface; this is its frontend twin. A Tier-1
// plugin registers UI contributions into named "slots"; core components render a slot via
// <PluginSlot/> / usePluginSlot (see PluginSlot.jsx) without importing or hard-conditioning any
// specific plugin. Core places the seam; the plugin fills it. Registration is side-effecting at
// module load (see plugins/index.js), mirroring the backend's in-process registry.
//
// A contribution: { pluginId, order?, isActive?(ctx), render(ctx) }.
//  - pluginId — gated by per-user activation (store.enabledPlugins) at render time, so a
//    deactivated plugin contributes nothing.
//  - order    — ascending sort within a slot (default 0) for deterministic placement.
//  - isActive — a finer, context-scoped gate beyond activation (e.g. "GTD is on for this account");
//    defaults to always-on. Activation is checked separately, so isActive need not re-check it.
//  - render   — (ctx) => ReactNode. ctx is the slot's documented data contract.

const slots = new Map(); // slotName -> Array<contribution>

export function registerSlot(slotName, contribution) {
  const list = slots.get(slotName) || [];
  list.push({ order: 0, isActive: () => true, ...contribution });
  list.sort((a, b) => a.order - b.order);
  slots.set(slotName, list);
}

export function getSlotContributions(slotName) {
  return slots.get(slotName) || [];
}

// Static per-plugin metadata a plugin declares about itself, so core never hardcodes plugin facts.
// e.g. settingsLocation: { tab, subtab, labelKey } tells the Plugins tab where a plugin's own
// settings live, replacing core's former hardcoded PLUGIN_SETTINGS_LOCATION map.
const pluginMeta = new Map(); // pluginId -> meta object

export function registerPluginMeta(pluginId, meta) {
  pluginMeta.set(pluginId, { ...pluginMeta.get(pluginId), ...meta });
}

export function getPluginMeta(pluginId) {
  return pluginMeta.get(pluginId) || null;
}

// Headless runtime components a plugin mounts once (near the app root) to run background behaviour
// with no UI of its own — data-fetch effects, subscriptions, timers. Rendered by <PluginRuntime/>
// only while the plugin is activated, so a plugin's effects tear down when the user deactivates it.
const runtimes = []; // [{ pluginId, component }]

export function registerRuntime(contribution) {
  runtimes.push(contribution);
}

export function getRuntimes() {
  return runtimes;
}

// Data (descriptor) contributions a plugin injects into a core-rendered list — e.g. context-menu
// items. Unlike slots (which render), a collector's `build(ctx)` returns plain descriptor arrays that
// core renders with its OWN chrome (so placement/styling stay consistent). Gathered via
// usePluginCollected, activation-gated.
const collectors = new Map(); // name -> [{ pluginId, build }]

export function registerCollector(name, contribution) {
  const list = collectors.get(name) || [];
  list.push(contribution);
  collectors.set(name, list);
}

export function getCollectors(name) {
  return collectors.get(name) || [];
}

const editorExtensions = [];

export function registerEditorExtension(pluginId, extension) {
  editorExtensions.push({ pluginId, extension });
}

export function getEditorExtensions() {
  return editorExtensions;
}
