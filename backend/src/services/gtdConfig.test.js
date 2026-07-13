import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));

import { query } from './db.js';
import {
  DEFAULT_GTD_FOLDERS,
  GTD_STATES,
  resolveGtdStateFolder,
  sanitizeGtdFolders,
  sanitizeGtdFoldersDetailed,
  findGtdFolderCollisions,
  planGtdFolderPersist,
  getGtdConfig,
  getGtdFolderSet,
  invalidateGtdConfigCache,
  gtdTickFolders,
} from './gtdConfig.js';

// Each test uses a distinct account id so the module-level cache never leaks
// between cases, then asserts on how many times the DB was hit.
let nextId = 0;
const freshId = () => `acct-${++nextId}`;

const mockAccount = (gtd_enabled, gtd_folders) =>
  query.mockResolvedValue({ rows: [{ gtd_enabled, gtd_folders }] });

beforeEach(() => {
  query.mockReset();
});

describe('DEFAULT_GTD_FOLDERS', () => {
  it('maps the five GTD states to their default folder paths', () => {
    expect(DEFAULT_GTD_FOLDERS).toEqual({
      todo: 'Todo',
      watch: 'Watch',
      delegated: 'Delegated',
      someday: 'Someday',
      reference: 'Reference',
    });
  });
});

describe('resolveGtdStateFolder', () => {
  it('lists exactly the five GTD states', () => {
    expect(GTD_STATES).toEqual(['todo', 'watch', 'delegated', 'someday', 'reference']);
  });

  it('returns the resolved folder for a valid state', () => {
    expect(resolveGtdStateFolder('todo', DEFAULT_GTD_FOLDERS)).toBe('Todo');
    expect(resolveGtdStateFolder('reference', { ...DEFAULT_GTD_FOLDERS, reference: 'Ref' })).toBe('Ref');
  });

  it('returns null for an unknown or non-GTD state', () => {
    expect(resolveGtdStateFolder('inbox', DEFAULT_GTD_FOLDERS)).toBeNull();
    expect(resolveGtdStateFolder('', DEFAULT_GTD_FOLDERS)).toBeNull();
    expect(resolveGtdStateFolder(undefined, DEFAULT_GTD_FOLDERS)).toBeNull();
  });

  it('returns null when the state maps to a blank/missing folder path', () => {
    expect(resolveGtdStateFolder('todo', {})).toBeNull();
    expect(resolveGtdStateFolder('todo', { todo: '   ' })).toBeNull();
    expect(resolveGtdStateFolder('todo', null)).toBeNull();
  });
});

describe('sanitizeGtdFolders', () => {
  it('keeps the five known states with trimmed non-empty values', () => {
    expect(sanitizeGtdFolders({ todo: '  Tasks  ', reference: 'Ref' }))
      .toEqual({ todo: 'Tasks', reference: 'Ref' });
  });

  it('drops unknown keys', () => {
    expect(sanitizeGtdFolders({ todo: 'Tasks', bogus: 'X', INBOX: 'Y' }))
      .toEqual({ todo: 'Tasks' });
  });

  it('drops blank / whitespace-only values', () => {
    expect(sanitizeGtdFolders({ todo: 'Tasks', watch: '   ', delegated: '' }))
      .toEqual({ todo: 'Tasks' });
  });

  it('drops non-string values', () => {
    expect(sanitizeGtdFolders({ todo: 5, watch: { path: 'x' }, delegated: ['y'], someday: 'Later' }))
      .toEqual({ someday: 'Later' });
  });

  it('returns an empty object for non-object input', () => {
    expect(sanitizeGtdFolders(null)).toEqual({});
    expect(sanitizeGtdFolders(undefined)).toEqual({});
    expect(sanitizeGtdFolders('Todo')).toEqual({});
    expect(sanitizeGtdFolders(['Todo'])).toEqual({});
  });
});

describe('sanitizeGtdFoldersDetailed — length + traversal hardening', () => {
  it('rejects an over-long folder path (>255) and reports the state, keeping the rest', () => {
    const long = 'x'.repeat(256);
    const { folders, rejected } = sanitizeGtdFoldersDetailed({ todo: long, watch: 'Watch' });
    expect(folders).toEqual({ watch: 'Watch' }); // over-long todo falls back to its default
    expect(rejected).toEqual(['todo']);
  });

  it('accepts a folder path exactly at the 255-char limit', () => {
    const exact = 'y'.repeat(255);
    const { folders, rejected } = sanitizeGtdFoldersDetailed({ todo: exact });
    expect(folders).toEqual({ todo: exact });
    expect(rejected).toEqual([]);
  });

  it('rejects a `..` path segment and reports the state', () => {
    const { folders, rejected } = sanitizeGtdFoldersDetailed({ todo: '../etc', watch: 'a/../b', delegated: 'Del' });
    expect(folders).toEqual({ delegated: 'Del' });
    expect(rejected).toEqual(['todo', 'watch']);
  });

  it('allows dots that are not a standalone `..` traversal segment', () => {
    const { folders, rejected } = sanitizeGtdFoldersDetailed({ todo: 'Todo.Later', reference: 'a..b' });
    expect(folders).toEqual({ todo: 'Todo.Later', reference: 'a..b' });
    expect(rejected).toEqual([]);
  });

  it('does not report blank / non-string values as rejected — they fall back silently', () => {
    const { folders, rejected } = sanitizeGtdFoldersDetailed({ todo: '   ', watch: 5, delegated: 'Del' });
    expect(folders).toEqual({ delegated: 'Del' });
    expect(rejected).toEqual([]);
  });

  it('returns empty folders + no rejections for non-object input', () => {
    expect(sanitizeGtdFoldersDetailed(null)).toEqual({ folders: {}, rejected: [], reserved: [] });
    expect(sanitizeGtdFoldersDetailed(['Todo'])).toEqual({ folders: {}, rejected: [], reserved: [] });
  });
});

describe('sanitizeGtdFoldersDetailed — reserved system-folder denylist', () => {
  it('drops a mapping onto a reserved system folder and reports it in `reserved`', () => {
    const { folders, reserved } = sanitizeGtdFoldersDetailed({ todo: 'INBOX', watch: 'Watch' });
    expect(folders).toEqual({ watch: 'Watch' }); // INBOX falls back to its default, never persisted
    expect(reserved).toEqual(['todo']);
  });

  it('rejects every reserved name case-insensitively', () => {
    for (const name of ['inbox', 'Sent', 'DRAFTS', 'trash', 'Junk', 'spam', 'ARCHIVE']) {
      const { folders, reserved } = sanitizeGtdFoldersDetailed({ todo: name });
      expect(folders).toEqual({});
      expect(reserved).toEqual(['todo']);
    }
  });

  it('rejects the Gmail special "[Gmail]/…" tree (case-insensitive)', () => {
    const { folders, reserved } = sanitizeGtdFoldersDetailed({ todo: '[Gmail]/Sent Mail', watch: '[gmail]/Trash' });
    expect(folders).toEqual({});
    expect(reserved).toEqual(['todo', 'watch']);
  });

  it('keeps ordinary and nested names — only the exact reserved full paths are denied', () => {
    const { folders, reserved } = sanitizeGtdFoldersDetailed({
      todo: 'Todo', watch: 'Work/Todo', delegated: 'Inbox Zero', someday: 'Archived',
    });
    // "Inbox Zero"/"Archived" merely start with a reserved word — not a reserved FULL path.
    expect(folders).toEqual({ todo: 'Todo', watch: 'Work/Todo', delegated: 'Inbox Zero', someday: 'Archived' });
    expect(reserved).toEqual([]);
  });

  it('reports reserved separately from over-long/traversal rejections', () => {
    const { folders, rejected, reserved } = sanitizeGtdFoldersDetailed({ todo: 'INBOX', watch: '../etc', delegated: 'Del' });
    expect(folders).toEqual({ delegated: 'Del' });
    expect(rejected).toEqual(['watch']);
    expect(reserved).toEqual(['todo']);
  });
});

describe('findGtdFolderCollisions', () => {
  it('returns [] when the five resolved states map to distinct folders', () => {
    expect(findGtdFolderCollisions(DEFAULT_GTD_FOLDERS)).toEqual([]);
  });

  it('detects two states resolving to the same folder', () => {
    const collisions = findGtdFolderCollisions({ ...DEFAULT_GTD_FOLDERS, todo: 'Watch' });
    expect(collisions).toHaveLength(1);
    expect(collisions[0].folder).toBe('Watch');
    expect([...collisions[0].states].sort()).toEqual(['todo', 'watch']);
  });

  it('groups a three-way collision into one clash', () => {
    const folders = { todo: 'X', watch: 'X', delegated: 'X', someday: 'Someday', reference: 'Reference' };
    const collisions = findGtdFolderCollisions(folders);
    expect(collisions).toHaveLength(1);
    expect([...collisions[0].states].sort()).toEqual(['delegated', 'todo', 'watch']);
  });
});

describe('getGtdConfig', () => {
  it('applies all defaults when gtd_folders is an empty object', async () => {
    const id = freshId();
    mockAccount(true, {});
    const cfg = await getGtdConfig(id);
    expect(cfg.enabled).toBe(true);
    expect(cfg.folders).toEqual(DEFAULT_GTD_FOLDERS);
  });

  it('merges stored overrides over the defaults', async () => {
    const id = freshId();
    mockAccount(true, { todo: 'Tasks', reference: 'Ref' });
    const cfg = await getGtdConfig(id);
    expect(cfg.folders).toEqual({
      todo: 'Tasks',
      watch: 'Watch',
      delegated: 'Delegated',
      someday: 'Someday',
      reference: 'Ref',
    });
  });

  it('neutralizes a legacy reserved mapping while preserving ordinary stored values', async () => {
    const id = freshId();
    mockAccount(true, { todo: 'INBOX', watch: 'Watch' });
    const cfg = await getGtdConfig(id);
    expect(cfg.folders.todo).toBe(DEFAULT_GTD_FOLDERS.todo);
    expect(cfg.folders.todo).not.toBe('INBOX');
    expect(cfg.folders.watch).toBe('Watch');
  });

  it('neutralizes a lowercase reserved mapping', async () => {
    const id = freshId();
    mockAccount(true, { someday: 'archive' });
    const cfg = await getGtdConfig(id);
    expect(cfg.folders.someday).toBe(DEFAULT_GTD_FOLDERS.someday);
  });

  it('neutralizes a mapping into the Gmail system-folder tree', async () => {
    const id = freshId();
    mockAccount(true, { reference: '[Gmail]/All Mail' });
    const cfg = await getGtdConfig(id);
    expect(cfg.folders.reference).toBe(DEFAULT_GTD_FOLDERS.reference);
  });

  it('preserves an ordinary custom mapping', async () => {
    const id = freshId();
    mockAccount(true, { todo: 'Tasks' });
    const cfg = await getGtdConfig(id);
    expect(cfg.folders.todo).toBe('Tasks');
  });

  it('reports enabled=false when the account has GTD off', async () => {
    const id = freshId();
    mockAccount(false, {});
    const cfg = await getGtdConfig(id);
    expect(cfg.enabled).toBe(false);
  });

  it('treats a missing account row as disabled with default folders', async () => {
    const id = freshId();
    query.mockResolvedValue({ rows: [] });
    const cfg = await getGtdConfig(id);
    expect(cfg.enabled).toBe(false);
    expect(cfg.folders).toEqual(DEFAULT_GTD_FOLDERS);
  });

  it('caches within the TTL so a second call issues no new query', async () => {
    const id = freshId();
    mockAccount(true, {});
    await getGtdConfig(id);
    await getGtdConfig(id);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('re-queries after the cache is invalidated', async () => {
    const id = freshId();
    mockAccount(true, {});
    await getGtdConfig(id);
    invalidateGtdConfigCache(id);
    await getGtdConfig(id);
    expect(query).toHaveBeenCalledTimes(2);
  });
});

describe('getGtdFolderSet', () => {
  it('returns the set of designated folder paths when enabled', async () => {
    const id = freshId();
    mockAccount(true, { todo: 'Tasks' });
    const set = await getGtdFolderSet(id);
    expect(set).toEqual(new Set(['Tasks', 'Watch', 'Delegated', 'Someday', 'Reference']));
  });

  it('returns an empty set when GTD is disabled', async () => {
    const id = freshId();
    mockAccount(false, { todo: 'Tasks' });
    const set = await getGtdFolderSet(id);
    expect(set.size).toBe(0);
  });
});

describe('gtdTickFolders', () => {
  it('returns no folders when GTD is disabled — the tick stays inert', () => {
    expect(gtdTickFolders({ enabled: false, folders: DEFAULT_GTD_FOLDERS })).toEqual([]);
  });

  it('returns the distinct designated folder paths when enabled', () => {
    expect(gtdTickFolders({ enabled: true, folders: DEFAULT_GTD_FOLDERS })).toEqual([
      'Todo', 'Watch', 'Delegated', 'Someday', 'Reference',
    ]);
  });

  it('dedupes when two states point at the same folder', () => {
    const folders = { todo: 'X', watch: 'X', delegated: 'Delegated', someday: 'Someday', reference: 'Reference' };
    const result = gtdTickFolders({ enabled: true, folders });
    expect(result).toEqual(['X', 'Delegated', 'Someday', 'Reference']);
  });
});

describe('planGtdFolderPersist', () => {
  // Every ensure result carries { folder, path }; `path` is the real server path.
  const resultsFrom = (fn) => ['Todo', 'Watch', 'Delegated', 'Someday', 'Reference']
    .map(folder => ({ folder, path: fn(folder), created: false }));

  it('persists the effective paths when a prefixed namespace relocates every folder', () => {
    // INBOX.-prefixed server: each bare configured name lands at INBOX.<name>. Stored
    // overrides are empty (all defaults), so the whole five-state map must be recorded.
    const merged = { ...DEFAULT_GTD_FOLDERS };
    const results = resultsFrom(f => `INBOX.${f}`);
    expect(planGtdFolderPersist({ merged, stored: {}, results })).toEqual({
      changed: true,
      folders: {
        todo: 'INBOX.Todo',
        watch: 'INBOX.Watch',
        delegated: 'INBOX.Delegated',
        someday: 'INBOX.Someday',
        reference: 'INBOX.Reference',
      },
    });
  });

  it('is a no-op on a flat server where every folder lands where configured', () => {
    // Gmail / modern Fastmail: effective path === configured name for all five.
    const merged = { ...DEFAULT_GTD_FOLDERS };
    const results = resultsFrom(f => f);
    expect(planGtdFolderPersist({ merged, stored: {}, results })).toEqual({ changed: false });
  });

  it('overlays only the affected state, leaving an unrelated stored override untouched', () => {
    // Only `todo` was relocated; a custom `reference` override the server left alone stays.
    const merged = { ...DEFAULT_GTD_FOLDERS, reference: 'Ref' };
    const results = [
      { folder: 'Todo', path: 'INBOX.Todo' },
      { folder: 'Watch', path: 'Watch' },
      { folder: 'Delegated', path: 'Delegated' },
      { folder: 'Someday', path: 'Someday' },
      { folder: 'Ref', path: 'Ref' },
    ];
    expect(planGtdFolderPersist({ merged, stored: { reference: 'Ref' }, results })).toEqual({
      changed: true,
      folders: { reference: 'Ref', todo: 'INBOX.Todo' },
    });
  });

  it('rejects (no write) when two configured names collapse to one effective path', () => {
    // A case-insensitive server returns the same real path for 'Todo' and 'todo', so both
    // todo and watch would resolve to INBOX.Todo — the save-path collision contract applies.
    const merged = { ...DEFAULT_GTD_FOLDERS, watch: 'todo' };
    const results = [
      { folder: 'Todo', path: 'INBOX.Todo' },
      { folder: 'todo', path: 'INBOX.Todo' },
      { folder: 'Delegated', path: 'INBOX.Delegated' },
      { folder: 'Someday', path: 'INBOX.Someday' },
      { folder: 'Reference', path: 'INBOX.Reference' },
    ];
    const plan = planGtdFolderPersist({ merged, stored: {}, results });
    expect(plan.changed).toBe(false);
    expect(plan.collisions).toEqual([{ folder: 'INBOX.Todo', states: ['todo', 'watch'] }]);
  });

  it('does not persist a server path that violates the length cap', () => {
    // Defence in depth: an over-cap effective path falls back to the default rather than
    // being stored, so a single such folder yields no change.
    const longPath = 'X'.repeat(256);
    const merged = { ...DEFAULT_GTD_FOLDERS };
    const results = [
      { folder: 'Todo', path: longPath },
      { folder: 'Watch', path: 'Watch' },
      { folder: 'Delegated', path: 'Delegated' },
      { folder: 'Someday', path: 'Someday' },
      { folder: 'Reference', path: 'Reference' },
    ];
    expect(planGtdFolderPersist({ merged, stored: {}, results })).toEqual({ changed: false });
  });

  it('leaves a state untouched when its configured (stored) name was never among the ensured results', () => {
    // Mirrors the route's fixed call: `merged` is the STORED config, not the request body's
    // possibly-unsaved form override. Here the form overrode todo to 'TodoNew' and only that
    // name was ensured this call — the stored name 'Todo' never appears in `results` — so
    // planGtdFolderPersist must not invent a relocation for todo from the unsaved name.
    const merged = { ...DEFAULT_GTD_FOLDERS }; // stored-based: todo is still 'Todo'
    const results = [
      { folder: 'TodoNew', path: 'INBOX.TodoNew' }, // what the unsaved form value actually created
      { folder: 'Watch', path: 'Watch' },
      { folder: 'Delegated', path: 'Delegated' },
      { folder: 'Someday', path: 'Someday' },
      { folder: 'Reference', path: 'Reference' },
    ];
    expect(planGtdFolderPersist({ merged, stored: {}, results })).toEqual({ changed: false });
  });

  it('persists a relocation for the stored name regardless of an unrelated unsaved override elsewhere', () => {
    // todo's stored name ('Todo') was actually ensured and relocated; watch's result comes
    // from an unsaved form override ('WatchNew') that doesn't match watch's stored name
    // ('Watch') at all. todo's relocation must still persist despite the unrelated form edit.
    const merged = { ...DEFAULT_GTD_FOLDERS }; // stored-based
    const results = [
      { folder: 'Todo', path: 'INBOX.Todo' },
      { folder: 'WatchNew', path: 'INBOX.WatchNew' },
      { folder: 'Delegated', path: 'Delegated' },
      { folder: 'Someday', path: 'Someday' },
      { folder: 'Reference', path: 'Reference' },
    ];
    expect(planGtdFolderPersist({ merged, stored: {}, results })).toEqual({
      changed: true,
      folders: { todo: 'INBOX.Todo' },
    });
  });

  it('skips folders whose create errored', () => {
    // An errored create carries no `path`; that state must be left as configured, not wiped.
    const merged = { ...DEFAULT_GTD_FOLDERS };
    const results = [
      { folder: 'Todo', path: 'INBOX.Todo' },
      { folder: 'Watch', error: true },
      { folder: 'Delegated', path: 'INBOX.Delegated' },
      { folder: 'Someday', path: 'INBOX.Someday' },
      { folder: 'Reference', path: 'INBOX.Reference' },
    ];
    expect(planGtdFolderPersist({ merged, stored: {}, results })).toEqual({
      changed: true,
      folders: {
        todo: 'INBOX.Todo',
        delegated: 'INBOX.Delegated',
        someday: 'INBOX.Someday',
        reference: 'INBOX.Reference',
      },
    });
  });
});
