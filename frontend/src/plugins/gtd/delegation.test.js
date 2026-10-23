import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getGtdMetadata } from './metadataStore.js';
import { closeDelegation, getDelegationSnapshot } from './delegationController.js';
import { contactOption, delegationPillData, findDelegationTarget, findMessageWindowTargets, runDelegation, submitDelegation } from './delegation.js';

const t = (key, vars) => `${key}:${JSON.stringify(vars || {})}`;
const messageId = 'delegate-message';

function harness(result = { status: 'success', successCount: 1, failureCount: 0, results: [] }) {
  const notifications = [];
  let sectionRefreshes = 0;
  return {
    api: {
      carddav: { status: async () => ({ connected: false }) },
      gtdDelegate: async () => result,
    },
    store: {
      addNotification: value => notifications.push(value),
      scheduleGtdSectionsFetch: () => { sectionRefreshes += 1; },
    },
    get sectionRefreshes() { return sectionRefreshes; },
    notifications,
    t,
  };
}

beforeEach(() => closeDelegation());

describe('runDelegation', () => {
  it('submits personless immediately when CardDAV is disconnected', async () => {
    const h = harness();
    const result = await runDelegation([messageId], h);
    assert.equal(result.status, 'success');
    assert.equal(getDelegationSnapshot().phase, 'closed');
  });

  it('keeps an automatic personless submission out of picker mode', async () => {
    let finish;
    const h = harness();
    h.api.gtdDelegate = () => new Promise(resolve => { finish = resolve; });

    const pending = runDelegation([messageId], h);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(getDelegationSnapshot().phase, 'submitting-background');
    finish({ status: 'success', successCount: 1, failureCount: 0, results: [] });
    await pending;
  });

  it('opens the picker when CardDAV is connected', async () => {
    const h = harness();
    h.api.carddav.status = async () => ({ connected: true });
    assert.equal(await runDelegation([messageId], h), null);
    assert.equal(getDelegationSnapshot().phase, 'picker');
  });

  it('surfaces a status-check failure in the controller', async () => {
    const h = harness();
    h.api.carddav.status = async () => { throw new Error('offline'); };
    await runDelegation([messageId], h);
    assert.equal(getDelegationSnapshot().phase, 'picker');
    assert.equal(getDelegationSnapshot().error, 'gtd.delegate.loadFailed:{}');
  });

  it('reports an oversized batch without checking CardDAV or dropping targets', async () => {
    const h = harness();
    let statusChecks = 0;
    h.api.carddav.status = async () => { statusChecks += 1; return { connected: true }; };
    await runDelegation(Array.from({ length: 101 }, (_, index) => `m${index}`), h);
    assert.equal(statusChecks, 0);
    assert.equal(h.notifications[0].title, 'gtd.delegate.tooMany:{"max":100}');
    assert.equal(getDelegationSnapshot().phase, 'closed');
  });
});

describe('delegation target selection', () => {
  it('finds a selected message stored only in an expanded thread', () => {
    const selected = { id: messageId, account_id: 'account-1' };
    assert.equal(findDelegationTarget({
      selectedMessageId: messageId,
      searchQuery: '',
      messages: [],
      searchResults: [],
      threadMessages: { 'thread-1': [selected] },
    }), selected);
  });

  it('finds detached-window messages independently of the global selection', () => {
    const global = { id: 'global-message', account_id: 'account-1' };
    const detached = { id: 'detached-message', account_id: 'account-1' };
    assert.deepEqual(findMessageWindowTargets({
      selectedMessageId: global.id,
      searchQuery: '',
      messages: [global],
      searchResults: [],
      threadMessages: { detached: [detached] },
      messageWindows: [{ winId: 'window-1', messageId: detached.id }],
    }), [detached]);
  });
});

describe('submitDelegation', () => {
  it('patches successful snapshots and emits one partial notification', async () => {
    const delegation = { contactId: 'c1', displayName: 'Casey', delegatedAt: '2026-08-13T00:00:00.000Z' };
    const h = harness({
      status: 'partial', successCount: 1, failureCount: 1,
      results: [
        { messageId, ok: true, delegation },
        { messageId: 'failed', ok: false, error: 'operation_failed' },
      ],
    });
    await submitDelegation([messageId, 'failed'], 'c1', h);
    assert.deepEqual(getGtdMetadata(messageId)?.delegation, delegation);
    assert.equal(h.notifications.length, 1);
    assert.equal(h.notifications[0].title, 'gtd.delegate.partial:{"success":1,"failed":1}');
    assert.equal(h.sectionRefreshes, 1);
  });

  it('normalizes contact labels with display-name and email fallbacks', () => {
    assert.deepEqual(contactOption({ id: 'c1', display_name: 'Casey', primary_email: 'c@example.test' }), {
      id: 'c1', label: 'Casey', email: 'c@example.test',
    });
    assert.equal(contactOption({ id: 'c2', primary_email: 'e@example.test' }).label, 'e@example.test');
  });
});

describe('delegation pill', () => {
  it('uses display name then email and ages from delegatedAt', () => {
    assert.deepEqual(delegationPillData({
      displayName: 'Casey', primaryEmail: 'c@example.test', delegatedAt: '2026-08-10T00:00:00.000Z',
    }, Date.parse('2026-08-13T00:00:00.000Z')), { label: 'Casey', email: 'c@example.test', days: 3 });
    assert.equal(delegationPillData({ primaryEmail: 'e@example.test' }, 0).label, 'e@example.test');
  });
});
