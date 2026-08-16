import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getGtdMetadata } from './metadataStore.js';
import { closeDelegation, getDelegationSnapshot } from './delegationController.js';
import { contactOption, delegationPillData, runDelegation, submitDelegation } from './delegation.js';

const t = (key, vars) => `${key}:${JSON.stringify(vars || {})}`;
const messageId = 'delegate-message';

function harness(result = { status: 'success', successCount: 1, failureCount: 0, results: [] }) {
  const notifications = [];
  return {
    api: {
      carddav: { status: async () => ({ connected: false }) },
      gtdDelegate: async () => result,
    },
    store: { addNotification: value => notifications.push(value) },
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
