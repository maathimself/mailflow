import test from 'node:test';
import assert from 'node:assert/strict';
import { GTD_SIDEBAR_PREVIEW_LIMITS, getGtdSidebarPreview } from './gtdSidebar.js';

const section = (key, count, total = count) => ({
  key,
  total,
  threads: Array.from({ length: count }, (_, id) => ({ id })),
});

test('uses larger previews for active sections and smaller previews for passive sections', () => {
  assert.deepEqual(GTD_SIDEBAR_PREVIEW_LIMITS, {
    todo: 6,
    waiting: 6,
    reference: 3,
    someday: 3,
  });
  assert.equal(getGtdSidebarPreview(section('todo', 8), false).threads.length, 6);
  assert.equal(getGtdSidebarPreview(section('waiting', 8), false).threads.length, 6);
  assert.equal(getGtdSidebarPreview(section('reference', 8), false).threads.length, 3);
  assert.equal(getGtdSidebarPreview(section('someday', 8), false).threads.length, 3);
});

test('expands to every fetched row and identifies a bounded feed', () => {
  const preview = getGtdSidebarPreview(section('reference', 50, 75), true);
  assert.equal(preview.threads.length, 50);
  assert.equal(preview.available, 50);
  assert.equal(preview.total, 75);
  assert.equal(preview.expandable, true);
  assert.equal(preview.bounded, true);
});

test('does not offer expansion when fetched rows fit the preview', () => {
  const preview = getGtdSidebarPreview(section('todo', 6), false);
  assert.equal(preview.expandable, false);
  assert.equal(preview.bounded, false);
});

test('normalizes malformed section data without hiding fetched rows', () => {
  assert.deepEqual(getGtdSidebarPreview(null, false), {
    threads: [], limit: 6, available: 0, total: 0, expandable: false, bounded: false,
  });
  const preview = getGtdSidebarPreview({ key: 'todo', total: 1, threads: [{ id: 1 }, { id: 2 }] }, true);
  assert.equal(preview.total, 2);
  assert.equal(preview.threads.length, 2);
});
