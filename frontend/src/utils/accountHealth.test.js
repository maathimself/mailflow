import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ACCOUNT_HEALTH_CODES,
  HEALTH_FIELDS,
  HEALTH_LABEL_KEYS,
  MICROSOFT_OAUTH_PATH,
  STALE_AFTER_MS,
  accountEventPatch,
  computeAccountHealth,
  reconnectMenuAction,
  reconnectUrlFor,
  withProvisionalHealth,
} from './accountHealth.js';

// The same fixture the backend suite reads; both rules must agree on every case.
const fixture = JSON.parse(readFileSync(
  new URL('../../../backend/src/services/accountHealth.fixtures.json', import.meta.url), 'utf8'));

// The client receives last_sync as an ISO string over JSON, so this suite feeds strings.
function toAccount({ lastSyncAgeMs, ...fields }, now) {
  if (lastSyncAgeMs === undefined) return fields;
  return { ...fields, last_sync: lastSyncAgeMs === null ? null : new Date(now - lastSyncAgeMs).toISOString() };
}

describe('computeAccountHealth parity with the backend rule', () => {
  it('uses the same stale threshold as the fixture', () => {
    assert.equal(STALE_AFTER_MS, 15 * 60 * 1000);
    assert.equal(fixture.staleAfterMs, STALE_AFTER_MS);
  });

  it('knows exactly the five stable codes', () => {
    assert.deepEqual([...ACCOUNT_HEALTH_CODES].sort(), ['disabled', 'failed', 'healthy', 'oauth_reconnect_required', 'stale']);
  });

  for (const testCase of fixture.cases) {
    it(`fixture: ${testCase.name}`, () => {
      assert.equal(computeAccountHealth(toAccount(testCase.account, fixture.now), fixture.now), testCase.expected);
    });
  }

  it('treats a missing account like one that never synced', () => {
    assert.equal(computeAccountHealth(null, fixture.now), 'stale');
  });
});

describe('HEALTH_LABEL_KEYS', () => {
  it('maps every code to a sidebar.health key', () => {
    for (const code of ACCOUNT_HEALTH_CODES) {
      assert.match(HEALTH_LABEL_KEYS[code], /^sidebar\.health\.\w+$/, code);
    }
  });
});

describe('withProvisionalHealth', () => {
  const now = fixture.now;
  const base = {
    id: 'a1', enabled: true, oauth_reconnect_required: false, sync_error: null,
    last_sync: new Date(now - 60000).toISOString(), health: 'healthy',
  };

  it('recomputes the code when a health field changes', () => {
    assert.equal(withProvisionalHealth(base, { sync_error: 'Connection refused' }, now).health, 'failed');
    assert.equal(withProvisionalHealth(base, { sync_error: 'oauth_reconnect_required' }, now).health, 'oauth_reconnect_required');
    assert.equal(withProvisionalHealth({ ...base, sync_error: 'x', health: 'failed' }, { sync_error: null }, now).health, 'healthy');
    assert.equal(withProvisionalHealth(base, { enabled: false }, now).health, 'disabled');
  });

  it('keeps the server code when the patch does not touch a health field', () => {
    const serverStale = { ...base, health: 'stale' };
    const merged = withProvisionalHealth(serverStale, { name: 'Renamed' }, now);
    assert.equal(merged.name, 'Renamed');
    assert.equal(merged.health, 'stale');
  });

  it('never newly produces stale from an aging client last_sync', () => {
    const old = new Date(now - 20 * 60 * 1000).toISOString();
    assert.equal(withProvisionalHealth({ ...base, last_sync: old }, { sync_error: null }, now).health, 'healthy');
    assert.equal(withProvisionalHealth({ ...base, last_sync: old, sync_error: 'x', health: 'failed' }, { sync_error: null }, now).health, 'healthy');
    assert.equal(withProvisionalHealth({ ...base, last_sync: old, health: 'stale' }, { sync_error: null }, now).health, 'stale');
  });

  it('lets an explicit health in the patch win', () => {
    assert.equal(withProvisionalHealth(base, { sync_error: 'boom', health: 'healthy' }, now).health, 'healthy');
  });

  it('lists the fields the rule reads', () => {
    assert.deepEqual([...HEALTH_FIELDS].sort(), ['enabled', 'last_sync', 'oauth_reconnect_required', 'sync_error']);
  });
});

describe('reconnectUrlFor', () => {
  it('starts the Google flow with the mailbox as login_hint', () => {
    assert.equal(reconnectUrlFor({ oauth_provider: 'google', email_address: 'box+1@gmail.com' }),
      '/oauth/google?login_hint=box%2B1%40gmail.com');
  });

  it('uses the existing Microsoft connect entry', () => {
    assert.equal(MICROSOFT_OAUTH_PATH, '/oauth/microsoft');
    assert.equal(reconnectUrlFor({ oauth_provider: 'microsoft', email_address: 'box@outlook.com' }), '/oauth/microsoft');
  });

  it('returns null for accounts without an OAuth provider', () => {
    assert.equal(reconnectUrlFor({ oauth_provider: null, email_address: 'a@b.c' }), null);
    assert.equal(reconnectUrlFor({ email_address: 'a@b.c' }), null);
    assert.equal(reconnectUrlFor(null), null);
  });
});

describe('accountEventPatch', () => {
  it('clears the failure and the reconnect flag on account_connected', () => {
    assert.deepEqual(accountEventPatch('account_connected', { accountId: 'a1' }),
      { sync_error: null, oauth_reconnect_required: false });
  });

  it('carries the error and sets the flag only for the stable reconnect code', () => {
    assert.deepEqual(accountEventPatch('account_error', { error: 'Connection refused' }), { sync_error: 'Connection refused' });
    assert.deepEqual(accountEventPatch('account_error', { error: 'oauth_reconnect_required' }),
      { sync_error: 'oauth_reconnect_required', oauth_reconnect_required: true });
  });

  it('returns null for unrelated events', () => {
    assert.equal(accountEventPatch('folder_counts', {}), null);
  });
});

describe('reconnectMenuAction', () => {
  it('offers the OAuth consent flow for a reconnect-required OAuth account', () => {
    const google = { oauth_provider: 'google', email_address: 'a@gmail.com', health: 'oauth_reconnect_required' };
    assert.deepEqual(reconnectMenuAction(google), { kind: 'oauth', url: reconnectUrlFor(google) });
    const microsoft = { oauth_provider: 'microsoft', health: 'oauth_reconnect_required' };
    assert.deepEqual(reconnectMenuAction(microsoft), { kind: 'oauth', url: MICROSOFT_OAUTH_PATH });
  });

  it('keeps the IMAP reconnect for every other account', () => {
    assert.deepEqual(reconnectMenuAction({ oauth_provider: 'google', health: 'failed' }), { kind: 'imap' });
    assert.deepEqual(reconnectMenuAction({ oauth_provider: null, health: 'oauth_reconnect_required' }), { kind: 'imap' });
  });
});
