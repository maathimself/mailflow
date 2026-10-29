# MailFlow plugins

MailFlow features can live as **plugins**: self-contained modules that talk to core only through a
fixed, reviewed capability surface. **GTD** (`gtd/`) is the reference plugin and the first fully
extracted one.

The point of the boundary is trust: a plugin **cannot** reach into core, the mail engine, the
database, the network, or other users' data — so a plugin change can be reviewed for *feature
correctness*, not for whether it could compromise the app. That's what lets a contributor own a
plugin without a deep security review of every PR.

Two tiers (conceptual): **Tier-1** = trusted, in-repo (like GTD today); **Tier-2** = untrusted /
third-party. Both use the *same* capability surface — GTD was migrated fully onto it so the surface
is proven.

---

## Where things live

| | Path |
|---|---|
| Backend plugin code | `backend/src/plugins/<name>/` |
| Backend capability surface (the ONLY core import a plugin may use) | `backend/src/plugins/api.js` |
| Import-boundary lint rule | `backend/eslint.plugins-boundary.js` (`npm run lint:plugins`) |
| Frontend plugin code | `frontend/src/plugins/<name>/` |
| Frontend slot registry | `frontend/src/plugins/registry.js`, `PluginSlot.jsx`, `events.js` |

---

## Backend

### The rule

A file under `src/plugins/<name>/` may import **only**:
- `../api.js` (the capability surface), and
- its own siblings inside `src/plugins/<name>/`.

It may **not** import `../../services`, `../../utils`, `../../routes`, `../../middleware`,
`../../index`, or platform internals (`../registry.js`, `../storage.js`, …). This is enforced by
`eslint.plugins-boundary.js`. At runtime a plugin's hooks receive a **bounded engine facade**
(`mailEngineFacade.js`), never the raw mail engine.

Run it locally:

```bash
cd backend
npm run lint:plugins   # boundary check — must be 0 violations
npm run lint           # normal lint
npm test               # full suite
```

### Capability surface (`api.js`)

Everything a plugin may do, grouped:

- **Labels (read):** `listThreadHeadsByLabels`, `getLabelMetadata` (up to 100 account-scoped row IDs; live thread/message copies and oldest message date per folder), `notifyOnLabelTouch`, `hasMessageCopy` (checks one copy on the server), `isLabelStoreAccount` (Gmail: folders are labels), `supportsUidPlus` (whether a move names the new uid; false when unknown)
- **Labels (write):** `applyLabel`, `removeLabel`, `markThreadRead`, `markCopySeen`, `ensureLabelFolders`, `resolveLabelCopyUid`
- **Archive:** `archiveInboxCopy`
- **Realtime:** `broadcast` (scoped to one user)
- **Summarize:** `summarizeMessage({ userId, … })`, `summarizeAvailable(userId)` (both fail closed when the AI provider or summaries are off, or AI is turned off for that user)
- **Per-plugin storage:** `storage.*` (the `plugin_data` table — KV + blobs, owner-scoped, cascade-cleaned)
- **Per-account plugin config:** `getAccountConfig`, `setAccountConfig` (the `plugin_account_config` table)
- **Per-message annotations:** `getMessageAnnotations`, `setMessageAnnotation` (namespaced `messages.plugin_annotations`)
- **Activation:** `isPluginActivated`, `isPluginActivatedForAccount`
- **Logging:** `logger` · **Auth middleware:** `requireAuth` · **Folder resolution:** `resolveAllDraftsPaths`, `resolveAllTrashPaths`, `resolveAllSpamPaths`
- **Ownership-scoped mail/account reads:** `loadOwnedMessage`, `getOwnedAccount`, `listUserAccounts`, `getAccountAddresses`, `getMessagesByThreadKeys`, `getMessageCopyFolders`, `getMessageFields`, the thread-key resolvers, …

If you need something not here, **don't reach around the boundary** — ask, and we add a reviewed
capability to `api.js`. That's a small, deliberate core change; the boundary stays intact.

### Manifest + registration

A plugin exports a manifest (see `gtd/index.js`): `{ id, name, version, tier, router?, hooks?, sync? }`.
Core mounts the router and fires the hooks through the registry — core never calls a plugin directly.
`hooks` are the plugin's halves of generic core events (e.g. `inboxIngest`, `afterLabelCopy`,
`onSentMessage`, `validateAccountSettings`, `enrichAccount`, …); `sync` is an optional periodic tick.

### Data

No plugin-specific columns/tables in core. Plugin data lives in generic stores: `plugin_data`
(KV/blobs), `plugin_account_config` (per-account config), `messages.plugin_annotations` (per-message,
namespaced by plugin id). All cascade-clean with their owner.

---

## Frontend

Core carries no plugin-specific UI code. A plugin registers into a small in-process registry
(imported once at startup via `frontend/src/plugins/index.js`), activation-gated on
`store.enabledPlugins`:

- `registerSlot(name, { pluginId, isActive?, render })` — render UI at a core seam (`right-sidebar`,
  `settings-categories`, `row-hover-action`, …). Rendered with `<PluginSlot>` / `usePluginSlot`.
- `registerCollector(name, { pluginId, build })` — contribute descriptor arrays core renders with its
  own chrome (e.g. context-menu items). Read with `usePluginCollected`.
- `registerRuntime({ pluginId, component })` — a headless component (renders null) that runs
  background effects/subscriptions only while the plugin is activated.
- `registerWsHandler(type, { pluginId, handler })` / `registerReconnectHandler(...)` — handle WS
  message types core doesn't, and resync on reconnect.
- `registerPluginMeta(pluginId, meta)` — static metadata (e.g. where the plugin's settings live).

The `settings-tabs` collector receives `{ user, isMobile }` and contributes
`{ id, group, labelKey, icon, render }` descriptors. Use `group: 'mail'` to appear under Mail.
Deactivated plugins lose their tabs automatically, including settings search entries.

The `compose-actions` slot appears in the rich-text toolbar's More submenu and the plain-text
action strip. Its context exposes `{ editor, sessionId, disabled, htmlMode, plaintextEmail,
isMobile, captureSelection, applyPreset }`. Capture the selection before opening a picker, then
call `applyPreset({ to, cc, bcc, subject, body }, selection)` with HTML content. Core sanitizes and
inserts the body, merges recipients, and fills an empty subject. Async pickers must discard results
when unmounted or when `sessionId` changes. Reusable content editors can use
`ComposeContentEditor` to share the composer's extensions, image handling, and formatting toolbar.
Its optional `renderActions({ disabled, captureSelection, insertText })` contributes controls to
More. `insertText(text, selection)` inserts literal text in rich-text or HTML-source mode and
restores the saved caret. Templates uses it for variables such as `{{ contact.fullName }}` and
the editable `{{ add placeholder }}` marker. Variable identifiers remain untranslated. Tokens
stay intact in templates and drafts and expand in the server's `outgoingContent` hook at send
time. Date values use the attempt's Date and the composer's locale/time zone (UTC/en for API
clients that omit them). Contact values come from each distinct To, Cc, and Bcc recipient,
scoped to the sender's own contacts; additional vCard fields supply addresses, titles, and name
prefixes/suffixes. A content transform returns `personalize: true` to request isolated delivery
for every recipient. Core controls recipient selection, deduplication, SMTP envelopes, and
stable individual Message-IDs. To/Cc headers keep their normal visibility; Bcc stays hidden.
All variable values are validated before any copy is sent. Ordinary and date-only messages
remain a single group delivery. MIME copies are built one at a time to bound attachment memory.
Missing values and unfilled placeholders stop sending with an error. HTML replacements are
escaped and limited to message text, never HTML attributes or quoted/forwarded mail.
`transformHook` awaits activation gates, runs transformations in order, and propagates errors.
Scheduled sends save expanded content in their encrypted payload before SMTP, so recovery uses
the same content even if contacts or plugin activation change after delivery. Personalized jobs
also checkpoint attempts and acceptances per recipient. An interrupted group is uncertain,
never automatically retried as a whole; explicit retries skip confirmed recipients. A Sent
copy for one recipient does not prove that the rest were delivered. Immediate/Undo Send groups
retain an idempotency reservation after partial delivery and report the interruption. Each
delivered variant gets its own Sent copy; the original draft is removed only after completion.

Templates is a bundled, per-user opt-in plugin. It stores private records through `storage.put`
and lists only the current owner's records through `storage.listValues(pluginId, ownerId)`.

The neutral `message-row-meta` slot receives `{ message }` on ordinary flat and threaded rows.
GTD fills it for inbox/search with its own metadata endpoint, account gating and state chips;
core message queries remain plugin-agnostic. Waiting ages use the oldest labeled message date,
not a classification timestamp. GTD batches row IDs per account, refreshes after mutations and
realtime events, and clears its cache when the plugin or session ends.

**Caveat — the one place core still knows about GTD:** the inbox pill-tab strip (Inbox/Todo/Waiting/…)
in `MessageList.jsx` is interleaved with the core *category* tabs (shared tab strip + active-tab
state + list-body swap), so it isn't behind a slot yet. Changes there still touch core. Everything
else (right sidebar, context menu, row actions, settings, WS, the sections fetch) is fully behind the
registry. There's no import-boundary lint on the frontend — but a frontend plugin's blast radius is
one user's own browser (never the server or other users), so it's reviewed lightly.

---

## Contributing to a plugin

- Work inside `plugins/<name>/`. Keep `npm run lint:plugins` at 0 violations.
- Need a new capability? Open an issue/PR describing it — core adds it to `api.js`.
- GTD is per-user opt-in (Settings → Plugins), off by default.
