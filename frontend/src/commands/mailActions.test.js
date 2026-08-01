import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMailActionExecutors, mailCommandDefinitions } from './mailActions.js';

const target = (rowId, patch = {}) => {
  const id = `account-1:<${rowId}@example.test>`;
  return {
    id,
    rowId,
    accountId: 'account-1',
    message: {
      id: rowId,
      account_id: 'account-1',
      message_id: `<${rowId}@example.test>`,
      is_read: false,
      is_starred: false,
      subject: `Subject ${rowId}`,
      ...patch,
    },
  };
};

function harness(apiPatch = {}, depsPatch = {}) {
  const events = [];
  const api = {
    bulkRead: async (ids, read) => ({ ok: true, ids, read }),
    markStarred: async (id, starred) => ({ ok: true, id, starred }),
    gtdClassify: async (id, state) => ({ ok: true, id, state }),
    gtd: {
      delegate: async (ids, contactId) => ({
        status: 'success', successCount: ids.length, failureCount: 0,
        results: ids.map(messageId => ({ messageId, ok: true, delegation: contactId })),
      }),
    },
    getMessageBody: async () => ({ text: 'body', html: '<p>body</p>', attachments: [] }),
    ...apiPatch,
  };
  const deps = {
    api,
    accounts: () => [{ id: 'account-1', email_address: 'me@example.test', gtd_enabled: true }],
    openCompose: payload => events.push(['compose', payload]),
    openExternal: value => events.push(['external', value]),
    patchMessages: (targets, patch) => events.push(['patch', targets.map(item => item.id), patch]),
    restoreMessages: targets => events.push(['restore', targets.map(item => item.id)]),
    adjustUnread: (targets, read) => events.push(['unread', targets.map(item => item.id), read]),
    guardReadPending: targets => events.push(['read-pending', targets.map(item => item.id)]),
    guardReadCompleted: targets => events.push(['read-complete', targets.map(item => item.id)]),
    clearReadGuards: targets => events.push(['read-clear', targets.map(item => item.id)]),
    scheduleGtdRefresh: () => events.push(['gtd-refresh']),
    refreshCarddavStatus: async () => ({ connected: false }),
    refreshMessages: async () => events.push(['messages-refresh']),
    refreshGtdSections: async () => events.push(['gtd-refresh']),
    notify: notification => events.push(['notify', notification]),
    moveOptions: () => [{ id: 'Archive', label: 'Archive' }],
    snoozeOptions: () => [{ id: '2026-08-01T09:00:00.000Z', label: 'Tomorrow morning' }],
    ...depsPatch,
  };
  const executors = createMailActionExecutors(deps);
  const invoke = (executorId, targets, rest = {}) => executors[executorId]({
    context: { conversationsById: Object.fromEntries(targets.map(item => [item.id, item])) },
    targetIds: targets.map(item => item.id),
    source: 'test',
    ...rest,
  });
  return { events, executors, invoke };
}

describe('mailCommandDefinitions', () => {
  it('declares bulk-safe mutations and single-only response commands', () => {
    const byId = new Map(mailCommandDefinitions.map(definition => [definition.id, definition]));
    assert.equal(byId.get('mail.archive').targetMode, 'bulk_safe');
    assert.equal(byId.get('mail.toggleRead').targetMode, 'bulk_safe');
    assert.equal(byId.get('mail.reply').targetMode, 'single_conversation');
    assert.equal(byId.get('mail.replyAll').targetMode, 'single_conversation');
    assert.equal(byId.get('mail.forward').targetMode, 'single_conversation');
    assert.equal(byId.get('mail.move').executorId, 'mail.move');
    assert.deepEqual(byId.get('mail.archive').aliasKeys, ['commands.mail.archive.aliasDone']);
    assert.equal(byId.get('mail.snooze').titleKey, 'contextMenu.snooze.label');
    assert.deepEqual(byId.get('mail.toggleRead').defaultKeys, { primary: 'u', secondary: ['m'] });
    assert.deepEqual(byId.get('mail.replyAll').defaultKeys, { primary: 'enter', secondary: ['a'] });
  });

  it('offers Unsubscribe only for one usable active message', () => {
    const command = mailCommandDefinitions.find(item => item.id === 'mail.unsubscribe');
    assert.equal(command.targetMode, 'single_conversation');
    assert.equal(command.isAvailable({ surface: 'conversation', activeMessage: { list_unsubscribe: '<https://example.test/u>' } }), true);
    assert.equal(command.isAvailable({ surface: 'list', activeMessage: { list_unsubscribe: '<https://example.test/u>' } }), false);
    assert.equal(command.isAvailable({ surface: 'conversation', activeMessage: { list_unsubscribe: null } }), false);
  });
});

describe('non-destructive mail executors', () => {
  it('accepts the backend one-click unsubscribe result and patches the message', async () => {
    const h = harness({ unsubscribeMessage: async () => ({ ok: true, type: 'one-click' }) });
    const message = target('a', { list_unsubscribe: '<https://example.test/u>' });
    const result = await h.invoke('mail.unsubscribe', [message]);
    assert.equal(result.status, 'success');
    assert.ok(h.events.find(event => event[0] === 'patch'));
    assert.equal(h.events.some(event => event[0] === 'external'), false);
  });

  it('marks the complete resolved target set read with one optimistic patch', async () => {
    const h = harness();
    const result = await h.invoke('mail.read', [target('a'), target('b')], { source: 'toolbar' });
    assert.equal(result.status, 'success');
    assert.deepEqual(result.succeededIds, ['account-1:<a@example.test>', 'account-1:<b@example.test>']);
    assert.deepEqual(h.events.find(event => event[0] === 'patch'), [
      'patch', result.succeededIds, { is_read: true },
    ]);
    assert.deepEqual(h.events.find(event => event[0] === 'unread'), [
      'unread', result.succeededIds, true,
    ]);
    assert.deepEqual(h.events.filter(event => event[0].startsWith('read-')), [
      ['read-pending', result.succeededIds],
      ['read-complete', result.succeededIds],
    ]);
  });

  it('restores read state and returns failed when the API rejects', async () => {
    const h = harness({ bulkRead: async () => { throw new Error('read failed'); } });
    const result = await h.invoke('mail.read', [target('a')], { source: 'shortcut' });
    assert.equal(result.status, 'failed');
    assert.deepEqual(result.failed, [{ id: 'account-1:<a@example.test>', error: 'read failed' }]);
    assert.deepEqual(h.events.find(event => event[0] === 'restore'), [
      'restore',
      ['account-1:<a@example.test>'],
    ]);
    assert.deepEqual(h.events.filter(event => event[0].startsWith('read-')), [
      ['read-pending', ['account-1:<a@example.test>']],
      ['read-clear', ['account-1:<a@example.test>']],
    ]);
  });

  it('clears read guards before marking a message unread', async () => {
    const h = harness();
    await h.invoke('mail.unread', [target('a', { is_read: true })]);
    assert.equal(h.events.findIndex(event => event[0] === 'read-clear')
      < h.events.findIndex(event => event[0] === 'patch'), true);
    assert.deepEqual(h.events.filter(event => event[0].startsWith('read-')), [
      ['read-clear', ['account-1:<a@example.test>']],
    ]);
  });

  it('reverses the optimistic unread delta when a read request fails', async () => {
    const h = harness({ bulkRead: async () => { throw new Error('read failed'); } });
    await h.invoke('mail.read', [target('a')]);
    assert.deepEqual(h.events.slice(-2), [
      ['restore', ['account-1:<a@example.test>']],
      ['unread', ['account-1:<a@example.test>'], false],
    ]);
  });

  it('reports only failed star targets and rolls those targets back', async () => {
    const h = harness({
      markStarred: async id => {
        if (id === 'b') throw new Error('flag failed');
        return { ok: true };
      },
    });
    const result = await h.invoke('mail.star', [target('a'), target('b')], { source: 'palette' });
    assert.equal(result.status, 'partial');
    assert.deepEqual(result.succeededIds, ['account-1:<a@example.test>']);
    assert.deepEqual(result.failed, [{ id: 'account-1:<b@example.test>', error: 'flag failed' }]);
    assert.deepEqual(h.events.at(-1), ['restore', ['account-1:<b@example.test>']]);
  });

  it('opens one reply-all composer through the existing payload builder', async () => {
    const h = harness();
    const result = await h.invoke('mail.replyAll', [target('a')], { source: 'context-menu' });
    assert.equal(result.status, 'success');
    assert.equal(h.events[0][0], 'compose');
    assert.equal(h.events[0][1].isReplyAll, true);
  });

  it('does not depend on a pane-cached body when replying or forwarding', async () => {
    const h = harness();
    const current = target('a', { thread_id: 'thread-a' });
    await h.invoke('mail.reply', [current], { source: 'pane-toolbar' });
    await h.invoke('mail.forward', [current], { source: 'list-context-menu' });
    const payloads = h.events.filter(event => event[0] === 'compose').map(event => event[1]);
    assert.equal(payloads[0].threadId, 'thread-a');
    assert.equal(payloads[0].quotedBody.includes('body'), true);
    assert.equal(payloads[1].quotedBody.includes('body'), true);
  });

  it('returns partial GTD classification and refreshes sections once', async () => {
    const h = harness({
      gtdClassify: async id => {
        if (id === 'b') throw new Error('copy failed');
        return { ok: true };
      },
    });
    const result = await h.invoke('gtd.todo', [target('a'), target('b')], { source: 'toolbar' });
    assert.equal(result.status, 'partial');
    assert.deepEqual(result.failed, [{ id: 'account-1:<b@example.test>', error: 'copy failed' }]);
    assert.equal(h.events.filter(event => event[0] === 'gtd-refresh').length, 1);
  });

  it('requests contact input with exact frozen targets when CardDAV is connected', async () => {
    const h = harness();
    const targets = [target('a'), target('b')];
    const context = {
      conversationsById: Object.fromEntries(targets.map(item => [item.id, item])),
      carddavStatus: { connected: true },
      carddavStatusLoaded: true,
    };
    const result = await h.invoke('gtd.delegate', targets, { context, source: 'shortcut' });
    assert.deepEqual(result, {
      status: 'needs_input',
      continuation: {
        commandId: 'gtd.delegate', kind: 'contact', targetIds: targets.map(item => item.id),
        props: { targetCount: 2 },
      },
    });
    assert.equal(h.events.length, 0);
  });

  it('refreshes an unknown CardDAV status before choosing the delegation workflow', async () => {
    const calls = [];
    const h = harness({}, {
      refreshCarddavStatus: async () => {
        calls.push('status');
        return { connected: true };
      },
    });
    const current = target('a');
    const context = {
      conversationsById: { [current.id]: current },
      carddavStatus: { connected: false },
      carddavStatusLoaded: false,
    };
    const result = await h.invoke('gtd.delegate', [current], { context });
    assert.deepEqual(calls, ['status']);
    assert.equal(result.status, 'needs_input');
    assert.equal(result.continuation.kind, 'contact');
  });

  it('delegates immediately without a person when CardDAV is disconnected', async () => {
    const calls = [];
    const h = harness({
      gtd: { delegate: async (...args) => {
        calls.push(args);
        return {
          status: 'success', successCount: 1, failureCount: 0,
          results: [{ messageId: 'a', ok: true }],
        };
      } },
    });
    const current = target('a');
    const context = {
      conversationsById: { [current.id]: current },
      carddavStatus: { connected: false },
      carddavStatusLoaded: true,
    };
    const result = await h.invoke('gtd.delegate', [current], { context });
    assert.deepEqual(calls, [[['a'], null]]);
    assert.equal(result.status, 'success');
  });

  it('resumes with a stable contact ID and sends only database message UUIDs', async () => {
    const calls = [];
    const h = harness({
      gtd: { delegate: async (...args) => {
        calls.push(args);
        return {
          status: 'success', successCount: 2, failureCount: 0,
          results: ['a', 'b'].map(messageId => ({ messageId, ok: true })),
        };
      } },
    });
    const targets = [target('a'), target('b')];
    const context = {
      conversationsById: Object.fromEntries(targets.map(item => [item.id, item])),
      carddavStatus: { connected: true },
      carddavStatusLoaded: true,
    };
    const result = await h.invoke('gtd.delegate', targets, {
      context, source: 'continuation', input: { contactId: 'contact-1' },
    });
    assert.deepEqual(calls, [[['a', 'b'], 'contact-1']]);
    assert.deepEqual(result.succeededIds, targets.map(item => item.id));
  });

  it('patches successful delegation metadata into every cached message surface', async () => {
    const delegation = {
      contact_id: 'contact-1', display_name: 'Casey Rivera',
      primary_email: 'casey@example.test',
    };
    const h = harness({
      gtd: { delegate: async () => ({
        status: 'partial', successCount: 1, failureCount: 1,
        results: [
          { messageId: 'a', ok: true, delegation },
          { messageId: 'b', ok: false, error: { code: 'operation_failed' } },
        ],
      }) },
    });
    const targets = [target('a'), target('b')];
    const context = {
      conversationsById: Object.fromEntries(targets.map(item => [item.id, item])),
      carddavStatus: { connected: true }, carddavStatusLoaded: true,
    };
    await h.invoke('gtd.delegate', targets, {
      context, input: { contactId: 'contact-1' }, source: 'continuation',
    });
    assert.deepEqual(h.events.filter(event => event[0] === 'patch'), [
      ['patch', [targets[0].id], { delegation }],
    ]);
  });
});

function removalHarness(apiPatch = {}) {
  const events = [];
  const scheduled = [];
  const timers = {
    setTimeout(fn, ms) {
      const item = { fn, ms, cleared: false };
      scheduled.push(item);
      return item;
    },
    clearTimeout(item) { item.cleared = true; },
  };
  const api = {
    bulkArchive: async ids => ({ archived: ids, noArchiveFolder: [] }),
    bulkDelete: async ids => ({ deleted: ids }),
    bulkMove: async ids => ({ moved: ids }),
    snoozeMessage: async id => ({ ok: true, id }),
    markSpam: async id => ({ ok: true, id }),
    markHam: async id => ({ ok: true, id }),
    ...apiPatch,
  };
  const deps = {
    api,
    accounts: () => [],
    openCompose() {},
    patchMessages() {},
    adjustUnread: (targets, read) => events.push(['unread', targets.map(item => item.id), read]),
    removeMessages: targets => events.push(['remove', targets.map(item => item.id)]),
    restoreMessages: targets => events.push(['restore', targets.map(item => item.id)]),
    guardPending: ids => events.push(['guard-pending', ids]),
    guardCompleted: ids => events.push(['guard-complete', ids]),
    clearGuards: ids => events.push(['guard-clear', ids]),
    recordRecentFolder: (accountId, folder) => events.push(['recent', accountId, folder]),
    scheduleGtdRefresh() {},
    notify: notification => events.push(['notify', notification]),
    moveOptions: () => [{ id: 'Archive', label: 'Archive' }],
    snoozeOptions: () => [{ id: '2026-08-01T09:00:00.000Z', label: 'Tomorrow morning' }],
    registerPendingRemoval: operation => {
      events.push(['register-pending-removal', operation]);
      return () => events.push(['unregister-pending-removal']);
    },
    keepaliveDelete: ids => events.push(['keepalive-delete', ids]),
    timers,
  };
  const executors = createMailActionExecutors(deps);
  const invoke = (executorId, targets, rest = {}) => executors[executorId]({
    context: { conversationsById: Object.fromEntries(targets.map(item => [item.id, item])) },
    targetIds: targets.map(item => item.id),
    source: 'test',
    ...rest,
  });
  return { events, scheduled, executors, invoke };
}

describe('removal and continuation executors', () => {
  it('requests Move input with the exact frozen target IDs', async () => {
    const h = removalHarness();
    const targets = [target('a'), target('b')];
    const result = await h.invoke('mail.move', targets, { source: 'shortcut' });
    assert.deepEqual(result, {
      status: 'needs_input',
      continuation: {
        commandId: 'mail.move',
        kind: 'move',
        targetIds: targets.map(item => item.id),
        props: {
          accountId: 'account-1',
          targetCount: 2,
          titleKey: 'contextMenu.moveToFolder',
          inputKey: 'folder',
          items: [{ id: 'Archive', label: 'Archive' }],
        },
      },
    });
    assert.equal(h.events.length, 0);
  });

  it('requests Snooze input without mutating targets', async () => {
    const h = removalHarness();
    const result = await h.invoke('mail.snooze', [target('a')], { source: 'palette' });
    assert.equal(result.status, 'needs_input');
    assert.equal(result.continuation.kind, 'snooze');
    assert.deepEqual(result.continuation.targetIds, ['account-1:<a@example.test>']);
    assert.equal(result.continuation.props.inputKey, 'until');
    assert.equal(result.continuation.props.items[0].label, 'Tomorrow morning');
    assert.equal(h.events.length, 0);
  });

  it('undoes Archive before the delayed API call', async () => {
    const h = removalHarness();
    const result = await h.invoke('mail.archive', [target('a')], { source: 'hover' });
    assert.equal(result.status, 'success');
    assert.equal(h.scheduled[0].ms, 4500);
    const notification = h.events.find(event => event[0] === 'notify')[1];
    notification.onUndo();
    assert.equal(h.scheduled[0].cleared, true);
    assert.ok(h.events.some(event => event[0] === 'restore'));
    assert.ok(h.events.some(event => event[0] === 'guard-clear'));
  });

  it('restores only failed Move targets and records the destination once', async () => {
    const h = removalHarness({ bulkMove: async () => ({ moved: ['a'] }) });
    const result = await h.invoke('mail.move', [target('a'), target('b')], {
      input: { folder: 'Archive' },
      source: 'context-menu',
    });
    assert.equal(result.status, 'success');
    await h.scheduled[0].fn();
    assert.deepEqual(h.events.find(event => event[0] === 'restore'), ['restore', ['account-1:<b@example.test>']]);
    assert.equal(h.events.filter(event => event[0] === 'recent').length, 1);
  });

  it('reports per-target Spam failure after the undo window', async () => {
    const h = removalHarness({
      markSpam: async id => {
        if (id === 'b') throw new Error('spam failed');
        return { ok: true };
      },
    });
    await h.invoke('mail.spam', [target('a'), target('b')], { source: 'toolbar' });
    await h.scheduled[0].fn();
    const errorNotice = h.events.filter(event => event[0] === 'notify').at(-1)[1];
    assert.equal(errorNotice.failedCount, 1);
    assert.equal(errorNotice.succeededCount, 1);
    assert.deepEqual(h.events.find(event => event[0] === 'restore'), ['restore', ['account-1:<b@example.test>']]);
  });

  it('restores every target and reports exact counts when a delayed request throws', async () => {
    const h = removalHarness({ bulkArchive: async () => { throw new Error('archive failed'); } });
    await h.invoke('mail.archive', [target('a'), target('b')]);
    await h.scheduled[0].fn();
    assert.deepEqual(h.events.find(event => event[0] === 'restore'), [
      'restore',
      ['account-1:<a@example.test>', 'account-1:<b@example.test>'],
    ]);
    const errorNotice = h.events.filter(event => event[0] === 'notify').at(-1)[1];
    assert.equal(errorNotice.succeededCount, 0);
    assert.equal(errorNotice.failedCount, 2);
  });

  it('registers Trash so lifecycle cleanup can flush it normally or with keepalive', async () => {
    const h = removalHarness();
    await h.invoke('mail.trash', [target('a')]);
    const operation = h.events.find(event => event[0] === 'register-pending-removal')[1];
    await operation.run();
    operation.unload();
    assert.deepEqual(h.events.find(event => event[0] === 'keepalive-delete'), [
      'keepalive-delete',
      ['a'],
    ]);
  });
});

it('constructs every executor with the documented dependency adapter', () => {
  const required = [
    'api', 'accounts', 'openCompose', 'patchMessages', 'removeMessages',
    'restoreMessages', 'adjustUnread', 'guardPending', 'guardCompleted',
    'clearGuards', 'recordRecentFolder', 'scheduleGtdRefresh', 'notify', 'timers',
    'moveOptions', 'snoozeOptions',
    'refreshCarddavStatus', 'refreshMessages', 'refreshGtdSections',
    'guardReadPending', 'guardReadCompleted', 'clearReadGuards',
    'registerPendingRemoval', 'keepaliveDelete',
  ];
  const deps = Object.fromEntries(required.map(key => [key, key === 'api' ? {} : () => {}]));
  deps.timers = { setTimeout, clearTimeout };
  assert.doesNotThrow(() => createMailActionExecutors(deps));
});
