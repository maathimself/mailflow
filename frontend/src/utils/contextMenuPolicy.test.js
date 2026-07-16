import test from 'node:test';
import assert from 'node:assert/strict';
import { getContextMenuPolicy } from './contextMenuPolicy.js';

test('GTD sidebar keeps message actions but drops list-only and archive actions', () => {
  assert.deepEqual(getContextMenuPolicy('gtdSidebar'), {
    select: false,
    compose: true,
    archive: false,
    snooze: false,
    categorize: false,
    done: true,
    rules: true,
    spam: false,
    copy: true,
    viewHeaders: true,
  });
});

test('inbox retains its existing action capabilities', () => {
  assert.deepEqual(getContextMenuPolicy('inbox'), {
    select: true,
    compose: true,
    archive: true,
    snooze: true,
    categorize: true,
    done: false,
    rules: true,
    spam: true,
    copy: true,
    viewHeaders: true,
  });
});
