---
last_edited: 2026-07-29
---

# Custom Mail Folder Ordering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users drag ordinary mail folders into a custom per-account display
order without favoriting them or changing the IMAP hierarchy.

**Architecture:** Pure sidebar utilities build and reconcile the ordered folder
tree. Zustand persists one `folderOrder` object through local storage and the
existing debounced preferences API, while the backend merges that object into
the user's JSONB preferences. `Sidebar.jsx` adds a drag handle and before/after
drop indicator, while preserving the separate message-drop path.

**Tech Stack:** React 18, Zustand 4, Node.js built-in test runner, Express 4,
PostgreSQL JSONB, Vitest 4, ESLint 10, Vite 8.

## Global Constraints

- Folder ordering is display-only; never rename folders, change parent paths, or
  issue an IMAP mutation.
- A folder can move only among siblings in the same account and parent.
- Favorite order and hidden-folder state remain independent.
- Ranked folders precede newly discovered folders; unranked folders use
  deterministic alphabetical order.
- Deleted and malformed saved paths are ignored.
- Desktop drag behavior matches the existing favorite-folder interaction; a new
  mobile reorder interaction is out of scope.
- No database migration and no new dependency.
- Every production behavior begins with a failing focused test.
- Baseline evidence: backend full suite has four unrelated `safeFetch` failures
  caused by local Undici `UND_ERR_INVALID_ARG`; crabbox must rerun the full suite.

---

### Task 1: Pure folder-tree ordering and drag reconciliation

**Files:**

- Modify: `frontend/src/utils/sidebar.js:1-13`
- Modify: `frontend/src/utils/sidebar.test.js:1-54`
- Modify: `frontend/src/components/Sidebar.jsx:108-149` (remove the local tree
  builder only after the utility tests pass)

**Interfaces:**

- Consumes: folder records shaped as `{ path: string, delimiter?: string }` and a
  saved `string[]` of full IMAP paths.
- Produces:
  - `sanitizeFolderOrder(value: unknown): Record<string, string[]>`
  - `buildFolderTree(folders: Folder[], savedOrder?: string[]): FolderNode[]`
  - `normalizeFolderOrder(folders: Folder[], savedOrder?: unknown): string[]`
  - `reorderFolderPaths(folders: Folder[], savedOrder: unknown, draggedPath:
    string, targetPath: string, position: 'before' | 'after'): string[] | null`
  - `folderDropPosition(clientY: number, rect: { top: number, height: number }):
    'before' | 'after'`

- [x] **Step 1: Add failing tests for sanitization and ordered tree rendering**

Update the import and append these cases to
`frontend/src/utils/sidebar.test.js`:

```js
import {
  activateOnKey,
  buildFolderTree,
  collapsedTooltip,
  folderDropPosition,
  normalizeFolderOrder,
  reorderFolderPaths,
  sanitizeFolderOrder,
} from './sidebar.js';

const folders = [
  { path: 'Archive', name: 'Archive', delimiter: '/' },
  { path: 'INBOX', name: 'INBOX', delimiter: '/' },
  { path: 'Projects', name: 'Projects', delimiter: '/' },
  { path: 'Projects/Alpha', name: 'Alpha', delimiter: '/' },
  { path: 'Projects/Beta', name: 'Beta', delimiter: '/' },
];

describe('folder ordering', () => {
  it('sanitizes account order maps without duplicate or malformed paths', () => {
    assert.deepEqual(sanitizeFolderOrder({
      a1: ['INBOX', 'Archive', 'INBOX', 42, ''],
      a2: 'not-an-array',
    }), { a1: ['INBOX', 'Archive'] });
    assert.deepEqual(sanitizeFolderOrder(null), {});
    assert.deepEqual(sanitizeFolderOrder([]), {});
  });

  it('keeps the legacy alphabetical order without a saved preference', () => {
    const tree = buildFolderTree(folders);
    assert.deepEqual(tree.map(node => node.path), ['Archive', 'INBOX', 'Projects']);
    assert.deepEqual(tree[2].children.map(node => node.path), [
      'Projects/Alpha',
      'Projects/Beta',
    ]);
  });

  it('applies saved ranks independently to root and nested siblings', () => {
    const tree = buildFolderTree(folders, [
      'Projects',
      'INBOX',
      'Projects/Beta',
      'Projects/Alpha',
    ]);
    assert.deepEqual(tree.map(node => node.path), ['Projects', 'INBOX', 'Archive']);
    assert.deepEqual(tree[0].children.map(node => node.path), [
      'Projects/Beta',
      'Projects/Alpha',
    ]);
  });

  it('puts new folders after ranked folders and ignores stale paths', () => {
    assert.deepEqual(
      normalizeFolderOrder(folders, ['Gone', 'INBOX', 'Archive', 'INBOX']),
      ['INBOX', 'Archive', 'Projects', 'Projects/Alpha', 'Projects/Beta'],
    );
  });
});
```

- [x] **Step 2: Run the tree tests and verify the RED state**

Run:

```bash
cd frontend
node --test src/utils/sidebar.test.js
```

Expected: FAIL because the five new exports do not exist.

- [x] **Step 3: Implement sanitization, path normalization, and ordered tree building**

Add these helpers to `frontend/src/utils/sidebar.js`:

```js
function delimiterFor(folders) {
  return folders.find(folder => typeof folder?.delimiter === 'string' && folder.delimiter)?.delimiter || '/';
}

function folderParent(path, delimiter) {
  const index = path.lastIndexOf(delimiter);
  return index === -1 ? null : path.slice(0, index);
}

function folderPathsWithAncestors(folders) {
  const delimiter = delimiterFor(folders);
  const paths = new Set();
  for (const folder of folders) {
    if (typeof folder?.path !== 'string' || !folder.path) continue;
    const parts = folder.path.split(delimiter);
    for (let depth = 1; depth <= parts.length; depth += 1) {
      paths.add(parts.slice(0, depth).join(delimiter));
    }
  }
  return [...paths].sort((a, b) => a.localeCompare(b));
}

export function sanitizeFolderOrder(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const clean = {};
  for (const [accountId, paths] of Object.entries(value)) {
    if (!Array.isArray(paths)) continue;
    const seen = new Set();
    const valid = paths.filter(path => {
      if (typeof path !== 'string' || !path || seen.has(path)) return false;
      seen.add(path);
      return true;
    });
    clean[accountId] = valid;
  }
  return clean;
}

export function normalizeFolderOrder(folders, savedOrder = []) {
  const known = folderPathsWithAncestors(Array.isArray(folders) ? folders : []);
  const knownSet = new Set(known);
  const ranked = [];
  const seen = new Set();
  if (Array.isArray(savedOrder)) {
    for (const path of savedOrder) {
      if (typeof path !== 'string' || seen.has(path) || !knownSet.has(path)) continue;
      seen.add(path);
      ranked.push(path);
    }
  }
  return [...ranked, ...known.filter(path => !seen.has(path))];
}

export function buildFolderTree(folders, savedOrder = []) {
  const safeFolders = Array.isArray(folders) ? folders : [];
  const delimiter = delimiterFor(safeFolders);
  const map = {};
  for (const folder of safeFolders) {
    if (typeof folder?.path !== 'string' || !folder.path) continue;
    map[folder.path] = { ...folder, children: [] };
  }
  for (const folder of safeFolders) {
    if (typeof folder?.path !== 'string' || !folder.path) continue;
    const parts = folder.path.split(delimiter);
    for (let depth = 1; depth < parts.length; depth += 1) {
      const path = parts.slice(0, depth).join(delimiter);
      if (!map[path]) {
        map[path] = {
          path,
          name: parts[depth - 1],
          delimiter,
          special_use: null,
          account_id: folder.account_id,
          children: [],
        };
      }
    }
  }

  const roots = [];
  const nodes = Object.values(map).sort((a, b) => a.path.localeCompare(b.path));
  for (const node of nodes) {
    const parentPath = folderParent(node.path, delimiter);
    if (parentPath && map[parentPath] && parentPath !== node.path) {
      map[parentPath].children.push(node);
    } else {
      roots.push(node);
    }
  }

  const rank = new Map(
    normalizeFolderOrder(safeFolders, savedOrder).map((path, index) => [path, index]),
  );
  const sortGroup = group => {
    group.sort((a, b) => {
      const aRank = rank.get(a.path);
      const bRank = rank.get(b.path);
      if (aRank != null && bRank != null) return aRank - bRank;
      if (aRank != null) return -1;
      if (bRank != null) return 1;
      return a.path.localeCompare(b.path);
    });
    group.forEach(node => sortGroup(node.children));
  };
  sortGroup(roots);
  return roots;
}
```

Delete the duplicate `buildFolderTree` function from
`frontend/src/components/Sidebar.jsx` and add it to the existing utility import
so the component keeps its legacy alphabetical rendering until Task 3 supplies a
saved order:

```js
import {
  activateOnKey,
  buildFolderTree,
  collapsedTooltip,
} from '../utils/sidebar.js';
```

- [x] **Step 4: Verify the ordered-tree tests pass**

Run:

```bash
cd frontend
node --test src/utils/sidebar.test.js
```

Expected: the existing tooltip/keyboard tests and the new tree tests PASS.

- [x] **Step 5: Add failing tests for sibling-only before/after moves**

Append to the `folder ordering` suite:

```js
it('moves a root sibling before or after its target', () => {
  assert.deepEqual(
    reorderFolderPaths(folders, [], 'Archive', 'Projects', 'after'),
    ['INBOX', 'Projects', 'Archive', 'Projects/Alpha', 'Projects/Beta'],
  );
  assert.deepEqual(
    reorderFolderPaths(folders, [], 'Projects', 'Archive', 'before'),
    ['Projects', 'Archive', 'INBOX', 'Projects/Alpha', 'Projects/Beta'],
  );
});

it('moves nested siblings without changing the parent hierarchy', () => {
  assert.deepEqual(
    reorderFolderPaths(folders, [], 'Projects/Beta', 'Projects/Alpha', 'before'),
    ['Archive', 'INBOX', 'Projects', 'Projects/Beta', 'Projects/Alpha'],
  );
});

it('rejects self, cross-parent, missing-path, and invalid-position moves', () => {
  assert.equal(reorderFolderPaths(folders, [], 'INBOX', 'INBOX', 'before'), null);
  assert.equal(
    reorderFolderPaths(folders, [], 'Projects/Alpha', 'Archive', 'before'),
    null,
  );
  assert.equal(reorderFolderPaths(folders, [], 'Gone', 'INBOX', 'before'), null);
  assert.equal(reorderFolderPaths(folders, [], 'INBOX', 'Archive', 'middle'), null);
});

it('selects a before or after drop edge from the row midpoint', () => {
  assert.equal(folderDropPosition(110, { top: 100, height: 40 }), 'before');
  assert.equal(folderDropPosition(130, { top: 100, height: 40 }), 'after');
});

it('does not persist a drop that leaves the normalized order unchanged', () => {
  assert.equal(
    reorderFolderPaths(folders, [], 'Archive', 'INBOX', 'before'),
    null,
  );
});
```

- [x] **Step 6: Run the move tests and verify the RED state**

Run:

```bash
cd frontend
node --test src/utils/sidebar.test.js
```

Expected: FAIL because `reorderFolderPaths` and `folderDropPosition` are not
implemented.

- [x] **Step 7: Implement sibling validation and before/after insertion**

Add to `frontend/src/utils/sidebar.js`:

```js
export function reorderFolderPaths(
  folders,
  savedOrder,
  draggedPath,
  targetPath,
  position,
) {
  if (position !== 'before' && position !== 'after') return null;
  const safeFolders = Array.isArray(folders) ? folders : [];
  const delimiter = delimiterFor(safeFolders);
  const current = normalizeFolderOrder(safeFolders, savedOrder);
  const known = new Set(current);
  if (
    draggedPath === targetPath
    || !known.has(draggedPath)
    || !known.has(targetPath)
    || folderParent(draggedPath, delimiter) !== folderParent(targetPath, delimiter)
  ) return null;

  const next = current.filter(path => path !== draggedPath);
  const targetIndex = next.indexOf(targetPath);
  next.splice(targetIndex + (position === 'after' ? 1 : 0), 0, draggedPath);
  return next.every((path, index) => path === current[index]) ? null : next;
}

export function folderDropPosition(clientY, rect) {
  return clientY < rect.top + rect.height / 2 ? 'before' : 'after';
}
```

- [x] **Step 8: Run the complete utility test file and commit**

Run:

```bash
cd frontend
node --test src/utils/sidebar.test.js
npm run lint -- --quiet
cd ..
git add frontend/src/utils/sidebar.js frontend/src/utils/sidebar.test.js frontend/src/components/Sidebar.jsx
git commit -m "feat: model custom folder ordering"
```

Expected: tests and lint PASS; commit contains only the pure model and removal of
the duplicate local tree builder.

---

### Task 2: Cross-device folder-order preference

**Files:**

- Modify: `frontend/src/store/index.js:690-771,855-870`
- Create: `frontend/src/store/folderOrder.js`
- Create: `frontend/src/store/folderOrder.test.js`
- Modify: `backend/src/routes/auth.js:763-854`
- Create: `backend/src/routes/auth.preferences.test.js`

**Interfaces:**

- Consumes: `sanitizeFolderOrder()` from Task 1 and `folderOrder:
  Record<string, string[]>` from `GET /auth/preferences`.
- Produces:
  - `readFolderOrder(storage): Record<string, string[]>`
  - `mergeFolderOrder(current, accountId, paths, storage): Record<string, string[]>`
  - `cacheFolderOrder(value, storage): Record<string, string[]>`
  - Zustand state `folderOrder: Record<string, string[]>`
  - `setFolderOrder(accountId: string | number, paths: string[]): void`
  - exported Express handler `patchPreferences(req, res): Promise<void>`
  - JSONB preference key `folderOrder`

- [x] **Step 1: Write the failing Zustand persistence test**

Execution note: importing the entire Zustand store under Node 26 failed before
the intended RED because `i18n.js` imports JSON without Node import attributes.
The test boundary was corrected to exercise the real cache/merge module consumed
by the store, without mocking the application bootstrap.

Create `frontend/src/store/folderOrder.test.js`:

```js
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const values = new Map();
const originalLocalStorage = globalThis.localStorage;
const originalFetch = globalThis.fetch;

before(() => {
  globalThis.localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ ok: true }),
  });
});

after(() => {
  globalThis.localStorage = originalLocalStorage;
  globalThis.fetch = originalFetch;
});

describe('folderOrder store preference', () => {
  it('updates one account without replacing another and mirrors local storage', async () => {
    const { useStore } = await import('./index.js');
    useStore.setState({
      folderOrder: { other: ['INBOX'] },
    });

    useStore.getState().setFolderOrder('account-1', ['Archive', 'INBOX']);

    assert.deepEqual(useStore.getState().folderOrder, {
      other: ['INBOX'],
      'account-1': ['Archive', 'INBOX'],
    });
    assert.deepEqual(JSON.parse(values.get('mailflow_folder_order')), {
      other: ['INBOX'],
      'account-1': ['Archive', 'INBOX'],
    });
  });
});
```

- [x] **Step 2: Run the store test and verify the RED state**

Run:

```bash
cd frontend
node --test src/store/folderOrder.test.js
```

Expected: FAIL because `setFolderOrder` is undefined.

- [x] **Step 3: Implement local state and login-time preference loading**

Import `sanitizeFolderOrder` in `frontend/src/store/index.js`, then add:

```js
// Custom per-account folder display order — { [accountId]: [path, ...] }
folderOrder: (() => {
  try {
    return sanitizeFolderOrder(
      JSON.parse(localStorage.getItem('mailflow_folder_order') || '{}'),
    );
  } catch {
    return {};
  }
})(),
setFolderOrder: (accountId, paths) => {
  const next = {
    ...get().folderOrder,
    [accountId]: Array.isArray(paths) ? paths : [],
  };
  localStorage.setItem('mailflow_folder_order', JSON.stringify(next));
  set({ folderOrder: next });
  schedulePrefSave({ folderOrder: next });
},
```

In `loadPreferences`, next to the other sidebar preferences, add:

```js
if (prefs.folderOrder && typeof prefs.folderOrder === 'object') {
  const next = sanitizeFolderOrder(prefs.folderOrder);
  localStorage.setItem('mailflow_folder_order', JSON.stringify(next));
  set({ folderOrder: next });
}
```

- [x] **Step 4: Verify the frontend preference test passes**

Run:

```bash
cd frontend
node --test src/store/folderOrder.test.js src/utils/sidebar.test.js
```

Expected: both files PASS.

- [x] **Step 5: Write the failing backend route-handler test**

Create `backend/src/routes/auth.preferences.test.js` with dependency mocks, import
the exported handler, and assert the additive JSONB merge:

```js
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn(), pool: {} }));
vi.mock('../index.js', () => ({
  imapManager: {
    updateSyncIntervalForUser: vi.fn(),
    updateFolderSyncIntervalForUser: vi.fn(),
  },
}));
vi.mock('../services/encryption.js', () => ({
  decrypt: value => value,
  encrypt: value => value,
}));
vi.mock('../services/pushNotifications.js', () => ({ pushConfigured: false }));
vi.mock('../services/hostValidation.js', () => ({
  validateHost: vi.fn(),
  resolveForConnection: vi.fn(),
}));
vi.mock('../services/connectionPolicy.js', () => ({
  getConnectionPolicy: vi.fn(),
}));
vi.mock('../services/authLimiter.js', () => ({
  authLimiterConfig: { maxRequests: 10, windowMs: 900000 },
}));
vi.mock('../services/authEvents.js', () => ({ logAuthEvent: vi.fn() }));
vi.mock('../services/mailer.js', () => ({ sendSystemEmail: vi.fn() }));
vi.mock('./oidc.js', () => ({ buildEndSessionUrl: vi.fn() }));
vi.mock('../services/categorizer.js', () => ({
  invalidateGlobalCategorizationCache: vi.fn(),
}));
vi.mock('../services/redis.js', () => ({ redisClient: {} }));
vi.mock('../services/rateLimiter.js', () => ({
  consume: vi.fn(),
  reset: vi.fn(),
}));

import { query } from '../services/db.js';
import { patchPreferences } from './auth.js';

beforeEach(() => {
  query.mockReset().mockResolvedValue({ rows: [] });
});

describe('PATCH /auth/preferences folderOrder', () => {
  it('merges folderOrder into existing preferences as JSONB', async () => {
    const folderOrder = { 'account-1': ['Archive', 'INBOX'] };
    const req = { session: { userId: 'user-1' }, body: { folderOrder } };
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };

    await patchPreferences(req, res);

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('SET preferences = preferences');
    expect(sql).toContain(
      "jsonb_build_object('folderOrder', $39::jsonb)",
    );
    expect(params[0]).toBe('user-1');
    expect(params[38]).toBe(JSON.stringify(folderOrder));
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });
});
```

- [x] **Step 6: Run the backend test and verify the RED state**

Run:

```bash
cd backend
npx vitest run src/routes/auth.preferences.test.js
```

Expected: FAIL because `patchPreferences` is not exported and `folderOrder` is
not part of the SQL merge.

- [x] **Step 7: Export the handler and add the additive JSONB preference**

Replace the handler's opening line:

```js
export async function patchPreferences(req, res) {
```

Replace the handler's closing `});` immediately after
`res.json({ ok: true });` with:

```js
}

router.patch('/preferences', patchPreferences);
```

Append `folderOrder` to the request destructure:

```js
const {
  theme, font, layout, notificationSound, pageSize, scrollMode, syncInterval,
  blockRemoteImages, imageWhitelist, shortcuts, hiddenFolders, language,
  threadedView, plaintextEmail, hoverQuickActions, swipeActions,
  expandedAccounts, collapsedFolders, favoriteFolders, recentFolders, fontSize,
  showAppBadge, showFaviconBadge, replyDefault, sidebarWidth,
  categorizationEnabled, markReadBehavior, markReadDelay, aiActions,
  autoLockMinutes, showMobileAvatars, gravatarAvatars, folderSyncInterval,
  folderOrder,
} = req.body;

const folderOrderJson = folderOrder != null ? JSON.stringify(folderOrder) : null;
```

Append the final SQL merge before `WHERE id = $1`:

```sql
|| CASE WHEN $39::jsonb IS NOT NULL
     THEN jsonb_build_object('folderOrder', $39::jsonb)
     ELSE '{}'::jsonb
   END
```

Append `folderOrderJson` as parameter 39 after `folderSyncIntervalVal`.

- [x] **Step 8: Run focused persistence tests and commit**

Run:

```bash
cd backend
npx vitest run src/routes/auth.preferences.test.js
npm run lint -- --quiet
cd ../frontend
node --test src/store/folderOrder.test.js src/utils/sidebar.test.js
npm run lint -- --quiet
cd ..
git add frontend/src/store/index.js frontend/src/store/folderOrder.test.js \
  backend/src/routes/auth.js backend/src/routes/auth.preferences.test.js
git commit -m "feat: persist custom folder order"
```

Expected: focused tests and lint PASS. The backend test proves the update remains
an additive merge instead of replacing unrelated preference keys.

---

### Task 3: Sidebar folder drag-and-drop

**Files:**

- Modify: `frontend/src/components/Sidebar.jsx:1-20,283-320,1240-1390`
- Test: `frontend/src/utils/sidebar.test.js`

**Interfaces:**

- Consumes:
  - `folderOrder[accountId]`
  - `setFolderOrder(accountId, paths)`
  - `buildFolderTree`, `folderDropPosition`, and `reorderFolderPaths`
- Produces:
  - drag MIME type `application/x-mailflow-folder-order`
  - transient drag state `{ accountId, path }`
  - transient drop state `{ accountId, path, position }`

- [x] **Step 1: Import ordering helpers and wire store state**

In `frontend/src/components/Sidebar.jsx`, replace the sidebar utility import with:

```js
import {
  activateOnKey,
  buildFolderTree,
  collapsedTooltip,
  folderDropPosition,
  reorderFolderPaths,
} from '../utils/sidebar.js';
```

Add to the Zustand destructure:

```js
folderOrder, setFolderOrder,
```

Define the MIME type outside the component:

```js
const FOLDER_ORDER_DRAG_TYPE = 'application/x-mailflow-folder-order';
```

- [x] **Step 2: Add drag state, cleanup, and typed event handlers**

Add beside the existing favorite drag state:

```js
const [folderDrag, setFolderDrag] = useState(null);
const [folderDropTarget, setFolderDropTarget] = useState(null);

const clearFolderDrag = useCallback(() => {
  setFolderDrag(null);
  setFolderDropTarget(null);
}, []);
```

Extend the global `dragend` effect to clear `msgDragTarget` and folder-order
state. Add these handlers inside the expanded account tree closure:

```js
const handleFolderOrderDragStart = (event, path) => {
  event.stopPropagation();
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData(
    FOLDER_ORDER_DRAG_TYPE,
    JSON.stringify({ accountId: account.id, path }),
  );
  setFolderDrag({ accountId: account.id, path });
  setFolderDropTarget(null);
};

const handleFolderOrderDragOver = (event, path, siblings) => {
  if (!event.dataTransfer.types.includes(FOLDER_ORDER_DRAG_TYPE)) return false;
  event.preventDefault();
  event.stopPropagation();
  const validTarget = (
    folderDrag?.accountId === account.id
    && folderDrag.path !== path
    && siblings.some(sibling => sibling.path === folderDrag.path)
  );
  if (!validTarget) {
    setFolderDropTarget(null);
    return true;
  }
  setFolderDropTarget({
    accountId: account.id,
    path,
    position: folderDropPosition(
      event.clientY,
      event.currentTarget.getBoundingClientRect(),
    ),
  });
  return true;
};

const handleFolderOrderDrop = (event, path) => {
  if (!event.dataTransfer.types.includes(FOLDER_ORDER_DRAG_TYPE)) return false;
  event.preventDefault();
  event.stopPropagation();
  if (
    folderDrag?.accountId === account.id
    && folderDropTarget?.accountId === account.id
    && folderDropTarget.path === path
  ) {
    const next = reorderFolderPaths(
      accountFolders,
      folderOrder[account.id],
      folderDrag.path,
      path,
      folderDropTarget.position,
    );
    if (next) setFolderOrder(account.id, next);
  }
  clearFolderDrag();
  return true;
};
```

- [x] **Step 3: Render sibling-aware handles and before/after indicators**

Change the function signature and add the sibling/drop calculations after the
current `indent` declaration:

```js
const renderNode = (node, depth, siblings) => {
```

```js
const canReorder = !isMobile && siblings.length >= 2;
const dropPosition = (
  folderDropTarget?.accountId === account.id
  && folderDropTarget.path === folder.path
) ? folderDropTarget.position : null;
```

Replace the row's `onDragOver` and `onDrop` props:

```jsx
onDragOver={event => {
  if (handleFolderOrderDragOver(event, folder.path, siblings)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  setMsgDragTarget(`${account.id}:${folder.path}`);
}}
onDrop={event => {
  if (handleFolderOrderDrop(event, folder.path)) return;
  handleMsgDrop(event, folder.path);
}}
```

Add this declaration to the row's style object after `transition`:

```js
boxShadow: dropPosition === 'before'
  ? 'inset 0 2px var(--accent)'
  : dropPosition === 'after'
    ? 'inset 0 -2px var(--accent)'
    : 'none',
```

Insert this handle immediately before the current chevron toggle:

```jsx
{canReorder && (
  <span
    draggable
    onDragStart={event => handleFolderOrderDragStart(event, folder.path)}
    onDragEnd={clearFolderDrag}
    title={t('sidebar.reorderFolder', 'Drag to reorder folder')}
    style={{
      color: 'var(--text-tertiary)',
      flexShrink: 0,
      display: 'flex',
      opacity: 0.4,
      cursor: 'grab',
    }}
  >
    <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor">
      <circle cx="2" cy="2" r="1.5"/><circle cx="8" cy="2" r="1.5"/>
      <circle cx="2" cy="7" r="1.5"/><circle cx="8" cy="7" r="1.5"/>
      <circle cx="2" cy="12" r="1.5"/><circle cx="8" cy="12" r="1.5"/>
    </svg>
  </span>
)}
```

Replace the child mapping:

```jsx
{visibleChildren.map(child => renderNode(child, depth + 1, visibleChildren))}
```

Replace the tree construction:

```js
const tree = buildFolderTree(accountFolders, folderOrder[account.id]);
const visibleTree = showingHidden
  ? tree
  : tree.filter(node => !accountHiddenPaths.includes(node.path));
```

Replace the root mapping:

```jsx
{visibleTree.map(node => renderNode(node, 0, visibleTree))}
```

Do not remove the selection, rename, collapse, context-menu, message-drop,
unread-count, hidden-folder, or create-folder branches surrounding these exact
edits.

- [x] **Step 4: Run focused tests, lint, and production build**

Run:

```bash
cd frontend
node --test src/utils/sidebar.test.js src/store/folderOrder.test.js
npm run lint
npm run build
```

Expected: tests PASS, ESLint reports zero warnings, and Vite completes a
production build.

- [x] **Step 5: Commit the sidebar interaction**

Run:

```bash
git add frontend/src/components/Sidebar.jsx frontend/src/utils/sidebar.test.js
git commit -m "feat: reorder folders in account sidebar"
```

Expected: the commit contains the UI integration and its final regression test.

---

### Task 4: Full verification and crabbox evidence

**Files:**

- No production files.
- Update the Kata issue with exact command results.

**Interfaces:**

- Consumes: all three implementation commits.
- Produces: local and remote verification evidence sufficient to close
  `mailflow#tebq`.

- [x] **Step 1: Run clean local frontend gates**

Run:

```bash
cd frontend
npm test
npm run lint
npm run build
```

Expected: all frontend tests PASS, ESLint has zero warnings, and Vite builds.

Observed: the initial run passed all 1,415 tests in 50 suites. After independent
review fixes, a fresh `npm test` run passed all 1,419 tests in 50 suites.
`npm run lint` completed with no errors or warnings, and `npm run build`
completed successfully after transforming 477 modules. Vite emitted only its
existing chunk-size advisory.

- [x] **Step 2: Run clean local backend gates**

Run:

```bash
cd backend
npm test
npm run lint
```

Expected: the new preferences test and all unrelated backend tests pass. If the
four known `safeFetch` tests still fail locally with `UND_ERR_INVALID_ARG`, record
them verbatim and require crabbox to establish the clean full-suite result.

Observed: the host Node 26.5 run passed 703 of 707 tests and reproduced exactly
the four baseline `safeFetch` failures with Undici `UND_ERR_INVALID_ARG:
invalid onError method`; the feature's new route test passed. A clean rerun
under Node 22.23.1 passed all 707 tests in 36 files. `npm run lint` completed
successfully.

- [x] **Step 3: Inspect the final diff and history**

Run:

```bash
git diff --check origin/main...HEAD
git status --short --branch
git log --oneline origin/main..HEAD
```

Expected: no whitespace errors, no uncommitted files, and the design plus three
feature commits are present.

Observed: `git diff --check origin/main...HEAD` produced no errors, the worktree
was clean, and the branch contained the approved design, corrected plan, and
three implementation commits.

- [ ] **Step 4: Run the complete project gates through crabbox**

First inspect available providers without exposing credentials:

```bash
crabbox providers
crabbox config show
```

Then use the available broker/provider and run:

```bash
crabbox run --shell \
  'cd frontend && npm ci && npm test && npm run lint && npm run build &&
   cd ../backend && npm ci && npm test && npm run lint'
```

Expected: crabbox reports a successful run receipt with frontend tests, frontend
lint/build, backend tests, and backend lint all passing. If no provider is
available, record the exact doctor/provider failure in Kata and do not claim
remote verification.

Observed: Vladimir confirmed `exe.dev` is the required provider. Crabbox's
`exe-dev` adapter is available, and direct SSH reaches the service, but the
current machine's key is unregistered. `ssh exe.dev` requires an email address
and account verification before Crabbox can allocate a VM. The flow was
cancelled before sending personal data; remote verification remains open.

- [x] **Step 5: Review the implementation against the approved design**

Check each invariant explicitly:

```text
[x] per-account custom order works with no favorites
[x] hierarchy cannot change
[x] root and nested sibling ordering both work
[x] hidden/favorite state remains independent
[x] new folders remain visible after ranked folders
[x] stale/malformed paths cannot break rendering
[x] order survives local reload and server preference round-trip
[x] message dragging still moves messages rather than folders
[x] desktop-only scope matches the approved design
```

Expected: every item is supported by a focused test, code inspection, build, or
crabbox run.

Observed: independent review found no critical issues and two important issues.
Commit `e763898` fixes both: an absent server preference now clears a previous
user's cached order, and a drop derives its authoritative payload and edge from
the drop event instead of asynchronously committed React state. New regressions
cover empty server state, immediate typed drops, cross-parent rejection,
message-transfer routing, and synthesized ancestors. The complete post-review
frontend and Node 22 backend suites pass.

- [ ] **Step 6: Record evidence and close the Kata issue**

Run:

```bash
head_sha=$(git rev-parse --short HEAD)
run_id=$(crabbox history --json | jq -r '.[0].run_id')
kata comment mailflow#tebq \
  --body "Verified ${head_sha}: frontend test/lint/build passed; backend test/lint passed; crabbox run ${run_id} passed the same full gates." \
  --agent --as codex
kata close mailflow#tebq --agent --as codex
```

Expected: the issue closes only after every required gate is either green or an
explicitly approved exception; `work.attention` is not written after close.
