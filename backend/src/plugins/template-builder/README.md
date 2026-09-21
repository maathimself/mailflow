# Template Builder plugin

A visual email template editor with drag-and-drop blocks, built on the MailFlow
composer's Tiptap editor and compiled to email-safe HTML via MJML.

This is a **Tier-1** plugin (in-repo, PR upstream). It spans both backend and
frontend trees:

| Layer | Path |
|---|---|
| Backend | `backend/src/plugins/template-builder/` |
| Frontend | `frontend/src/plugins/template-builder/` |

---

## Architecture overview

The plugin owns **no database schema** — it uses core's generic stores.

- `plugin_data` (KV + blobs) — one row per template; the value JSON holds `blocks`,
  the blob holds the compiled HTML produced by the MJML pass.
- `plugin_account_config` — reserved for future per-account settings.
- `messages.plugin_annotations` — reserved for future per-message tracking.

Templates are **owner-scoped** automatically by `storage.*` (see `api.js`); a user
can only CRUD their own templates.

### Two rendering paths

```
         Block JSON
              │
     ┌────────┴────────┐
     │                 │
     ▼                 ▼
blocksToEditorHtml  blockToMjml
     │                 │
     ▼                 ▼
 Tiptap editor     Backend MJML
 (insertContent)   → compiled HTML
     │                 │
     ▼                 ▼
Editor renders      Email-safe HTML
the template        stored in blob
```

**`blocksToEditorHtml`** generates HTML the Tiptap composer can parse. Button,
spacer, and social blocks emit `data-type="template-button|spacer|social"` so
the custom Tiptap nodes (see below) deserialize into atomic nodes — meaning
what you see in the editor IS what gets sent.

**`blockToMjml`** generates MJML (table-based + CSS inline) that the backend
compiles with the `mjml` npm package and stores as the HTML blob.

---

## Tiptap custom nodes

The plugin registers three atomic Tiptap nodes via the core seam
`registerEditorExtension` (see `registry.js` changes in `ComposeModal.jsx`).
These render as real, interactive elements in the composer — not styled `<a>`
tags that lose their styling to the editor's CSS:

| Node | Name | Description |
|---|---|---|
| `TemplateButton` | `templateButton` | A real button with background-color, text color, label, and URL. Preserved through send. |
| `TemplateSpacer` | `templateSpacer` | A visual spacer (rendered with a subtle background pattern in the editor; emits a `<div>` of the right height on send). |
| `TemplateSocial` | `templateSocial` | Social media links rendered with platform icons. |

Each node has `atom: true` (non-editable as a unit) and implements `parseHTML` /
`renderHTML` so the round-trip HTML → node → HTML is lossless.

---

## Frontend API surface

The plugin registers into four core plugin seams:

### `composer-toolbar`

Injects `TemplateInsertButton` into the compose toolbar. Context:

```js
ctx = {
  insertHtml: (html: string) => void,
  // Calls editor.commands.setContent(html) on the focused composer
}
```

1. Renders a "Template" button in the toolbar.
2. On click, opens a popover listing the user's saved templates (always re-fetched
   on open — no stale cache).
3. On select, calls `ctx.insertHtml(html)` — the Tiptap nodes are parsed from
   the `data-type` attributes and inserted as atomic nodes.
4. Popover flips up/down based on viewport proximity.

### `sidebar-nav-item`

Icon-only (28×28) button sitting inline with the contacts button in the sidebar.
When the sidebar is expanded, the two buttons are side-by-side; when collapsed,
they stack vertically.

### `settings-categories`

Template Manager settings UI (CRUD + preview), registered under the Categories
tab (activation-gated per user).

### `main-view`

The full-page Template Builder, rendered when the sidebar icon is clicked.

---

## Backend API

All routes are under `/api/template-builder/templates`, protected by `requireAuth`.

| Method | Path | Description |
|---|---|---|
| GET | `/templates` | List all templates for the user (metadata only — no HTML blob, fast) |
| POST | `/templates` | Create a new template. Body: `{ name, description?, blocks[] }` |
| GET | `/templates/:id` | Get a single template (with compiled HTML from blob) |
| PUT | `/templates/:id` | Update. Body: `{ name?, description?, blocks?, mjml? }` — if `mjml` provided, recompiles to HTML |
| DELETE | `/templates/:id` | Delete template |
| POST | `/templates/:id/compile` | Compile MJML → HTML. Body: `{ mjml }`, returns `{ html }` |

Template IDs are UUIDs. All queries are filtered to `owner_id = current_user_id`.

---

## Block schema

```json
[
  {
    "id": "crypto.randomUUID()",
    "type": "text|image|button|divider|spacer|columns|social|list",
    "props": { }
  }
]
```

| Type | Props |
|---|---|
| `text` | `{ type: 'paragraph'\|'h1'\|'h2'\|'h3', content, color, fontSize, bold, italic, align }` |
| `image` | `{ src, alt, href, width }` |
| `button` | `{ label, href, backgroundColor, color }` |
| `divider` | `{ color, width }` |
| `spacer` | `{ height }` |
| `columns` | `{ columns: [{ content }, ...] }` |
| `social` | `{ items: [{ name, href, label? }, ...] }` |
| `list` | `{ listType: 'ul'\|'ol', items: 'line\\nline…' }` |

---

## Development

```bash
source ~/.nvm/nvm.sh
cd /home/dog/Documents/GitHub/plugin-mailflow/mailflow

# Start local MailFlow (bind-mounts plugin dist for live reload)
docker compose -f docker-compose.plugin-dev.yml up -d

# Frontend tests (node:test)
cd frontend
npm run lint                         # 0 warnings required
npm run build                        # writes dist/ (bind-mounted into container)
node --test src/plugins/template-builder/

# Backend
cd backend
npm run lint:plugins                  # boundary check — 0 violations required
npm run lint
npm test

# Refresh the browser after building to pick up frontend changes
```

### File map

```
backend/src/plugins/template-builder/
├── index.js          — plugin manifest (id, name, version, tier, router)
├── routes.js         — Express router (REST endpoints above)
├── templateStorage.js — CRUD via storage.* (owner-scoped)
├── mjmlCompile.js    — mjml() compilation with error handling
├── mjmlCompile.test.js
├── templateStorage.test.js
└── routes.test.js

frontend/src/plugins/template-builder/
├── index.jsx         — registers slots + editor extensions + plugin meta
├── socialIcons.js    — SVG icon library (7 networks + domain)
├── utils.js          — shared helpers (safeUrl, esc, isValidColor/Align/Length)
├── tiptapExtensions.js — TemplateButton, TemplateSpacer, TemplateSocial nodes
├── blocksToEditorHtml.js — JSON blocks → Tiptip-parseable HTML (insertContent)
├── blockToMjml.js    — JSON blocks → MJML string (backend compiles)
├── templateApi.js    — frontend API client
├── useTemplateManager.js — state + CRUD hook with useMemo'd preview
├── TemplateBuilderPage.jsx — full-page editor UI (master-detail)
├── TemplateEditor.jsx — block editor (drag, reorder, expand/collapse)
├── TemplateInsertButton.jsx — composer toolbar popover
├── TemplateManagerSettings.jsx — settings-category CRUD
└── blocks/
    ├── TextBlock.jsx
    ├── ImageBlock.jsx
    ├── ButtonBlock.jsx
    ├── DividerBlock.jsx
    ├── SpacerBlock.jsx
    ├── ColumnsBlock.jsx
    ├── ListBlock.jsx
    └── SocialBlock.jsx
```

---

## Security notes

- **safeUrl** blocks `javascript:`, `vbscript:`, and `data:` schemes — shared from
  `utils.js` so all three rendering paths (editor HTML, MJML, Tiptap nodes) use
  the same check.
- **blocksToEditorHtml** escapes all text content (`esc`) and validates colors,
  lengths, and alignments (`isValidColor/Length/Align`) before interpolation,
  preventing CSS injection via block properties.
- **blockToMjml** validates the same props before emitting MJML attributes.
- **TiptapPreview** sanitizes with DOMPurify before `dangerouslySetInnerHTML`,
  allowing the SVG tags the social icons use.
- **Backend**: all routes gated by `requireAuth`; storage is owner-scoped; template
  IDs validated against UUID regex before any DB call.
