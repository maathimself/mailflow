import { describe, expect, it } from 'vitest';
import { UUID_RE, areValidUUIDs, isValidFolderName } from './validation.js';

describe('mail validation helpers', () => {
  it('accepts UUID-shaped message ids case-insensitively', () => {
    expect(UUID_RE.test('AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA')).toBe(true);
    expect(areValidUUIDs([
      '11111111-1111-4111-8111-111111111111',
      'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
    ])).toBe(true);
  });

  it('rejects non-string or malformed ids in an array', () => {
    expect(areValidUUIDs(['not-a-uuid'])).toBe(false);
    expect(areValidUUIDs([null])).toBe(false);
  });

  it('accepts folder paths up to 255 characters without control characters', () => {
    expect(isValidFolderName('Projects/2026')).toBe(true);
    expect(isValidFolderName('x'.repeat(255))).toBe(true);
  });

  it('rejects empty, oversized, non-string, and control-character folder names', () => {
    expect(isValidFolderName('')).toBe(false);
    expect(isValidFolderName('x'.repeat(256))).toBe(false);
    expect(isValidFolderName(null)).toBe(false);
    expect(isValidFolderName('Inbox\nArchive')).toBe(false);
  });
});
