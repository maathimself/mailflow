// Run with: node --test src/utils/gtd.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  STALE_DAYS,
  agingDays,
  isStale,
  agingLabel,
  resolveRowDisplay,
  gtdActiveForContext,
  mergeWaiting,
  buildGtdDisplaySections,
  removeGtdThreadFromSections,
  setGtdThreadReadInSections,
  collectThreadReadIds,
  scheduleGtdThreadAutoRead,
  openGtdThreadWithAutoRead,
  sectionBadge,
  openDeepLinkMessage,
  classifyThread,
  unclassifyThread,
  pickThreadMessage,
  isSelectedRow,
  DEFAULT_GTD_FOLDERS,
  resolveAccountGtdFolders,
  gtdStatesInFolders,
  diffGtdFolders,
  findGtdFolderCollisions,
  computeSpriteLayout,
} from './gtd.js';

const DAY = 24 * 60 * 60 * 1000;

describe('agingDays', () => {
  it('returns whole days elapsed since the head date', () => {
    const now = Date.parse('2026-07-10T12:00:00Z');
    assert.equal(agingDays('2026-07-09T12:00:00Z', now), 1);
    assert.equal(agingDays('2026-06-24T12:00:00Z', now), 16);
  });

  it('floors partial days', () => {
    const now = Date.parse('2026-07-10T12:00:00Z');
    // 1 day and 23 hours ago -> 1 whole day
    assert.equal(agingDays(new Date(now - DAY - 23 * 60 * 60 * 1000).toISOString(), now), 1);
  });

  it('clamps future dates to 0 rather than going negative', () => {
    const now = Date.parse('2026-07-10T12:00:00Z');
    assert.equal(agingDays('2026-07-11T12:00:00Z', now), 0);
  });

  it('returns null for a missing or unparseable date', () => {
    assert.equal(agingDays(null), null);
    assert.equal(agingDays(''), null);
    assert.equal(agingDays('not-a-date'), null);
  });
});

describe('isStale', () => {
  it('is true only past STALE_DAYS', () => {
    assert.equal(STALE_DAYS, 14);
    assert.equal(isStale(14), false);
    assert.equal(isStale(15), true);
    assert.equal(isStale(3), false);
    assert.equal(isStale(null), false);
  });
});

describe('agingLabel', () => {
  it('formats an aging chip label, empty when unknown', () => {
    assert.equal(agingLabel(3), '⏱ 3d');
    assert.equal(agingLabel(0), '⏱ 0d');
    assert.equal(agingLabel(null), '');
  });
});

describe('resolveRowDisplay', () => {
  const DAY = 24 * 60 * 60 * 1000;

  it('non-waiting section uses the section key as rowState with no kinds', () => {
    const out = resolveRowDisplay({ is_read: true, from_name: 'Alice' }, 'todo');
    assert.deepEqual(out.kinds, []);
    assert.equal(out.rowState, 'todo');
  });

  it('waiting section defaults to a single watch kind when no kind info is present', () => {
    const out = resolveRowDisplay({ is_read: true }, 'waiting');
    assert.deepEqual(out.kinds, ['watch']);
    assert.equal(out.rowState, 'watch');
  });

  it('waiting section falls back to the single gtdKind when gtdKinds is absent', () => {
    const out = resolveRowDisplay({ gtdKind: 'delegated', is_read: true }, 'waiting');
    assert.deepEqual(out.kinds, ['delegated']);
    assert.equal(out.rowState, 'delegated');
  });

  it('a merged watch+delegated row reads as watch-first (gtdKinds[0] wins)', () => {
    const out = resolveRowDisplay({ gtdKinds: ['watch', 'delegated'], is_read: true }, 'waiting');
    assert.deepEqual(out.kinds, ['watch', 'delegated']);
    assert.equal(out.rowState, 'watch');
  });

  it('computes unread from is_read', () => {
    assert.equal(resolveRowDisplay({ is_read: false }, 'todo').unread, true);
    assert.equal(resolveRowDisplay({ is_read: true }, 'todo').unread, false);
  });

  it('ages from agingDate when present (falls back to date), flagging stale past STALE_DAYS', () => {
    const now = Date.now();
    const oldAgingDate = new Date(now - 20 * DAY).toISOString();
    const recentDate = new Date(now - 2 * DAY).toISOString();

    // agingDate (older, merged-row date) wins over the row's own newer date.
    const merged = resolveRowDisplay({ date: recentDate, agingDate: oldAgingDate, is_read: true }, 'waiting');
    assert.equal(merged.days, 20);
    assert.equal(merged.stale, true);

    // No agingDate: falls back to date, and stays under the stale threshold.
    const single = resolveRowDisplay({ date: recentDate, is_read: true }, 'waiting');
    assert.equal(single.days, 2);
    assert.equal(single.stale, false);
  });

  it('falls back through the sender chain: from_name, then from_email, then empty', () => {
    assert.equal(resolveRowDisplay({ from_name: 'Alice', from_email: 'a@x.com' }, 'todo').sender, 'Alice');
    assert.equal(resolveRowDisplay({ from_email: 'a@x.com' }, 'todo').sender, 'a@x.com');
    assert.equal(resolveRowDisplay({}, 'todo').sender, '');
  });
});

describe('gtdActiveForContext', () => {
  const accounts = [
    { id: 'a', gtd_enabled: true },
    { id: 'b', gtd_enabled: false },
  ];
  it('unified: true when any account has GTD enabled', () => {
    assert.equal(gtdActiveForContext(accounts, null), true);
    assert.equal(gtdActiveForContext([{ id: 'b', gtd_enabled: false }], null), false);
  });
  it('per-account: gates on that account flag only', () => {
    assert.equal(gtdActiveForContext(accounts, 'a'), true);
    assert.equal(gtdActiveForContext(accounts, 'b'), false);
    assert.equal(gtdActiveForContext(accounts, 'missing'), false);
  });
  it('is false for empty/absent accounts', () => {
    assert.equal(gtdActiveForContext([], null), false);
    assert.equal(gtdActiveForContext(undefined, null), false);
  });
});

describe('mergeWaiting', () => {
  it('merges watch + delegated newest-first and tags each row kind', () => {
    const watch = {
      total: 2, unread: 1,
      threads: [
        { message_id: 'w1', date: '2026-07-08T00:00:00Z' },
        { message_id: 'w2', date: '2026-06-23T00:00:00Z' },
      ],
    };
    const delegated = {
      total: 1, unread: 0,
      threads: [{ message_id: 'd1', date: '2026-07-06T00:00:00Z' }],
    };
    const merged = mergeWaiting(watch, delegated);
    assert.equal(merged.total, 3);
    assert.equal(merged.unread, 1);
    assert.deepEqual(merged.threads.map(t => t.message_id), ['w1', 'd1', 'w2']);
    assert.deepEqual(merged.threads.map(t => t.gtdKind), ['watch', 'delegated', 'watch']);
  });

  it('tolerates missing sections', () => {
    const merged = mergeWaiting(undefined, undefined);
    assert.deepEqual(merged, { total: 0, unread: 0, threads: [] });
  });

  it('dedupes a thread labelled BOTH watch and delegated into one row with both kinds', () => {
    const watch = {
      total: 1, unread: 1,
      threads: [{ message_id: 'x', date: '2026-07-05T00:00:00Z', is_read: false }],
    };
    const delegated = {
      total: 1, unread: 1,
      threads: [{ message_id: 'x', date: '2026-07-08T00:00:00Z', is_read: false }],
    };
    const merged = mergeWaiting(watch, delegated);
    // One surviving row, not two.
    assert.equal(merged.threads.length, 1);
    // Count is deduped (1 unique thread), not the sum of folder rows (2).
    assert.equal(merged.total, 1);
    assert.equal(merged.unread, 1);
    // Shows BOTH kind chips, watch before delegated.
    assert.deepEqual(merged.threads[0].gtdKinds, ['watch', 'delegated']);
    // Uses the newer head's date for display, ages from the older waiting date.
    assert.equal(merged.threads[0].date, '2026-07-08T00:00:00Z');
    assert.equal(merged.threads[0].agingDate, '2026-07-05T00:00:00Z');
  });

  it('falls back to id (not thread_key) for identity, matching the backend dedupe', () => {
    // Same thread_key, no message_id, different id: must NOT collapse (thread_key
    // is not part of the identity chain, per backend parity).
    const byThreadKey = mergeWaiting(
      { total: 1, unread: 0, threads: [{ id: 'w1', thread_key: 'shared', date: '2026-07-05T00:00:00Z' }] },
      { total: 1, unread: 0, threads: [{ id: 'd1', thread_key: 'shared', date: '2026-07-06T00:00:00Z' }] },
    );
    assert.equal(byThreadKey.threads.length, 2);

    // Same id, no message_id: DOES collapse (id is the fallback after message_id).
    const byId = mergeWaiting(
      { total: 1, unread: 0, threads: [{ id: 'x', date: '2026-07-05T00:00:00Z' }] },
      { total: 1, unread: 0, threads: [{ id: 'x', date: '2026-07-06T00:00:00Z' }] },
    );
    assert.equal(byId.threads.length, 1);
    assert.deepEqual(byId.threads[0].gtdKinds, ['watch', 'delegated']);
  });

  it('tags a single-kind row with a one-entry gtdKinds and its own agingDate', () => {
    const merged = mergeWaiting(
      { total: 1, unread: 0, threads: [{ message_id: 'w', date: '2026-07-02T00:00:00Z' }] },
      { total: 0, unread: 0, threads: [] },
    );
    assert.deepEqual(merged.threads[0].gtdKinds, ['watch']);
    assert.equal(merged.threads[0].agingDate, '2026-07-02T00:00:00Z');
  });

  it('prefers the server waiting rollup over the visible-heads arithmetic (beyond-window drift)', () => {
    // The per-state totals sum to 80 while the client holds only a couple of heads, so the
    // visible-collapse math cannot see the overlap and would report ~80. The server rollup
    // is the deduped truth and wins; the thread list is still the deduped visible heads.
    const watch = { total: 40, unread: 20, threads: [{ message_id: 'w1', date: '2026-07-08T00:00:00Z', is_read: false }] };
    const delegated = { total: 40, unread: 20, threads: [{ message_id: 'd1', date: '2026-07-06T00:00:00Z', is_read: false }] };
    const merged = mergeWaiting(watch, delegated, { total: 55, unread: 27 });
    assert.equal(merged.total, 55);
    assert.equal(merged.unread, 27);
    assert.deepEqual(merged.threads.map(t => t.message_id), ['w1', 'd1']);
  });

  it('still dedupes the visible-heads count when no rollup is supplied (fallback)', () => {
    const watch = { total: 1, unread: 1, threads: [{ message_id: 'x', date: '2026-07-05T00:00:00Z', is_read: false }] };
    const delegated = { total: 1, unread: 1, threads: [{ message_id: 'x', date: '2026-07-08T00:00:00Z', is_read: false }] };
    const merged = mergeWaiting(watch, delegated);
    assert.equal(merged.total, 1);
    assert.equal(merged.unread, 1);
  });

  it('fallback unread counts a both-labelled thread once regardless of which copy is unread', () => {
    // No server rollup: a both-labelled thread must contribute exactly 1 to unread when ANY
    // copy is unread, and 0 when none is — independent of dedupe order (which copy is newer).
    // watch carries the newer date (first-seen, owns display); delegated the older.
    const both = (watchRead, delegatedRead) => mergeWaiting(
      { total: 1, unread: watchRead ? 0 : 1, threads: [{ message_id: 'x', date: '2026-07-08T00:00:00Z', is_read: watchRead }] },
      { total: 1, unread: delegatedRead ? 0 : 1, threads: [{ message_id: 'x', date: '2026-07-05T00:00:00Z', is_read: delegatedRead }] },
    );

    assert.equal(both(true, false).unread, 1);  // newer read, older unread (the previously-broken order → was 0)
    assert.equal(both(false, true).unread, 1);  // newer unread, older read (symmetric order)
    assert.equal(both(false, false).unread, 1); // both unread → deduped to 1, not summed to 2
    assert.equal(both(true, true).unread, 0);   // both read → 0

    // Every case is still a single deduped row of total 1.
    for (const m of [both(true, false), both(false, true), both(false, false), both(true, true)]) {
      assert.equal(m.total, 1);
      assert.equal(m.threads.length, 1);
    }
  });
});

describe('buildGtdDisplaySections', () => {
  it('returns todo, waiting, reference, someday in order with waiting merged', () => {
    const sections = {
      todo: { total: 1, unread: 1, threads: [{ message_id: 't' }] },
      watch: { total: 1, unread: 0, threads: [{ message_id: 'w', date: '2026-07-02' }] },
      delegated: { total: 1, unread: 1, threads: [{ message_id: 'd', date: '2026-07-05' }] },
      reference: { total: 12, unread: 0, threads: [{ message_id: 'r' }] },
      someday: { total: 4, unread: 0, threads: [{ message_id: 's' }] },
    };
    const displaySections = buildGtdDisplaySections(sections);
    assert.deepEqual(displaySections.map(s => s.key), ['todo', 'waiting', 'reference', 'someday']);
    const waiting = displaySections.find(s => s.key === 'waiting');
    assert.equal(waiting.total, 2);
    assert.equal(waiting.unread, 1);
    assert.deepEqual(waiting.threads.map(t => t.message_id), ['d', 'w']);
  });

  it('produces zeroed sections when data is absent', () => {
    const displaySections = buildGtdDisplaySections(undefined);
    assert.deepEqual(displaySections.map(s => s.key), ['todo', 'waiting', 'reference', 'someday']);
    assert.ok(displaySections.every(s => s.total === 0 && s.threads.length === 0));
  });

  it('counts the deduped Waiting thread once when it is in both watch and delegated', () => {
    const sections = {
      watch:     { total: 1, unread: 0, threads: [{ message_id: 'x', date: '2026-07-05' }] },
      delegated: { total: 1, unread: 0, threads: [{ message_id: 'x', date: '2026-07-05' }] },
    };
    const waiting = buildGtdDisplaySections(sections).find(s => s.key === 'waiting');
    assert.equal(waiting.total, 1);
    assert.equal(waiting.threads.length, 1);
    assert.deepEqual(waiting.threads[0].gtdKinds, ['watch', 'delegated']);
  });

  it('uses the server waiting rollup for the Waiting section count when present', () => {
    // Per-state totals sum to 60, but the deduped server rollup is the source of truth.
    const sections = {
      watch:     { total: 30, unread: 10, threads: [{ message_id: 'w', date: '2026-07-05' }] },
      delegated: { total: 30, unread: 10, threads: [{ message_id: 'd', date: '2026-07-06' }] },
      waiting:   { total: 45, unread: 15 },
    };
    const waiting = buildGtdDisplaySections(sections).find(s => s.key === 'waiting');
    assert.equal(waiting.total, 45);
    assert.equal(waiting.unread, 15);
    assert.deepEqual(waiting.threads.map(t => t.message_id), ['d', 'w']);
  });
});

describe('sectionBadge', () => {
  it('caps at 99+', () => {
    assert.equal(sectionBadge(0), '');
    assert.equal(sectionBadge(5), '5');
    assert.equal(sectionBadge(150), '99+');
  });
});

describe('resolveAccountGtdFolders', () => {
  it('returns defaults when the account has no overrides', () => {
    assert.deepEqual(resolveAccountGtdFolders({}), DEFAULT_GTD_FOLDERS);
    assert.deepEqual(resolveAccountGtdFolders(undefined), DEFAULT_GTD_FOLDERS);
  });
  it('merges stored overrides over the defaults', () => {
    const merged = resolveAccountGtdFolders({ gtd_folders: { todo: 'Tasks' } });
    assert.equal(merged.todo, 'Tasks');
    assert.equal(merged.watch, 'Watch');
  });
});

describe('gtdStatesInFolders', () => {
  const map = DEFAULT_GTD_FOLDERS;
  it('returns the states whose folder is present in the thread folders', () => {
    assert.deepEqual(gtdStatesInFolders(['INBOX', 'Todo', 'Reference'], map), ['todo', 'reference']);
  });
  it('returns empty for no folders or no matches', () => {
    assert.deepEqual(gtdStatesInFolders([], map), []);
    assert.deepEqual(gtdStatesInFolders(undefined, map), []);
    assert.deepEqual(gtdStatesInFolders(['INBOX'], map), []);
  });
});

describe('openDeepLinkMessage', () => {
  it('stashes the fetched message under __dl_<id> then selects it', async () => {
    const calls = [];
    const msg = { id: 'm1', subject: 'hi' };
    const deps = {
      getMessage: async (id) => { calls.push(['get', id]); return msg; },
      setThreadMessages: (tid, msgs) => calls.push(['stash', tid, msgs]),
      setSelectedMessage: (id) => calls.push(['select', id]),
    };
    const out = await openDeepLinkMessage('m1', deps);
    assert.equal(out, msg);
    assert.deepEqual(calls, [
      ['get', 'm1'],
      ['stash', '__dl_m1', [msg]],
      ['select', 'm1'],
    ]);
  });

  it('does not select when the fetch fails and no recovery deps are supplied', async () => {
    const calls = [];
    const deps = {
      getMessage: async () => { throw new Error('nope'); },
      setThreadMessages: (tid, msgs) => calls.push(['stash', tid, msgs]),
      setSelectedMessage: (id) => calls.push(['select', id]),
    };
    const out = await withWarnCaptured(() => openDeepLinkMessage('m1', deps));
    assert.equal(out.result, null);
    assert.deepEqual(calls, []);
    // Even with nothing to recover with, a failed click warns — never a silent no-op.
    assert.equal(out.warned.length, 1);
  });
});

// Capture console.warn for the "never a silent no-op" contract without leaking noise.
async function withWarnCaptured(fn) {
  const warned = [];
  const orig = console.warn;
  console.warn = (...a) => warned.push(a.join(' '));
  try { return { result: await fn(), warned }; } finally { console.warn = orig; }
}

describe('pickThreadMessage', () => {
  const A = { id: 'a', message_id: '<a>', date: '2026-07-01T00:00:00Z' };
  const B = { id: 'b', message_id: '<b>', date: '2026-07-05T00:00:00Z' };

  it('prefers the row whose message_id matches, even under a fresh row id', () => {
    // Same logical mail, re-inserted with a new PK after a purge/relocation: match on the
    // stable RFC message_id, not the volatile id.
    const msgs = [{ id: 'fresh', message_id: '<a>', date: '2026-07-01T00:00:00Z' }, B];
    assert.equal(pickThreadMessage(msgs, '<a>').id, 'fresh');
  });

  it('falls back to the newest row when no message_id matches', () => {
    assert.equal(pickThreadMessage([A, B], '<missing>').id, 'b');
    assert.equal(pickThreadMessage([A, B], undefined).id, 'b');
  });

  it('ignores rows without an id and returns null for an empty set', () => {
    assert.equal(pickThreadMessage([{ message_id: '<x>' }], '<x>'), null);
    assert.equal(pickThreadMessage([], '<a>'), null);
    assert.equal(pickThreadMessage(undefined, '<a>'), null);
  });
});

describe('isSelectedRow', () => {
  it('matches a different DB copy of the selected message by shared message_id', () => {
    // GTD section row (label-folder copy) and inbox row (INBOX copy) are distinct ids, same RFC id.
    const sectionRow = { id: 'label-7', message_id: '<m1>' };
    const inboxRow = { id: 'inbox-3', message_id: '<m1>' };
    // Selection is the label copy (selectedId = label-7, selectedMid = <m1>).
    assert.equal(isSelectedRow(sectionRow, 'label-7', '<m1>'), true);   // exact id
    assert.equal(isSelectedRow(inboxRow, 'label-7', '<m1>'), true);  // identity across copies
  });

  it('never matches two null/absent message_ids — falls back to id equality', () => {
    // A row with no message_id and a selection with no message_id must not collapse together.
    assert.equal(isSelectedRow({ id: 'a' }, 'b', null), false);
    assert.equal(isSelectedRow({ id: 'a', message_id: null }, 'b', null), false);
    assert.equal(isSelectedRow({ id: 'b' }, 'b', null), true); // id fallback still works
  });

  it('does not match rows with a different message_id and a different id', () => {
    assert.equal(isSelectedRow({ id: 'x', message_id: '<other>' }, 'y', '<m1>'), false);
  });

  it('returns false for a missing row or when nothing is selected', () => {
    assert.equal(isSelectedRow(null, 'a', '<m1>'), false);
    assert.equal(isSelectedRow(undefined, 'a', '<m1>'), false);
    assert.equal(isSelectedRow({ id: 'a', message_id: '<m1>' }, null, null), false);
  });
});

describe('openDeepLinkMessage — stale-id recovery', () => {
  const stash = () => {
    const calls = [];
    const base = {
      setThreadMessages: (tid, msgs) => calls.push(['stash', tid, msgs]),
      setSelectedMessage: (id) => calls.push(['select', id]),
    };
    return { calls, base };
  };

  it('recovers a 404 by resolving the thread on the stable message_id, and self-heals', async () => {
    const { calls, base } = stash();
    let refetched = 0;
    const fresh = { id: 'fresh', message_id: '<mid>', date: '2026-07-01T00:00:00Z' };
    const deps = {
      ...base,
      getMessage: async () => { throw new Error('404'); },
      getThread: async (tk) => { calls.push(['thread', tk]); return { messages: [fresh] }; },
      thread: { id: 'stale', message_id: '<mid>', thread_key: 'tk1' },
      onMiss: () => { refetched += 1; },
    };
    const { result, warned } = await withWarnCaptured(() => openDeepLinkMessage('stale', deps));
    assert.equal(result, fresh);
    assert.equal(refetched, 1);
    assert.equal(warned.length, 1);
    assert.match(warned[0], /stale/);
    assert.deepEqual(calls, [
      ['thread', 'tk1'],
      ['stash', '__dl_fresh', [fresh]],
      ['select', 'fresh'],
    ]);
  });

  it('treats a falsy id as a miss: never calls getMessage, self-heals, recovers via thread', async () => {
    const { calls, base } = stash();
    let refetched = 0;
    const fresh = { id: 'fresh', message_id: '<mid>' };
    const deps = {
      ...base,
      getMessage: async () => { calls.push(['get']); return { id: 'x' }; },
      getThread: async () => ({ messages: [fresh] }),
      thread: { id: null, message_id: '<mid>', thread_key: 'tk1' },
      onMiss: () => { refetched += 1; },
    };
    const { result, warned } = await withWarnCaptured(() => openDeepLinkMessage(null, deps));
    assert.equal(result, fresh);
    assert.equal(refetched, 1);
    assert.equal(warned.length, 1);
    assert.ok(!calls.some(c => c[0] === 'get')); // a falsy id skips the doomed fetch
  });

  it('warns and self-heals even when thread recovery finds nothing (never a silent no-op)', async () => {
    const { calls, base } = stash();
    let refetched = 0;
    const deps = {
      ...base,
      getMessage: async () => null,
      getThread: async () => ({ messages: [] }),
      thread: { id: 'stale', message_id: '<mid>', thread_key: 'tk1' },
      onMiss: () => { refetched += 1; },
    };
    const { result, warned } = await withWarnCaptured(() => openDeepLinkMessage('stale', deps));
    assert.equal(result, null);
    assert.equal(refetched, 1);
    assert.equal(warned.length, 1);
    assert.ok(!calls.some(c => c[0] === 'stash' || c[0] === 'select'));
  });
});

describe('diffGtdFolders', () => {
  it('returns only entries that differ from the defaults, trimmed', () => {
    assert.deepEqual(
      diffGtdFolders({ ...DEFAULT_GTD_FOLDERS, todo: '  Tasks  ', reference: 'Ref' }),
      { todo: 'Tasks', reference: 'Ref' },
    );
  });

  it('returns {} when every field matches the default', () => {
    assert.deepEqual(diffGtdFolders(DEFAULT_GTD_FOLDERS), {});
  });

  it('drops blank fields (they fall back to the default)', () => {
    assert.deepEqual(diffGtdFolders({ ...DEFAULT_GTD_FOLDERS, todo: '   ', watch: '' }), {});
  });

  it('ignores unknown keys and a missing map', () => {
    assert.deepEqual(diffGtdFolders({ bogus: 'X' }), {});
    assert.deepEqual(diffGtdFolders(null), {});
    assert.deepEqual(diffGtdFolders(undefined), {});
  });
});

describe('findGtdFolderCollisions', () => {
  it('returns [] when all resolved folders are distinct', () => {
    assert.deepEqual(findGtdFolderCollisions(DEFAULT_GTD_FOLDERS), []);
    // Every field blank -> each resolves to its distinct default -> no collision.
    assert.deepEqual(findGtdFolderCollisions({}), []);
  });

  it('detects a collision when an override matches another state default', () => {
    const collisions = findGtdFolderCollisions({ ...DEFAULT_GTD_FOLDERS, todo: 'Watch' });
    assert.equal(collisions.length, 1);
    assert.equal(collisions[0].folder, 'Watch');
    assert.deepEqual([...collisions[0].states].sort(), ['todo', 'watch']);
  });

  it('resolves blanks to defaults before comparing', () => {
    // todo blank -> "Todo"; watch typed as "Todo" -> both resolve to "Todo".
    const collisions = findGtdFolderCollisions({ ...DEFAULT_GTD_FOLDERS, todo: '', watch: 'Todo' });
    assert.equal(collisions.length, 1);
    assert.deepEqual([...collisions[0].states].sort(), ['todo', 'watch']);
  });

  it('trims before comparing so whitespace variants still collide', () => {
    const collisions = findGtdFolderCollisions({ ...DEFAULT_GTD_FOLDERS, todo: '  Watch  ' });
    assert.equal(collisions.length, 1);
    assert.deepEqual([...collisions[0].states].sort(), ['todo', 'watch']);
  });
});

describe('computeSpriteLayout', () => {
  // steve-jobs geometry fixture: 1536×1872 sheet, 8×9 grid → 192×208 frames. Each
  // test supplies the hover sequence it exercises.
  const STEVE_JOBS = { cols: 8, rows: 9, frameW: 192, frameH: 208, staticFrame: 0, hover: { start: 0, count: 8 } };

  it('scales steve-jobs frames to the render size and lays out the first-row hover', () => {
    const L = computeSpriteLayout({ ...STEVE_JOBS, size: 104 });
    // scale = 104 / max(192,208) = 0.5
    assert.equal(L.dispW, 96);
    assert.equal(L.dispH, 104);
    assert.equal(L.bgW, 768);   // 8 * 96
    assert.equal(L.bgH, 936);   // 9 * 104
    assert.deepEqual([L.staticX, L.staticY], [0, 0]);
    assert.deepEqual([L.hoverX0, L.hoverX1, L.hoverY], [0, -768, 0]);
    assert.equal(L.hoverCount, 8);
  });

  it('lays out the jump-row hover (row 4, 5 frames) as a stable single-row loop', () => {
    // The 8×9 fallback loops the jump row over exactly its 5 populated frames, so
    // steps(5) sweeps frames 32–36 and ends one past frame 36 — never onto the
    // blank trailing cells (37–39) that made the old row-0 count-8 loop flash.
    const L = computeSpriteLayout({ ...STEVE_JOBS, hover: { start: 32, count: 5 }, size: 104 });
    assert.equal(L.hoverY, -416);   // -(4 * 104): row 4
    assert.equal(L.hoverX0, 0);     // col 0
    assert.equal(L.hoverX1, -480);  // -(5 * 96): 5 steps, ending one frame past the last
    assert.equal(L.hoverCount, 5);
  });

  it('positions a non-zero static frame at its grid cell', () => {
    const L = computeSpriteLayout({ ...STEVE_JOBS, staticFrame: 10, size: 104 });
    // frame 10 in an 8-col grid → col 2, row 1.
    assert.equal(L.staticX, -192); // -(2 * 96)
    assert.equal(L.staticY, -104); // -(1 * 104)
  });

  it('clamps a hover sequence to the rest of its row', () => {
    const L = computeSpriteLayout({ ...STEVE_JOBS, hover: { start: 6, count: 8 }, size: 104 });
    // start 6 → col 6 of row 0; only 2 frames remain in the row.
    assert.equal(L.hoverCount, 2);
    assert.equal(L.hoverX0, -576); // -(6 * 96)
    assert.equal(L.hoverX1, -768); // -(8 * 96)
    assert.equal(L.hoverY, 0);
  });

  it('never produces NaN for a degenerate descriptor', () => {
    const L = computeSpriteLayout({});
    for (const v of Object.values(L)) assert.equal(Number.isFinite(v), true);
    assert.equal(L.hoverCount >= 1, true);
  });
});

describe('openDeepLinkMessage — click race (sequence token)', () => {
  it('a slow first click loses to a faster newer click: no overwrite, no warn', async () => {
    const calls = [];
    const mk = (msg, gate) => ({
      getMessage: async () => { await gate; return msg; },
      setThreadMessages: (tid) => calls.push(['stash', tid]),
      setSelectedMessage: (id) => calls.push(['select', id]),
    });
    let releaseFirst;
    const firstGate = new Promise(r => { releaseFirst = r; });
    const m1 = { id: 'm1' };
    const m2 = { id: 'm2' };

    const { result, warned } = await withWarnCaptured(async () => {
      const p1 = openDeepLinkMessage('m1', mk(m1, firstGate));            // starts; fetch held open
      const r2 = await openDeepLinkMessage('m2', mk(m2, Promise.resolve())); // newer click, resolves first
      releaseFirst();                                                     // first click resolves last
      const r1 = await p1;
      return { r1, r2 };
    });

    assert.equal(result.r2, m2);   // the newer click selected its message
    assert.equal(result.r1, null); // the superseded older click drops its write, returns null
    // Only the newer click wrote the pane, and losing a race is not a miss → no warn.
    assert.deepEqual(calls, [['stash', '__dl_m2'], ['select', 'm2']]);
    assert.equal(warned.length, 0);
  });
});

// Rollup-adjustment math for the optimistic store mutators (removeGtdThread /
// markGtdThreadRead delegate to these). A merged Waiting row lives in BOTH watch and
// delegated but is a single deduped row, so the waiting rollup adjusts once.
describe('removeGtdThreadFromSections', () => {
  // Shaped like the store's gtdSections: watch/delegated carry heads; waiting is the
  // server's deduped rollup (no threads). 'x' is labelled BOTH watch and delegated.
  const make = () => ({
    todo:      { total: 2, unread: 1, threads: [{ message_id: 't1', is_read: false }, { message_id: 't2', is_read: true }] },
    watch:     { total: 2, unread: 1, threads: [{ message_id: 'x', is_read: false }, { message_id: 'w2', is_read: true }] },
    delegated: { total: 1, unread: 1, threads: [{ message_id: 'x', is_read: false }] },
    waiting:   { total: 2, unread: 1 }, // deduped unique threads: x (unread) + w2 (read)
    reference: { total: 0, unread: 0, threads: [] },
  });

  it('a thread in BOTH watch and delegated adjusts the Waiting rollup once', () => {
    const out = removeGtdThreadFromSections(make(), 'x', ['watch', 'delegated']);
    assert.deepEqual(out.watch.threads.map(t => t.message_id), ['w2']);
    assert.equal(out.watch.total, 1);
    assert.equal(out.delegated.threads.length, 0);
    assert.equal(out.delegated.total, 0);
    // Waiting decremented ONCE (2 -> 1), and once for the single unread copy.
    assert.equal(out.waiting.total, 1);
    assert.equal(out.waiting.unread, 0);
    assert.equal(out.todo.total, 2); // untouched section left alone
  });

  it('a single-state waiting thread adjusts the rollup once', () => {
    const out = removeGtdThreadFromSections(make(), 'w2', ['watch']);
    assert.deepEqual(out.watch.threads.map(t => t.message_id), ['x']);
    assert.equal(out.watch.total, 1);
    // w2 was read: total drops by one, unread is unchanged.
    assert.equal(out.waiting.total, 1);
    assert.equal(out.waiting.unread, 1);
  });

  it('removing a non-waiting (todo) thread leaves the Waiting rollup untouched', () => {
    const out = removeGtdThreadFromSections(make(), 't1', ['todo']);
    assert.equal(out.todo.total, 1);
    assert.equal(out.todo.unread, 0);
    assert.equal(out.waiting.total, 2);
    assert.equal(out.waiting.unread, 1);
  });

  it('floors rollup counts at zero and no-ops (same reference) when nothing matched', () => {
    const sections = make();
    assert.equal(removeGtdThreadFromSections(sections, 'nope', ['watch', 'delegated']), sections);
    const zeroed = {
      watch: { total: 1, unread: 1, threads: [{ message_id: 'x', is_read: false }] },
      waiting: { total: 0, unread: 0 },
    };
    const out = removeGtdThreadFromSections(zeroed, 'x', ['watch']);
    assert.equal(out.waiting.total, 0);
    assert.equal(out.waiting.unread, 0);
  });

  it('does not mutate the input snapshot', () => {
    const sections = make();
    const before = JSON.stringify(sections);
    removeGtdThreadFromSections(sections, 'x', ['watch', 'delegated']);
    assert.equal(JSON.stringify(sections), before);
  });
});

describe('setGtdThreadReadInSections', () => {
  const make = () => ({
    watch:     { total: 2, unread: 2, threads: [{ message_id: 'x', is_read: false }, { message_id: 'w2', is_read: false }] },
    delegated: { total: 1, unread: 1, threads: [{ message_id: 'x', is_read: false }] },
    waiting:   { total: 2, unread: 2 }, // deduped: x + w2, both unread
    todo:      { total: 1, unread: 1, threads: [{ message_id: 't1', is_read: false }] },
  });

  it('marking a both-states thread read flips every copy and nudges the rollup once', () => {
    const out = setGtdThreadReadInSections(make(), 'x', true);
    assert.equal(out.watch.threads.find(t => t.message_id === 'x').is_read, true);
    assert.equal(out.delegated.threads[0].is_read, true);
    // Each per-state unread dropped by one...
    assert.equal(out.watch.unread, 1);
    assert.equal(out.delegated.unread, 0);
    // ...but the deduped Waiting rollup only once (2 -> 1), and total is untouched.
    assert.equal(out.waiting.unread, 1);
    assert.equal(out.waiting.total, 2);
  });

  it('marking a single-state waiting thread read nudges the rollup once', () => {
    const out = setGtdThreadReadInSections(make(), 'w2', true);
    assert.equal(out.watch.unread, 1);
    assert.equal(out.waiting.unread, 1);
    assert.equal(out.waiting.total, 2);
  });

  it('read then unread restores the rollup (revert path)', () => {
    const read = setGtdThreadReadInSections(make(), 'x', true);
    assert.equal(read.waiting.unread, 1);
    const back = setGtdThreadReadInSections(read, 'x', false);
    assert.equal(back.waiting.unread, 2);
    assert.equal(back.watch.unread, 2);
    assert.equal(back.delegated.unread, 1);
    assert.equal(back.watch.threads.find(t => t.message_id === 'x').is_read, false);
  });

  it('marking a non-waiting (todo) thread read leaves the Waiting rollup untouched', () => {
    const out = setGtdThreadReadInSections(make(), 't1', true);
    assert.equal(out.todo.unread, 0);
    assert.equal(out.waiting.unread, 2);
  });

  it('is a no-op (same reference) when already in the target state or identity is absent', () => {
    const sections = make();
    assert.equal(setGtdThreadReadInSections(sections, 'x', false), sections); // already unread
    assert.equal(setGtdThreadReadInSections(sections, 'nope', true), sections); // no such thread
  });

  it('does not mutate the input snapshot', () => {
    const sections = make();
    const before = JSON.stringify(sections);
    setGtdThreadReadInSections(sections, 'x', true);
    assert.equal(JSON.stringify(sections), before);
  });
});

describe('collectThreadReadIds', () => {
  const head = { id: 'head-1', thread_key: 'tk-1' };

  it('marking READ targets every message in the thread, not just the head', async () => {
    const asked = [];
    const getThread = async (tk) => { asked.push(tk); return { messages: [{ id: 'a' }, { id: 'b' }, { id: 'head-1' }] }; };
    const ids = await collectThreadReadIds(head, true, getThread);
    assert.deepEqual(asked, ['tk-1']);
    assert.deepEqual(ids, ['a', 'b', 'head-1']);
  });

  it('marking UNREAD targets only the head copy and never fetches the thread', async () => {
    const getThread = async () => { throw new Error('must not be called'); };
    assert.deepEqual(await collectThreadReadIds(head, false, getThread), ['head-1']);
  });

  it('degrades to the head id when the thread lookup fails or returns nothing', async () => {
    assert.deepEqual(await collectThreadReadIds(head, true, async () => { throw new Error('boom'); }), ['head-1']);
    assert.deepEqual(await collectThreadReadIds(head, true, async () => ({ messages: [] })), ['head-1']);
    assert.deepEqual(await collectThreadReadIds({ id: 'head-1' }, true, async () => ({})), ['head-1']); // no thread_key
  });
});

describe('scheduleGtdThreadAutoRead', () => {
  const thread = { id: 'head', is_read: false };

  it('reads an unread thread immediately', () => {
    const calls = [];
    const timer = scheduleGtdThreadAutoRead(thread, {
      markReadBehavior: 'immediate',
      markReadDelay: 3,
      readThread: (value, read) => calls.push([value.id, read]),
    });
    assert.equal(timer, null);
    assert.deepEqual(calls, [['head', true]]);
  });

  it('returns the delayed timer handle and uses seconds', () => {
    const calls = [];
    const timer = scheduleGtdThreadAutoRead(thread, {
      markReadBehavior: 'delay',
      markReadDelay: 3,
      readThread: () => calls.push('read'),
      setTimer: (fn, ms) => { calls.push(ms); return { fn }; },
    });
    assert.deepEqual(calls, [3000]);
    assert.equal(typeof timer.fn, 'function');
  });

  it('does nothing in manual mode or for an already-read thread', () => {
    const calls = [];
    const deps = { readThread: () => calls.push('read') };
    assert.equal(scheduleGtdThreadAutoRead(thread, { ...deps, markReadBehavior: 'manual' }), null);
    assert.equal(scheduleGtdThreadAutoRead({ ...thread, is_read: true }, { ...deps, markReadBehavior: 'immediate' }), null);
    assert.deepEqual(calls, []);
  });
});

describe('openGtdThreadWithAutoRead', () => {
  it('publishes a delayed timer before orchestration settles so its owner can cancel it', async () => {
    const timer = { id: 'timer' };
    const cleared = [];
    let finishOpen;
    let ownedTimer = null;
    let settled = false;
    const cancelOwnedTimer = () => {
      cleared.push(ownedTimer);
      ownedTimer = null;
    };
    const opening = openGtdThreadWithAutoRead({ id: 'head', is_read: false }, {
      openThread: () => new Promise(resolve => { finishOpen = resolve; }),
      isCancelled: () => false,
      getPreferences: () => ({ markReadBehavior: 'delay', markReadDelay: 3 }),
      readThread: () => {},
      setTimer: () => timer,
      publishTimer: value => { ownedTimer = value; },
    });
    opening.then(() => { settled = true; });

    finishOpen({ id: 'opened' });
    await Promise.resolve();

    assert.equal(ownedTimer, timer);
    assert.equal(settled, false);
    cancelOwnedTimer();
    assert.deepEqual(cleared, [timer]);
    assert.equal(ownedTimer, null);
    await opening;
  });

  it('publishes null for successful immediate, manual, and already-read opens', async () => {
    const reads = [];
    const cases = [
      { name: 'immediate', thread: { id: 'immediate', is_read: false }, markReadBehavior: 'immediate' },
      { name: 'manual', thread: { id: 'manual', is_read: false }, markReadBehavior: 'manual' },
      { name: 'already-read', thread: { id: 'already-read', is_read: true }, markReadBehavior: 'immediate' },
    ];

    for (const value of cases) {
      let ownedTimer = 'previous';
      await openGtdThreadWithAutoRead(value.thread, {
        openThread: async () => ({ id: 'opened' }),
        isCancelled: () => false,
        getPreferences: () => ({ markReadBehavior: value.markReadBehavior, markReadDelay: 3 }),
        readThread: thread => reads.push(thread.id),
        setTimer: () => { throw new Error('must not schedule'); },
        publishTimer: timer => { ownedTimer = timer; },
      });
      assert.equal(ownedTimer, null, value.name);
    }
    assert.deepEqual(reads, ['immediate']);
  });

  it('does not schedule an automatic read when cancelled while the open is pending', async () => {
    const thread = { id: 'head', is_read: false };
    const calls = [];
    let cancelled = false;
    let finishOpen;
    const opening = openGtdThreadWithAutoRead(thread, {
      openThread: () => new Promise(resolve => { finishOpen = resolve; }),
      isCancelled: () => cancelled,
      getPreferences: () => {
        calls.push('preferences');
        return { markReadBehavior: 'delay', markReadDelay: 3 };
      },
      readThread: () => calls.push('read'),
      setTimer: () => calls.push('timer'),
      publishTimer: timer => calls.push(['publish', timer]),
    });

    cancelled = true;
    finishOpen({ id: 'opened' });

    assert.equal(await opening, null);
    assert.deepEqual(calls, []);
  });

  // The owner cancels a pending delay-mode auto-read when the just-opened row is explicitly
  // marked unread within the window (GtdSidebarContent.cancelAutoMarkRead → clearTimeout on
  // the published handle). Model that seam with a fake clock: setTimer registers the
  // callback, the owner clears the handle, and advancing the clock must NOT run readThread.
  const makeFakeClock = () => {
    let seq = 0;
    const tasks = new Map();
    return {
      setTimer: (fn) => { const id = ++seq; tasks.set(id, fn); return id; },
      clearTimer: (id) => tasks.delete(id),
      tick: () => { for (const fn of [...tasks.values()]) fn(); tasks.clear(); },
    };
  };

  it('fires the delayed auto-read when the window elapses uncancelled', async () => {
    const clock = makeFakeClock();
    const reads = [];
    await openGtdThreadWithAutoRead({ id: 'head', is_read: false }, {
      openThread: async () => ({ id: 'opened' }),
      isCancelled: () => false,
      getPreferences: () => ({ markReadBehavior: 'delay', markReadDelay: 5 }),
      readThread: (thread, read) => reads.push([thread.id, read]),
      setTimer: clock.setTimer,
      publishTimer: () => {},
    });
    clock.tick();
    assert.deepEqual(reads, [['head', true]]);
  });

  it('a mark-unread within the delay window cancels the auto-read: no read (bulkRead) fires', async () => {
    const clock = makeFakeClock();
    const reads = [];
    let owned = null;
    await openGtdThreadWithAutoRead({ id: 'head', is_read: false }, {
      openThread: async () => ({ id: 'opened' }),
      isCancelled: () => false,
      getPreferences: () => ({ markReadBehavior: 'delay', markReadDelay: 5 }),
      readThread: (thread, read) => reads.push([thread.id, read]),
      setTimer: clock.setTimer,
      publishTimer: (handle) => { owned = handle; },
    });
    // Owner (the sidebar) drops the published handle on an explicit mark-unread.
    clock.clearTimer(owned);
    // The delay elapsing on the cleared timer must not revert the thread to read.
    clock.tick();
    assert.deepEqual(reads, []);
  });
});

// Classify = COPY into the state's label folder; unclassify strips one. Both just fire the
// API call, reconverge the GTD sections store, and notify — deps injected (like openDeepLinkMessage)
// so the success and failure-notification paths are unit-testable without a real store/API.
describe('classifyThread', () => {
  const t = (key) => key;

  it('classifies, reconverges the GTD sections store, then notifies success', async () => {
    const calls = [];
    const deps = {
      gtdClassify: async (id, state) => { calls.push(['classify', id, state]); },
      addNotification: (n) => calls.push(['notify', n.title, n.body]),
      scheduleGtdSectionsFetch: () => calls.push(['schedule']),
      t,
    };
    await classifyThread('m1', 'todo', deps);
    assert.deepEqual(calls, [
      ['classify', 'm1', 'todo'],
      ['schedule'],
      ['notify', 'gtd.classified', 'gtd.state.todo'],
    ]);
  });

  it('notifies a classify failure instead of the GTD sections store when the API call rejects', async () => {
    const calls = [];
    const deps = {
      gtdClassify: async () => { throw new Error('boom'); },
      addNotification: (n) => calls.push(['notify', n.title, n.body]),
      scheduleGtdSectionsFetch: () => calls.push(['schedule']),
      t,
    };
    await classifyThread('m1', 'todo', deps);
    assert.deepEqual(calls, [['notify', 'gtd.classifyFailed', 'gtd.state.todo']]);
  });
});

describe('unclassifyThread', () => {
  const t = (key) => key;

  it('unclassifies, reconverges the GTD sections store, then notifies success', async () => {
    const calls = [];
    const deps = {
      gtdUnclassify: async (id, state) => { calls.push(['unclassify', id, state]); },
      addNotification: (n) => calls.push(['notify', n.title, n.body]),
      scheduleGtdSectionsFetch: () => calls.push(['schedule']),
      t,
    };
    await unclassifyThread('m1', 'todo', deps);
    assert.deepEqual(calls, [
      ['unclassify', 'm1', 'todo'],
      ['schedule'],
      ['notify', 'gtd.removed', 'gtd.state.todo'],
    ]);
  });

  it('notifies an unclassify failure instead of the GTD sections store when the API call rejects', async () => {
    const calls = [];
    const deps = {
      gtdUnclassify: async () => { throw new Error('boom'); },
      addNotification: (n) => calls.push(['notify', n.title, n.body]),
      scheduleGtdSectionsFetch: () => calls.push(['schedule']),
      t,
    };
    await unclassifyThread('m1', 'todo', deps);
    assert.deepEqual(calls, [['notify', 'gtd.removeFailed', 'gtd.state.todo']]);
  });
});
