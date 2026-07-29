import { describe, expect, it } from 'vitest';

import { resolveAccountScope } from './unifiedInbox.js';

const accounts = [
  { id: 'included', include_in_unified_inbox: true },
  { id: 'excluded', include_in_unified_inbox: false },
  { id: 'legacy' },
];

describe('resolveAccountScope', () => {
  it('excludes opted-out accounts from unified scope and includes legacy rows', () => {
    expect(resolveAccountScope(accounts)).toEqual({
      accountIds: ['included', 'legacy'],
      resolvedAccountId: null,
    });
  });

  it('keeps an excluded account available when it is explicitly selected', () => {
    expect(resolveAccountScope(accounts, 'excluded')).toEqual({
      accountIds: ['excluded'],
      resolvedAccountId: 'excluded',
    });
  });

  it('falls back to unified scope for an account the user does not own', () => {
    expect(resolveAccountScope(accounts, 'other')).toEqual({
      accountIds: ['included', 'legacy'],
      resolvedAccountId: null,
    });
  });
});
