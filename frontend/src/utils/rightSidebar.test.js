import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  addSidebarLabel,
  buildSidebarFolderChoices,
  clampRightSidebarWidth,
  removeRightSidebarThreadFromSections,
  removeSidebarLabel,
  resolveSavedSidebarLabels,
  rightSidebarActiveForContext,
} from './rightSidebar.js';

describe('clampRightSidebarWidth', () => {
  it('clamps to the supported pixel range and rounds', () => {
    assert.equal(clampRightSidebarWidth(296), 296);
    assert.equal(clampRightSidebarWidth(120), 200);
    assert.equal(clampRightSidebarWidth(999), 600);
    assert.equal(clampRightSidebarWidth(305.7), 306);
  });

  it('falls back to the default width for non-numeric input', () => {
    assert.equal(clampRightSidebarWidth('abc'), 296);
    assert.equal(clampRightSidebarWidth(null), 296);
    assert.equal(clampRightSidebarWidth(undefined), 296);
  });
});

describe('rightSidebarActiveForContext', () => {
  const configured = { id: 'a', enabled: true, right_sidebar_labels: ['Receipts'] };
  const bare = { id: 'b', enabled: true, right_sidebar_labels: [] };
  const disabled = { id: 'c', enabled: false, right_sidebar_labels: ['Receipts'] };

  it('is inactive until a label is configured', () => {
    assert.equal(rightSidebarActiveForContext([bare], 'b'), false);
    assert.equal(rightSidebarActiveForContext([], null), false);
    assert.equal(rightSidebarActiveForContext(null, null), false);
  });

  it('follows the selected account, not the others', () => {
    assert.equal(rightSidebarActiveForContext([configured, bare], 'a'), true);
    assert.equal(rightSidebarActiveForContext([configured, bare], 'b'), false);
  });

  it('activates in unified view when any account is configured', () => {
    assert.equal(rightSidebarActiveForContext([configured, bare], null), true);
    assert.equal(rightSidebarActiveForContext([bare], null), false);
  });

  it('ignores disabled accounts', () => {
    assert.equal(rightSidebarActiveForContext([disabled], 'c'), false);
    assert.equal(rightSidebarActiveForContext([disabled], null), false);
  });
});

describe('sidebar label list edits', () => {
  it('appends without duplicating', () => {
    assert.deepEqual(addSidebarLabel(['a'], 'b'), ['a', 'b']);
    assert.deepEqual(addSidebarLabel(['a'], 'a'), ['a']);
  });

  it('removes by path', () => {
    assert.deepEqual(removeSidebarLabel(['a', 'b'], 'a'), ['b']);
    assert.deepEqual(removeSidebarLabel(['a'], 'missing'), ['a']);
  });
});

describe('resolveSavedSidebarLabels', () => {
  it('prefers the server echo over what was submitted', () => {
    assert.deepEqual(resolveSavedSidebarLabels({ right_sidebar_labels: ['a'] }, ['a', 'INBOX']), ['a']);
  });

  it('falls back to the submitted list when the server sends nothing', () => {
    assert.deepEqual(resolveSavedSidebarLabels({}, ['a']), ['a']);
    assert.deepEqual(resolveSavedSidebarLabels(null, ['a']), ['a']);
  });
});

describe('buildSidebarFolderChoices', () => {
  const folders = [
    { path: 'INBOX', name: 'Inbox' },
    { path: 'Sent', name: 'Sent', special_use: '\\Sent' },
    { path: 'Receipts', name: 'Receipts' },
    { path: 'Work/Clients', name: 'Clients' },
  ];

  it('keeps saved order and flags folders that no longer exist', () => {
    const { selected } = buildSidebarFolderChoices(folders, ['Work/Clients', 'Gone', 'Receipts']);
    assert.deepEqual(selected.map(f => f.path), ['Work/Clients', 'Gone', 'Receipts']);
    assert.deepEqual(selected.map(f => f.available), [true, false, true]);
    // A vanished folder has no name to show, so it falls back to its raw path.
    assert.equal(selected[1].name, 'Gone');
  });

  it('offers only unpicked, non-system folders', () => {
    const { available } = buildSidebarFolderChoices(folders, ['Receipts']);
    assert.deepEqual(available.map(f => f.path), ['Work/Clients']);
  });

  it('tolerates a missing folder list', () => {
    assert.deepEqual(buildSidebarFolderChoices(null, null), { selected: [], available: [] });
  });
});

describe('removeRightSidebarThreadFromSections', () => {
  const sections = () => [{
    path: 'Receipts',
    total: 2,
    unread: 1,
    threads: [
      { id: 1, account_id: 'a', message_id: '<x>', is_read: false },
      { id: 2, account_id: 'a', message_id: '<y>', is_read: true },
    ],
  }];

  it('drops the thread and decrements total and unread', () => {
    const [section] = removeRightSidebarThreadFromSections(sections(), 'a\u0000<x>', ['Receipts']);
    assert.deepEqual(section.threads.map(t => t.id), [2]);
    assert.equal(section.total, 1);
    assert.equal(section.unread, 0);
  });

  it('accepts a row object as the identity', () => {
    const rows = sections();
    const [section] = removeRightSidebarThreadFromSections(rows, rows[0].threads[0], ['Receipts']);
    assert.deepEqual(section.threads.map(t => t.id), [2]);
  });

  it('returns the same reference when nothing matched', () => {
    const rows = sections();
    assert.equal(removeRightSidebarThreadFromSections(rows, 'a\u0000<none>', ['Receipts']), rows);
    assert.equal(removeRightSidebarThreadFromSections(rows, 'a\u0000<x>', ['Other']), rows);
  });

  it('never drives a count below zero', () => {
    const rows = [{ path: 'Receipts', total: 0, unread: 0, threads: [{ id: 1, account_id: 'a', message_id: '<x>', is_read: false }] }];
    const [section] = removeRightSidebarThreadFromSections(rows, 'a\u0000<x>', ['Receipts']);
    assert.equal(section.total, 0);
    assert.equal(section.unread, 0);
  });
});
