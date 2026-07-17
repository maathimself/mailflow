import { describe, it, expect } from 'vitest';
import { newPaginatedResponse, newPaginatedResponseNoTotal, TOTAL_COUNT_UNKNOWN, toRFC3339, wireSummary } from './envelope.js';

describe('newPaginatedResponse', () => {
  it('computes has_more from offset+returned vs total', () => {
    expect(newPaginatedResponse([{ id: 'a' }, { id: 'b' }], 10, 0)).toEqual({
      data: [{ id: 'a' }, { id: 'b' }], total: 10, returned: 2, offset: 0, has_more: true,
    });
    expect(newPaginatedResponse([{ id: 'a' }], 1, 0).has_more).toBe(false);
  });
  it('coerces null data to an empty array', () => {
    expect(newPaginatedResponse(null, 0, 0).data).toEqual([]);
  });
});

describe('newPaginatedResponseNoTotal', () => {
  it('always reports total -1 and echoes has_more', () => {
    const r = newPaginatedResponseNoTotal([{ id: 'a' }], 20, true);
    expect(r).toEqual({ data: [{ id: 'a' }], total: TOTAL_COUNT_UNKNOWN, returned: 1, offset: 20, has_more: true });
    expect(TOTAL_COUNT_UNKNOWN).toBe(-1);
  });
});

describe('toRFC3339', () => {
  it('strips fractional seconds (msgvault wire timestamps are Go RFC3339, no millis)', () => {
    expect(toRFC3339('2024-01-01T00:00:00.000Z')).toBe('2024-01-01T00:00:00Z');
    expect(toRFC3339('2024-01-01T00:00:00.123Z')).toBe('2024-01-01T00:00:00Z');
    expect(toRFC3339('2024-01-01T00:00:00.123456+02:00')).toBe('2024-01-01T00:00:00+02:00');
  });
  it('passes through already-clean, empty, and non-string values', () => {
    expect(toRFC3339('2024-01-01T00:00:00Z')).toBe('2024-01-01T00:00:00Z');
    expect(toRFC3339('')).toBe('');
    expect(toRFC3339(undefined)).toBe(undefined);
  });
});

describe('wireSummary', () => {
  it('reformats sent_at to RFC3339 without mutating the input', () => {
    const s = { id: 'm1', sent_at: '2024-01-01T00:00:00.000Z' };
    expect(wireSummary(s)).toEqual({ id: 'm1', sent_at: '2024-01-01T00:00:00Z' });
    expect(s.sent_at).toBe('2024-01-01T00:00:00.000Z');
  });
  it('leaves summaries without a sent_at string untouched', () => {
    const s = { id: 'm1' };
    expect(wireSummary(s)).toBe(s);
    expect(wireSummary(null)).toBe(null);
  });
});
