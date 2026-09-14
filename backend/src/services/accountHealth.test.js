import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ACCOUNT_HEALTH_CODES, STALE_AFTER_MS, computeAccountHealth } from './accountHealth.js';

// Shared with frontend/src/utils/accountHealth.test.js so both rules stay in parity.
const fixture = JSON.parse(readFileSync(new URL('./accountHealth.fixtures.json', import.meta.url), 'utf8'));

// Cases carry a relative age; pg hands the route a Date, so the backend suite feeds Dates.
function toAccount({ lastSyncAgeMs, ...fields }, now) {
  if (lastSyncAgeMs === undefined) return fields;
  return { ...fields, last_sync: lastSyncAgeMs === null ? null : new Date(now - lastSyncAgeMs) };
}

describe('computeAccountHealth', () => {
  it('uses a 15-minute stale threshold shared with the fixture', () => {
    expect(STALE_AFTER_MS).toBe(15 * 60 * 1000);
    expect(fixture.staleAfterMs).toBe(STALE_AFTER_MS);
  });

  it('exposes exactly the five stable codes', () => {
    expect([...ACCOUNT_HEALTH_CODES].sort()).toEqual(['disabled', 'failed', 'healthy', 'oauth_reconnect_required', 'stale']);
    expect(fixture.cases.every(c => ACCOUNT_HEALTH_CODES.includes(c.expected))).toBe(true);
  });

  for (const testCase of fixture.cases) {
    it(`fixture: ${testCase.name}`, () => {
      expect(computeAccountHealth(toAccount(testCase.account, fixture.now), fixture.now)).toBe(testCase.expected);
    });
  }

  it('accepts an ISO string last_sync as well as a Date', () => {
    const now = fixture.now;
    expect(computeAccountHealth({ enabled: true, last_sync: new Date(now - 1000).toISOString() }, now)).toBe('healthy');
    expect(computeAccountHealth({ enabled: true, last_sync: new Date(now - STALE_AFTER_MS - 1).toISOString() }, now)).toBe('stale');
  });

  it('accepts a Date for now and defaults now to the current time', () => {
    const lastSync = new Date(Date.now() - 1000);
    expect(computeAccountHealth({ enabled: true, last_sync: lastSync }, new Date())).toBe('healthy');
    expect(computeAccountHealth({ enabled: true, last_sync: lastSync })).toBe('healthy');
  });

  it('treats a missing account like one that never synced rather than throwing', () => {
    expect(computeAccountHealth(null, fixture.now)).toBe('stale');
    expect(computeAccountHealth(undefined, fixture.now)).toBe('stale');
  });

  it('returns only the code, never the sync_error text', () => {
    const secretish = 'Invalid credentials: ya29.token-like-text';
    const code = computeAccountHealth({ enabled: true, sync_error: secretish, last_sync: new Date(fixture.now) }, fixture.now);
    expect(code).toBe('failed');
    expect(code.includes('ya29')).toBe(false);
  });
});
