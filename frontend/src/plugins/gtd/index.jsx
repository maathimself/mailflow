// GTD plugin — frontend registrations (v3.0 plugin platform).
//
// Registers GTD's UI into core's plugin slots so core components carry no GTD-specific code. This is
// the frontend twin of backend/src/plugins/gtd. Imported for its side effects by plugins/index.js.
// (The GTD UI components/utils still live under components/ & utils/ for now; later slices relocate
// them wholesale into this directory.)
import { registerSlot, registerPluginMeta, registerRuntime, registerCollector } from '../registry.js';
import { registerWsHandler, registerReconnectHandler } from '../events.js';
import GtdSidebarContent from '../../components/GtdSidebarContent.jsx';
import GtdRuntime from './GtdRuntime.jsx';
import GtdSettings from './GtdSettings.jsx';
import GtdRowDone from './GtdRowDone.jsx';
import { buildGtdContextItems } from './GtdContextMenu.jsx';
import { gtdActiveForContext } from '../../utils/gtd.js';
import { accountAffectsUnifiedInbox } from '../../utils/unifiedInbox.js';
import { useStore } from '../../store/index.js';
import GtdInboxIndicators from './GtdInboxIndicators.jsx';
import { invalidateGtdMetadata } from './metadataStore.js';

// Right-sidebar panel: GTD's triage rail. Live when GTD is on for the current account scope
// (per-user activation is already checked by the slot registry, so pass `true` here).
// ctx: { accounts, selectedAccountId, onCollapse, toggleHint }.
// Where GTD's own settings live, so the Plugins tab can point the user there once GTD is activated.
// Replaces core's former hardcoded PLUGIN_SETTINGS_LOCATION map (a nav fact core shouldn't own).
registerPluginMeta('gtd', {
  settingsLocation: { tab: 'categories', subtab: 'gtd', labelKey: 'admin.tabs.categories' },
});

// Headless runtime: owns the GTD sections fetch (mounted only while GTD is activated).
registerRuntime({ pluginId: 'gtd', component: GtdRuntime });

// Settings: GTD's per-account + pet settings block, shown under the Categories tab (rendered only
// while GTD is activated). ctx: { initialSubTab } — 'gtd' deep-links the block open.
registerSlot('settings-categories', {
  pluginId: 'gtd',
  render: (ctx) => <GtdSettings initialSubTab={ctx.initialSubTab} />,
});

registerSlot('right-sidebar', {
  pluginId: 'gtd',
  isActive: (ctx) => gtdActiveForContext(ctx.accounts, ctx.selectedAccountId, true),
  render: (ctx) => <GtdSidebarContent onCollapse={ctx.onCollapse} toggleHint={ctx.toggleHint} />,
});

// Context-menu items (GTD submenu + sidebar "Done"), injected into the 'Actions' group at the seam
// where GTD used to sit. ctx: { message, account, variant, onAction, onClose, openSubmenu, t }.
registerCollector('context-menu-actions', { pluginId: 'gtd', build: buildGtdContextItems });

// Row hover "done" checkmark on main-list rows of a GTD-active account (activation already gated by
// the registry). ctx: { message }.
registerSlot('row-hover-action', {
  pluginId: 'gtd',
  isActive: (ctx) => gtdActiveForContext(useStore.getState().accounts, ctx.message.account_id, true),
  // ctx.done (optional) lets a surface inject its own done action (the GTD sidebar's section-scoped
  // strip); the main list omits it and GtdRowDone runs its inbox-archive default.
  render: (ctx) => <GtdRowDone message={ctx.message} done={ctx.done} />,
});

registerSlot('message-row-meta', {
  pluginId: 'gtd',
  isActive: (ctx) => gtdActiveForContext(useStore.getState().accounts, ctx.message.account_id, true),
  render: (ctx) => <GtdInboxIndicators message={ctx.message} />,
});

// WS: a GTD label folder changed (tick / classify copy-remove / transition strip). Refetch the
// rail+tab sections when the event's account is in the current rail scope (debounced in the store).
registerWsHandler('gtd_sections_updated', {
  pluginId: 'gtd',
  handler: (data) => {
    const store = useStore.getState();
    if (
      (store.selectedAccountId === null && accountAffectsUnifiedInbox(store.accounts, data.accountId)) ||
      store.selectedAccountId === data.accountId
    ) {
      store.scheduleGtdSectionsFetch();
      invalidateGtdMetadata();
    }
  },
});

// On WS reconnect, gtd_sections_updated events fired during the outage are lost (not buffered).
// Refetch the sections if GTD is active in the current scope (activation is already gated by the
// dispatcher, so the account-scope check is what matters here).
registerReconnectHandler({
  pluginId: 'gtd',
  handler: () => {
    const { accounts, selectedAccountId, scheduleGtdSectionsFetch } = useStore.getState();
    if (gtdActiveForContext(accounts, selectedAccountId, true)) {
      scheduleGtdSectionsFetch();
      invalidateGtdMetadata();
    }
  },
});
