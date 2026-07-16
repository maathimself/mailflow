import test from 'node:test';
import assert from 'node:assert/strict';
import { getContextMenuPolicy, resolveContextMenuMessage } from './contextMenuPolicy.js';

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

test('GTD actions resolve the current row by stable Message-ID', async () => {
  const calls = [];
  const current = { id: 'current-row' };
  const result = await resolveContextMenuMessage({
    id: 'stale-row',
    message_id: '<stable@example.com>',
  }, 'gtdSidebar', async ref => {
    calls.push(ref);
    return current;
  });

  assert.equal(result, current);
  assert.deepEqual(calls, ['<stable@example.com>']);
});

test('GTD resolution falls back to a legacy row id', async () => {
  const result = await resolveContextMenuMessage(
    { id: 'legacy-row' },
    'gtdSidebar',
    async ref => ({ id: ref }),
  );

  assert.deepEqual(result, { id: 'legacy-row' });
});

test('inbox actions keep their current row without resolving', async () => {
  const message = { id: 'current-row', message_id: '<stable@example.com>' };
  const result = await resolveContextMenuMessage(message, 'inbox', async () => {
    throw new Error('must not resolve');
  });

  assert.equal(result, message);
});
