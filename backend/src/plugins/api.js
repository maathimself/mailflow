// The plugin API surface — the ONLY module a sandboxed (Tier-2) plugin is allowed to import
// from (v3.0 plugin platform).
//
// Everything a plugin may safely do lives here, re-exported from core so plugins never reach
// into core internals directly (no raw `db.js`/`query`, no `imapManager`, no service files). This
// is the boundary the enforcement lint rule guards: a plugin directory may import from './api.js'
// (this file) and its own siblings, and nothing else under src/.
//
// Tiers: a Tier-1 (trusted, in-repo) plugin like GTD may currently still import core directly
// while we migrate it onto this surface; the goal is that GTD ends up importing ONLY from here,
// at which point it — and any third-party plugin — can be owned and changed without a core
// security review. This module grows as capabilities are proven safe and GTD is moved onto them.
//
// What's intentionally NOT here (and never will be): the database handle, the IMAP/mail engine,
// other users' data, the Express app, filesystem/network. Mail actions are exposed only as narrow,
// pre-bound capabilities (apply a label, summarize a message, …), never as the raw manager.

import { getMailEngine } from './mailEngine.js';
import * as labelsWrite from '../services/labels.js';
import { archiveInboxCopy as _archiveInboxCopy } from '../services/archiveInbox.js';

// ── Labels (read) ─────────────────────────────────────────────────────────────
// Thread-aware read over a set of label folders: heads grouped by label with thread-level
// unread/union counts. See services/labelsRead.js for the correctness contract.
export { listThreadHeadsByLabels } from '../services/labelsRead.js';

// "Did an ordinary mail mutation touch one of my labelled threads?" → scoped user broadcast.
export { notifyOnLabelTouch } from '../services/labelsRead.js';

// ── Labels (write) ────────────────────────────────────────────────────────────
// Apply/remove a label (a message copy in a label folder) and mark a thread read. The mail
// engine is bound in by the platform (getMailEngine) so a plugin performs these mail actions
// without ever holding the engine itself. resolveLabelCopyUid is pure (no engine).
export const applyLabel = (account, message, labelFolder) => labelsWrite.applyLabel(getMailEngine(), account, message, labelFolder);
export const removeLabel = (message, labelFolder) => labelsWrite.removeLabel(getMailEngine(), message, labelFolder);
export const removeExactLabelCopy = (message, labelFolder, uid) => labelsWrite.removeExactLabelCopy(getMailEngine(), message, labelFolder, uid);
export const markThreadRead = (account, message) => labelsWrite.markThreadRead(getMailEngine(), account, message);
export const ensureLabelFolders = (account, folderPaths) => labelsWrite.ensureLabelFolders(getMailEngine(), account, folderPaths);
export const resolveLabelCopyUid = labelsWrite.resolveLabelCopyUid;

// ── Archive ───────────────────────────────────────────────────────────────────
// Archive a message's INBOX copy (used by GTD "done"). Engine bound by the platform.
export const archiveInboxCopy = (account, inboxCopy) => _archiveInboxCopy(getMailEngine(), account, inboxCopy);

// ── Realtime broadcast ────────────────────────────────────────────────────────
// Push a payload to a specific user's live sessions. A plugin can notify its own clients; it
// cannot address other users or subsystems (the engine + user scoping are enforced here).
export const broadcast = (payload, userId) => getMailEngine().broadcast(payload, userId);

// ── Summarize ─────────────────────────────────────────────────────────────────
// Condense a message into one line via the configured AI provider (fails closed when the
// provider is off / the summarize feature is disabled). No access to keys or the provider itself.
export { summarizeMessage, summarizeAvailable } from '../services/summarize.js';

// ── Per-plugin storage ────────────────────────────────────────────────────────
// Generic per-plugin key/value + blob storage (the plugin_data table), owner-scoped and cascade-
// cleaned. A plugin can persist its own data without a schema migration or DB access.
export * as storage from './storage.js';

// ── Logging ───────────────────────────────────────────────────────────────────
// Structured logger. A plugin may log; it cannot reach the transport or other subsystems.
export { logger } from '../services/logger.js';

// ── Auth ──────────────────────────────────────────────────────────────────────
// Express middleware to require an authenticated session on a plugin's own routes.
export { requireAuth } from '../middleware/auth.js';

// ── Activation ────────────────────────────────────────────────────────────────
// Whether a plugin is activated for a user (per-user, from preferences). A plugin composes this
// with its own config to decide whether it is effectively on for an account.
export { isPluginActivated, isPluginActivatedForAccount } from './activation.js';

// ── Per-account plugin config ───────────────────────────────────────────────────
// A plugin's own configuration for one account (opaque blob), cascade-cleaned with the account.
export { getAccountConfig, setAccountConfig } from './accountConfig.js';

// ── Folder resolution ─────────────────────────────────────────────────────────
// Resolve an account's Drafts folder paths (across provider naming). A safe read over the
// account's folder mapping — no mail engine, no raw DB.
export { resolveAllDraftsPaths } from '../utils/mailUtils.js';

// ── Mail/account reads ────────────────────────────────────────────────────────
// A fixed, reviewed set of ownership-scoped read queries (see services/mailAccess.js). A plugin
// reads mail/account data only through these — never raw SQL, never across users.
export {
  loadOwnedMessage,
  getOwnedAccount,
  listUserAccounts,
  getAccountAddresses,
  getThreadKeysForMessageIds,
  getThreadKeysInFolders,
  getThreadKeysForMessageIdHeaders,
  getMessagesByThreadKeys,
  getThreadKeyForUid,
  getMessageCopyFolders,
  getMessageFields,
  getMessageAnnotations,
  setMessageAnnotation,
} from '../services/mailAccess.js';
