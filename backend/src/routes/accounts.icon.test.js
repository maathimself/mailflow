// A mailbox's icon (#376): exactly one emoji, or none.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../index.js', () => ({ imapManager: {} }));

const { normalizeAccountIcon } = await import('./accounts.js');

describe('normalizeAccountIcon', () => {
  it.each(['🏠', '💼', '🇳🇱', '#️⃣', '👨‍👩‍👧', '👍🏽', '❤️', ' 🛒 '])('takes %s', (icon) => {
    expect(normalizeAccountIcon(icon)).toEqual({ value: icon.trim() });
  });
  it.each([null, undefined, '', '   '])('takes %s as none', (icon) => {
    expect(normalizeAccountIcon(icon)).toEqual({ value: null });
  });
  it.each(['A', 'ab', '🏠🏠', '<b>', '1', 'home'])('refuses %s', (icon) => {
    expect(normalizeAccountIcon(icon).error).toBe('icon must be a single emoji');
  });
  it('refuses what is not a string', () => {
    expect(normalizeAccountIcon(5).error).toBe('icon must be a string');
  });
});
