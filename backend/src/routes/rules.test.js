import { describe, it, expect, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: vi.fn() }));

import { normalizeActions } from './rules.js';

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
});
