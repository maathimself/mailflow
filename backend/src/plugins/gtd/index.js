// GTD plugin manifest (Tier-1, bundled) — the first plugin registered with the platform.
//
// This hands GTD's existing router to the registry so route mounting is driven by the plugin
// system rather than a hardcoded line in index.js, and registers GTD's sync-engine hook
// handlers so the sync engine (imapManager) can consult GTD generically — with no GTD imports
// of its own. GTD's code still lives under routes/ and services/; later phases move its
// storage and UI behind the plugin boundary. Behavior is unchanged.
import gtdRoutes from './routes.js';
import { relocateExemptFolders, sectionsChanged, inboxIngest, afterLabelCopy, afterLabelRemove, messageRowsDeleted, messageRowsIngested, onMailMutation, onSentMessage, onUserDelete, enrichAccount, validateAccountSettings, persistAccountSettings, onAccountIdentityChanged, onPluginActivationChanged, gtdEnabledForAccount, gtdSyncTick } from './hooks.js';

export const gtdPlugin = {
  id: 'gtd',
  name: 'Getting Things Done',
  version: '1.0.0',
  tier: 1,
  // Mounted at the /api/gtd subtree (not bare /api) so gtd.js's router-level requireAuth
  // cannot intercept the unauthenticated /api/health and /api/version probes.
  router: { base: '/api/gtd', handler: gtdRoutes },
  // Sync-engine capabilities GTD contributes. Core fires these through the registry; each is
  // the GTD half of a generic hook (see ./hooks.js). relocateExemptFolders/sectionsChanged run
  // unconditionally and self-gate (empty/no-op when GTD is disabled), matching the pre-plugin
  // behavior that read the DB every time. inboxIngest carries a per-hook isActive gate so core
  // skips collecting candidates entirely for non-GTD accounts (the old `account.gtd_enabled`).
  hooks: {
    relocateExemptFolders,
    sectionsChanged,
    inboxIngest: { handler: inboxIngest, isActive: gtdEnabledForAccount },
    // Fired by the generic label copy/remove primitives (imapManager.copyMessage/
    // removeMessageCopy). Unconditional like the pre-plugin manager-level emit — they only
    // broadcast (and, for copy, run a gtd_enabled-gated deferred reconcile inside the handler).
    afterLabelCopy,
    afterLabelRemove,
    messageRowsDeleted: { handler: messageRowsDeleted, isActive: gtdEnabledForAccount },
    messageRowsIngested: { handler: messageRowsIngested, isActive: gtdEnabledForAccount },
    // Fired by the mail/send/admin routes for ordinary mail mutations, sent-message sync, and
    // user deletion. Each self-gates internally (gtd_enabled / pet-slug presence), so they stay
    // unconditional here and match the pre-plugin direct calls.
    onMailMutation,
    onSentMessage,
    onUserDelete,
    // Fired by the account-settings routes: enrich the GET response with GTD's per-account config
    // (it's no longer a column), validate GTD's own fields before the write, persist them into the
    // plugin config store, and invalidate GTD's identity cache. This is the account-scoped settings
    // surface future plugins reuse.
    enrichAccount,
    validateAccountSettings,
    persistAccountSettings,
    onAccountIdentityChanged,
    // Fired by the plugin-management route when the user toggles GTD's activation: invalidate the
    // per-account config cache so getGtdConfig's effective gate flips at once.
    onPluginActivationChanged,
  },
  // Periodic background tick core arms per connected account whose gtd_enabled gate passes. Keeps
  // the non-INBOX GTD label folders (Todo/Watch/…) fresh — INBOX gets IDLE + the fast tick, but
  // label folders otherwise sync on open only. Slower cadence on purpose: label folders change far
  // less than INBOX. Uses only core's generic sync-capability primitives (see gtdSyncTick).
  sync: {
    intervalMs: 120000,
    isActive: gtdEnabledForAccount,
    tick: gtdSyncTick,
  },
};
