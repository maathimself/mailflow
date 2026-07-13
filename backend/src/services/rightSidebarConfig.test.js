import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));

import { query } from './db.js';
import {
  getRightSidebarConfig,
  invalidateRightSidebarConfig,
  sanitizeRightSidebarLabels,
} from './rightSidebarConfig.js';

beforeEach(() => {
  query.mockReset();
});

describe('sanitizeRightSidebarLabels', () => {
  it('trims, preserves order, and deduplicates paths', () => {
    expect(sanitizeRightSidebarLabels([' Projects ', 'Receipts', 'Projects'])).toEqual({
      labels: ['Projects', 'Receipts'],
      rejected: [],
    });
  });

  it('rejects invalid and reserved paths while keeping labels', () => {
    const tooLong = 'x'.repeat(256);
    expect(sanitizeRightSidebarLabels([
      '', tooLong, '../Trash', '..\\Trash', 4, 'INBOX', 'Sent', 'Sent Items', 'Sent Mail',
      'Draft', 'Projects/Archive', 'Bad\0Label', 'Bad\nLabel', 'Projects',
    ])).toEqual({
      labels: ['Projects'],
      rejected: [
        '', tooLong, '../Trash', '..\\Trash', 4, 'INBOX', 'Sent', 'Sent Items', 'Sent Mail',
        'Draft', 'Projects/Archive', 'Bad\0Label', 'Bad\nLabel',
      ],
    });
  });

  it('caps the stored list at 40 labels and reports the overflow', () => {
    const input = Array.from({ length: 45 }, (_, i) => `Label-${i}`);
    const result = sanitizeRightSidebarLabels(input);
    expect(result.labels).toHaveLength(40);
    expect(result.rejected).toEqual(input.slice(40));
  });

  it('returns an empty list for absent values and rejects malformed containers', () => {
    expect(sanitizeRightSidebarLabels()).toEqual({ labels: [], rejected: [] });
    expect(sanitizeRightSidebarLabels('Projects')).toEqual({ labels: [], rejected: ['Projects'] });
  });
});

describe('getRightSidebarConfig', () => {
  it('sanitizes the stored array and caches it until invalidated', async () => {
    query.mockResolvedValue({ rows: [{ right_sidebar_labels: [' Projects ', 'INBOX'] }] });
    const accountId = 'account-cache';

    expect(await getRightSidebarConfig(accountId)).toEqual(['Projects']);
    expect(await getRightSidebarConfig(accountId)).toEqual(['Projects']);
    expect(query).toHaveBeenCalledTimes(1);

    invalidateRightSidebarConfig(accountId);
    expect(await getRightSidebarConfig(accountId)).toEqual(['Projects']);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('returns an empty list for a missing account', async () => {
    query.mockResolvedValue({ rows: [] });
    expect(await getRightSidebarConfig('account-missing')).toEqual([]);
  });
});
