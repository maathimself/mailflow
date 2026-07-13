import { describe, it, expect, vi } from 'vitest';

// gtd.js registers auth middleware and pulls imapManager from the app entrypoint
// at import time; neither is exercised by the pure helper under test, so stub them.
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: vi.fn() }));
vi.mock('../index.js', () => ({ imapManager: {} }));

import { classifyTarget, resolveDoneFolders } from './gtd.js';
import { DEFAULT_GTD_FOLDERS } from '../services/gtdConfig.js';

describe('classifyTarget', () => {
  it('rejects with 400 when GTD is disabled for the account', () => {
    const r = classifyTarget({ enabled: false, folders: DEFAULT_GTD_FOLDERS, state: 'todo' });
    expect(r.status).toBe(400);
    expect(r.error).toMatch(/not enabled/i);
    expect(r.folder).toBeUndefined();
  });

  it('rejects with 400 for an unknown GTD state', () => {
    const r = classifyTarget({ enabled: true, folders: DEFAULT_GTD_FOLDERS, state: 'inbox' });
    expect(r.status).toBe(400);
    expect(r.error).toMatch(/unknown/i);
  });

  it('resolves the designated folder for a valid state when enabled', () => {
    expect(classifyTarget({ enabled: true, folders: DEFAULT_GTD_FOLDERS, state: 'todo' }))
      .toEqual({ folder: 'Todo' });
  });

  it('honours an account folder override', () => {
    const folders = { ...DEFAULT_GTD_FOLDERS, todo: 'Tasks' };
    expect(classifyTarget({ enabled: true, folders, state: 'todo' }))
      .toEqual({ folder: 'Tasks' });
  });

  it('rejects with 400 when the state maps to a blank folder path', () => {
    const folders = { ...DEFAULT_GTD_FOLDERS, todo: '   ' };
    const r = classifyTarget({ enabled: true, folders, state: 'todo' });
    expect(r.status).toBe(400);
  });
});

describe('resolveDoneFolders', () => {
  it('rejects with 400 when GTD is disabled for the account', () => {
    const r = resolveDoneFolders({ enabled: false, folders: DEFAULT_GTD_FOLDERS, states: ['watch'] });
    expect(r.status).toBe(400);
    expect(r.error).toMatch(/not enabled/i);
    expect(r.folders).toBeUndefined();
  });

  it('rejects with 400 when states is missing or empty', () => {
    expect(resolveDoneFolders({ enabled: true, folders: DEFAULT_GTD_FOLDERS, states: [] }).status).toBe(400);
    expect(resolveDoneFolders({ enabled: true, folders: DEFAULT_GTD_FOLDERS }).status).toBe(400);
  });

  it('rejects with 400 for an unknown GTD state', () => {
    const r = resolveDoneFolders({ enabled: true, folders: DEFAULT_GTD_FOLDERS, states: ['watch', 'inbox'] });
    expect(r.status).toBe(400);
    expect(r.error).toMatch(/unknown/i);
  });

  it('resolves a single state to its designated folder', () => {
    expect(resolveDoneFolders({ enabled: true, folders: DEFAULT_GTD_FOLDERS, states: ['todo'] }))
      .toEqual({ folders: ['Todo'] });
  });

  it('resolves a merged Waiting row (watch + delegated) to both folders in order', () => {
    expect(resolveDoneFolders({ enabled: true, folders: DEFAULT_GTD_FOLDERS, states: ['watch', 'delegated'] }))
      .toEqual({ folders: ['Watch', 'Delegated'] });
  });

  it('dedupes states that resolve to the same folder path', () => {
    const folders = { ...DEFAULT_GTD_FOLDERS, watch: 'Waiting', delegated: 'Waiting' };
    expect(resolveDoneFolders({ enabled: true, folders, states: ['watch', 'delegated'] }))
      .toEqual({ folders: ['Waiting'] });
  });

  it('honours an account folder override', () => {
    const folders = { ...DEFAULT_GTD_FOLDERS, watch: 'Follow-up' };
    expect(resolveDoneFolders({ enabled: true, folders, states: ['watch'] }))
      .toEqual({ folders: ['Follow-up'] });
  });

  describe("'all' mode (inbox checkmark)", () => {
    it('rejects with 400 when GTD is disabled, regardless of existing copies', () => {
      const r = resolveDoneFolders({ enabled: false, folders: DEFAULT_GTD_FOLDERS, states: 'all', existing: ['Todo'] });
      expect(r.status).toBe(400);
      expect(r.folders).toBeUndefined();
    });

    it('resolves to only the designated GTD folders the thread actually carries, in map order', () => {
      // existing includes non-GTD folders (INBOX, Archive) and is out of map order —
      // both are normalised away.
      expect(resolveDoneFolders({
        enabled: true, folders: DEFAULT_GTD_FOLDERS, states: 'all',
        existing: ['Watch', 'INBOX', 'Todo', 'Archive'],
      })).toEqual({ folders: ['Todo', 'Watch'] });
    });

    it('resolves to [] when the thread holds no GTD label copies', () => {
      expect(resolveDoneFolders({
        enabled: true, folders: DEFAULT_GTD_FOLDERS, states: 'all', existing: ['INBOX'],
      })).toEqual({ folders: [] });
    });

    it('resolves to [] when existing is omitted', () => {
      expect(resolveDoneFolders({ enabled: true, folders: DEFAULT_GTD_FOLDERS, states: 'all' }))
        .toEqual({ folders: [] });
    });

    it('dedupes when two states share a folder path present in existing', () => {
      const folders = { ...DEFAULT_GTD_FOLDERS, watch: 'Waiting', delegated: 'Waiting' };
      expect(resolveDoneFolders({ enabled: true, folders, states: 'all', existing: ['Waiting'] }))
        .toEqual({ folders: ['Waiting'] });
    });
  });
});
