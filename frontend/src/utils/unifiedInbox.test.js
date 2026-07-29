import test from 'node:test';
import assert from 'node:assert/strict';

import {
  accountAffectsUnifiedInbox,
  unifiedUnreadTotal,
} from './unifiedInbox.js';

const accounts = [
  { id: 'included', enabled: true, include_in_unified_inbox: true },
  { id: 'excluded', enabled: true, include_in_unified_inbox: false },
  { id: 'legacy', enabled: true },
  { id: 'disabled', enabled: false, include_in_unified_inbox: true },
];

test('legacy and opted-in enabled accounts affect the unified inbox', () => {
  assert.equal(accountAffectsUnifiedInbox(accounts, 'included'), true);
  assert.equal(accountAffectsUnifiedInbox(accounts, 'legacy'), true);
  assert.equal(accountAffectsUnifiedInbox(accounts, 'excluded'), false);
  assert.equal(accountAffectsUnifiedInbox(accounts, 'disabled'), false);
});

test('unified unread total excludes opted-out and disabled accounts', () => {
  assert.equal(unifiedUnreadTotal({
    included: 2,
    excluded: 5,
    legacy: 3,
    disabled: 7,
  }, accounts), 5);
});
