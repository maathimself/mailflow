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
    tags: false,
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
    tags: true,
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
    account_id: 'account-1',
  }, 'gtdSidebar', async (ref, accountId) => {
    calls.push([ref, accountId]);
    return current;
  });

  assert.equal(result, current);
  assert.deepEqual(calls, [['<stable@example.com>', 'account-1']]);
});

test('GTD resolution falls back to a legacy row id', async () => {
  const result = await resolveContextMenuMessage(
    { id: 'legacy-row', account_id: 'account-1' },
    'gtdSidebar',
    async (ref, accountId) => ({ id: ref, accountId }),
  );

  assert.deepEqual(result, { id: 'legacy-row', accountId: 'account-1' });
});

test('inbox actions keep their current row without resolving', async () => {
  const message = { id: 'current-row', message_id: '<stable@example.com>' };
  const result = await resolveContextMenuMessage(message, 'inbox', async () => {
    throw new Error('must not resolve');
  });

  assert.equal(result, message);
});

test('the conversation pane drops only row selection, since it has no list row', () => {
  // Everything else must survive: the pane's pickers are this menu's, so disabling
  // snooze or move here would silently empty the conversation toolbar.
  assert.deepEqual(getContextMenuPolicy('conversation'), {
    select: false,
    compose: true,
    archive: true,
    snooze: true,
    categorize: true,
    tags: true,
    done: false,
    rules: true,
    spam: true,
    copy: true,
    viewHeaders: true,
  });
});
