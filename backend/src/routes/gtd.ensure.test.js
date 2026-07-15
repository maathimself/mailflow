import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';

// POST /api/gtd/folders/ensure end-to-end: proves the route persists the effective folder
// paths, invalidates the config cache, and reflects the persisted map — the wiring the pure
// planGtdFolderPersist tests in gtdConfig.test.js cannot reach. The DB and imapManager are
// stubbed; requireAuth is replaced with a passthrough that injects a session. gtdConfig is
// partially mocked so invalidateGtdConfigCache is observable while the real planner/collision
// logic still runs.
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'u1' }; next(); },
}));
vi.mock('../index.js', () => ({ imapManager: { ensureFolder: vi.fn(), broadcast: vi.fn() } }));
vi.mock('../services/gtdConfig.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, invalidateGtdConfigCache: vi.fn() };
});

import express from 'express';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';
import { invalidateGtdConfigCache } from '../services/gtdConfig.js';
import gtdRoutes from './gtd.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/gtd', gtdRoutes);
  return app;
}

const account = { id: 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1', user_id: 'u1', gtd_folders: {} };

// Route the SELECT to the account row and let the UPDATE resolve to nothing.
function stubQuery() {
  query.mockImplementation(async (sql) => {
    if (sql.startsWith('SELECT * FROM email_accounts')) return { rows: [account] };
    return { rows: [] };
  });
}

const ensure = (folders = {}) => fetch(`${base}/api/gtd/folders/ensure`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ accountId: 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1', folders }),
});

const updateCall = () => query.mock.calls.find(c => c[0].startsWith('UPDATE email_accounts'));

let server;
let base;

beforeAll(async () => {
  await new Promise((resolve) => { server = buildApp().listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  query.mockReset();
  imapManager.ensureFolder.mockReset();
  invalidateGtdConfigCache.mockClear();
  account.gtd_folders = {}; // reset between tests that mutate the stored config
  stubQuery();
});

describe('POST /api/gtd/folders/ensure — persist effective paths', () => {
  it('persists the effective paths and invalidates the cache when a prefix relocates folders', async () => {
    imapManager.ensureFolder.mockImplementation(async (_acct, folder) => ({ path: `INBOX.${folder}`, created: true }));

    const res = await ensure();
    expect(res.status).toBe(200);
    const body = await res.json();

    const expected = {
      todo: 'INBOX.Todo',
      watch: 'INBOX.Watch',
      delegated: 'INBOX.Delegated',
      someday: 'INBOX.Someday',
      reference: 'INBOX.Reference',
    };
    // Response reflects what was persisted, so the settings form can show the real paths.
    expect(body.folders).toEqual(expected);
    // The JSONB update wrote exactly that map for this account.
    const upd = updateCall();
    expect(upd).toBeTruthy();
    expect(upd[1]).toEqual([expected, 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1']);
    // Cache dropped so getGtdConfig re-reads the relocated map.
    expect(invalidateGtdConfigCache).toHaveBeenCalledWith('a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1');
  });

  it('is a no-op on a flat server: no update, no cache invalidation, plain results', async () => {
    imapManager.ensureFolder.mockImplementation(async (_acct, folder) => ({ path: folder, created: false }));

    const res = await ensure();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.folders).toBeUndefined();
    expect(body.results).toHaveLength(5);
    expect(updateCall()).toBeUndefined();
    expect(invalidateGtdConfigCache).not.toHaveBeenCalled();
  });

  it('rejects a form mapping onto a reserved system folder with 400, creating nothing', async () => {
    imapManager.ensureFolder.mockImplementation(async (_acct, folder) => ({ path: folder, created: false }));

    const res = await ensure({ todo: 'INBOX' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/reserved system folder/i);
    expect(body.reserved).toEqual(['todo']);
    expect(imapManager.ensureFolder).not.toHaveBeenCalled();
  });

  it('rejects with 400 and does not persist when two SAVED states collapse to one effective path', async () => {
    // watch is already saved as 'todo' (not just typed in the form this request), so its
    // stored configured name matches what the request ensures; a case-insensitive server
    // then returns INBOX.Todo for both 'Todo' and 'todo'.
    account.gtd_folders = { watch: 'todo' };
    imapManager.ensureFolder.mockImplementation(async (_acct, folder) => ({
      path: folder.toLowerCase() === 'todo' ? 'INBOX.Todo' : `INBOX.${folder}`,
      created: false,
    }));

    const res = await ensure({ watch: 'todo' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/same folder/i);
    expect(body.collisions).toEqual([{ folder: 'INBOX.Todo', states: ['todo', 'watch'] }]);
    expect(updateCall()).toBeUndefined();
    expect(invalidateGtdConfigCache).not.toHaveBeenCalled();
  });

  it('does not persist an unsaved form override, but still persists an unrelated saved relocation', async () => {
    // The form has an unsaved edit — todo overridden to 'TodoNew' — while the account's
    // saved config still has todo at the default 'Todo'. Clicking "Create missing folders"
    // must not write TodoNew's relocated path into gtd_folders (that would bypass Save);
    // the other four states, whose stored names ARE what's being ensured, still persist
    // normally when the prefixed server relocates them.
    imapManager.ensureFolder.mockImplementation(async (_acct, folder) => ({ path: `INBOX.${folder}`, created: true }));

    const res = await ensure({ todo: 'TodoNew' });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.folders).toEqual({
      watch: 'INBOX.Watch',
      delegated: 'INBOX.Delegated',
      someday: 'INBOX.Someday',
      reference: 'INBOX.Reference',
    });
    expect(body.folders.todo).toBeUndefined();
    const upd = updateCall();
    expect(upd[1][0]).toEqual(body.folders);
    expect(invalidateGtdConfigCache).toHaveBeenCalledWith('a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1');
  });
});
