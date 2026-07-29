---
last_edited: 2026-07-29
---

# Custom Mail Folder Ordering Design

## Purpose

MailFlow users can already hide folders and reorder favorite folders. Issue
[#262](https://github.com/maathimself/mailflow/issues/262) asks for the same
control over the ordinary folder list under each account, without requiring
every folder to be a favorite.

The feature will let a user reorder the folders displayed under an expanded
account. The order is a MailFlow display preference: it does not rename folders,
move them between parents, or modify the IMAP server's hierarchy.

## User Experience

- Each ordinary folder row gets the same drag-handle affordance used by favorite
  folders when at least two folders exist at that hierarchy level.
- Dragging a handle reorders the folder among its siblings. A root folder can
  move among root folders, and a child folder can move among children of the
  same parent.
- A drop indicator shows whether the folder will land before or after the
  target row.
- A folder cannot be dropped into another parent. Message drag-and-drop remains
  independent and continues to move messages into the target folder.
- The custom order applies to every account, including the single-account,
  no-favorites case described in the issue.
- Favorite-folder order remains independent. Hiding or revealing a folder does
  not discard its position.
- Newly synchronized folders that have no saved rank appear after ranked
  siblings in alphabetical order. Deleted paths in a saved preference are
  ignored.
- As with the existing favorite-folder drag behavior, folder ordering is a
  desktop pointer interaction. This change does not introduce a new mobile
  reorder interaction.

## Data Model and Persistence

The frontend store adds a `folderOrder` preference with this shape:

```json
{
  "42": ["INBOX", "Archive", "Projects", "Projects/Client A"],
  "77": ["INBOX", "Receipts"]
}
```

Each key is an account ID and each value is an ordered list of complete IMAP
folder paths. Complete paths are stable identifiers and avoid ambiguity when
different parents contain children with the same display name.

The store seeds this preference from
`localStorage["mailflow_folder_order"]`, updates local storage immediately after
a reorder, and schedules the existing debounced preference save. Login-time
preference loading replaces the local value with the server value, matching the
existing expanded-account, collapsed-folder, and favorite-folder behavior.

`PATCH /auth/preferences` accepts `folderOrder` and merges it into the user's
JSONB preferences. No database migration is required.

## Ordering and Reconciliation

Pure helpers in `frontend/src/utils/sidebar.js` own the ordering rules so the
tree renderer and tests use the same behavior:

1. Build the existing parent/child tree from IMAP paths.
2. Sort every sibling group by saved rank.
3. Place unranked siblings after ranked siblings, using path-aware alphabetical
   order as their deterministic fallback.
4. When a drag completes, normalize the account's saved list against the
   folders currently known to MailFlow, remove stale and duplicate paths, append
   unranked paths in deterministic tree order, then move the dragged path before
   or after the target sibling.
5. Reject cross-account, cross-parent, self, and missing-path moves without
   changing the preference.

This keeps folder synchronization safe: a newly discovered folder is always
visible, while a renamed or deleted folder cannot break rendering.

## Component Changes

### Sidebar utilities

`frontend/src/utils/sidebar.js` will export the tree-building and reorder
helpers. Moving `buildFolderTree` out of `Sidebar.jsx` gives the ordering rules a
small, testable boundary without otherwise restructuring the sidebar.

### Frontend store

`frontend/src/store/index.js` will add the `folderOrder` state and a
`reorderFolders` action. The action persists only when a valid reorder produces
a changed order.

### Sidebar

`frontend/src/components/Sidebar.jsx` will:

- pass the account's saved order into the tree builder;
- track the dragged folder and current before/after drop target;
- distinguish folder-order drags from existing message drags;
- render a drag handle only when the folder has reorderable siblings; and
- clear transient drag state on drop, cancellation, and global drag end.

### Preferences API

`backend/src/routes/auth.js` will add `folderOrder` to the existing preference
merge. It remains per user and cross-device, like favorite-folder ordering.

## Failure Handling

The interface updates optimistically, consistent with the current preference
store. If the debounced server save fails, the session keeps the local order;
the next successful reorder retries the current preference. A later login loads
the last server-persisted value.

Malformed preference values are treated as empty by the frontend. Invalid
account entries, non-array values, duplicate paths, and non-string paths do not
reach the tree sorter.

## Testing

Frontend unit tests will cover:

- default alphabetical tree order without a preference;
- ranked sibling order at root and nested levels;
- ranked folders before newly discovered folders;
- stale, duplicate, and malformed saved paths;
- valid before/after moves;
- rejected cross-parent and missing-path moves; and
- preservation of unrelated account paths.

Backend route tests will cover persisting `folderOrder` without overwriting
unrelated preferences.

Verification will include focused frontend/backend tests, complete frontend and
backend suites, lint, a production frontend build, and the relevant full test
commands on crabbox.

## Non-Goals

- Renaming or moving IMAP folders.
- Reordering email accounts.
- Combining favorite and ordinary folder order.
- Adding a dedicated settings screen.
- Adding a new mobile drag-and-drop interaction.
