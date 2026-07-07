import { describe, it, expect, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: vi.fn() }));

import { normalizeActions, validateConditions } from './rules.js';

describe('validateConditions', () => {
  it('returns null for a well-formed condition', () => {
    expect(validateConditions([{ field: 'subject', operator: 'contains', value: 'invoice' }])).toBeNull();
  });

  it('returns null for has_attachment which has no value', () => {
    expect(validateConditions([{ field: 'has_attachment', operator: 'equals', value: '' }])).toBeNull();
  });

  it('returns an error when a string-match condition has a blank value', () => {
    expect(validateConditions([{ field: 'from', operator: 'contains', value: '' }])).toBeTruthy();
    expect(validateConditions([{ field: 'subject', operator: 'contains', value: '   ' }])).toBeTruthy();
    expect(validateConditions([{ field: 'body', operator: 'contains', value: '' }])).toBeTruthy();
  });

  it('returns an error for a null condition entry', () => {
    expect(validateConditions([null])).toBeTruthy();
  });

  it('returns an error when field is not a string', () => {
    expect(validateConditions([{ field: 42, operator: 'contains', value: 'x' }])).toBeTruthy();
  });

  it('returns null for an empty conditions array', () => {
    expect(validateConditions([])).toBeNull();
  });

  it('returns null for a read_status condition with value "read"', () => {
    expect(validateConditions([{ field: 'read_status', value: 'read' }])).toBeNull();
  });

  it('returns null for a read_status condition with value "unread"', () => {
    expect(validateConditions([{ field: 'read_status', value: 'unread' }])).toBeNull();
  });

  it('returns an error for a read_status condition with a missing or invalid value', () => {
    expect(validateConditions([{ field: 'read_status' }])).toBeTruthy();
    expect(validateConditions([{ field: 'read_status', value: '' }])).toBeTruthy();
    expect(validateConditions([{ field: 'read_status', value: 'maybe' }])).toBeTruthy();
  });
});

describe('normalizeActions', () => {
  it('returns actions unchanged when there are no destination actions', () => {
    const actions = [{ type: 'mark_read', value: '' }, { type: 'star', value: '' }];
    expect(normalizeActions(actions)).toEqual(actions);
  });

  it('returns actions unchanged when there is exactly one destination action', () => {
    const actions = [{ type: 'mark_read', value: '' }, { type: 'move', value: 'INBOX/Work' }];
    expect(normalizeActions(actions)).toEqual(actions);
  });

  it('keeps only the first destination action when move and archive are both present', () => {
    const actions = [{ type: 'move', value: 'INBOX/Work' }, { type: 'archive', value: '' }];
    expect(normalizeActions(actions)).toEqual([{ type: 'move', value: 'INBOX/Work' }]);
  });

  it('keeps only the first destination action when archive and delete are both present', () => {
    const actions = [{ type: 'archive', value: '' }, { type: 'delete', value: '' }];
    expect(normalizeActions(actions)).toEqual([{ type: 'archive', value: '' }]);
  });

  it('keeps only the first destination action when all three are present', () => {
    const actions = [
      { type: 'move', value: 'INBOX/Work' },
      { type: 'archive', value: '' },
      { type: 'delete', value: '' },
    ];
    expect(normalizeActions(actions)).toEqual([{ type: 'move', value: 'INBOX/Work' }]);
  });

  it('preserves non-destination actions that appear after the first destination action', () => {
    const actions = [
      { type: 'mark_read', value: '' },
      { type: 'move', value: 'INBOX/Work' },
      { type: 'star', value: '' },
      { type: 'archive', value: '' },
    ];
    expect(normalizeActions(actions)).toEqual([
      { type: 'mark_read', value: '' },
      { type: 'move', value: 'INBOX/Work' },
      { type: 'star', value: '' },
    ]);
  });

  it('returns an empty array for an empty input', () => {
    expect(normalizeActions([])).toEqual([]);
  });

  it('trims whitespace from move destination values', () => {
    const actions = [{ type: 'move', value: '  INBOX/Work  ' }];
    expect(normalizeActions(actions)).toEqual([{ type: 'move', value: 'INBOX/Work' }]);
  });

  it('does not modify non-move action values', () => {
    const actions = [{ type: 'mark_read', value: '  ' }, { type: 'star', value: '' }];
    expect(normalizeActions(actions)).toEqual(actions);
  });

  it('drops null entries without throwing', () => {
    const actions = [null, { type: 'move', value: 'INBOX/Work' }];
    expect(normalizeActions(actions)).toEqual([{ type: 'move', value: 'INBOX/Work' }]);
  });

  it('drops entries with a non-string type without throwing', () => {
    const actions = [{ type: 42 }, { type: 'move', value: 'INBOX/Work' }];
    expect(normalizeActions(actions)).toEqual([{ type: 'move', value: 'INBOX/Work' }]);
  });

  it('handles a non-string move value without throwing', () => {
    const actions = [{ type: 'move', value: 123 }];
    expect(normalizeActions(actions)).toEqual([{ type: 'move', value: 123 }]);
  });
});
